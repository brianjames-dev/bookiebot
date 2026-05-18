from pathlib import Path

import pytest

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount, BankTransaction
from bookiebot.banking.plaid_client import PlaidClient
import bookiebot.banking.service as banking_service
from bookiebot.banking.reconciliation import action_log_bank_transaction, classify_transaction, reconcile_transaction
from bookiebot.banking.service import BankingService
from bookiebot.banking.store import BankStore
from bookiebot.sheets.undo import LoggedAction, UndoAction


def _transaction(name: str, amount: float, pending: bool = False) -> BankTransaction:
    return BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-17",
        authorized_date=None,
        name=name,
        merchant_name=None,
        amount=amount,
        pending=pending,
        payment_channel=None,
        updated_at="2026-05-17T00:00:00+00:00",
    )


def test_classify_credit_card_account_purchase_as_expense():
    txn = _transaction("Touchstone Climbing", 78.50)
    txn = BankTransaction(
        **{
            **txn.__dict__,
            "account_name": "Plaid Credit Card",
            "account_subtype": "credit card",
        }
    )

    classification, status, _confidence, notes = classify_transaction(txn)

    assert classification == "expense"
    assert status == "needs_review"
    assert notes == "outflow transaction"


def test_classify_transfer_payment_as_matched():
    classification, status, confidence, notes = classify_transaction(
        _transaction("CREDIT CARD 3333 PAYMENT", 25.0)
    )

    assert classification == "transfer_or_payment"
    assert status == "matched"
    assert confidence == 0.95
    assert notes == "transfer/payment pattern"


def test_classify_outflow_as_expense_needing_review():
    classification, status, _confidence, notes = classify_transaction(_transaction("Starbucks", 4.33))

    assert classification == "expense"
    assert status == "needs_review"
    assert notes == "outflow transaction"


def test_classify_payroll_inflow_as_income_needing_review():
    classification, status, _confidence, notes = classify_transaction(_transaction("Sonic Payroll", -1639.90))

    assert classification == "income"
    assert status == "needs_review"
    assert notes == "possible income deposit"


def test_classify_merchant_inflow_as_refund_credit():
    classification, status, _confidence, notes = classify_transaction(_transaction("United Airlines", -500.0))

    assert classification == "refund_or_credit"
    assert status == "needs_review"
    assert notes == "inflow without payroll pattern"


def test_classify_pending_as_needs_review():
    classification, status, _confidence, notes = classify_transaction(_transaction("Uber", 5.40, pending=True))

    assert classification == "needs_review"
    assert status == "needs_review"
    assert notes == "pending transaction"


def test_reconcile_matches_logged_expense_by_amount_and_date():
    action = LoggedAction(
        id="abc123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/17/2026", "coffee", "4.33", "Starbucks", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $4.33 for Brian (BofA)",
        ),
    )

    decision = reconcile_transaction(_transaction("Starbucks", 4.33), [action])

    assert decision.status == "matched"
    assert decision.classification == "expense"
    assert decision.matched_action_log_id == "abc123"
    assert decision.matched_sheet_ref == "expense!row 12"
    assert decision.notes == "matched expense action"


def test_reconcile_income_requires_name_overlap():
    action = LoggedAction(
        id="income123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="income",
            kind="delete_row",
            row=12,
            columns=[],
            previous_values=[],
            new_values=["", "Hannah Venmo", "100.0"],
            metadata={"type": "income", "source": "Hannah Venmo"},
            description="income $100.0 from Hannah Venmo",
        ),
    )

    decision = reconcile_transaction(_transaction("Sonic", -100.0), [action])

    assert decision.status == "needs_review"
    assert decision.classification == "income"
    assert decision.matched_action_log_id is None


def test_reconcile_income_matches_when_source_overlaps():
    action = LoggedAction(
        id="income123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="income",
            kind="delete_row",
            row=12,
            columns=[],
            previous_values=[],
            new_values=["", "Sonic paycheck", "100.0"],
            metadata={"type": "income", "source": "Sonic"},
            description="income $100.0 from Sonic",
        ),
    )

    decision = reconcile_transaction(_transaction("Sonic", -100.0), [action])

    assert decision.status == "matched"
    assert decision.classification == "income"
    assert decision.matched_action_log_id == "income123"


def test_action_log_bank_transaction_builds_debug_expense_row():
    action = LoggedAction(
        id="abc123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/17/2026", "coffee", "4.33", "Starbucks", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $4.33 for Brian (BofA)",
        ),
    )

    row = action_log_bank_transaction(action)

    assert row == {
        "transaction_id": "bookiebot-action-log-abc123",
        "account_id": "bookiebot-action-log",
        "date": "2026-05-17",
        "name": "coffee",
        "merchant_name": None,
        "amount": 4.33,
        "pending": False,
        "payment_channel": "bookiebot_debug",
    }


