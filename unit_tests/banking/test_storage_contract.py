"""The same persistent banking contract against SQLite and a real Postgres schema.

Postgres is opt-in locally via BOOKIEBOT_TEST_POSTGRES_URL. Each case owns one
random schema; no banking application URL or pre-existing schema is reused.
"""
import json
import os
import uuid

import pytest

from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount
from bookiebot.banking.postgres_store import PostgresBankStore
from bookiebot.banking.store import BankStore


@pytest.fixture(params=["sqlite", "postgres"])
def contract_store(request, tmp_path):
    cipher = TokenCipher("contract-tests-only")
    if request.param == "sqlite":
        store = BankStore(tmp_path / "banking-contract.sqlite3", cipher)
        store.initialize()
        yield store
        return
    database_url = os.getenv("BOOKIEBOT_TEST_POSTGRES_URL", "").strip()
    if not database_url:
        pytest.skip("Set BOOKIEBOT_TEST_POSTGRES_URL to run the real Postgres contract")
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    schema = "bookiebot_contract_" + uuid.uuid4().hex
    with psycopg.connect(database_url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            isolated_url = make_conninfo(database_url, options=f"-csearch_path={schema}", connect_timeout=5)
            store = PostgresBankStore(isolated_url, cipher)
            store.initialize()
            with store.connect() as connection:
                assert connection.execute("SELECT current_schema() AS name").fetchone()["name"] == schema
            yield store
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def _seed(store, owner="brian", suffix="1", amount=12.50):
    item = store.upsert_item(owner_key=owner, provider="plaid", item_id=f"item-{owner}-{suffix}", access_token=f"token-{owner}-{suffix}", institution_name="Contract Bank")
    store.upsert_accounts([BankAccount(
        item_id=item.id, provider_account_id=f"account-{owner}-{suffix}", owner_key=owner,
        name="Checking", mask="1234", type="depository", subtype="checking",
        official_name="Checking", current_balance=100, available_balance=100,
    )])
    transaction = dict(transaction_id=f"txn-{owner}-{suffix}", account_id=f"account-{owner}-{suffix}",
                       date="2026-09-06", authorized_date="2026-09-05", name="Contract purchase",
                       merchant_name="Contract store", amount=amount, pending=False, payment_channel="online")
    store.upsert_transactions([transaction], owner_key=owner)
    stored = next(tx for tx in store.recent_transactions(owner, limit=100) if tx.provider_transaction_id == transaction["transaction_id"])
    review = store.upsert_reconciliation_item(owner_key=owner, transaction=stored, classification="expense", status="needs_review", confidence=0.5)
    return item, transaction, review


def _claim(store, review, *, owner="brian", operation_id=None):
    return store.claim_reconciliation_import(owner, review.id, operation_id=operation_id or uuid.uuid4().hex,
        actor_key="discord-actor", kind="expense", request={"bank_amount": review.transaction.amount, "bank_date": review.transaction.date})


def test_storage_roundtrip_encryption_upsert_and_owner_isolation(contract_store):
    store = contract_store
    item, transaction, review = _seed(store)
    _seed(store, "hannah")
    assert store.get_access_token(item.id) == "token-brian-1"
    with store.connect() as connection:
        encrypted = connection.execute("SELECT encrypted_access_token FROM bank_items WHERE id = ?", (item.id,)).fetchone()["encrypted_access_token"]
    assert "token-brian-1" not in encrypted
    store.upsert_transactions([transaction], owner_key="brian")
    assert store.transaction_count("brian") == 1
    assert store.transaction_count("hannah") == 1
    assert [account.owner_key for account in store.list_accounts("brian")] == ["brian"]
    assert store.get_reconciliation_item("hannah", review.id) is None
    assert store.confirm_reconciliation_item("hannah", review.id, matched_action_log_id="wrong-owner") is None
    assert store.ignore_reconciliation_item("hannah", review.id) is None
    assert store.disconnect_item("hannah", item.id) is None
    assert store.get_reconciliation_item("brian", review.id).status == "needs_review"


def test_storage_connection_rolls_back_and_remains_usable(contract_store):
    store = contract_store
    item, _, _ = _seed(store)
    store.mark_sync_success(item.id, "cursor-before")
    with pytest.raises(RuntimeError, match="simulated interruption"):
        with store.connect() as connection:
            connection.execute("UPDATE bank_sync_state SET transactions_cursor = ? WHERE item_id = ?", ("uncommitted", item.id))
            raise RuntimeError("simulated interruption")
    assert store.get_cursor(item.id) == "cursor-before"
    store.mark_sync_success(item.id, "cursor-after")
    assert store.get_cursor(item.id) == "cursor-after"


def test_storage_reconciliation_confirm_reopen_ignore_and_removed_lifecycle(contract_store):
    store = contract_store
    _, transaction, review = _seed(store)
    confirmed = store.confirm_reconciliation_item("brian", review.id, matched_action_log_id="action-1", matched_sheet_ref="September!A3:F3")
    assert confirmed.status == "confirmed"
    assert confirmed.matched_action_log_id == "action-1"
    assert confirmed.resolved_at
    reopened = store.reopen_reconciliation_item("brian", review.id)
    assert reopened.status == "needs_review"
    assert reopened.matched_action_log_id is None
    assert reopened.resolved_at is None
    ignored = store.ignore_reconciliation_item("brian", review.id)
    assert ignored.status == "ignored"
    store.mark_transactions_removed([transaction["transaction_id"]])
    assert store.recent_transactions("brian") == []
    assert store.reopen_reconciliation_item("brian", review.id) is None


def test_storage_import_claim_is_owner_scoped_and_retry_cannot_duplicate(contract_store):
    store = contract_store
    _, _, review = _seed(store)
    denied, claimed = _claim(store, review, owner="hannah")
    assert denied is None and not claimed
    operation, claimed = _claim(store, review)
    assert operation is not None and claimed
    assert json.loads(operation.request_json)["bank_amount"] == 12.50
    assert store.get_reconciliation_item("brian", review.id).status == "import_requested"
    retry, claimed = _claim(store, review)
    assert not claimed and retry.operation_id == operation.operation_id
    assert store.get_import_operation("hannah", review.id) is None
    assert not store.mark_import_writing("hannah", operation.operation_id)
    assert store.mark_import_writing("brian", operation.operation_id)
    assert not store.mark_import_writing("brian", operation.operation_id)
    store.mark_import_needs_recovery("brian", operation.operation_id, "Interrupted after sheet write")
    completed = store.complete_reconciliation_import(operation, action_id="action-import-1", sheet_ref="September!A3:F3")
    assert completed.status == "completed"
    linked = store.get_reconciliation_item("brian", review.id)
    assert linked.status == "confirmed" and linked.matched_action_log_id == "action-import-1"
    assert store.complete_reconciliation_import(operation, action_id="action-import-2", sheet_ref="September!A4:F4").matched_action_log_id == "action-import-1"


def test_storage_import_insert_failure_rolls_back_the_claim(contract_store):
    store = contract_store
    _, _, first = _seed(store)
    _, _, second = _seed(store, suffix="2")
    operation, claimed = _claim(store, first, operation_id="deliberate-operation-collision")
    assert claimed and operation is not None
    with pytest.raises(Exception) as failure:
        _claim(store, second, operation_id=operation.operation_id)
    assert type(failure.value).__name__ in {"IntegrityError", "UniqueViolation"}
    assert store.get_reconciliation_item("brian", second.id).status == "needs_review"
    assert store.get_import_operation("brian", second.id) is None
    _, claimed = _claim(store, second)
    assert claimed


def test_storage_simultaneous_import_requests_share_one_durable_claim(contract_store):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    store = contract_store
    _, _, review = _seed(store)
    ready = Barrier(2)
    def claim():
        ready.wait(timeout=5)
        return _claim(store, review)
    with ThreadPoolExecutor(max_workers=2) as workers:
        attempts = [workers.submit(claim) for _ in range(2)]
        results = [attempt.result(timeout=10) for attempt in attempts]
    assert sum(claimed for _operation, claimed in results) == 1
    assert len({operation.operation_id for operation, _claimed in results}) == 1


def test_storage_modified_match_reopens_once_and_retains_auditable_lineage(contract_store):
    store = contract_store
    _, transaction, review = _seed(store)
    store.confirm_reconciliation_item("brian", review.id, matched_action_log_id="original-action", matched_sheet_ref="September!A3:F3")
    renamed = {**transaction, "merchant_name": "Updated display name"}
    store.upsert_transactions([renamed], owner_key="brian")
    assert store.get_reconciliation_item("brian", review.id).status == "confirmed"
    assert store.reconciliation_events("brian", review.id) == []
    changed = {**renamed, "amount": -15.75, "date": "2026-09-07", "pending": True}
    store.upsert_transactions([changed], owner_key="brian")
    reopened = store.get_reconciliation_item("brian", review.id)
    assert reopened.status == "needs_review"
    assert reopened.matched_action_log_id is None and reopened.resolved_at is None
    assert reopened.transaction.amount == -15.75
    events = store.reconciliation_events("brian", review.id)
    assert len(events) == 1
    assert events[0]["event_type"] == "bank_transaction_modified"
    assert set(events[0]["payload"]["changed_fields"]) == {"amount", "date", "pending"}
    assert events[0]["payload"]["before"]["amount"] == 12.50
    assert events[0]["payload"]["after"]["amount"] == -15.75
    assert events[0]["payload"]["previous_match"]["matched_action_log_id"] == "original-action"
    assert store.reconciliation_events("hannah", review.id) == []
    store.upsert_transactions([changed], owner_key="brian")
    assert len(store.reconciliation_events("brian", review.id)) == 1
    _, ignored_transaction, ignored = _seed(store, suffix="ignored")
    store.ignore_reconciliation_item("brian", ignored.id)
    store.upsert_transactions([{**ignored_transaction, "amount": 20}], owner_key="brian")
    assert store.get_reconciliation_item("brian", ignored.id).status == "ignored"
    assert store.reconciliation_events("brian", ignored.id) == []


def test_storage_webhook_leases_recover_and_reject_stale_workers(contract_store):
    store = contract_store
    item, _, _ = _seed(store)
    payload = {"webhook_type": "TRANSACTIONS", "webhook_code": "SYNC_UPDATES_AVAILABLE", "item_id": item.item_id}
    first = store.enqueue_plaid_webhook(payload)
    second = store.enqueue_plaid_webhook(payload)
    stale_token = store.claim_plaid_webhook_event(first.id)
    assert stale_token
    assert store.claim_plaid_webhook_event(second.id) is None
    with store.connect() as connection:
        connection.execute("UPDATE bank_webhook_events SET lease_expires_at = ? WHERE id = ?", ("2000-01-01T00:00:00+00:00", first.id))
    assert first.id in [event.id for event, _payload in store.pending_plaid_webhook_events()]
    current_token = store.claim_plaid_webhook_event(first.id)
    assert current_token and current_token != stale_token
    assert not store.mark_plaid_webhook_processed(first.id, item.item_id, claim_token=stale_token)
    assert not store.mark_plaid_webhook_failed(first.id, "obsolete failure", claim_token=stale_token)
    assert store.mark_plaid_webhook_processed(first.id, item.item_id, claim_token=current_token)
    second_token = store.claim_plaid_webhook_event(second.id)
    assert second_token
    assert store.mark_plaid_webhook_failed(second.id, "temporary failure", claim_token=second_token)
    assert second.id not in [event.id for event, _payload in store.pending_plaid_webhook_events()]
    with store.connect() as connection:
        connection.execute("UPDATE bank_webhook_events SET next_attempt_at = ? WHERE id = ?", ("2000-01-01T00:00:00+00:00", second.id))
    retry_token = store.claim_plaid_webhook_event(second.id)
    assert retry_token and retry_token != second_token
    assert store.mark_plaid_webhook_processed(second.id, item.item_id, claim_token=retry_token)
    assert store.pending_plaid_webhook_events() == []


def _phone_review(store, review, action='confirm', **overrides):
    options = dict(
        action=action, expected_status=review.status,
        expected_updated_at=review.transaction.updated_at,
        expected_last_seen_at=review.last_seen_at,
    )
    if action == 'confirm':
        options.update(matched_action_log_id='phone-action', matched_sheet_ref='September!A3:F3')
    options.update(overrides)
    return store.apply_reconciliation_review('brian', review.id, **options)


def test_phone_review_lists_only_recent_watched_connected_owner_data(contract_store):
    store = contract_store
    item, raw, review = _seed(store)
    _seed(store, 'hannah')
    _, old, _ = _seed(store, suffix='old')
    store.upsert_transactions([{**old, 'date': '2025-01-01'}], 'brian')
    hidden_item, _, _ = _seed(store, suffix='hidden')
    hidden = next(account for account in store.list_accounts('brian') if account.item_id == hidden_item.id)
    store.set_account_watched('brian', hidden.id, False)
    disconnected, _, _ = _seed(store, suffix='disconnected')
    store.disconnect_item('brian', disconnected.id)
    assert [entry.id for entry in store.review_transactions('brian', start_date='2026-09-01')] == [review.transaction.id]
    assert [entry.id for entry in store.review_reconciliation_items('brian', start_date='2026-09-01')] == [review.id]
    assert store.review_transactions('unknown', start_date='2026-09-01') == []

    pending = {**raw, 'transaction_id': 'authorization', 'pending': True}
    store.upsert_transactions([pending], 'brian')
    before = store.review_transactions('brian', start_date='2026-09-01')
    assert len(before) == 2 and before[0].pending
    posted = {**pending, 'transaction_id': 'posted-replacement', 'pending_transaction_id': 'authorization', 'pending': False}
    store.upsert_transactions([posted], 'brian')
    # The removal can arrive later; never show both authorization and posting.
    after = store.review_transactions('brian', start_date='2026-09-01')
    assert len(after) == 2 and all(not entry.pending for entry in after)
    store.mark_transactions_removed(['authorization'])
    assert [entry.id for entry in store.review_transactions('brian', start_date='2026-09-01')] == [entry.id for entry in after]
    store.disconnect_item('brian', item.id)
    assert store.review_transactions('brian', start_date='2026-09-01') == []


def test_phone_review_confirm_ignore_reopen_is_versioned_audited_and_repeat_safe(contract_store):
    store = contract_store
    _, _, review = _seed(store)
    confirmed = _phone_review(store, review)
    assert confirmed.status == 'confirmed' and confirmed.matched_action_log_id == 'phone-action'
    assert _phone_review(store, review) is None
    assert _phone_review(store, confirmed, 'ignore') is None
    reopened = _phone_review(store, confirmed, 'reopen')
    assert reopened.status == 'needs_review' and reopened.matched_sheet_ref is None
    ignored = _phone_review(store, reopened, 'ignore')
    assert ignored.status == 'ignored'
    assert _phone_review(store, reopened) is None
    again = _phone_review(store, ignored, 'reopen')
    assert again.status == 'needs_review' and again.ignored_at is None
    events = store.reconciliation_events('brian', review.id)
    assert [event['event_type'] for event in events] == [
        'phone_review_reopen', 'phone_review_ignore', 'phone_review_reopen', 'phone_review_confirm',
    ]
    assert events[2]['payload']['previous_action_log_id'] == 'phone-action'
    assert store.reconciliation_events('hannah', review.id) == []


@pytest.mark.parametrize('change', ['bank', 'review', 'pending', 'removed', 'unwatched', 'disconnected', 'import', 'owner'])
def test_phone_review_rejects_changed_or_ineligible_transactions(contract_store, change):
    store = contract_store
    item, raw, review = _seed(store)
    if change == 'bank':
        store.upsert_transactions([{**raw, 'amount': 15}], 'brian')
    elif change == 'review':
        store.upsert_reconciliation_item(owner_key='brian', transaction=review.transaction,
            classification='expense', status='needs_review', confidence=0.4)
    elif change == 'pending':
        store.upsert_transactions([{**raw, 'pending': True}], 'brian')
    elif change == 'removed':
        store.mark_transactions_removed([raw['transaction_id']])
    elif change == 'unwatched':
        store.set_account_watched('brian', store.list_accounts('brian')[0].id, False)
    elif change == 'disconnected':
        store.disconnect_item('brian', item.id)
    elif change == 'import':
        _claim(store, review)
    elif change == 'owner':
        assert store.apply_reconciliation_review('hannah', review.id, action='ignore',
            expected_status=review.status, expected_updated_at=review.transaction.updated_at,
            expected_last_seen_at=review.last_seen_at) is None
        assert store.get_reconciliation_item('brian', review.id).status == 'needs_review'
        return
    for action in ('confirm', 'ignore', 'reopen'):
        assert _phone_review(store, review, action) is None


def test_phone_review_prevents_two_transactions_claiming_the_same_entry(contract_store):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    store = contract_store
    _, _, first = _seed(store)
    _, _, second = _seed(store, suffix='second')
    ready = Barrier(2)
    def confirm(review):
        ready.wait(timeout=5)
        return _phone_review(store, review)
    with ThreadPoolExecutor(max_workers=2) as workers:
        attempts = [workers.submit(confirm, review) for review in (first, second)]
        results = [attempt.result(timeout=10) for attempt in attempts]
    assert sum(result is not None for result in results) == 1
    assert len(store.matched_action_log_ids('brian')) == 1
    loser = next(review for review, result in zip((first, second), results) if result is None)
    assert store.confirm_reconciliation_item('brian', loser.id, matched_action_log_id='phone-action') is None
    assert store.confirm_reconciliation_item('brian', loser.id, matched_sheet_ref='September!A3:F3') is None


@pytest.mark.parametrize('hidden', ['unwatched', 'disconnected'])
def test_hiding_an_account_does_not_release_its_confirmed_ledger_claim(contract_store, hidden):
    store = contract_store
    first_item, _, first = _seed(store)
    _, _, second = _seed(store, suffix='second')
    assert _phone_review(store, first) is not None
    if hidden == 'unwatched':
        account = next(account for account in store.list_accounts('brian') if account.item_id == first_item.id)
        store.set_account_watched('brian', account.id, False)
    else:
        store.disconnect_item('brian', first_item.id)
    assert store.matched_action_log_ids('brian') == {'phone-action'}
    assert store.matched_sheet_refs('brian') == {'September!A3:F3'}
    assert _phone_review(store, second) is None
    assert store.review_reconciliation_items('brian', start_date='2026-09-01') == [second]


@pytest.mark.parametrize('hidden', ['unwatched', 'disconnected'])
def test_hidden_account_cannot_receive_new_matches_from_a_stale_preview(contract_store, hidden):
    store = contract_store
    item, _, review = _seed(store)
    if hidden == 'unwatched':
        store.set_account_watched('brian', store.list_accounts('brian')[0].id, False)
    else:
        store.disconnect_item('brian', item.id)
    for force in (False, True):
        assert store.bank_transactions_for_reconciliation('brian', force=force, start_date='2026-09-01') == []
    rejected = store.upsert_reconciliation_item(owner_key='brian', transaction=review.transaction,
        classification='expense', status='matched', confidence=0.99, matched_action_log_id='do-not-claim')
    assert rejected.status == 'needs_review' and rejected.matched_action_log_id is None
    assert store.confirm_reconciliation_item('brian', review.id, matched_action_log_id='do-not-claim') is None
    assert store.matched_action_log_ids('brian') == set()


@pytest.mark.parametrize('status', ['confirmed', 'ignored', 'import_requested'])
def test_preview_does_not_overwrite_resolved_or_inflight_lineage(contract_store, status):
    store = contract_store
    _, _, review = _seed(store)
    if status == 'confirmed':
        store.confirm_reconciliation_item('brian', review.id, matched_action_log_id='kept-action',
            matched_sheet_ref='kept-ref', notes='reviewed choice')
    elif status == 'ignored':
        store.ignore_reconciliation_item('brian', review.id)
    else:
        _claim(store, review)
    before = store.get_reconciliation_item('brian', review.id)
    after = store.upsert_reconciliation_item(owner_key='brian', transaction=review.transaction,
        classification='subscription_or_bill', status='matched', confidence=0.99,
        matched_action_log_id='wrong-action', matched_sheet_ref='wrong-ref', notes='stale preview')
    assert after == before


def test_removed_matches_release_candidate_and_stale_preview_cannot_claim_it(contract_store):
    store = contract_store
    _, first_raw, first = _seed(store)
    _, second_raw, second = _seed(store, suffix='second')
    store.confirm_reconciliation_item('brian', first.id, matched_action_log_id='a+b', matched_sheet_ref='first + second')
    denied = store.upsert_reconciliation_item(owner_key='brian', transaction=second.transaction,
        classification='expense', status='matched', confidence=0.99, matched_action_log_id='b')
    assert denied.status == 'needs_review' and denied.matched_action_log_id is None
    store.mark_transactions_removed([first_raw['transaction_id']])
    assert store.matched_action_log_ids('brian') == set() and store.matched_sheet_refs('brian') == set()
    accepted = store.upsert_reconciliation_item(owner_key='brian', transaction=second.transaction,
        classification='expense', status='matched', confidence=0.99, matched_action_log_id='b')
    assert accepted.status == 'matched'
    store.upsert_transactions([{**second_raw, 'amount': 99}], 'brian')
    stale = store.upsert_reconciliation_item(owner_key='brian', transaction=second.transaction,
        classification='expense', status='matched', confidence=0.99, matched_action_log_id='b')
    assert stale.status == 'needs_review' and stale.matched_action_log_id is None


def test_phone_review_sync_freshness_is_complete_and_owner_scoped(contract_store):
    store = contract_store
    first, _, _ = _seed(store)
    second, _, _ = _seed(store, suffix='second')
    other, _, _ = _seed(store, 'hannah')
    store.mark_sync_success(first.id, 'first')
    assert store.review_sync_status('brian') == {'checkedAt': None, 'syncFailed': False}
    store.mark_sync_success(second.id, 'second')
    with store.connect() as conn:
        conn.execute('UPDATE bank_sync_state SET last_success_at = ? WHERE item_id = ?', ('2026-09-05T12:00:00Z', first.id))
        conn.execute('UPDATE bank_sync_state SET last_success_at = ? WHERE item_id = ?', ('2026-09-06T12:00:00Z', second.id))
    store.mark_sync_error(other.id, 'PRIVATE OTHER OWNER ERROR')
    assert store.review_sync_status('brian') == {'checkedAt': '2026-09-05T12:00:00Z', 'syncFailed': False}
    store.mark_sync_error(second.id, 'PRIVATE BANK ERROR')
    assert store.review_sync_status('brian') == {'checkedAt': '2026-09-05T12:00:00Z', 'syncFailed': True}
    store.disconnect_item('brian', second.id)
    assert store.review_sync_status('brian') == {'checkedAt': '2026-09-05T12:00:00Z', 'syncFailed': False}
    assert store.review_sync_status('unknown') == {'checkedAt': None, 'syncFailed': False}


def test_occurrence_scoped_matches_respect_legacy_month_without_blocking_future_pulls(contract_store):
    store = contract_store
    _, first_raw, first = _seed(store)
    _, second_raw, second = _seed(store, suffix='second')
    base_ref = 'Subscriptions!row 4'
    store.confirm_reconciliation_item('brian', first.id, matched_sheet_ref=base_ref)
    assert _phone_review(store, second, matched_action_log_id=None,
        matched_sheet_ref=f'{base_ref}#pull=2026-09-06') is None
    store.upsert_transactions([{**first_raw, 'date': '2026-08-06', 'authorized_date': '2026-08-05'}], 'brian')
    store.confirm_reconciliation_item('brian', first.id, matched_sheet_ref=base_ref)
    accepted = _phone_review(store, second, matched_action_log_id=None,
        matched_sheet_ref=f'{base_ref}#pull=2026-09-06')
    assert accepted is not None and accepted.status == 'confirmed'
    _, third_raw, third = _seed(store, suffix='third')
    assert _phone_review(store, third, matched_action_log_id=None,
        matched_sheet_ref=f'{base_ref}#pull=2026-09-06') is None
    assert store.get_reconciliation_item_for_transaction('hannah', third.transaction.id) is None
    assert store.get_reconciliation_item_for_transaction('brian', third.transaction.id).id == third.id


@pytest.mark.parametrize('first_ref,first_date,second_ref,second_date,conflicts', [
    ('expense!row 12', '2026-08-05', 'expense!row 12', '2026-09-05', False),
    ('expense!row 12', '2026-09-05', 'expense!row 12', '2026-09-06', True),
    ('income!row 12#month=2026-08', '2026-09-01', 'income!row 12#month=2026-09', '2026-09-05', False),
    ('income!row 12#month=2026-08', '2026-08-31', 'income!row 12#month=2026-08', '2026-09-01', True),
    ('income!row 12', '2026-08-31', 'income!row 12#month=2026-08', '2026-09-01', True),
    ('income!row 12', '2026-08-31', 'income!row 12#month=2026-09', '2026-09-05', False),
    ('income!row 12#month=2026-08', '2026-09-01', 'income!row 12', '2026-08-31', True),
    ('income!row 12#month=2026-09', '2026-09-05', 'income!row 12', '2026-08-31', False),
])
def test_monthly_physical_rows_are_reserved_for_their_expense_period(
    contract_store, first_ref, first_date, second_ref, second_date, conflicts,
):
    store = contract_store
    _, first_raw, first = _seed(store)
    _, second_raw, second = _seed(store, suffix='second')
    store.upsert_transactions([{**first_raw, 'date': first_date, 'authorized_date': first_date},
                               {**second_raw, 'date': second_date, 'authorized_date': second_date}], 'brian')
    first = store.get_reconciliation_item('brian', first.id)
    second = store.get_reconciliation_item('brian', second.id)
    assert _phone_review(store, first, matched_action_log_id='first-action', matched_sheet_ref=first_ref)
    result = _phone_review(store, second, matched_action_log_id='second-action', matched_sheet_ref=second_ref)
    assert (result is None) == conflicts


@pytest.mark.parametrize('group_first', [False, True])
def test_grouped_action_and_schedule_aliases_share_one_claim_in_either_order(contract_store, group_first):
    store = contract_store
    _, _, first = _seed(store)
    _, _, second = _seed(store, suffix='second')
    schedule = 'Bills!A3:J3#pull=2026-09'
    grouped = f'income!row 12#month=2026-09 + {schedule}'
    first_ref, second_ref = (grouped, schedule) if group_first else (schedule, grouped)
    assert _phone_review(store, first, matched_action_log_id=None, matched_sheet_ref=first_ref)
    assert _phone_review(store, second, matched_action_log_id='another-action', matched_sheet_ref=second_ref) is None
    # Adding an alias to the same transaction is not a second allocation.
    repointed = store.confirm_reconciliation_item('brian', first.id,
        matched_action_log_id='same-purchase-action', matched_sheet_ref=grouped)
    assert repointed is not None and repointed.matched_sheet_ref == grouped


def test_preview_rejects_foreign_transaction_owner(contract_store):
    store = contract_store
    _, _, review = _seed(store)
    with pytest.raises(ValueError, match='belong'):
        store.upsert_reconciliation_item(owner_key='hannah', transaction=review.transaction,
            classification='expense', status='matched', confidence=0.99)
    assert store.get_reconciliation_item('brian', review.id).status == 'needs_review'


def test_bank_sync_cannot_reassign_another_persons_transaction_or_account(contract_store):
    store = contract_store
    _, raw, review = _seed(store)
    with pytest.raises(ValueError, match='transaction.*belong'):
        store.upsert_transactions([raw], 'hannah')
    with pytest.raises(ValueError, match='account.*belong'):
        store.upsert_transactions([{**raw, 'transaction_id': 'foreign-account-row'}], 'hannah')
    assert store.transaction_count('hannah') == 0
    assert store.get_reconciliation_item('brian', review.id).transaction.owner_key == 'brian'


def test_phone_pending_authorizations_cannot_be_confirmed_even_with_fresh_version(contract_store):
    store = contract_store
    _, raw, review = _seed(store)
    store.upsert_transactions([{**raw, 'pending': True}], 'brian')
    fresh = store.get_reconciliation_item('brian', review.id)
    assert fresh.transaction.pending
    assert _phone_review(store, fresh) is None
    assert _phone_review(store, fresh, 'ignore') is None
    assert store.confirm_reconciliation_item('brian', fresh.id, matched_action_log_id='must-not-reserve') is None
    assert store.matched_action_log_ids('brian') == set()


def test_forced_review_rechecks_the_full_phone_batch_not_only_the_latest_25(contract_store):
    store = contract_store
    _, raw, _ = _seed(store)
    store.upsert_transactions([{**raw, 'transaction_id': f'batch-{index}'} for index in range(204)], 'brian')
    store.upsert_transactions([
        {**raw, 'transaction_id': 'old-authorization', 'pending': True},
        {**raw, 'transaction_id': 'posted-purchase', 'pending_transaction_id': 'old-authorization'},
    ], 'brian')
    visible = store.review_transactions('brian', start_date='2026-09-01', limit=200)
    checked = store.bank_transactions_for_reconciliation('brian', force=True, limit=200,
        start_date='2026-09-01')
    assert len(visible) == len(checked) == 200
    assert {entry.id for entry in visible} == {entry.id for entry in checked}
    assert len(store.bank_transactions_for_reconciliation('brian', force=True, limit=1000,
        start_date='2026-09-01')) == 200
    assert len(store.bank_transactions_for_reconciliation('brian', force=True, limit=10,
        start_date='2026-09-01')) == 10


def test_phone_decision_rolls_back_when_its_audit_event_cannot_be_saved(contract_store):
    store = contract_store
    _, _, review = _seed(store)
    original_connect = store.connect
    from contextlib import contextmanager
    class FailingEventConnection:
        def __init__(self, conn):
            self.conn = conn
        def execute(self, sql, params=()):
            if 'INSERT INTO bank_reconciliation_events' in sql:
                raise RuntimeError('simulated audit write failure')
            return self.conn.execute(sql, params)
        def executescript(self, sql):
            return self.conn.executescript(sql)
    @contextmanager
    def failing_connect():
        with original_connect() as conn:
            yield FailingEventConnection(conn)
    store.connect = failing_connect
    with pytest.raises(RuntimeError, match='audit write'):
        _phone_review(store, review)
    store.connect = original_connect
    assert store.get_reconciliation_item('brian', review.id) == review
    assert store.matched_action_log_ids('brian') == set()


def test_storage_simultaneous_webhooks_for_one_item_have_one_active_lease(contract_store):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    store = contract_store
    item, _, _ = _seed(store)
    payload = {"webhook_type": "TRANSACTIONS", "webhook_code": "SYNC_UPDATES_AVAILABLE", "item_id": item.item_id}
    events = [store.enqueue_plaid_webhook(payload) for _ in range(2)]
    ready = Barrier(2)
    def claim(event):
        ready.wait(timeout=5)
        return event, store.claim_plaid_webhook_event(event.id)
    with ThreadPoolExecutor(max_workers=2) as workers:
        attempts = [workers.submit(claim, event) for event in events]
        results = [attempt.result(timeout=10) for attempt in attempts]
    assert sum(token is not None for _event, token in results) == 1
    winner, token = next((event, token) for event, token in results if token)
    blocked, _ = next((event, token) for event, token in results if not token)
    assert store.mark_plaid_webhook_processed(winner.id, item.item_id, claim_token=token)
    assert store.claim_plaid_webhook_event(blocked.id)
