"""Matched sheet details must come from saved actions, never bank-row guesses."""
from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from bookiebot.banking.models import BankTransaction, ReconciliationCacheBuckets, ReconciliationItem
from bookiebot.banking.reconciliation import ScheduledPullCandidate, action_log_candidate_by_id
from bookiebot.banking.service import BankingService
from bookiebot.banking.formatting import format_reconciliation_match_report_chunks
from bookiebot.sheets.undo import LoggedAction, UndoAction
import bookiebot.banking.service as banking


@pytest.fixture
def matched_report(monkeypatch):
    transaction = BankTransaction(
        id=1, provider_transaction_id="bank-1", owner_key="brian", account_name="Checking",
        account_mask="1234", account_type="depository", account_subtype="checking",
        date="2026-10-13", authorized_date=None, name="Example Cafe",
        merchant_name=None, amount=12.34, pending=False, payment_channel=None, updated_at="bank-v1",
    )
    action = LoggedAction("purchase", "2026-10-12", "actor", UndoAction(
        worksheet="expense", kind="clear_cells", row=12, columns=[14, 15, 16, 17, 18],
        previous_values=[], new_values=["10/12/2026", "Dinner", "12.34", "Example Cafe", "Brian (BofA)"],
        metadata={"type": "expense", "category": "food"}, description="Dinner at Example Cafe",
    ))
    candidate = action_log_candidate_by_id(action)
    assert candidate is not None
    item = ReconciliationItem(
        id=1, owner_key="brian", bank_transaction_id=1, provider_transaction_id="bank-1",
        classification="expense", status="matched", confidence=.98,
        matched_action_log_id=action.id, matched_sheet_ref=candidate.sheet_ref,
        first_seen_at="first", last_seen_at="review-v1", resolved_at=None, ignored_at=None,
        notes="matched expense action within 1d", transaction=transaction,
    )
    reader = Mock(return_value=[action])
    schedules = Mock(side_effect=AssertionError("Ordinary expense reports must not read schedules"))
    monkeypatch.setattr(banking, "read_active_logged_actions", reader)
    monkeypatch.setattr(banking, "_scheduled_pulls_for_transactions", schedules)
    service = BankingService(config=SimpleNamespace(), store=SimpleNamespace(), plaid=SimpleNamespace())
    return service, item, action, candidate, reader, schedules


def test_report_hydrates_exact_saved_expense_and_skips_schedule_reads(matched_report):
    service, item, action, candidate, reader, schedules = matched_report
    report = service.reconciliation_report_matches("brian", [item], actor_key="actor")
    match = report[0]
    assert (match.matched_date, match.matched_amount, match.matched_name) == (
        "2026-10-12", 12.34, candidate.label,
    )
    assert match.bank_date == "2026-10-13"
    assert match.matched_sheet_ref == item.matched_sheet_ref
    reader.assert_called_once_with("actor")
    schedules.assert_not_called()
    text = "\n".join(format_reconciliation_match_report_chunks(report))
    assert "Sheet:  10-12    $12.34" in text
    assert "no spreadsheet row" not in text


def test_persisted_report_keeps_row_reference_without_external_reads(matched_report):
    service, item, action, candidate, reader, schedules = matched_report
    report = service.reconciliation_report_matches("brian", [item], actor_key=None)
    reader.assert_not_called()
    schedules.assert_not_called()
    assert report[0].matched_name is None
    assert report[0].matched_sheet_ref == item.matched_sheet_ref
    text = "\n".join(format_reconciliation_match_report_chunks(report))
    assert "Sheet:  expense!N12:R12 (2026-10); details unavailable" in text
    assert "no spreadsheet row" not in text


@pytest.mark.parametrize("missing", [False, True])
def test_group_report_never_presents_a_partial_group_as_the_whole_match(matched_report, missing):
    service, item, action, candidate, reader, schedules = matched_report
    second = replace(action, id="second", action=replace(action.action,
        row=13, new_values=["10/12/2026", "Lunch", "10.00", "Example Cafe", "Brian (BofA)"]))
    reader.return_value = [action] if missing else [action, second]
    grouped = replace(item, matched_action_log_id="purchase+second",
        transaction=replace(item.transaction, amount=22.34))
    match = service.reconciliation_report_matches("brian", [grouped], actor_key="actor")[0]
    assert match.source_type == "spreadsheet group"
    assert match.matched_amount == (None if missing else 22.34)
    assert match.matched_name == (None if missing else candidate.label + " + " + action_log_candidate_by_id(second).label)


