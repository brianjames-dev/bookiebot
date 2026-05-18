from bookiebot.banking.models import BankTransaction, ReconciliationItem, ReconciliationPreview
from bookiebot.banking.formatting import (
    format_bank_transaction,
    format_bank_transaction_table,
    format_reconciliation_preview,
)


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

    assert line == "`2026-05-17  out          $18.50  Blue Bottle                 Checking *1111`"


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

    assert line == "`2026-05-17  in*        $1639.90  Sonic Payroll               Checking`"


def test_format_bank_transaction_table_aligns_and_clips():
    table = format_bank_transaction_table(
        [
            BankTransaction(
                id=1,
                provider_transaction_id="txn-1",
                owner_key="brian",
                account_name="Plaid Checking",
                account_mask="0000",
                account_type="depository",
                account_subtype="checking",
                date="2026-05-17",
                authorized_date=None,
                name="Very Long Merchant Name That Should Clip",
                merchant_name=None,
                amount=18.5,
                pending=False,
                payment_channel="in store",
                updated_at="2026-05-17T00:00:00+00:00",
            )
        ]
    )

    assert table.startswith("```text\nDate")
    assert "Very Long Merchant Name T~" in table
    assert "Plaid Checking *0000" in table
    assert table.endswith("\n```")


def test_format_reconciliation_preview_does_not_cut_code_blocks():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-17",
        authorized_date=None,
        name="Very Long Merchant Name That Should Clip",
        merchant_name=None,
        amount=18.5,
        pending=False,
        payment_channel="in store",
        updated_at="2026-05-17T00:00:00+00:00",
    )
    items = [
        ReconciliationItem(
            id=index,
            owner_key="brian",
            bank_transaction_id=index,
            provider_transaction_id=f"txn-{index}",
            classification="expense",
            status="needs_review",
            confidence=0.6,
            matched_action_log_id=None,
            matched_sheet_ref=None,
            first_seen_at="2026-05-17T00:00:00+00:00",
            last_seen_at="2026-05-17T00:00:00+00:00",
            resolved_at=None,
            ignored_at=None,
            notes="outflow transaction",
            transaction=transaction,
        )
        for index in range(10)
    ]

    output = format_reconciliation_preview(ReconciliationPreview(owner_key="brian", items=items), max_chars=500)

    assert output.count("```") % 2 == 0
    assert "Date        Amt  Name" in output
    assert "Status" not in output
    assert "Note" not in output
    assert "05-17" in output
    assert "Unmatched Expense:" in output
    assert "...and " in output
    assert len(output) <= 760


def test_format_reconciliation_preview_uses_narrow_rows():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-17",
        authorized_date=None,
        name="Very Long Merchant Name That Should Clip",
        merchant_name=None,
        amount=1234.56,
        pending=False,
        payment_channel="in store",
        updated_at="2026-05-17T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=1,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="expense",
        status="needs_review",
        confidence=0.6,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-17T00:00:00+00:00",
        last_seen_at="2026-05-17T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="outflow transaction",
        transaction=transaction,
    )

    output = format_reconciliation_preview(ReconciliationPreview(owner_key="brian", items=[item]))
    code_lines = [
        line
        for line in output.splitlines()
        if not line.startswith("```") and line not in {"Bank reconciliation preview:", "Unmatched Expense:"}
    ]

    assert "Note" not in output
    assert "Very Long Merchant Name T~" in output
    assert all(len(line) <= 46 for line in code_lines if line and not line.startswith("-"))


def test_format_reconciliation_preview_separates_matched_items():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-17",
        authorized_date=None,
        name="Starbucks",
        merchant_name=None,
        amount=4.33,
        pending=False,
        payment_channel="in store",
        updated_at="2026-05-17T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=1,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="expense",
        status="matched",
        confidence=0.96,
        matched_action_log_id="abc123",
        matched_sheet_ref="expense!row 12",
        first_seen_at="2026-05-17T00:00:00+00:00",
        last_seen_at="2026-05-17T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="matched expense action",
        transaction=transaction,
    )

    output = format_reconciliation_preview(ReconciliationPreview(owner_key="brian", items=[item]))

    assert "Matched Expense:" in output
    assert "05-17     $4.33  Starbucks" in output


def test_format_reconciliation_preview_tightens_section_spacing():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-17",
        authorized_date=None,
        name="Coffee",
        merchant_name=None,
        amount=4.33,
        pending=False,
        payment_channel="in store",
        updated_at="2026-05-17T00:00:00+00:00",
    )
    items = [
        ReconciliationItem(
            id=1,
            owner_key="brian",
            bank_transaction_id=1,
            provider_transaction_id="txn-1",
            classification="expense",
            status="needs_review",
            confidence=0.6,
            matched_action_log_id=None,
            matched_sheet_ref=None,
            first_seen_at="2026-05-17T00:00:00+00:00",
            last_seen_at="2026-05-17T00:00:00+00:00",
            resolved_at=None,
            ignored_at=None,
            notes="outflow transaction",
            transaction=transaction,
        ),
        ReconciliationItem(
            id=2,
            owner_key="brian",
            bank_transaction_id=2,
            provider_transaction_id="txn-2",
            classification="income",
            status="matched",
            confidence=0.96,
            matched_action_log_id="income1",
            matched_sheet_ref="income!row 5",
            first_seen_at="2026-05-17T00:00:00+00:00",
            last_seen_at="2026-05-17T00:00:00+00:00",
            resolved_at=None,
            ignored_at=None,
            notes="matched income action",
            transaction=BankTransaction(
                **{
                    **transaction.__dict__,
                    "id": 2,
                    "provider_transaction_id": "txn-2",
                    "name": "Paycheck",
                    "amount": -100.0,
                }
            ),
        ),
    ]

    output = format_reconciliation_preview(ReconciliationPreview(owner_key="brian", items=items))

    assert "Unmatched Expense:" in output
    assert "Matched Income:" in output
    assert "\n```\n\n\n" not in output
    assert "\n```\nMatched Income:" in output
