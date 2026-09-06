from types import SimpleNamespace

from gspread import Spreadsheet
from gspread.http_client import HTTPClient
import pytest

from bookiebot.reports import expense_breakdown as reports
from bookiebot.reports.expense_breakdown import BudgetMonth
from bookiebot.sheets import auth
from bookiebot.sheets.repo import GSpreadSheetsRepository
from bookiebot.sheets.routing import sheet_user_context


class ReadTransport(HTTPClient):
    """Real gspread Spreadsheet boundary with offline metadata/value responses."""
    def __init__(self):
        self.metadata_calls = 0
        self.value_calls = []
        self.rows = {"January": [["Main Income Source", "xAI"], ["Expected Income Amount", "$3,775.00"], ["Notes"]],
                     "August": [["8/31/2026", "xAI", "$3,100.00"]],
                     "September": [], "October": [["10/1/2026", "xAI", "$3,775.00"]],
                     "December": [["12/31/2026", "xAI", "$3,000.00"]]}

    def fetch_sheet_metadata(self, spreadsheet_id, params=None):
        self.metadata_calls += 1
        return {"properties": {"title": "budget"}, "sheets": [
            {"properties": {"sheetId": i, "title": title, "gridProperties": {"rowCount": 100, "columnCount": 28}}}
            for i, title in enumerate(self.rows)
        ]}

    def values_batch_get(self, spreadsheet_id, ranges, params=None):
        self.value_calls.append((ranges, params))
        return {"valueRanges": [{"range": value_range, "values": self.rows[value_range.strip("'")]}
                                for value_range in ranges]}


def test_history_uses_two_reads_and_retains_settings_empty_month_and_next_month():
    transport = ReadTransport()
    spreadsheet = Spreadsheet(transport, {"id": "offline-budget"})
    transport.metadata_calls = 0  # Spreadsheet construction has its own metadata read.
    history = reports._budget_history_from_spreadsheet(spreadsheet, BudgetMonth(2026, 9))
    assert transport.metadata_calls == 1
    assert transport.value_calls == [(["'January'", "'August'", "'September'", "'October'"], {"valueRenderOption": "FORMATTED_VALUE"})]
    assert [item.month.month for item in history] == [1, 8, 9, 10]
    assert history[0].rows == [["Main Income Source", "xAI"], ["Expected Income Amount", "$3,775.00"], ["Notes", ""]]
    assert history[2].rows == [[]]
    assert history[-1].rows == transport.rows["October"]
    # Do not cache a prior request's settings or adjacent receipts.
    transport.rows["January"][1][1] = "$3,900.00"
    refreshed = reports._budget_history_from_spreadsheet(spreadsheet, BudgetMonth(2026, 9))
    assert refreshed[0].rows[1][1] == "$3,900.00"
    assert history[0].rows[1][1] == "$3,775.00"


def test_previous_year_history_includes_all_available_months_with_one_values_batch(monkeypatch):
    transport = ReadTransport()
    spreadsheet = Spreadsheet(transport, {"id": "offline-budget"})
    monkeypatch.setattr(auth, "get_gspread_client", lambda: SimpleNamespace(open_by_key=lambda _id: spreadsheet))
    monkeypatch.setattr("bookiebot.sheets.routing.get_budget_spreadsheet_id_for_user", lambda actor, year: f"{actor}-{year}")
    history = reports._optional_previous_year_budget_history("owner", BudgetMonth(2027, 1))
    assert [item.month for item in history] == [BudgetMonth(2026, n) for n in (1, 8, 9, 10, 12)]
    assert len(transport.value_calls) == 1


def test_incomplete_batch_cannot_silently_drop_income_history():
    spreadsheet = SimpleNamespace(worksheets=lambda: [SimpleNamespace(title="January")], values_batch_get=lambda *a, **k: {})
    with pytest.raises(ValueError, match="Incomplete budget history"):
        reports._budget_history_from_spreadsheet(spreadsheet, BudgetMonth(2026, 1))


def test_current_report_reads_never_create_optional_sheets(monkeypatch):
    class MissingOptionalBook:
        def worksheet(self, title):
            raise LookupError(title)
        def add_worksheet(self, *args, **kwargs):
            raise AssertionError("A read-only report attempted to create a worksheet")
    book = MissingOptionalBook()
    monkeypatch.setattr(auth, "_get_gc", lambda: SimpleNamespace(open_by_key=lambda _key: book))
    monkeypatch.setattr(reports, "_is_current_month", lambda _month: True)
    monkeypatch.setattr(reports, "_optional_budget_history", lambda *a: ())
    repo = GSpreadSheetsRepository()
    monkeypatch.setattr(repo, "expense_sheet", lambda: "existing expenses")
    monkeypatch.setattr(repo, "income_sheet", lambda: "existing budget")
    monkeypatch.setattr(repo, "subscriptions_sheet", lambda: "existing subscriptions")
    monkeypatch.setattr(repo, "bill_schedule_sheet", lambda: pytest.fail("Report used provisioning getter"))
    monkeypatch.setattr(repo, "shared_reimbursements_sheet", lambda: pytest.fail("Report used provisioning getter"))
    monkeypatch.setattr(reports, "get_sheets_repo", lambda: repo)
    with sheet_user_context("676638528590970917"):
        worksheets = reports.load_report_worksheets("676638528590970917", BudgetMonth(2026, 9))
    assert worksheets.bill_schedule is None
    assert worksheets.shared_reimbursements is None
    assert worksheets.shared_expenses == "existing expenses"
    assert worksheets.personal_budget == "existing budget"
