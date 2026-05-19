from pathlib import Path

import pytest

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount, BankTransaction
from bookiebot.banking.plaid_client import PlaidClient
import bookiebot.banking.service as banking_service
from bookiebot.banking.reconciliation import (
    action_log_bank_transaction,
    classify_transaction,
    find_action_log_candidate_groups,
    find_action_log_candidates,
    reconcile_transaction,
)
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


def test_find_action_log_candidates_allows_fuzzy_amount_and_seven_day_window():
    action = LoggedAction(
        id="abc123",
        created_at="2026-05-12T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/12/2026", "hardware", "88.99", "Ace Hardware", "Brian (BofA)"],
            metadata={"type": "expense", "category": "home", "person": "Brian (BofA)"},
            description="home expense $88.99 for Brian (BofA)",
        ),
    )
    transaction = BankTransaction(
        **{
            **_transaction("Bennett Valley Ace Hardware", 89.99).__dict__,
            "date": "2026-05-18",
        }
    )

    candidates = find_action_log_candidates(transaction, [action], classification="expense")

    assert len(candidates) == 1
    assert candidates[0].action_id == "abc123"
    assert candidates[0].sheet_ref == "expense!row 12"
    assert "date Δ 6d" in candidates[0].notes


def test_find_action_log_candidate_groups_matches_exact_aggregate_total():
    actions = [
        LoggedAction(
            id="minted123",
            created_at="2026-05-15T12:00:00",
            user_key="676638528590970917",
            action=UndoAction(
                worksheet="expense",
                kind="clear_cells",
                row=12,
                columns=[14, 15, 16, 17, 18],
                previous_values=["", "", "", "", ""],
                new_values=["5/15/2026", "graduation invites", "135.93", "Minted", "Brian (BofA)"],
                metadata={"type": "expense", "category": "shopping", "person": "Brian (BofA)"},
                description="shopping expense $135.93 for Brian (BofA)",
            ),
        ),
        LoggedAction(
            id="zazzle123",
            created_at="2026-05-15T12:00:00",
            user_key="676638528590970917",
            action=UndoAction(
                worksheet="expense",
                kind="clear_cells",
                row=13,
                columns=[14, 15, 16, 17, 18],
                previous_values=["", "", "", "", ""],
                new_values=["5/15/2026", "graduation announcements", "37.66", "Zazzle", "Brian (BofA)"],
                metadata={"type": "expense", "category": "shopping", "person": "Brian (BofA)"},
                description="shopping expense $37.66 for Brian (BofA)",
            ),
        ),
    ]
    transaction = BankTransaction(
        **{
            **_transaction("Venmo", 173.59).__dict__,
            "date": "2026-05-18",
        }
    )

    groups = find_action_log_candidate_groups(transaction, actions, classification="expense")

    assert len(groups) == 1
    assert groups[0].total_amount == 173.59
    assert [candidate.action_id for candidate in groups[0].candidates] == ["minted123", "zazzle123"]


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


def test_reconciliation_match_candidates_excludes_already_matched_actions(monkeypatch, tmp_path):
    matched_action = LoggedAction(
        id="matched123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/17/2026", "coffee", "12.34", "Coffee", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $12.34 for Brian (BofA)",
        ),
    )
    available_action = LoggedAction(
        id="available123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=13,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/17/2026", "coffee", "12.34", "Coffee Shop", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $12.34 for Brian (BofA)",
        ),
    )
    monkeypatch.setattr(
        banking_service,
        "read_active_logged_actions",
        lambda _actor_key: [matched_action, available_action],
    )
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
        name="Coffee",
        amount=12.34,
        date="2026-05-17",
    )
    preview_item = service.reconciliation_preview("brian", force=True).items[0]
    store.upsert_reconciliation_item(
        owner_key="brian",
        transaction=transaction,
        classification="expense",
        status="matched",
        confidence=0.96,
        matched_action_log_id="matched123",
        matched_sheet_ref="expense!row 12",
    )

    item, candidates, groups = service.reconciliation_match_candidates(
        "brian",
        preview_item.id,
        actor_key="676638528590970917",
    )

    assert item is not None
    assert [candidate.action_id for candidate in candidates] == ["available123"]
    assert groups == []


