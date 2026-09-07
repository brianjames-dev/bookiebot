"""Phone comparison traffic regression at the actual gspread HTTP boundary.

Only the HTTP response transport, authenticated identity and clock are fixtures.
The routes, build queue, annual reads, gspread request serialization and report
calculations all run normally. No request can reach a real workbook or network.
"""
from __future__ import annotations

import calendar
from copy import deepcopy
from datetime import datetime
import json
import os
import re
from threading import Lock
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlsplit

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from google.auth.credentials import AnonymousCredentials
from gspread import Client
import pytest
from requests import PreparedRequest, Response, Session

from bookiebot.reports import expense_breakdown as reports
from bookiebot.reports import batched_report_reads, comparison_reads
from bookiebot.reports import phone_app, phone_history, web as reports_web
from bookiebot.reports.report_insights import compare_report_periods
from bookiebot.sheets import auth, reimbursement_history, repo, routing
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.collaboration import SHARED_REIMBURSEMENT_HEADERS
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


ACTOR = "676638528590970917"
NOW = datetime(2026, 9, 7, 12, tzinfo=routing.PACIFIC_TZ)
PERSONAL = "offline-brian-budget-2026"
SHARED = "offline-shared-expenses-2026"


def _row(cells: dict[str, str]) -> list[str]:
    values = [""] * 34
    for column, value in cells.items():
        index = 0
        for character in column:
            index = index * 26 + ord(character) - ord("A") + 1
        values[index - 1] = value
    return values


def _workbooks() -> dict[str, dict[str, list[list[str]]]]:
    books: dict[str, dict[str, list[list[str]]]] = {PERSONAL: {}, SHARED: {}}
    for month in range(1, 13):
        title = calendar.month_name[month]
        books[SHARED][title] = [
            ["Category headings"], ["Transaction headings"],
            _row({"N": f"{month}/3/2026", "O": "Lunch", "P": str(100 + month), "Q": "Cafe", "R": "Brian (BofA)"}),
            _row({"A": f"{month}/5/2026", "B": str(40 + month), "C": "Market", "D": "Brian (BofA)"}),
            _row({"N": f"{month}/20/2026", "O": "Later meal", "P": "500", "R": "Brian (BofA)"}),
            _row({"N": f"{month}/2/2026", "O": "Other owner", "P": "9000", "R": "Hannah"}),
            _row({"N": f"{month}/2/2026", "O": "Other account", "P": "8000", "R": "Brian (AL)"}),
        ]
        books[PERSONAL][title] = [
            ["Date", "Source", "Amount"],
            [f"{month}/2/2026", "Salary", str(3000 + month)],
            [f"{month}/20/2026", "Salary", "1000"],
            ["", "Monthly Income:", ""],
            ["Name:", "Needs (50%):", "Wants (30%):", "Savings (20%):"],
            ["Rent", str(1500 + month)], ["PG&E", str(50 + month)],
            ["Groceries", str(40 + month)], ["Auto/Gas", "0"],
            ["Static Bills & Subscriptions (Needs)", "12"],
            ["DMV Registration", str(35 + month)],  # Legacy personal Needs entry
            ["(Needs) Subtotal:", "0"],
            ["Eating out", str(600 + month)], ["Shopping", "0"],
            ["Subscriptions (Wants)", "15"],
            ["Monthly Income", str(4000 + month)],
            ["Income Projection Mode", "off"],
            _row({"B": "Enter 1st Paycheck Deposit", "C": "Ideal $500", "D": "Minimum $250", "E": "250"}),
            _row({"B": "Total Savings Deposited", "E": "250"}),
        ]
    books[PERSONAL]["Subscriptions"] = [
        [], ["", "SUBSCRIPTIONS"], [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "Wants", "", "(Yearly)"],
        [],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["5th", "Cloud storage", "12", "", "3rd", "Music", "15"],
    ]
    books[PERSONAL]["_BookieBot Bill Schedule"] = [
        BILL_SCHEDULE_HEADERS,
        ["rent", "Rent", "monthly", "1", "", "Rent", "", "", ""],
        ["pge", "PG&E", "monthly", "18", "", "PG&E", "", "", ""],
    ]
    books[PERSONAL]["Shared Reimbursements"] = [SHARED_REIMBURSEMENT_HEADERS]
    return books