def test_reconcile_matches_utility_payment_as_bill():
    action = LoggedAction(
        id="pge123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="income",
            kind="restore_cells",
            row=8,
            columns=[3],
            previous_values=[""],
            new_values=["132.36"],
            metadata={"type": "payment", "category": "pg&e"},
            description="pg&e payment $132.36",
        ),
    )

    decision = reconcile_transaction(_transaction("PG&E WEB ONLINE", 132.36), [action])

    assert decision.status == "matched"
    assert decision.classification == "subscription_or_bill"
    assert decision.matched_action_log_id == "pge123"


def test_reconcile_does_not_match_wrong_amount():
    action = LoggedAction(
        id="abc123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[1, 2, 3, 4],
            previous_values=["", "", "", ""],
            new_values=["5/17/2026", "5.33", "Starbucks", "Brian (BofA)"],
            metadata={"type": "expense", "category": "grocery", "person": "Brian (BofA)"},
            description="grocery expense $5.33 for Brian (BofA)",
        ),
    )

    decision = reconcile_transaction(_transaction("Starbucks", 4.33), [action])

    assert decision.status == "needs_review"
    assert decision.matched_action_log_id is None


def test_reconciliation_preview_persists_items(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
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
                official_name=None,
                current_balance=500.0,
                available_balance=450.0,
            )
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-expense",
                "account_id": "account-1",
                "date": "2026-05-17",
                "name": "Starbucks",
                "amount": 4.33,
                "pending": False,
            },
            {
                "transaction_id": "txn-payment",
                "account_id": "account-1",
                "date": "2026-05-17",
                "name": "CREDIT CARD 3333 PAYMENT",
                "amount": 25.0,
                "pending": False,
            },
        ],
        owner_key="brian",
    )
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=PlaidClient(
            BankingConfig(
                plaid_client_id="client",
                plaid_secret="secret",
                plaid_env="sandbox",
                token_encryption_key="test-secret-key",
                sqlite_path=Path("unused.sqlite3"),
            )
        ),
    )

    preview = service.reconciliation_preview("brian")

    assert len(preview.items) == 2
    by_name = {item.transaction.name: item for item in preview.items}
    assert by_name["Starbucks"].classification == "expense"
    assert by_name["Starbucks"].status == "needs_review"
    assert by_name["CREDIT CARD 3333 PAYMENT"].classification == "transfer_or_payment"
    assert by_name["CREDIT CARD 3333 PAYMENT"].status == "matched"


def test_reconciliation_preview_force_rechecks_already_matched_items(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
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
                official_name=None,
                current_balance=500.0,
                available_balance=450.0,
            )
        ]
    )
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-payment",
                "account_id": "account-1",
                "date": "2026-05-17",
                "name": "CREDIT CARD 3333 PAYMENT",
                "amount": 25.0,
                "pending": False,
            }
        ],
        owner_key="brian",
    )
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=PlaidClient(
            BankingConfig(
                plaid_client_id="client",
                plaid_secret="secret",
                plaid_env="sandbox",
                token_encryption_key="test-secret-key",
                sqlite_path=Path("unused.sqlite3"),
            )
        ),
    )

    first_preview = service.reconciliation_preview("brian")
    second_preview = service.reconciliation_preview("brian")
    forced_preview = service.reconciliation_preview("brian", force=True)

    assert len(first_preview.items) == 1
    assert first_preview.items[0].status == "matched"
    assert second_preview.items == []
    assert len(forced_preview.items) == 1
    assert forced_preview.items[0].classification == "transfer_or_payment"


