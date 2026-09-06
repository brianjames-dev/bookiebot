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
