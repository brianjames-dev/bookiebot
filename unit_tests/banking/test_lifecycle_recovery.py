from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import sqlite3

import pytest

import bookiebot.banking.store as store_module
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.store import BankStore
from unit_tests.banking.test_imports import seed, store


@pytest.mark.parametrize('status', ['matched', 'confirmed'])
@pytest.mark.parametrize('change', [
    {'amount': 27}, {'amount': -20}, {'date': '2026-09-04'},
    {'authorized_date': '2026-09-03'}, {'pending': True},
])
def test_material_bank_change_reopens_and_preserves_previous_match_event(store, status, change):
    item = seed(store)
    store.confirm_reconciliation_item('brian', item.id, matched_action_log_id='action-a', matched_sheet_ref='expense!row 12')
    with store.connect() as conn:
        conn.execute('UPDATE bank_reconciliation_items SET status = ? WHERE id = ?', (status, item.id))
    raw = {'transaction_id': 'txn-1', 'date': '2026-09-05', 'name': 'Example merchant', 'amount': 20, 'pending': False}
    store.upsert_transactions([{**raw, **change}], 'brian')
    reopened = store.get_reconciliation_item('brian', item.id)
    assert reopened.status == 'needs_review'
    assert reopened.matched_action_log_id is None
    assert reopened.matched_sheet_ref is None
    assert reopened.resolved_at is None
    events = store.reconciliation_events('brian', item.id)
    assert len(events) == 1
    assert events[0]['event_type'] == 'bank_transaction_modified'
    assert events[0]['payload']['previous_match']['matched_action_log_id'] == 'action-a'
    assert events[0]['payload']['previous_match']['matched_sheet_ref'] == 'expense!row 12'
    assert events[0]['payload']['previous_match']['status'] == status
    assert events[0]['payload']['before']['amount'] == 20
    assert set(change) == set(events[0]['payload']['changed_fields'])
    assert store.reconciliation_events('hannah', item.id) == []
    store.upsert_transactions([{**raw, **change}], 'brian')
    assert len(store.reconciliation_events('brian', item.id)) == 1


def test_ignored_policy_and_identical_confirmed_replays_stay_unchanged(store):
    item = seed(store)
    store.confirm_reconciliation_item('brian', item.id, matched_action_log_id='action-a')
    raw = {'transaction_id': 'txn-1', 'date': '2026-09-05', 'name': 'Renamed merchant', 'amount': 20, 'pending': False}
    store.upsert_transactions([raw], 'brian')
    assert store.get_reconciliation_item('brian', item.id).status == 'confirmed'
    assert store.reconciliation_events('brian', item.id) == []
    store.ignore_reconciliation_item('brian', item.id)
    store.upsert_transactions([{**raw, 'amount': 27}], 'brian')
    assert store.get_reconciliation_item('brian', item.id).status == 'ignored'
    assert store.reconciliation_events('brian', item.id) == []


