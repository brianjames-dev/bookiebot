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

