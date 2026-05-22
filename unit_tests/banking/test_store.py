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


def test_store_persists_reconciliation_snooze_settings_per_actor(tmp_path):
    store = _store(tmp_path)

    store.set_reconciliation_default_snooze("111", "1h")
    store.set_reconciliation_snooze_until("111", "2026-05-18T15:30:00-07:00")
    store.set_reconciliation_default_snooze("222", "tomorrow")
    store.set_reconciliation_snooze_until("222", "2026-05-19T15:30:00-07:00")

    assert store.get_reconciliation_default_snooze("111") == "1h"
    assert store.get_reconciliation_snooze_until("111") == "2026-05-18T15:30:00-07:00"
    assert store.get_reconciliation_default_snooze("222") == "tomorrow"
    assert store.due_reconciliation_snoozes("2026-05-18T16:00:00-07:00") == [
        ("111", "2026-05-18T15:30:00-07:00")
    ]

    store.clear_reconciliation_snooze_until("111")

    assert store.get_reconciliation_snooze_until("111") is None
    assert store.get_reconciliation_default_snooze("111") == "1h"


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


def test_store_disconnects_item_without_deleting_history(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )

    disconnected = store.disconnect_item("brian", item.id)

    assert disconnected is not None
    assert disconnected.id == item.id
    assert disconnected.status == "disconnected"
    assert store.list_active_items("brian") == []
    all_items = store.list_items("brian")
    assert len(all_items) == 1
    assert all_items[0].status == "disconnected"
    assert store.get_access_token(item.id) == "access-sandbox-brian"


def test_store_disconnect_item_is_owner_scoped(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )

    assert store.disconnect_item("hannah", item.id) is None
    assert len(store.list_active_items("brian")) == 1


def test_store_purges_disconnected_item_cached_data(tmp_path):
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
                "transaction_id": "txn-brian",
                "account_id": "account-brian",
                "date": "2026-05-17",
                "name": "Coffee",
                "amount": 7.0,
                "pending": False,
            }
        ],
        owner_key="brian",
    )
    transaction = store.recent_transactions("brian", limit=1)[0]
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transaction,
        classification="expense",
        status="needs_review",
        confidence=0.6,
        notes="outflow transaction",
    )

    not_ready_result = store.purge_disconnected_item("brian", item.id)
    assert not_ready_result is not None
    assert not_ready_result["status"] == 0
    store.disconnect_item("brian", item.id)
    result = store.purge_disconnected_item("brian", item.id)

    assert result == {
        "item_id": item.id,
        "status": 1,
        "accounts": 1,
        "transactions": 1,
        "reconciliation_items": 1,
    }
    assert store.list_items("brian") == []
    assert store.transaction_count("brian") == 0
    assert store.unresolved_reconciliation_items("brian") == []


def test_store_purge_disconnected_item_is_owner_scoped(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )
    store.disconnect_item("brian", item.id)

    assert store.purge_disconnected_item("hannah", item.id) is None
    assert len(store.list_items("brian")) == 1


def test_store_purges_transactions_before_cutoff_without_touching_accounts(tmp_path):
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
                "transaction_id": "txn-april",
                "account_id": "account-brian",
                "date": "2026-04-30",
                "name": "Old Coffee",
                "amount": 4.33,
                "pending": False,
            },
            {
                "transaction_id": "txn-may",
                "account_id": "account-brian",
                "date": "2026-05-01",
                "name": "Current Coffee",
                "amount": 5.55,
                "pending": False,
            },
        ],
        owner_key="brian",
    )
    by_name = {transaction.name: transaction for transaction in store.recent_transactions("brian", limit=2)}
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=by_name["Old Coffee"],
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )
    current_item = store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=by_name["Current Coffee"],
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )

    result = store.purge_transactions_before("brian", "2026-05-01")

    assert result == {
        "cutoff_date": "2026-05-01",
        "transactions": 1,
        "reconciliation_items": 1,
    }
    assert [transaction.name for transaction in store.recent_transactions("brian", limit=10)] == ["Current Coffee"]
    assert [item.id for item in store.unresolved_reconciliation_items("brian")] == [current_item.id]
    assert len(store.list_accounts("brian")) == 1


