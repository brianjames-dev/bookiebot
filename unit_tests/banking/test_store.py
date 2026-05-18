from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount
from bookiebot.banking.store import BankStore


def _store(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
    return store


def test_store_encrypts_item_token_and_returns_decrypted_token(tmp_path):
    store = _store(tmp_path)

    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-1",
        access_token="access-sandbox-123",
        institution_name="Plaid Sandbox",
    )

    assert store.get_access_token(item.id) == "access-sandbox-123"

    with store.connect() as conn:
        row = conn.execute("SELECT encrypted_access_token FROM bank_items WHERE id = ?", (item.id,)).fetchone()
    assert row is not None
    assert "access-sandbox-123" not in row["encrypted_access_token"]


def test_store_tracks_accounts_transactions_and_removed_state(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-1",
        access_token="access-sandbox-123",
        institution_name="Plaid Sandbox",
    )

    store.upsert_accounts(
        [
            BankAccount(
                item_id=item.id,
                provider_account_id="account-1",
                owner_key="brian",
                name="Checking",
                mask="0000",
                type="depository",
                subtype="checking",
                official_name="Plaid Checking",
                current_balance=500.0,
                available_balance=450.0,
            )
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-1",
                "account_id": "account-1",
                "date": "2026-05-16",
                "authorized_date": "2026-05-15",
                "name": "Sonic",
                "merchant_name": "Sonic",
                "amount": -1639.90,
                "pending": False,
                "payment_channel": "other",
            }
        ],
        owner_key="brian",
    )

    status = store.status(configured=True, plaid_env="sandbox")
    assert status.item_count == 1
    assert status.account_count == 1
    assert status.transaction_count == 1

    assert store.mark_transactions_removed([{"transaction_id": "txn-1"}]) == 1
    status = store.status(configured=True, plaid_env="sandbox")
    assert status.transaction_count == 0


def test_store_persists_sync_cursor_and_error(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-1",
        access_token="access-sandbox-123",
        institution_name="Plaid Sandbox",
    )

    store.mark_sync_success(item.id, "cursor-1")
    assert store.get_cursor(item.id) == "cursor-1"

    store.mark_sync_error(item.id, "boom")
    status = store.status(configured=True, plaid_env="sandbox")
    assert status.last_error == "boom"


def test_store_resets_owner_sync_cursors(tmp_path):
    store = _store(tmp_path)
    brian_item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )
    hannah_item = store.upsert_item(
        owner_key="hannah",
        provider="plaid",
        item_id="item-hannah",
        access_token="access-sandbox-hannah",
        institution_name="Plaid Sandbox",
    )
    store.mark_sync_success(brian_item.id, "cursor-brian")
    store.mark_sync_success(hannah_item.id, "cursor-hannah")

    reset_count = store.reset_sync_cursors("brian")

    assert reset_count == 1
    assert store.get_cursor(brian_item.id) is None
    assert store.get_cursor(hannah_item.id) == "cursor-hannah"


def test_recent_transactions_are_owner_scoped_ordered_and_limited(tmp_path):
    store = _store(tmp_path)
    brian_item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )
    hannah_item = store.upsert_item(
        owner_key="hannah",
        provider="plaid",
        item_id="item-hannah",
        access_token="access-sandbox-hannah",
        institution_name="Plaid Sandbox",
    )
    store.upsert_accounts(
        [
            BankAccount(
                item_id=brian_item.id,
                provider_account_id="account-brian",
                owner_key="brian",
                name="Brian Checking",
                mask="1111",
                type="depository",
                subtype="checking",
                official_name=None,
                current_balance=500.0,
                available_balance=450.0,
            ),
            BankAccount(
                item_id=hannah_item.id,
                provider_account_id="account-hannah",
                owner_key="hannah",
                name="Hannah Checking",
                mask="2222",
                type="depository",
                subtype="checking",
                official_name=None,
                current_balance=300.0,
                available_balance=250.0,
            ),
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-old",
                "account_id": "account-brian",
                "date": "2026-05-15",
                "name": "Old Coffee",
                "amount": 5.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-new",
                "account_id": "account-brian",
                "date": "2026-05-17",
                "name": "New Coffee",
                "amount": 7.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-hannah",
                "account_id": "account-hannah",
                "date": "2026-05-18",
                "name": "Private",
                "amount": 9.0,
                "pending": False,
            },
        ],
        owner_key="brian",
    )

    # Correct the intentionally mixed owner insert to mimic Plaid rows arriving per owner.
    with store.connect() as conn:
        conn.execute("UPDATE bank_transactions SET owner_key = 'hannah' WHERE provider_transaction_id = 'txn-hannah'")

    transactions = store.recent_transactions("brian", limit=1)

    assert [transaction.name for transaction in transactions] == ["New Coffee"]
    assert transactions[0].account_name == "Brian Checking"
    assert transactions[0].account_mask == "1111"


def test_unresolved_reconciliation_items_only_returns_open_items(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )
    store.upsert_accounts(
        [
            BankAccount(
                item_id=item.id,
                provider_account_id="account-brian",
                owner_key="brian",
                name="Brian Checking",
                mask="1111",
                type="depository",
                subtype="checking",
                official_name=None,
                current_balance=500.0,
                available_balance=450.0,
            )
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-open",
                "account_id": "account-brian",
                "date": "2026-05-17",
                "name": "Unlogged Coffee",
                "amount": 12.34,
                "pending": False,
            },
            {
                "transaction_id": "txn-matched",
                "account_id": "account-brian",
                "date": "2026-05-17",
                "name": "Logged Coffee",
                "amount": 4.33,
                "pending": False,
            },
        ],
        owner_key="brian",
    )
    transactions = store.recent_transactions("brian", limit=2)
    by_name = {transaction.name: transaction for transaction in transactions}
    open_item = store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=by_name["Unlogged Coffee"],
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=by_name["Logged Coffee"],
        classification="expense",
        status="matched",
        confidence=0.96,
        matched_action_log_id="abc123",
    )

    unresolved = store.unresolved_reconciliation_items("brian")

    assert [item.id for item in unresolved] == [open_item.id]
    assert unresolved[0].transaction.name == "Unlogged Coffee"


def test_ignore_reconciliation_item_hides_it_from_review(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )
    store.upsert_accounts(
        [
            BankAccount(
                item_id=item.id,
                provider_account_id="account-brian",
                owner_key="brian",
                name="Brian Checking",
                mask="1111",
                type="depository",
                subtype="checking",
                official_name=None,
                current_balance=500.0,
                available_balance=450.0,
            )
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-open",
                "account_id": "account-brian",
                "date": "2026-05-17",
                "name": "Unlogged Coffee",
                "amount": 12.34,
                "pending": False,
            }
        ],
        owner_key="brian",
    )
    transaction = store.recent_transactions("brian", limit=1)[0]
    open_item = store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transaction,
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )

    ignored = store.ignore_reconciliation_item("brian", open_item.id)

    assert ignored is not None
    assert ignored.id == open_item.id
    assert ignored.status == "ignored"
    assert ignored.ignored_at
    assert store.unresolved_reconciliation_items("brian") == []


def test_ignore_reconciliation_item_is_owner_scoped(tmp_path):
    store = _store(tmp_path)

    assert store.ignore_reconciliation_item("brian", 999) is None
