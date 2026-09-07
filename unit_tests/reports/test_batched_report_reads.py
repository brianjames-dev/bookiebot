import calendar
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

import gspread
from google.auth.credentials import AnonymousCredentials
import pytest

from bookiebot.reports import batched_report_reads as batch, expense_breakdown as reports
from bookiebot.reports.worksheet_reads import read_workbook_tabs
from bookiebot.sheets.reimbursement_history import reimbursement_history_from_ledgers
from bookiebot.sheets.routing import PACIFIC_TZ, MissingMonthWorksheetError, MissingYearConfigError
from unit_tests.reports.test_expense_breakdown import _row
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet

ACTOR = "676638528590970917"
NOW = datetime(2026, 9, 7, 12, tzinfo=PACIFIC_TZ)


def client_for(tabs, failures=()):
    """Real gspread HTTP adapter; every request stops at this synthetic boundary."""
    client = gspread.Client(auth=AnonymousCredentials())
    calls = []
    def request(method, url, **kwargs):
        assert method == "get", "Report snapshots must never mutate sheets"
        assert url.startswith("https://sheets.googleapis.com/v4/spreadsheets/")
        suffix = url.split("/spreadsheets/", 1)[1]
        key = suffix.split("/", 1)[0]
        calls.append((key, suffix, kwargs.get("params")))
        if key in failures:
            raise RuntimeError("Synthetic source unavailable")
        source = tabs[key]
        if suffix.endswith("/values:batchGet"):
            params = kwargs["params"]
            assert params["valueRenderOption"] == "FORMATTED_VALUE"
            result = {"valueRanges": [{"range": title + "!A1:ZZ1000", "values": source[title[1:-1].replace("''", "'")]}
                                       for title in params["ranges"]]}
        else:
            assert suffix == key
            result = {"sheets": [{"properties": {"title": title}} for title in source]}
        return SimpleNamespace(json=lambda: result)
    client.http_client.request = request
    return client, calls


def configure(monkeypatch, years=(2026,), reimbursements=None):
    def personal(actor, year):
        assert actor == ACTOR
        if year not in years:
            raise MissingYearConfigError("Unconfigured synthetic year")
        return f"personal-{year}"
    monkeypatch.setattr(batch, "get_budget_spreadsheet_id_for_user", personal)
    monkeypatch.setattr(batch, "get_shared_expenses_spreadsheet_id", lambda year: f"shared-{year}")
    monkeypatch.setattr(batch, "configured_reimbursement_workbooks", lambda actor, year: reimbursements if reimbursements is not None else {y:f"personal-{y}" for y in years if y <= year})
    monkeypatch.setattr(batch, "now_pacific", lambda: NOW)
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)


def test_workbook_tabs_use_two_real_gspread_reads_and_preserve_formatted_rows():
    client, calls = client_for({"personal": {"September": [["Date", "Amount"], ["9/1/2026"], [], ["", "$1,025.50"]], "Owner's tab": []}})
    result = read_workbook_tabs(client, "personal", ["September", "Missing", "September", "Owner's tab"])
    assert len(calls) == 2
    assert result == {"September": [["Date", "Amount"], ["9/1/2026", ""], ["", ""], ["", "$1,025.50"]], "Owner's tab": [[]]}
    assert read_workbook_tabs(client, "personal", ["Absent"]) == {}
    assert len(calls) == 3, "No existing requested tabs must avoid a values call"


@pytest.mark.parametrize("result", [{}, {"valueRanges": []}, {"valueRanges": [{"range": "August!A1", "values": []}]},
                                      {"valueRanges": [{"values": []}]}, {"valueRanges": [{"range": "September!A1", "values": ["bad row"]}]}])
def test_incomplete_or_misaddressed_values_fail_closed(result):
    client = SimpleNamespace(http_client=SimpleNamespace(
        fetch_sheet_metadata=lambda _: {"sheets": [{"properties": {"title": "September"}}]},
        values_batch_get=lambda *a, **k: result))
    with pytest.raises(ValueError):
        read_workbook_tabs(client, "personal", ["September"])


@pytest.mark.parametrize("metadata", [{}, {"sheets": None}, {"sheets": [{}]}, {"sheets": [{"properties":{"title":""}}]}])
def test_incomplete_metadata_cannot_claim_optional_tabs_are_absent(metadata):
    client = SimpleNamespace(http_client=SimpleNamespace(fetch_sheet_metadata=lambda _: metadata))
    with pytest.raises(ValueError):
        read_workbook_tabs(client, "personal", ["September"])


def test_current_report_batches_four_reads_and_refreshes_values(monkeypatch):
    configure(monkeypatch)
    tabs = {"personal-2026": {"September": [["Monthly Income", "$5,000.00"]], "August": [["PG&E", "$75"]]},
            "shared-2026": {"September": []}}
    client, calls = client_for(tabs)
    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: client)
    from bookiebot.sheets.repo import GSpreadSheetsRepository
    monkeypatch.setattr(reports, "get_sheets_repo", GSpreadSheetsRepository)
    first = reports.load_report_worksheets(ACTOR, reports.BudgetMonth(2026, 9))
    assert len(calls) == 4
    assert [item.month.month for item in first.budget_history] == [8, 9]
    assert first.subscriptions is None and first.bill_schedule is None
    tabs["personal-2026"]["September"][0][1] = "$6,000.00"
    second = reports.load_report_worksheets(ACTOR, reports.BudgetMonth(2026, 9))
    assert len(calls) == 8
    assert first.personal_budget.get_all_values()[0][1] == "$5,000.00"
    assert second.personal_budget.get_all_values()[0][1] == "$6,000.00"
    assert second.reimbursement_history.status == "complete"