def test_store_purge_transactions_before_is_owner_scoped(tmp_path):
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
                current_balance=500.0,
                available_balance=450.0,
            ),
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-brian-april",
                "account_id": "account-brian",
                "date": "2026-04-30",
                "name": "Brian Old Coffee",
                "amount": 4.33,
                "pending": False,
            },
        ],
        owner_key="brian",
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-hannah-april",
                "account_id": "account-hannah",
                "date": "2026-04-30",
                "name": "Hannah Old Coffee",
                "amount": 5.55,
                "pending": False,
            },
        ],
        owner_key="hannah",
    )

    result = store.purge_transactions_before("brian", "2026-05-01")

    assert result["transactions"] == 1
    assert store.recent_transactions("brian", limit=10) == []
    assert [transaction.name for transaction in store.recent_transactions("hannah", limit=10)] == ["Hannah Old Coffee"]


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


def test_account_watch_status_filters_recent_transactions(tmp_path):
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
                provider_account_id="account-watched",
                owner_key="brian",
                name="Primary Checking",
                mask="1111",
                type="depository",
                subtype="checking",
                official_name=None,
                current_balance=500.0,
                available_balance=450.0,
            ),
            BankAccount(
                item_id=item.id,
                provider_account_id="account-ignored",
                owner_key="brian",
                name="Savings",
                mask="2222",
                type="depository",
                subtype="savings",
                official_name=None,
                current_balance=300.0,
                available_balance=300.0,
            ),
        ]
    )
    accounts = {account.provider_account_id: account for account in store.list_accounts("brian")}
    assert accounts["account-ignored"].id is not None
    ignored = store.set_account_watched("brian", accounts["account-ignored"].id, False)
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-watched",
                "account_id": "account-watched",
                "date": "2026-05-17",
                "name": "Coffee",
                "amount": 7.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-ignored",
                "account_id": "account-ignored",
                "date": "2026-05-18",
                "name": "Savings Interest",
                "amount": -4.22,
                "pending": False,
            },
        ],
        owner_key="brian",
    )

    transactions = store.recent_transactions("brian", limit=10)

    assert ignored is not None
    assert ignored.watched is False
    assert [transaction.name for transaction in transactions] == ["Coffee"]
    assert store.transaction_count("brian") == 2


def test_upsert_accounts_preserves_existing_watch_status(tmp_path):
    store = _store(tmp_path)
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-brian",
        access_token="access-sandbox-brian",
        institution_name="Plaid Sandbox",
    )
    account = BankAccount(
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
    store.upsert_accounts([account])
    account_id = store.list_accounts("brian")[0].id
    assert account_id is not None
    store.set_account_watched("brian", account_id, False)

    store.upsert_accounts(
        [
            BankAccount(
                item_id=item.id,
                provider_account_id="account-brian",
                owner_key="brian",
                name="Renamed Checking",
                mask="1111",
                type="depository",
                subtype="checking",
                official_name=None,
                current_balance=600.0,
                available_balance=550.0,
            )
        ]
    )

    refreshed = store.list_accounts("brian")[0]
    assert refreshed.name == "Renamed Checking"
    assert refreshed.watched is False


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
            {
                "transaction_id": "txn-pending",
                "account_id": "account-brian",
                "date": "2026-05-18",
                "name": "Pending Coffee",
                "amount": 5.55,
                "pending": True,
            },
        ],
        owner_key="brian",
    )
    transactions = store.recent_transactions("brian", limit=3)
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
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=by_name["Pending Coffee"],
        classification="needs_review",
        status="needs_review",
        confidence=0.4,
    )

    unresolved = store.unresolved_reconciliation_items("brian")

    assert [item.id for item in unresolved] == [open_item.id]
    assert unresolved[0].transaction.name == "Unlogged Coffee"


def test_unreconciled_transactions_skip_pending_items(tmp_path):
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
                "transaction_id": "txn-posted",
                "account_id": "account-brian",
                "date": "2026-05-18",
                "name": "Posted Coffee",
                "amount": 4.33,
                "pending": False,
            },
            {
                "transaction_id": "txn-pending",
                "account_id": "account-brian",
                "date": "2026-05-18",
                "name": "Pending Coffee",
                "amount": 5.55,
                "pending": True,
            },
        ],
        owner_key="brian",
    )

    transactions = store.unreconciled_transactions("brian")

    assert [transaction.name for transaction in transactions] == ["Posted Coffee"]