class OfflineSheetsSession(Session):
    """Count prepared HTTP reads, including hidden gspread metadata requests."""

    def __init__(self, books):
        super().__init__()
        self.books = books
        self.reads: list[str] = []
        self.attempts: list[tuple[str | None, str]] = []
        self.lock = Lock()

    def send(self, request: PreparedRequest, **kwargs) -> Response:
        # Fail before any socket/credential work. This catches Drive discovery,
        # accidental provisioning and any other unexpected transport operation.
        with self.lock:
            self.attempts.append((request.method, str(request.url)))
        assert request.method == "GET", f"Report attempted a mutation: {request.method}"
        url = urlsplit(str(request.url))
        assert url.netloc == "sheets.googleapis.com", f"Unexpected external service: {url.netloc}"
        match = re.fullmatch(r"/v4/spreadsheets/([^/]+)(.*)", unquote(url.path))
        assert match, f"Unexpected Sheets endpoint: {url.path}"
        key, operation = match.groups()
        assert key in self.books, f"Unexpected owner/year workbook: {key}"
        with self.lock:
            self.reads.append(str(request.url))
            tabs = self.books[key]
            if operation == "":
                payload = {"spreadsheetId": key, "properties": {"title": key}, "sheets": [
                    {"properties": {"sheetId": index, "title": title,
                                    "gridProperties": {"rowCount": 100, "columnCount": 34}}}
                    for index, title in enumerate(tabs)
                ]}
            elif operation == "/values:batchGet":
                query = parse_qs(url.query)
                assert query.get("valueRenderOption") == ["FORMATTED_VALUE"]
                payload = {"spreadsheetId": key, "valueRanges": [
                    self._values(tabs, selected) for selected in query["ranges"]
                ]}
            elif operation.startswith("/values/"):
                payload = self._values(tabs, operation.removeprefix("/values/"))
            else:
                raise AssertionError(f"Unexpected Sheets read: {operation}")
            response = Response()
            response.status_code = 200
            response.url = str(request.url)
            response.request = request
            response.headers["Content-Type"] = "application/json"
            response._content = json.dumps(payload).encode("utf-8")
            return response

    @staticmethod
    def _values(tabs, selected):
        title = selected.rsplit("!", 1)[0]
        if title.startswith("'") and title.endswith("'"):
            title = title[1:-1].replace("''", "'")
        assert title in tabs, f"Values requested for absent worksheet: {title}"
        return {"range": f"'{title}'!A1:AH100", "majorDimension": "ROWS", "values": deepcopy(tabs[title])}


def _canonical(books, month):
    """Reference assembly deliberately bypasses all new transport/cache code."""
    title = calendar.month_name[month]
    worksheets = reports.ReportWorksheets(
        shared_expenses=InMemoryWorksheet(deepcopy(books[SHARED][title]), title=title),
        personal_budget=InMemoryWorksheet(deepcopy(books[PERSONAL][title]), title=title),
        subscriptions=InMemoryWorksheet(deepcopy(books[PERSONAL]["Subscriptions"])),
        bill_schedule=InMemoryWorksheet(deepcopy(books[PERSONAL]["_BookieBot Bill Schedule"])),
        shared_reimbursements=InMemoryWorksheet(deepcopy(books[PERSONAL]["Shared Reimbursements"])),
        budget_history=tuple(reports.BudgetHistoryRows(
            reports.BudgetMonth(2026, number), deepcopy(books[PERSONAL][calendar.month_name[number]]),
        ) for number in range(1, min(month + 1, 12) + 1)),
    )
    report = reports.build_expense_breakdown_report(
        actor_key=ACTOR, owner_name="Brian", persons=["Brian (BofA)"],
        month=reports.BudgetMonth(2026, month), worksheets=worksheets,
    )
    return reports.expense_breakdown_client_payload(report)