def test_schedule_report_resolves_saved_occurrence_without_action_history(matched_report):
    service, item, action, candidate, reader, schedules = matched_report
    pull = ScheduledPullCandidate("subscription", "Example Cafe", 12.34, date(2026, 10, 13),
        "Subscriptions!B10:D10", amount_recorded=True)
    schedules.side_effect = None
    schedules.return_value = [pull]
    scheduled = replace(item, matched_action_log_id=None, matched_sheet_ref=pull.occurrence_ref)
    match = service.reconciliation_report_matches("brian", [scheduled], actor_key="actor")[0]
    assert (match.matched_name, match.matched_amount, match.matched_date) == ("Example Cafe (subscription)", 12.34, "2026-10-13")
    reader.assert_not_called()
    schedules.assert_called_once()


def test_rule_only_report_does_not_claim_a_missing_spreadsheet_match(matched_report):
    service, item, action, candidate, reader, schedules = matched_report
    rule = replace(item, matched_action_log_id=None, matched_sheet_ref=None, notes="transfer/payment pattern")
    report = service.reconciliation_report_matches("brian", [rule], actor_key="actor")
    reader.assert_not_called()
    schedules.assert_not_called()
    assert "Sheet:  no spreadsheet row (automatic rule)" in "\n".join(format_reconciliation_match_report_chunks(report))


@pytest.mark.parametrize("reference,shown", [
    ("expense!row 12#month=2026-10", "expense!row 12 (2026-10)"),
    ("Subscriptions!B10:D10#pull=2026-10-13", "Subscriptions!B10:D10 (2026-10-13)"),
    ("expense!row 0#cols=0#month=2026-10", "expense!row 0 (2026-10)"),
    ("expense!row 12#cols=bad#month=2026-10", "expense!row 12 (2026-10)"),
    ("expense!row 12#cols=14,15#month=2026-10 + expense!row 13#cols=14,15#month=2026-10",
     "expense!N12:O12 (2026-10) + expense!N13:O13 (2026-10)"),
])
def test_unavailable_details_show_readable_saved_references(matched_report, reference, shown):
    service, item, *_ = matched_report
    report = service.reconciliation_report_matches("brian", [replace(item, matched_sheet_ref=reference)], actor_key=None)
    assert f"Sheet:  {shown}; details unavailable" in "\n".join(format_reconciliation_match_report_chunks(report))


@pytest.mark.asyncio
async def test_view_inbox_resolves_saved_match_details_end_to_end(matched_report, monkeypatch):
    import bookiebot.core.bank_reconciliation as inbox
    service, item, action, candidate, reader, schedules = matched_report
    monkeypatch.setattr(inbox, "build_banking_service", lambda: service)
    monkeypatch.setattr(inbox, "get_user_config", lambda _: SimpleNamespace(budget_owner_key="brian", name="Brian"))
    monkeypatch.setattr(inbox, "now_pacific", lambda: datetime(2026, 10, 14))
    monkeypatch.setattr(service, "unresolved_reconciliation_items", lambda *args, **kwargs: [])
    monkeypatch.setattr(service, "matched_reconciliation_items", lambda *args, **kwargs: [item])
    monkeypatch.setattr(service, "reconciliation_cache_buckets", lambda *args, **kwargs:
        ReconciliationCacheBuckets(stored=1, matched=1))
    interaction = SimpleNamespace(followup=SimpleNamespace(send=AsyncMock()))

    await inbox._send_bank_reconciliation_inbox(interaction, "actor")

    calls = interaction.followup.send.await_args_list
    text = "\n".join(call.kwargs["content"] for call in calls)
    assert "Bank:   10-13    $12.34  Example Cafe" in text
    assert f"Sheet:  10-12    $12.34  {candidate.label}" in text
    assert "details unavailable" not in text
    reader.assert_called_once_with("actor")
    schedules.assert_not_called()
    assert all(call.kwargs["ephemeral"] for call in calls)
