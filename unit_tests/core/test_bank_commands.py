from datetime import date

from bookiebot.banking.models import BankTransaction, ReconciliationItem, ReconciliationPreview
from bookiebot.banking.formatting import (
    format_bank_transaction,
    format_bank_transaction_table,
    format_bank_transaction_table_chunks,
    format_group_match_amount_mismatch,
    format_reconciliation_detail,
    format_reconciliation_preview,
    format_reconciliation_review,
)
from bookiebot.banking.reconciliation import ActionLogCandidate
from bookiebot.banking.reconciliation import ActionLogCandidateGroup
from bookiebot.core.commands import _clean_command_text


def test_clean_command_text_strips_matching_outer_quotes():
    assert _clean_command_text('"Unlogged Coffee"') == "Unlogged Coffee"
    assert _clean_command_text("'Brian (BofA)'") == "Brian (BofA)"
    assert _clean_command_text("  \"Safeway\"  ") == "Safeway"


def test_clean_command_text_keeps_unwrapped_text_and_inner_apostrophes():
    assert _clean_command_text("Brian (BofA)") == "Brian (BofA)"
    assert _clean_command_text("McDonald's") == "McDonald's"
    assert _clean_command_text(None) == ""


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


def test_format_bank_transaction_table_chunks_keep_code_fences_closed():
    transactions = [
        BankTransaction(
            id=index,
            provider_transaction_id=f"txn-{index}",
            owner_key="brian",
            account_name="Very Long Account Name That Clips",
            account_mask="1234",
            account_type="depository",
            account_subtype="checking",
            date="2026-05-17",
            authorized_date=None,
            name="Very Long Merchant Name That Should Clip",
            merchant_name=None,
            amount=18.5 + index,
            pending=False,
            payment_channel="in store",
            updated_at="2026-05-17T00:00:00+00:00",
        )
        for index in range(25)
    ]

    chunks = format_bank_transaction_table_chunks(transactions, max_chars=500)

    assert len(chunks) > 1
    assert all(chunk.startswith("```text\nDate") for chunk in chunks)
    assert all(chunk.endswith("\n```") for chunk in chunks)
    assert all(chunk.count("```") == 2 for chunk in chunks)
    assert sum(chunk.count("2026-05-17") for chunk in chunks) == 25


def test_format_group_match_amount_mismatch_shows_update_choices():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="2178",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="Venmo",
        merchant_name=None,
        amount=173.59,
        pending=False,
        payment_channel=None,
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=126,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="needs_review",
        status="needs_review",
        confidence=0.5,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="manual review",
        transaction=transaction,
    )
    candidates = [
        ActionLogCandidate("minted123", "expense!row 12", "expense", date(2026, 5, 15), 135.93, "Minted", 0.9, ""),
        ActionLogCandidate("zazzle123", "expense!row 13", "expense", date(2026, 5, 15), 38.00, "Zazzle", 0.9, ""),
    ]

    output = format_group_match_amount_mismatch(item, candidates)

    assert "Bank: `$173.59`" in output
    assert "Selected rows: `$173.93`" in output
    assert "Difference: `$-0.34`" in output
    assert "Selected sheet rows:" in output
    assert "`/debug_bank_update_action_amount action_id:zazzle123 amount:37.66`" in output


def test_format_reconciliation_detail_can_hide_debug_commands_for_button_flow():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="2178",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="Venmo",
        merchant_name=None,
        amount=173.59,
        pending=False,
        payment_channel=None,
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=126,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="needs_review",
        status="needs_review",
        confidence=0.5,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="manual review",
        transaction=transaction,
    )
    first = ActionLogCandidate(
        "minted123", "expense!row 12", "expense", date(2026, 5, 15), 135.93, "graduation invites", 0.73, ""
    )
    second = ActionLogCandidate(
        "zazzle123", "expense!row 13", "expense", date(2026, 5, 15), 37.66, "graduation announcements", 0.37, ""
    )
    group = ActionLogCandidateGroup("minted123+zazzle123", (first, second), 173.59, 0.71, "")

    output = format_reconciliation_detail(item, [], [group], include_commands=False)

    assert "/debug_bank_match_group" not in output
    assert "Flow:    Money out / charge" in output
    assert "Use the buttons below to resolve this item." in output
    assert "Choice 1: $173.59 total, 0.71 confidence" in output
    assert "$135.93  graduation invites" in output
    assert "$37.66  graduation announcements" in output
    assert "BookieBot found existing sheet rows" in output


def test_format_reconciliation_detail_labels_money_in_flow():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Credit Card",
        account_mask="5746",
        account_type="credit",
        account_subtype="credit card",
        date="2026-05-18",
        authorized_date=None,
        name="Apple",
        merchant_name=None,
        amount=-51.87,
        pending=False,
        payment_channel=None,
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=125,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="needs_review",
        status="needs_review",
        confidence=0.5,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="manual review",
        transaction=transaction,
    )

    output = format_reconciliation_detail(item, [], [], include_commands=False)

    assert "Amount:  $51.87" in output
    assert "Flow:    Money in / refund" in output


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


def test_format_reconciliation_review_lists_unresolved_ids():
    transaction = BankTransaction(
        id=10,
        provider_transaction_id="txn-10",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="Unlogged Coffee",
        merchant_name=None,
        amount=12.34,
        pending=False,
        payment_channel="bookiebot_debug",
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=42,
        owner_key="brian",
        bank_transaction_id=10,
        provider_transaction_id="txn-10",
        classification="expense",
        status="needs_review",
        confidence=0.6,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="outflow transaction",
        transaction=transaction,
    )

    output = format_reconciliation_review([item])

    assert output.startswith("Unresolved bank reconciliation items:")
    assert "  42  05-18    $12.34  expense   Unlogged Coffee" in output


def test_format_reconciliation_review_empty():
    assert format_reconciliation_review([]) == "No unresolved bank reconciliation items."
