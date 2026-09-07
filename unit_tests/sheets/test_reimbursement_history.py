from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

from gspread.exceptions import WorksheetNotFound
import pytest

from bookiebot.sheets import reimbursement_history as history
from bookiebot.sheets.collaboration import SharedAllocation, SHARED_REIMBURSEMENT_HEADERS, _allocation_row
from bookiebot.sheets.routing import (
    DEFAULT_BRIAN_DISCORD_USER_IDS, DEFAULT_HANNAH_DISCORD_USER_IDS, PACIFIC_TZ,
    get_current_discord_user_id,
)
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


BRIAN = DEFAULT_BRIAN_DISCORD_USER_IDS[0]
HANNAH = DEFAULT_HANNAH_DISCORD_USER_IDS[0]
NOW = datetime(2027, 1, 7, 12, tzinfo=PACIFIC_TZ)


def allocation(key="old", **changes):
    return replace(SharedAllocation(
        allocation_id=key, created_at="2026-12-30T10:00:00-08:00",
        updated_at="2026-12-30T10:00:00-08:00", actor_key=BRIAN,
        owner_key="brian", payer="Brian (BofA)", partner="Hannah",
        source_action_id="expense-1", split_action_id="split-1", source_worksheet="expense",
        source_category="grocery", source_row=3, expense_date="12/30/2026",
        item="Groceries", location="Safeway", gross_amount=200, split_method="equal",
        payer_share=100, partner_share=100,
    ), **changes)


def ledger(year, *items):
    rows = [SHARED_REIMBURSEMENT_HEADERS, *[_allocation_row(item) for item in items]]
    worksheet = InMemoryWorksheet(rows)
    return history.ReimbursementLedger(year, worksheet, rows)


def snapshot(*ledgers, as_of=NOW):
    return history.reimbursement_history_from_ledgers(BRIAN, list(ledgers), as_of=as_of)


def test_carries_old_expenses_and_retains_original_date_and_partial_balance():
    result = snapshot(ledger(2025, allocation("ancient", expense_date="1/1/2025")),
                      ledger(2026, allocation(received_amount=25)),
                      ledger(2027, allocation("new", expense_date="1/2/2027")))
    assert [(item.allocation.allocation_id, item.allocation.expense_date, item.allocation.outstanding_amount)
            for item in result.outstanding_records] == [
                ("ancient", "1/1/2025", 100), ("old", "12/30/2026", 75), ("new", "1/2/2027", 100)]
    assert result.coverage_payload() == {
        "status": "complete", "asOf": "2027-01-07", "years": [2025, 2026, 2027],
        "unavailableYears": [], "excludedRecords": 0,
    }
    result.require_complete()


@pytest.mark.parametrize("status,received", [("reimbursed", 100), ("void", 0)])
def test_terminal_latest_record_suppresses_copied_outstanding(status, received):
    original = allocation()
    completed = replace(original, status=status, received_amount=received,
                        updated_at="2027-01-05T10:00:00-08:00")
    result = snapshot(ledger(2026, original), ledger(2027, completed))
    assert result.outstanding_records == ()
    assert len(result.records) == 1
    assert result.records[0].allocation.status == status


def test_newer_update_in_original_year_wins_over_stale_later_copy():
    copied = allocation()
    received = replace(copied, status="reimbursed", received_amount=100,
                       updated_at="2027-01-06T10:00:00-08:00")
    original_ledger = ledger(2026, received)
    result = snapshot(original_ledger, ledger(2027, copied))
    assert result.outstanding_records == ()
    assert result.records[0].worksheet is original_ledger.worksheet
    assert result.records[0].row_number == 2


def test_identical_copied_allocation_selects_one_latest_year_row():
    latest = ledger(2027, allocation())
    result = snapshot(ledger(2026, allocation()), latest)
    assert len(result.outstanding_records) == 1
    assert result.records[0].worksheet is latest.worksheet


@pytest.mark.parametrize("terminal_first", [True, False])
def test_equal_timestamp_conflicting_copies_are_ambiguous_not_resurrected(terminal_first):
    pending = allocation()
    terminal = replace(pending, status="reimbursed", received_amount=100)
    first, second = (terminal, pending) if terminal_first else (pending, terminal)
    result = snapshot(ledger(2026, first), ledger(2027, second))
    assert result.records == ()
    assert result.status == "partial"
    with pytest.raises(history.ReimbursementHistoryUnavailableError):
        result.require_complete()


def test_owner_aliases_and_fronted_payer_ownership_are_preserved():
    result = snapshot(ledger(2027,
        allocation("shortcut", actor_key="shortcut:brian"),
        allocation("fronted", payer_share=0, partner_share=200, split_method="fronted",
                   responsible_owner_key="hannah", responsible_person="Hannah"),
        allocation("other-owner", actor_key=HANNAH, owner_key="hannah", payer="Hannah", partner="Brian"),
        allocation("wrong-actor", actor_key=HANNAH),
    ))
    assert {record.allocation.allocation_id for record in result.outstanding_records} == {"shortcut", "fronted"}


def test_future_and_fully_received_items_do_not_count_as_current_outstanding():
    result = snapshot(ledger(2027,
        allocation("future", expense_date="1/8/2027"),
        allocation("zero", received_amount=100),
        allocation("today", expense_date="1/7/2027"),
    ))
    assert [record.allocation.allocation_id for record in result.outstanding_records] == ["today"]
    assert result.status == "complete"


