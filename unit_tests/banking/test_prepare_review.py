"""Explicit first reviews share the same SQLite/Postgres owner locks."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier

import pytest

from bookiebot.banking.models import BankAccount
from unit_tests.banking.test_storage_contract import contract_store  # noqa: F401


def unprepared(store):
    linked = store.upsert_item(owner_key='brian', provider='plaid', item_id='prepare-bank', access_token='fixture-only', institution_name='Fixture Bank')
    store.upsert_accounts([BankAccount(linked.id, 'prepare-account', 'brian', 'Checking', '1234', 'depository', 'checking', None, 100, 100)])
    raw = dict(transaction_id='prepare-purchase', account_id='prepare-account', date=date.today().isoformat(),
               name='Restaurant', amount=40, pending=False)
    store.upsert_transactions([raw], 'brian')
    return linked, raw, store.recent_transactions('brian')[0]


def test_prepare_only_creates_review_metadata_and_never_rescores_existing_match(contract_store):
    store = contract_store
    _, _, tx = unprepared(store)
    created = store.prepare_reconciliation_review('brian', tx, start_date='2000-01-01')
    assert created.status == 'needs_review' and created.matched_action_log_id is None
    assert created.transaction == tx
    assert store.prepare_reconciliation_review('brian', tx, start_date='2000-01-01') is None
    confirmed = store.confirm_reconciliation_item('brian', created.id, matched_action_log_id='source-action')
    assert confirmed.status == 'confirmed'
    assert store.prepare_reconciliation_review('brian', tx, start_date='2000-01-01') is None
    assert store.get_reconciliation_item('brian', created.id) == confirmed
    with store.connect() as db:
        events = db.execute("SELECT * FROM bank_reconciliation_events WHERE event_type = 'phone_review_prepare'").fetchall()
    assert len(events) == 1


@pytest.mark.parametrize('problem', ['pending', 'removed', 'unwatched', 'disconnected', 'stale', 'old', 'wrong_owner'])
def test_prepare_rechecks_live_eligibility_before_inserting(contract_store, problem):
    store = contract_store
    linked, raw, tx = unprepared(store)
    if problem == 'pending':
        store.upsert_transactions([{**raw, 'pending': True}], 'brian')
    elif problem == 'removed':
        store.mark_transactions_removed(['prepare-purchase'])
    elif problem == 'stale':
        store.upsert_transactions([{**raw, 'amount': 41}], 'brian')
    elif problem == 'unwatched':
        with store.connect() as db:
            db.execute('UPDATE bank_accounts SET watched = 0 WHERE item_id = ?', (linked.id,))
    elif problem == 'disconnected':
        with store.connect() as db:
            db.execute("UPDATE bank_items SET status = 'removed' WHERE id = ?", (linked.id,))
    cutoff = (date.today() + timedelta(days=1)).isoformat() if problem == 'old' else '2000-01-01'
    assert store.prepare_reconciliation_review('hannah' if problem == 'wrong_owner' else 'brian', tx, start_date=cutoff) is None
    assert store.get_reconciliation_item_for_transaction('brian', tx.id) is None


def test_concurrent_preparation_creates_one_review_and_one_audit_event(contract_store):
    store = contract_store
    _, _, tx = unprepared(store)
    barrier = Barrier(2)
    def prepare(_):
        barrier.wait()
        return store.prepare_reconciliation_review('brian', tx, start_date='2000-01-01')
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(prepare, range(2)))
    assert sum(result is not None for result in results) == 1
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) AS total FROM bank_reconciliation_items').fetchone()['total'] == 1
        assert db.execute('SELECT COUNT(*) AS total FROM bank_reconciliation_events').fetchone()['total'] == 1