def test_reconciliation_cache_buckets_counts_transaction_states(tmp_path):
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
                provider_account_id="account-watched",
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
                item_id=item.id,
                provider_account_id="account-unwatched",
                owner_key="brian",
                name="Savings",
                mask="2222",
                type="depository",
                subtype="savings",
                official_name=None,
                current_balance=300.0,
                available_balance=300.0,
            ),
        ]
    )
    accounts = {account.provider_account_id: account for account in store.list_accounts("brian")}
    assert accounts["account-unwatched"].id is not None
    store.set_account_watched("brian", accounts["account-unwatched"].id, False)
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-review",
                "account_id": "account-watched",
                "date": "2026-05-18",
                "name": "Review",
                "amount": 5.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-matched",
                "account_id": "account-watched",
                "date": "2026-05-18",
                "name": "Matched",
                "amount": 6.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-confirmed",
                "account_id": "account-watched",
                "date": "2026-05-18",
                "name": "Confirmed",
                "amount": 7.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-ignored",
                "account_id": "account-watched",
                "date": "2026-05-18",
                "name": "Ignored",
                "amount": 8.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-pending",
                "account_id": "account-watched",
                "date": "2026-05-18",
                "name": "Pending",
                "amount": 9.0,
                "pending": True,
            },
            {
                "transaction_id": "txn-new",
                "account_id": "account-watched",
                "date": "2026-05-18",
                "name": "New",
                "amount": 10.0,
                "pending": False,
            },
            {
                "transaction_id": "txn-unwatched",
                "account_id": "account-unwatched",
                "date": "2026-05-18",
                "name": "Unwatched",
                "amount": 11.0,
                "pending": False,
            },
        ],
        owner_key="brian",
    )
    transactions = {transaction.name: transaction for transaction in store.recent_transactions("brian", limit=10)}
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transactions["Review"],
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transactions["Matched"],
        classification="expense",
        status="matched",
        confidence=0.9,
    )
    confirmed = store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transactions["Confirmed"],
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )
    store.confirm_reconciliation_item("brian", confirmed.id, matched_action_log_id="abc123")
    ignored = store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transactions["Ignored"],
        classification="expense",
        status="needs_review",
        confidence=0.6,
    )
    store.ignore_reconciliation_item("brian", ignored.id)

    buckets = store.reconciliation_cache_buckets("brian")

    assert buckets.stored == 7
    assert buckets.needs_review == 1
    assert buckets.matched == 1
    assert buckets.confirmed == 1
    assert buckets.ignored == 1
    assert buckets.pending == 1
    assert buckets.not_reviewed == 1
    assert buckets.unwatched == 1
    assert buckets.other == 0


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


def test_confirm_reconciliation_item_hides_it_from_review(tmp_path):
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

    confirmed = store.confirm_reconciliation_item(
        "brian",
        open_item.id,
        matched_action_log_id="abc123",
        matched_sheet_ref="expense!row 5",
        notes="matched existing row",
    )

    assert confirmed is not None
    assert confirmed.status == "confirmed"
    assert confirmed.resolved_at
    assert confirmed.matched_action_log_id == "abc123"
    assert confirmed.matched_sheet_ref == "expense!row 5"
    assert store.matched_action_log_ids("brian") == {"abc123"}
    assert store.unresolved_reconciliation_items("brian") == []


def test_reopen_reconciliation_item_returns_confirmed_item_to_review(tmp_path):
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
    store.confirm_reconciliation_item(
        "brian",
        open_item.id,
        matched_action_log_id="abc123+def456",
        matched_sheet_ref="expense!row 5 + expense!row 6",
        notes="matched existing rows",
    )

    reopened = store.reopen_reconciliation_item("brian", open_item.id)

    assert reopened is not None
    assert reopened.status == "needs_review"
    assert reopened.resolved_at is None
    assert reopened.matched_action_log_id is None
    assert reopened.matched_sheet_ref is None
    assert store.matched_action_log_ids("brian") == set()
    assert [item.id for item in store.unresolved_reconciliation_items("brian")] == [open_item.id]


def test_matched_action_log_ids_splits_group_matches(tmp_path):
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
                "name": "Venmo",
                "amount": 173.59,
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

    store.confirm_reconciliation_item(
        "brian",
        open_item.id,
        matched_action_log_id="minted123+zazzle123",
        matched_sheet_ref="expense!row 12 + expense!row 13",
        notes="matched existing rows",
    )

    assert store.matched_action_log_ids("brian") == {"minted123", "zazzle123"}