@pytest.mark.parametrize("column,value", [
    (12, "not a date"), (12, ""), (15, "nan"), (15, "infinity"), (15, "200.001"),
    (15, "words"), (17, "-100"), (18, "201"), (20, "101"), (19, "paid-ish"),
    (19, "reimbursed"), (2, "not a timestamp"), (11, "wrong row"),
])
def test_malformed_new_record_cannot_resurrect_old_debt(column, value):
    newest = ledger(2027, allocation())
    newest.rows[1][column] = value
    result = snapshot(ledger(2026, allocation()), newest)
    assert result.outstanding_records == ()
    assert result.excluded_records == 1
    assert result.status == "partial"
    with pytest.raises(history.ReimbursementHistoryUnavailableError):
        result.require_complete()


def test_duplicate_rows_in_one_ledger_are_ambiguous_for_settlement():
    result = snapshot(ledger(2027, allocation(), allocation()))
    assert result.records == ()
    assert result.excluded_records == 1


def test_unknown_header_is_explicitly_incomplete():
    invalid = history.ReimbursementLedger(2027, None, [["unexpected", "columns"], ["data", "data"]])
    result = snapshot(invalid)
    assert result.records == ()
    assert result.status == "partial"


def test_config_discovers_all_owner_years_without_other_owner_or_shared_ids(monkeypatch):
    monkeypatch.setattr(history, "DEFAULT_YEARLY_SHEET_CONFIG", {2026: {"brian_budget_spreadsheet_id": "brian-2026"}})
    monkeypatch.setenv("BRIAN_BUDGET_SPREADSHEET_ID_2001", "brian-2001")
    monkeypatch.setenv("BRIAN_BUDGET_SPREADSHEET_ID_2027", "brian-2027")
    monkeypatch.setenv("BRIAN_BUDGET_SPREADSHEET_ID_2028", "future")
    monkeypatch.setenv("HANNAH_BUDGET_SPREADSHEET_ID_2000", "other-owner")
    assert history.configured_reimbursement_workbooks(BRIAN, 2027) == {
        2001: "brian-2001", 2026: "brian-2026", 2027: "brian-2027"}


def setup_reads(monkeypatch, *, current_sheet, previous_book):
    calls = []
    monkeypatch.setattr(history, "configured_reimbursement_workbooks", lambda *a: {2026: "old-budget", 2027: "current-budget"})
    def current():
        calls.append(("current", get_current_discord_user_id()))
        if isinstance(current_sheet, Exception):
            raise current_sheet
        return current_sheet
    monkeypatch.setattr(history, "get_sheets_repo", lambda: SimpleNamespace(find_shared_reimbursements_sheet=current))
    def open_by_key(key):
        calls.append(("open", key))
        if isinstance(previous_book, Exception):
            raise previous_book
        return previous_book
    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: SimpleNamespace(open_by_key=open_by_key))
    return calls


def test_live_reads_are_owner_scoped_read_only_and_refresh_values(monkeypatch):
    prior = ledger(2026, allocation())
    current = ledger(2027, allocation("new", expense_date="1/2/2027"))
    calls = setup_reads(monkeypatch, current_sheet=current.worksheet,
                        previous_book=SimpleNamespace(worksheet=lambda _title: prior.worksheet))
    result = history.read_reimbursement_history(BRIAN, as_of=NOW)
    assert len(result.outstanding_records) == 2
    assert calls == [("open", "old-budget"), ("current", BRIAN)]
    prior.worksheet.update([_allocation_row(allocation(status="reimbursed", received_amount=100))], "A2:Y2")
    refreshed = history.read_reimbursement_history(BRIAN, as_of=NOW)
    assert [record.allocation.allocation_id for record in refreshed.outstanding_records] == ["new"]
    assert current.worksheet.update_calls == current.worksheet.update_cell_calls == 0


def test_missing_tabs_are_empty_but_failed_reads_are_explicitly_incomplete(monkeypatch):
    def missing(_title):
        raise WorksheetNotFound("Shared Reimbursements")
    setup_reads(monkeypatch, current_sheet=WorksheetNotFound("Shared Reimbursements"),
                previous_book=SimpleNamespace(worksheet=missing))
    assert history.read_reimbursement_history(BRIAN, as_of=NOW).status == "complete"
    setup_reads(monkeypatch, current_sheet=ledger(2027, allocation()).worksheet,
                previous_book=RuntimeError("permission or quota failure"))
    partial = history.read_reimbursement_history(BRIAN, as_of=NOW)
    assert partial.status == "partial"
    assert partial.unavailable_years == (2026,)
    with pytest.raises(history.ReimbursementHistoryUnavailableError):
        partial.require_complete()
    setup_reads(monkeypatch, current_sheet=RuntimeError("failed"), previous_book=RuntimeError("failed"))
    assert history.read_reimbursement_history(BRIAN, as_of=NOW).status == "unavailable"


def test_missing_current_year_config_is_not_complete_empty_history(monkeypatch):
    monkeypatch.setattr(history, "configured_reimbursement_workbooks", lambda *a: {2027: ""})
    result = history.read_reimbursement_history(BRIAN, as_of=NOW)
    assert result.status == "unavailable"
    assert result.unavailable_years == (2027,)


def test_midnight_uses_pacific_date_for_outstanding_cutoff():
    result = snapshot(ledger(2027, allocation("tomorrow", expense_date="1/8/2027")),
                      as_of=datetime.fromisoformat("2027-01-08T03:00:00+00:00"))
    assert result.outstanding_records == ()
    assert result.coverage_payload()["asOf"] == "2027-01-07"