def test_event_persistence_failure_rolls_back_bank_change_and_reopening(store):
    item = seed(store)
    store.confirm_reconciliation_item('brian', item.id, matched_action_log_id='action-a')
    with store.connect() as conn:
        conn.execute("CREATE TRIGGER fail_event BEFORE INSERT ON bank_reconciliation_events BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        store.upsert_transactions([{'transaction_id': 'txn-1', 'date': '2026-09-05', 'amount': 27}], 'brian')
    saved = store.get_reconciliation_item('brian', item.id)
    assert saved.status == 'confirmed'
    assert saved.transaction.amount == 20
    assert saved.matched_action_log_id == 'action-a'
    assert store.reconciliation_events('brian', item.id) == []


@pytest.fixture
def webhook_clock(monkeypatch):
    clock = [datetime(2026, 9, 6, 10, tzinfo=timezone.utc)]
    monkeypatch.setattr(store_module, 'utc_now_iso', lambda: clock[0].isoformat())
    return clock


def webhook(store, item_id='item-1'):
    store.upsert_item(owner_key='brian', provider='plaid', item_id=item_id,
                      access_token='test-token', institution_name='Test')
    return store.enqueue_plaid_webhook({'item_id': item_id, 'webhook_type': 'TRANSACTIONS', 'webhook_code': 'SYNC_UPDATES_AVAILABLE'})


def test_webhook_claim_is_exclusive_and_expired_processing_recovers_after_restart(store, webhook_clock):
    event = webhook(store)
    first = store.claim_plaid_webhook_event(event.id)
    assert first
    assert store.claim_plaid_webhook_event(event.id) is None
    assert store.pending_plaid_webhook_events() == []
    webhook_clock[0] += timedelta(seconds=301)
    restarted = BankStore(store.path, TokenCipher('test-secret'))
    assert [e.id for e, _ in restarted.pending_plaid_webhook_events()] == [event.id]
    second = restarted.claim_plaid_webhook_event(event.id)
    assert second and second != first
    assert store.mark_plaid_webhook_processed(event.id, 'item-1', claim_token=first) is False
    assert store.mark_plaid_webhook_failed(event.id, 'stale worker', claim_token=first) is False
    assert restarted.mark_plaid_webhook_processed(event.id, 'item-1', claim_token=second) is True
    assert restarted.pending_plaid_webhook_events() == []


def test_legacy_processing_without_lease_is_reclaimed(store, webhook_clock):
    event = webhook(store)
    with store.connect() as conn:
        conn.execute("UPDATE bank_webhook_events SET status = 'processing' WHERE id = ?", (event.id,))
    assert store.claim_plaid_webhook_event(event.id)


def test_failed_webhooks_back_off_and_do_not_starve_new_events(store, webhook_clock):
    event = webhook(store)
    first = store.claim_plaid_webhook_event(event.id)
    assert store.mark_plaid_webhook_failed(event.id, 'temporary failure', claim_token=first)
    assert store.pending_plaid_webhook_events() == []
    newer = webhook(store, 'item-2')
    assert [e.id for e, _ in store.pending_plaid_webhook_events()] == [newer.id]
    webhook_clock[0] += timedelta(seconds=60)
    second = store.claim_plaid_webhook_event(event.id)
    assert second
    assert store.mark_plaid_webhook_failed(event.id, 'temporary failure', claim_token=second)
    with store.connect() as conn:
        row = conn.execute('SELECT attempt_count, next_attempt_at FROM bank_webhook_events WHERE id = ?', (event.id,)).fetchone()
    assert row['attempt_count'] == 2
    assert datetime.fromisoformat(row['next_attempt_at']) == webhook_clock[0] + timedelta(seconds=120)


def test_same_item_events_do_not_sync_concurrently(store, webhook_clock):
    first, second = webhook(store), webhook(store)
    first_token = store.claim_plaid_webhook_event(first.id)
    assert first_token
    assert store.claim_plaid_webhook_event(second.id) is None
    assert store.mark_plaid_webhook_processed(first.id, 'item-1', claim_token=first_token)
    assert store.claim_plaid_webhook_event(second.id)


def test_concurrent_webhook_claims_have_one_winner(store, webhook_clock):
    event = webhook(store)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(store.claim_plaid_webhook_event, [event.id, event.id]))
    assert sum(token is not None for token in results) == 1


def test_successful_sync_keeps_webhook_pending_until_claim_is_acknowledged(store, webhook_clock):
    event = webhook(store)
    token = store.claim_plaid_webhook_event(event.id)
    item = store.list_items('brian')[0]
    store.mark_sync_success(item.id, 'cursor-after-sync')
    with store.connect() as conn:
        assert conn.execute('SELECT webhook_pending FROM bank_sync_state WHERE item_id = ?', (item.id,)).fetchone()['webhook_pending'] == 1
    assert store.mark_plaid_webhook_processed(event.id, item.item_id, claim_token=token)
    with store.connect() as conn:
        assert conn.execute('SELECT webhook_pending FROM bank_sync_state WHERE item_id = ?', (item.id,)).fetchone()['webhook_pending'] == 0


@pytest.mark.asyncio
async def test_cancelled_webhook_worker_recovers_after_lease_without_stale_ack(store, webhook_clock, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from bookiebot.banking.service import BankingService

    event = webhook(store)
    service = BankingService(SimpleNamespace(), store, SimpleNamespace())
    monkeypatch.setattr(service, 'sync_item', AsyncMock(side_effect=asyncio.CancelledError()))
    with pytest.raises(asyncio.CancelledError):
        await service.process_plaid_webhook_inbox()
    assert store.pending_plaid_webhook_events() == []
    webhook_clock[0] += timedelta(seconds=301)
    sync = AsyncMock()
    monkeypatch.setattr(service, 'sync_item', sync)
    assert await service.process_plaid_webhook_inbox() == {'processed': 1, 'failed': 0, 'skipped': 0}
    sync.assert_awaited_once()
    with store.connect() as conn:
        assert conn.execute('SELECT status FROM bank_webhook_events WHERE id = ?', (event.id,)).fetchone()['status'] == 'processed'
