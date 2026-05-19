from datetime import datetime

from bookiebot.banking.models import BankTransaction, ReconciliationItem, ReconciliationPreview
from bookiebot.core.bank_reconciliation import (
    _parse_specific_snooze_time,
    _resolve_snooze,
    format_bank_reconciliation_digest,
)


def test_format_bank_reconciliation_digest_lists_unresolved_items():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
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
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
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
    preview = ReconciliationPreview(
        owner_key="brian",
        items=[item],
        cached_transaction_count=26,
        candidate_transaction_count=1,
    )

    output = format_bank_reconciliation_digest("<@123>", preview, [item])

    assert "<@123> bank reconciliation found `1` item that needs review." in output
    assert "Cached transactions: `26`" in output
    assert "Checked this run: `1`" in output
    assert "Unresolved bank reconciliation items:" in output
    assert "  42  05-18    $12.34  expense   Unlogged Coffee" in output


def test_resolve_snooze_options_use_readable_labels():
    current = datetime(2026, 5, 18, 14, 30)

    label, remind_at = _resolve_snooze("1h", current)
    assert label == "in 1 hour"
    assert remind_at == datetime(2026, 5, 18, 15, 30)

    label, remind_at = _resolve_snooze("2h", current)
    assert label == "in 2 hours"
    assert remind_at == datetime(2026, 5, 18, 16, 30)

    label, remind_at = _resolve_snooze("tomorrow", current)
    assert label == "tomorrow at the same time"
    assert remind_at == datetime(2026, 5, 19, 14, 30)


def test_parse_specific_snooze_time_rolls_past_times_to_tomorrow():
    current = datetime(2026, 5, 18, 14, 30)

    assert _parse_specific_snooze_time("3:30 PM", current) == datetime(2026, 5, 18, 15, 30)
    assert _parse_specific_snooze_time("9 AM", current) == datetime(2026, 5, 19, 9, 0)
    assert _parse_specific_snooze_time("tomorrow 9 AM", current) == datetime(2026, 5, 19, 9, 0)
    assert _parse_specific_snooze_time("not a time", current) is None