@pytest.mark.asyncio
async def test_phone_many_comparison_months_and_fresh_refresh_fit_one_read_budget(monkeypatch):
    books = _workbooks()
    transport = OfflineSheetsSession(books)
    client = Client(AnonymousCredentials(), session=transport)
    # Isolate from workstation configuration, previous tests and live auth.
    for name in list(os.environ):
        if re.fullmatch(r"(?:BRIAN_BUDGET|HANNAH_BUDGET|SHARED_EXPENSES)_SPREADSHEET_ID_\d{4}", name):
            monkeypatch.delenv(name)
    monkeypatch.setenv("BRIAN_BUDGET_SPREADSHEET_ID_2026", PERSONAL)
    monkeypatch.setenv("HANNAH_BUDGET_SPREADSHEET_ID_2026", "offline-hannah-must-not-read")
    monkeypatch.setenv("SHARED_EXPENSES_SPREADSHEET_ID_2026", SHARED)
    monkeypatch.delenv("BRIAN_EXPENSE_PAYMENT_METHODS", raising=False)
    monkeypatch.setattr(auth, "_GC", client)
    for name in ("_MONTH_WORKSHEET_BY_KEY", "_ACTION_LOG_WORKSHEET_BY_TITLE", "_SUBSCRIPTION_SCHEDULE_WORKSHEET_BY_KEY",
                 "_BILL_SCHEDULE_WORKSHEET_BY_KEY", "_SHARED_REIMBURSEMENTS_WORKSHEET_BY_KEY"):
        monkeypatch.setattr(auth, name, {})
    monkeypatch.setattr(repo, "_REPO", repo.GSpreadSheetsRepository())
    for module in (routing, auth, reports, phone_app, phone_history, reimbursement_history, batched_report_reads, comparison_reads):
        monkeypatch.setattr(module, "now_pacific", lambda: NOW)

    async def session(_request):
        return SimpleNamespace(actor_key=ACTOR, owner_key="brian")

    monkeypatch.setattr(phone_app, "_session", session)
    app = web.Application()
    builds = app[reports_web._REPORT_BUILDS] = reports_web._ReportBuilds()
    app.router.add_get("/app/expenses/data", phone_app._report_data)
    phone_history.register_phone_history_routes(app)

    async def read(http, path):
        response = await http.get(path)
        result = await response.json()
        assert response.status == 200, (path, result, transport.reads)
        assert response.headers["Cache-Control"] == "private, no-store"
        return result

    async def compare(http, month):
        result = await read(http, f"/app/expenses/comparison?month=2026-09&compare_month=2026-{month:02d}")
        reference = compare_report_periods(
            _canonical(books, 9), _canonical(books, month), baseline_month=f"2026-{month:02d}",
            baseline_kind="selected-month", as_of=NOW,
        )
        assert result == reference
        assert result["throughDay"] == 7
        assert result["status"] == "partial"
        assert result["selected"]["undatedSpending"] == 1612  # Rent + PG&E + legacy Needs
        assert result["selected"]["scheduledSpending"] == 27  # Schedule is not a receipt
        # Day 20, the other owner and Brian's non-default account are excluded.
        assert result["baseline"]["datedSpending"] < 1000
        return result

    try:
        async with TestClient(TestServer(app)) as http:
            initial = await read(http, "/app/expenses/data")
            assert initial["comparisonData"] == _canonical(books, 9)["comparisonData"]
            assert [item["amount"] for item in initial["comparisonData"]["recordedExpenses"]
                    if item["category"] == "need_expenses"] == [44]
            initial_metrics = initial["modeViews"]["current"]["metrics"]
            assert initial_metrics == _canonical(books, 9)["modeViews"]["current"]["metrics"]
            before = {}
            for month in range(1, 9):
                before[month] = await compare(http, month)
            assert len(before) == 8
            reads_before_refresh = len(transport.reads)

            # Simulate an external edit. A manual report refresh must invalidate
            # the comparison snapshot, including already-visited past months.
            books[SHARED]["September"][2][15] = "159"  # +50 in dated food
            books[SHARED]["August"][2][15] = "138"  # +30 in the baseline
            books[PERSONAL]["September"][1][2] = "3209"  # +200 in dated income
            for row in books[PERSONAL]["September"]:
                if row and row[0] == "Monthly Income":
                    row[1] = "4209"
            refreshed = await read(http, "/app/expenses/data")
            assert len(transport.reads) > reads_before_refresh, "Manual refresh must perform fresh source reads"
            assert refreshed["comparisonData"] == _canonical(books, 9)["comparisonData"]
            assert refreshed["modeViews"]["current"]["metrics"]["monthlyIncome"] == initial_metrics["monthlyIncome"] + 200
            after = {}
            for month in (8, 1, 7, 2, 6, 3, 5, 4):
                after[month] = await compare(http, month)
            assert after[8]["selected"]["datedSpending"] == before[8]["selected"]["datedSpending"] + 50
            assert after[8]["baseline"]["datedSpending"] == before[8]["baseline"]["datedSpending"] + 30
            assert after[8]["changeAmount"] == before[8]["changeAmount"] + 20
    finally:
        await builds.close()
        transport.close()

    assert len(transport.reads) <= 20, f"Phone refresh + 16 comparisons exhausted the read budget ({len(transport.reads)}): {transport.reads}"
    # Optional-source exception handling must not hide forbidden attempts.
    assert transport.attempts == [("GET", url) for url in transport.reads]
    assert any("/values:batchGet?" in url for url in transport.reads)