def test_reconciliation_preview_excludes_ignored_accounts(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
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
                provider_account_id="account-watched",
                owner_key="brian",
                name="Checking",
                mask="0000",
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
                mask="1111",
                type="depository",
                subtype="savings",
                official_name=None,
                current_balance=300.0,
                available_balance=300.0,
            ),
        ]
    )
    ignored_account = [
        account for account in store.list_accounts("brian")
        if account.provider_account_id == "account-ignored"
    ][0]
    store.set_account_watched("brian", ignored_account.id, False)
    store.upsert_transactions(
        [
            {
                "transaction_id": "txn-watched",
                "account_id": "account-watched",
                "date": "2026-05-17",
                "name": "Starbucks",
                "amount": 4.33,
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
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=PlaidClient(
            BankingConfig(
                plaid_client_id="client",
                plaid_secret="secret",
                plaid_env="sandbox",
                token_encryption_key="test-secret-key",
                sqlite_path=Path("unused.sqlite3"),
            )
        ),
    )

    preview = service.reconciliation_preview("brian", force=True)

    assert [item.transaction.name for item in preview.items] == ["Starbucks"]
    assert preview.cached_transaction_count == 2
    assert preview.candidate_transaction_count == 1


class _SandboxPlaidStub:
    def __init__(self):
        self.sync_cursors = []
        self.removed_tokens = []

    async def get_accounts(self, _access_token):
        return [
            {
                "account_id": "account-1",
                "name": "Plaid Checking",
                "mask": "0000",
                "type": "depository",
                "subtype": "checking",
                "balances": {"current": 500.0, "available": 450.0},
            }
        ]

    async def sync_transactions(self, _access_token, cursor=None):
        self.sync_cursors.append(cursor)
        if cursor:
            return {"added": [], "modified": [], "removed": [], "next_cursor": cursor, "has_more": False}
        return {
            "added": [
                {
                    "transaction_id": "txn-1",
                    "account_id": "account-1",
                    "date": "2026-05-17",
                    "name": "Starbucks",
                    "amount": 4.33,
                    "pending": False,
                }
            ],
            "modified": [],
            "removed": [],
            "next_cursor": "cursor-refreshed",
            "has_more": False,
        }

    async def remove_item(self, access_token):
        self.removed_tokens.append(access_token)
        return {"removed": True}


@pytest.mark.asyncio
async def test_remove_item_from_plaid_calls_provider_and_disconnects(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-1",
        access_token="access-sandbox-123",
        institution_name="Plaid Sandbox",
    )
    plaid = _SandboxPlaidStub()
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=plaid,
    )

    disconnected = await service.remove_item_from_plaid("brian", item.id)

    assert plaid.removed_tokens == ["access-sandbox-123"]
    assert disconnected is not None
    assert disconnected.status == "disconnected"
    assert store.list_active_items("brian") == []


@pytest.mark.asyncio
async def test_remove_item_from_plaid_skips_provider_for_disconnected_item(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-1",
        access_token="access-sandbox-123",
        institution_name="Plaid Sandbox",
    )
    store.disconnect_item("brian", item.id)
    plaid = _SandboxPlaidStub()
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=plaid,
    )

    disconnected = await service.remove_item_from_plaid("brian", item.id)

    assert plaid.removed_tokens == []
    assert disconnected is not None
    assert disconnected.status == "disconnected"


@pytest.mark.asyncio
async def test_seed_sandbox_resets_cursor_when_cache_is_empty(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    store.initialize()
    item = store.upsert_item(
        owner_key="brian",
        provider="plaid",
        item_id="item-1",
        access_token="access-sandbox-123",
        institution_name="Plaid Sandbox",
    )
    store.mark_sync_success(item.id, "stale-cursor")
    plaid = _SandboxPlaidStub()
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=plaid,
    )

    _item, results = await service.seed_sandbox_owner("brian")

    assert plaid.sync_cursors == ["stale-cursor", None]
    assert sum(result.added for result in results) == 1
    assert store.transaction_count("brian") == 1


def test_seed_cached_transactions_from_action_log_then_matches(monkeypatch, tmp_path):
    action = LoggedAction(
        id="abc123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/17/2026", "coffee", "4.33", "Starbucks", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $4.33 for Brian (BofA)",
        ),
    )
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda _actor_key: [action])
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=PlaidClient(
            BankingConfig(
                plaid_client_id="client",
                plaid_secret="secret",
                plaid_env="sandbox",
                token_encryption_key="test-secret-key",
                sqlite_path=Path("unused.sqlite3"),
            )
        ),
    )

    seeded, considered = service.seed_cached_transactions_from_action_log(
        "brian",
        "676638528590970917",
    )
    preview = service.reconciliation_preview("brian", force=True, actor_key="676638528590970917")

    assert (seeded, considered) == (1, 1)
    assert store.transaction_count("brian") == 1
    assert len(preview.items) == 1
    assert preview.items[0].status == "matched"
    assert preview.items[0].matched_action_log_id == "abc123"


def test_seed_unmatched_debug_transaction_then_needs_review(tmp_path):
    store = BankStore(tmp_path / "banking.sqlite3", TokenCipher("test-secret-key"))
    service = BankingService(
        config=BankingConfig(
            plaid_client_id="client",
            plaid_secret="secret",
            plaid_env="sandbox",
            token_encryption_key="test-secret-key",
            sqlite_path=Path("unused.sqlite3"),
        ),
        store=store,
        plaid=PlaidClient(
            BankingConfig(
                plaid_client_id="client",
                plaid_secret="secret",
                plaid_env="sandbox",
                token_encryption_key="test-secret-key",
                sqlite_path=Path("unused.sqlite3"),
            )
        ),
    )

    transaction = service.seed_unmatched_debug_transaction(
        "brian",
        name='"Unlogged Coffee"',
        amount=12.34,
        date="2026-05-17",
    )
    preview = service.reconciliation_preview("brian", force=True, actor_key="676638528590970917")

    assert transaction.name == "Unlogged Coffee"
    assert store.transaction_count("brian") == 1
    assert len(preview.items) == 1
    assert preview.items[0].classification == "expense"
    assert preview.items[0].status == "needs_review"
    assert preview.items[0].matched_action_log_id is None