def test_confirm_reconciliation_action_match_marks_existing_row(monkeypatch, tmp_path):
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
            new_values=["5/17/2026", "coffee", "12.34", "Coffee", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $12.34 for Brian (BofA)",
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
    service.seed_unmatched_debug_transaction("brian", name="Coffee", amount=12.34, date="2026-05-17")
    item = service.reconciliation_preview("brian", force=True).items[0]

    confirmed, candidate, status = service.confirm_reconciliation_action_match(
        "brian",
        item.id,
        actor_key="676638528590970917",
        action_id="abc123",
    )

    assert status == "matched"
    assert candidate is not None
    assert confirmed is not None
    assert confirmed.status == "confirmed"
    assert confirmed.matched_action_log_id == "abc123"
    assert confirmed.matched_sheet_ref == "expense!row 12"


def test_confirm_reconciliation_action_match_updates_sheet_amount_when_needed(monkeypatch, tmp_path):
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
            new_values=["5/17/2026", "food", "20.09", "Glizzy", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $20.09 for Brian (BofA)",
        ),
    )
    updated_action = LoggedAction(
        id="abc123",
        created_at="2026-05-17T12:00:00",
        user_key="676638528590970917",
        action=UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=12,
            columns=[14, 15, 16, 17, 18],
            previous_values=["", "", "", "", ""],
            new_values=["5/17/2026", "food", "20.89", "Glizzy", "Brian (BofA)"],
            metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
            description="food expense $20.89 for Brian (BofA)",
        ),
    )
    actions = [action]
    update_calls = []

    def fake_update_recent_action(user_key, *, updates, action_id=None, **_kwargs):
        update_calls.append((user_key, updates, action_id))
        actions[0] = updated_action
        return True, "Updated logged action"

    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda _actor_key: actions)
    monkeypatch.setattr(banking_service, "update_recent_action", fake_update_recent_action)
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
    service.seed_unmatched_debug_transaction("brian", name="ArmK Oracle Park F&b", amount=20.89, date="2026-05-17")
    item = service.reconciliation_preview("brian", force=True).items[0]

    confirmed, candidate, status = service.confirm_reconciliation_action_match(
        "brian",
        item.id,
        actor_key="676638528590970917",
        action_id="abc123",
    )

    assert status == "matched_updated"
    assert candidate is not None
    assert candidate.amount == 20.89
    assert confirmed is not None
    assert confirmed.status == "confirmed"
    assert update_calls == [
        ("676638528590970917", {"amount": "20.89"}, "abc123"),
    ]


def test_confirm_reconciliation_action_group_match_requires_exact_total(monkeypatch, tmp_path):
    actions = [
        LoggedAction(
            id="minted123",
            created_at="2026-05-15T12:00:00",
            user_key="676638528590970917",
            action=UndoAction(
                worksheet="expense",
                kind="clear_cells",
                row=12,
                columns=[14, 15, 16, 17, 18],
                previous_values=["", "", "", "", ""],
                new_values=["5/15/2026", "graduation invites", "135.93", "Minted", "Brian (BofA)"],
                metadata={"type": "expense", "category": "shopping", "person": "Brian (BofA)"},
                description="shopping expense $135.93 for Brian (BofA)",
            ),
        ),
        LoggedAction(
            id="zazzle123",
            created_at="2026-05-15T12:00:00",
            user_key="676638528590970917",
            action=UndoAction(
                worksheet="expense",
                kind="clear_cells",
                row=13,
                columns=[14, 15, 16, 17, 18],
                previous_values=["", "", "", "", ""],
                new_values=["5/15/2026", "graduation announcements", "37.66", "Zazzle", "Brian (BofA)"],
                metadata={"type": "expense", "category": "shopping", "person": "Brian (BofA)"},
                description="shopping expense $37.66 for Brian (BofA)",
            ),
        ),
    ]
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda _actor_key: actions)
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
    service.seed_unmatched_debug_transaction("brian", name="Venmo", amount=173.59, date="2026-05-18")
    item = service.reconciliation_preview("brian", force=True).items[0]

    confirmed, candidates, status = service.confirm_reconciliation_action_group_match(
        "brian",
        item.id,
        actor_key="676638528590970917",
        action_ids=["minted123", "zazzle123"],
    )

    assert status == "matched"
    assert len(candidates) == 2
    assert confirmed is not None
    assert confirmed.status == "confirmed"
    assert confirmed.matched_action_log_id == "minted123+zazzle123"
    assert confirmed.matched_sheet_ref == "expense!row 12 + expense!row 13"


def test_confirm_reconciliation_action_group_match_rejects_total_mismatch(monkeypatch, tmp_path):
    actions = [
        LoggedAction(
            id="minted123",
            created_at="2026-05-15T12:00:00",
            user_key="676638528590970917",
            action=UndoAction(
                worksheet="expense",
                kind="clear_cells",
                row=12,
                columns=[14, 15, 16, 17, 18],
                previous_values=["", "", "", "", ""],
                new_values=["5/15/2026", "graduation invites", "135.93", "Minted", "Brian (BofA)"],
                metadata={"type": "expense", "category": "shopping", "person": "Brian (BofA)"},
                description="shopping expense $135.93 for Brian (BofA)",
            ),
        ),
        LoggedAction(
            id="wrong123",
            created_at="2026-05-15T12:00:00",
            user_key="676638528590970917",
            action=UndoAction(
                worksheet="expense",
                kind="clear_cells",
                row=13,
                columns=[14, 15, 16, 17, 18],
                previous_values=["", "", "", "", ""],
                new_values=["5/15/2026", "graduation announcements", "38.00", "Zazzle", "Brian (BofA)"],
                metadata={"type": "expense", "category": "shopping", "person": "Brian (BofA)"},
                description="shopping expense $38.00 for Brian (BofA)",
            ),
        ),
    ]
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda _actor_key: actions)
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
    service.seed_unmatched_debug_transaction("brian", name="Venmo", amount=173.59, date="2026-05-18")
    item = service.reconciliation_preview("brian", force=True).items[0]

    confirmed, candidates, status = service.confirm_reconciliation_action_group_match(
        "brian",
        item.id,
        actor_key="676638528590970917",
        action_ids=["minted123", "wrong123"],
    )

    assert status == "amount_mismatch"
    assert len(candidates) == 2
    assert confirmed is not None
    assert confirmed.status == "needs_review"
