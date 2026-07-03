from datetime import datetime

from bookiebot.reports.expense_breakdown import (
    BudgetMonth,
    ReportWorksheets,
    build_expense_breakdown_report,
    parse_budget_month,
    render_expense_breakdown_html,
    write_expense_breakdown_report,
)
from bookiebot.sheets import routing
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


def _row(values: dict[str, str], width: int = 28) -> list[str]:
    row = [""] * width
    for column, value in values.items():
        index = 0
        for char in column:
            index = index * 26 + (ord(char.upper()) - 64)
        row[index - 1] = value
    return row


def test_parse_budget_month_accepts_names_and_relative_months():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=routing.PACIFIC_TZ)

    assert parse_budget_month(None, now=now) == BudgetMonth(2026, 7)
    assert parse_budget_month("June", now=now) == BudgetMonth(2026, 6)
    assert parse_budget_month("June 2025", now=now) == BudgetMonth(2025, 6)
    assert parse_budget_month("2026-05", now=now) == BudgetMonth(2026, 5)
    assert parse_budget_month("last month", now=now) == BudgetMonth(2026, 6)


def test_build_expense_breakdown_report_aggregates_shared_and_personal_data():
    shared_rows = [
        ["hdr"] * 28,
        ["hdr"] * 28,
        _row({"A": "05/01/2026", "B": "50", "C": "Trader Joe's", "D": "Hannah"}),
        _row({"N": "05/02/2026", "O": "Burrito", "P": "25", "Q": "Chipotle", "R": "Hannah"}),
        _row({"V": "05/03/2026", "W": "Desk", "X": "100", "Y": "IKEA", "Z": "Brian (BofA)"}),
    ]
    personal_rows = [
        ["Rent", "$1,200.00"],
        ["PG&E", "$100.00"],
        ["Water", "$40.00"],
        ["Bus Ticket", "$45.00"],
        ["Monthly Income", "$5,000.00"],
        ["Margins:", "", "$2,000.00"],
    ]
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)"],
        ["", "", "", "", "", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["5th", "Netflix", "$15.00", "", "10th", "Spotify", "$10.00", "", "6/10", "Annual App", "$99.00"],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet(shared_rows),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet(subscriptions_rows),
        ),
    )

    assert report.grand_total == 1485.0
    assert report.shared_total == 75.0
    assert report.personal_total == 1410.0
    assert report.income_total == 5000.0
    assert report.remaining_budget == 2000.0
    assert report.breakdown["rent"]["amount"] == 1200.0
    assert report.breakdown["bills_utilities"]["amount"] == 140.0
    assert report.breakdown["subscriptions"]["amount"] == 25.0
    assert report.breakdown["need_expenses"]["amount"] == 45.0
    assert report.breakdown["grocery"]["amount"] == 50.0
    assert report.breakdown["food"]["amount"] == 25.0
    assert [entry.location for entry in report.entries] == ["Chipotle", "Trader Joe's"]

    html = render_expense_breakdown_html(report)
    assert "Expense Breakdown" in html
    assert "All Shared Expense Transactions" in html
    assert "Source Sheet Data" in html
    assert "Netflix" in html
    assert "Trader Joe" in html


def test_write_expense_breakdown_report_returns_public_url(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "https://bookiebot.example")
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet([["Monthly Income", "$5,000.00"]]),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    page = write_expense_breakdown_report(report, report_dir=tmp_path)

    assert page.path.exists()
    assert page.path.parent == tmp_path
    assert page.url.startswith("https://bookiebot.example/reports/expense-breakdown-hannah-2026-05-")
    assert page.url.endswith(".html")
