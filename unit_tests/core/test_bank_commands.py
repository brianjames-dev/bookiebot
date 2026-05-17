from bookiebot.banking.models import BankTransaction
from bookiebot.banking.formatting import format_bank_transaction


def test_format_bank_transaction_outflow():
    line = format_bank_transaction(
        BankTransaction(
            id=1,
            provider_transaction_id="txn-1",
            owner_key="brian",
            account_name="Checking",
            account_mask="1111",
            account_type="depository",
            account_subtype="checking",
            date="2026-05-17",
            authorized_date=None,
            name="Coffee Shop",
            merchant_name="Blue Bottle",
            amount=18.5,
            pending=False,
            payment_channel="in store",
            updated_at="2026-05-17T00:00:00+00:00",
        )
    )

    assert line == "`2026-05-17 | outflow | $18.50 to Blue Bottle | Checking *1111`"


def test_format_bank_transaction_pending_inflow():
    line = format_bank_transaction(
        BankTransaction(
            id=1,
            provider_transaction_id="txn-1",
            owner_key="brian",
            account_name="Checking",
            account_mask=None,
            account_type="depository",
            account_subtype="checking",
            date=None,
            authorized_date="2026-05-17",
            name="Sonic Payroll",
            merchant_name=None,
            amount=-1639.9,
            pending=True,
            payment_channel="other",
            updated_at="2026-05-17T00:00:00+00:00",
        )
    )

    assert line == "`2026-05-17 | inflow pending | $1639.90 from Sonic Payroll | Checking`"