@pytest.mark.parametrize("month_number", [1, 2, 5, 8, 9, 12])
def test_batched_report_has_canonical_payload_parity_across_months(monkeypatch, month_number):
    configure(monkeypatch, years=(2025, 2026, 2027))
    month = reports.BudgetMonth(2026, month_number)
    personal = {calendar.month_name[number]: [["Monthly Income", "$5,000.00"], ["PG&E", str(50 + number)],
                 ["Rent", "$1,700.00"], ["Eating out", "$31.00"], ["Shopping", "$7.00"]] for number in range(1,13)}
    subscriptions = [[], ["", "SUBSCRIPTIONS"], [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)"], [],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:"],
        ["1st", "Internet", "$15.00", "", "10th", "Music", "$10.00"]]
    personal["Subscriptions"] = subscriptions
    shared = [["hdr"] * 28, ["hdr"] * 28,
              _row({"N":f"{month_number}/3/2026", "O":"Lunch", "P":"25", "Q":"Cafe", "R":"Brian (BofA)"}),
              _row({"V":"", "W":"Book", "X":"7", "Y":"Store", "Z":"Brian (BofA)"})]
    prior = {"December": [["12/31/2025", "xAI", "$2,500.00"], ["PG&E", "$100"]]}
    following = {"January": [["1/1/2027", "xAI", "$2,500.00"]]}
    client, _ = client_for({"personal-2026":personal, "shared-2026":{month.name:shared},
                            "personal-2025":prior, "personal-2027":following})
    actual = batch.batched_report_worksheets(ACTOR, month, client)
    history = [reports.BudgetHistoryRows(reports.BudgetMonth(2025,12), prior["December"])]
    history.extend(reports.BudgetHistoryRows(reports.BudgetMonth(2026,number), personal[calendar.month_name[number]])
                   for number in range(1,min(month_number+1,12)+1))
    if month_number == 12:
        history.append(reports.BudgetHistoryRows(reports.BudgetMonth(2027,1),following["January"]))
    expected = reports.ReportWorksheets(shared_expenses=InMemoryWorksheet(shared), personal_budget=InMemoryWorksheet(personal[month.name]),
        subscriptions=InMemoryWorksheet(subscriptions), budget_history=tuple(history),
        reimbursement_history=reimbursement_history_from_ledgers(ACTOR, [], as_of=NOW, years=[2025,2026]))
    def payload(worksheets):
        return reports.expense_breakdown_client_payload(reports.build_expense_breakdown_report(
            actor_key=ACTOR, owner_name="Brian", persons=["Brian (BofA)"], month=month, worksheets=worksheets))
    assert payload(actual) == payload(expected)


def test_failed_optional_year_retains_incomplete_reimbursement_coverage(monkeypatch):
    configure(monkeypatch, years=(2025,2026))
    client, calls = client_for({"personal-2026":{"September":[]},"shared-2026":{"September":[]}}, failures={"personal-2025"})
    result = batch.batched_report_worksheets(ACTOR, reports.BudgetMonth(2026,9), client)
    assert result.reimbursement_history.status == "partial"
    assert result.reimbursement_history.unavailable_years == (2025,)
    assert [item.month for item in result.budget_history] == [reports.BudgetMonth(2026,9)]
    assert len([call for call in calls if call[0] == "personal-2025"]) == 1


@pytest.mark.parametrize("failure", ["personal-2026", "shared-2026"])
def test_required_source_failures_propagate(monkeypatch, failure):
    configure(monkeypatch)
    client, _ = client_for({"personal-2026":{"September":[]},"shared-2026":{"September":[]}}, failures={failure})
    with pytest.raises(RuntimeError, match="Synthetic source unavailable"):
        batch.batched_report_worksheets(ACTOR, reports.BudgetMonth(2026,9), client)


def test_missing_required_month_is_not_an_empty_report(monkeypatch):
    configure(monkeypatch)
    client, _ = client_for({"personal-2026":{"August":[]},"shared-2026":{"September":[]}})
    with pytest.raises(MissingMonthWorksheetError):
        batch.batched_report_worksheets(ACTOR, reports.BudgetMonth(2026,9), client)


def test_batched_reimbursements_preserve_cross_year_lineage_and_partial_receipts(monkeypatch):
    from unit_tests.sheets.test_reimbursement_history import allocation, ledger
    configure(monkeypatch, years=(2025,2026))
    original = allocation(expense_date="12/1/2025", created_at="2025-12-01T10:00:00-08:00", updated_at="2025-12-01T10:00:00-08:00")
    latest = replace(original, received_amount=25, updated_at="2026-09-06T10:00:00-07:00")
    prior_ledger, current_ledger = ledger(2025, original), ledger(2026, latest)
    tabs = {"personal-2025":{"December":[], "Shared Reimbursements":prior_ledger.rows},
            "personal-2026":{"September":[], "Shared Reimbursements":current_ledger.rows},
            "shared-2026":{"September":[]}}
    client, calls = client_for(tabs)
    result = batch.batched_report_worksheets(ACTOR, reports.BudgetMonth(2026,9), client)
    assert len(calls) == 6, "Reimbursement and income history share one values batch per annual workbook"
    assert result.reimbursement_history.status == "complete"
    assert len(result.reimbursement_history.outstanding_records) == 1
    record = result.reimbursement_history.outstanding_records[0]
    assert record.year == 2026
    assert record.allocation.outstanding_amount == 75
    assert record.allocation.expense_date == "12/1/2025"
    assert not hasattr(record.worksheet, "update"), "Report snapshots are not settlement write targets"
    assert result.shared_reimbursements.get_all_values() == current_ledger.rows
