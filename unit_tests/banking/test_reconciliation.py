from pathlib import Path

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount, BankTransaction
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.reconciliation import classify_transaction
from bookiebot.banking.service import BankingService
from bookiebot.banking.store import BankStore


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
