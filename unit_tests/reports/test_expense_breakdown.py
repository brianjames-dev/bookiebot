from datetime import datetime
import json
import os
import re

from bookiebot.reports.expense_breakdown import (
    BudgetMonth,
    ReportWorksheets,
    build_expense_breakdown_report,
    parse_budget_month,
    render_expense_breakdown_html,
    write_expense_breakdown_report,
)
from bookiebot.reports.web import _static_report_path_for_payload, _verify_expense_report_token
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
        _row({"V": "05/04/2026", "W": "Camera", "X": "300", "Y": "B&H", "Z": "Brian (AL)"}),
    ]
    personal_rows = [
        ["", "Paycheck", "$3,000.00"],
        ["", "Side Gig", "$500.00"],
        ["", "Monthly Income:", ""],
        ["Rent", "$1,750.00"],
        ["PG&E", "$140.00"],
        ["Water", "$60.00"],
        ["Groceries", "$55.00"],
        ["Auto/Gas", "$12.00"],
        ["Static Bills & Subscriptions (Needs)", "$1,410.00"],
        ["Eating out", "$30.00"],
        ["Shopping", "$15.00"],
        ["Subscriptions (Wants)", "$10.00"],
        ["Monthly Income", "$3,500.00"],
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

    assert report.grand_total == 3482.0
    assert report.shared_total == 75.0
    assert report.personal_total == 3482.0
    assert report.income_total == 3500.0
    assert report.remaining_budget == 2000.0
    assert report.breakdown["rent"]["amount"] == 1750.0
    assert report.breakdown["bills_utilities"]["amount"] == 200.0
    assert report.breakdown["static_bills_subscriptions_needs"]["amount"] == 1410.0
    assert report.breakdown["subscriptions_wants"]["amount"] == 10.0
    assert report.breakdown["grocery"]["amount"] == 55.0
    assert report.breakdown["gas"]["amount"] == 12.0
    assert report.breakdown["food"]["amount"] == 30.0
    assert report.breakdown["shopping"]["amount"] == 15.0
    assert [entry.location for entry in report.entries] == ["Chipotle", "Trader Joe's"]
    assert [entry.location for entry in report.entries if entry.person == "Brian (AL)"] == []
    assert [(entry.label, entry.amount) for entry in report.income_entries] == [
        ("Paycheck", 3000.0),
        ("Side Gig", 500.0),
    ]

    html = render_expense_breakdown_html(report)
    assert "Expense Breakdown" in html
    assert "Budget Charts" in html
    assert 'id="bookiebot-expense-report-root"' in html
    assert "window.process = window.process ||" in html
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert [item["label"] for item in payload["breakdown"]][:3] == [
        "Rent",
        "Bills & Utilities",
        "Subscriptions (Needs)",
    ]
    assert payload["dailyTotals"] == [
        {"label": "1", "amount": 50.0},
        {"label": "2", "amount": 25.0},
    ]
    assert payload["budgetGroups"][0]["label"] == "Needs"
    assert "Needs vs Wants" in html
    assert "Highest day" in html
    assert "Daily Spending" in html
    assert "Rent" in html
    assert any(item["label"] == "Bills & Utilities" for item in payload["breakdown"])
    assert payload["rentPayments"] == [{"label": "Rent", "amount": 1750.0, "group": "Rent", "status": "entered"}]
    assert payload["utilityPayments"] == [
        {"label": "PG&E", "amount": 140.0, "group": "Bills & Utilities", "status": "entered"},
        {"label": "Water", "amount": 60.0, "group": "Bills & Utilities", "status": "entered"},
    ]
    assert "All Shared Expense Transactions" not in html
    assert "Source Sheet Data" not in html
    assert "Personal Budget" not in html
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == ["Netflix"]
    assert [item["name"] for item in payload["subscriptionsWants"]] == ["Spotify"]
    assert any(entry["location"] == "Trader Joe's" for entry in payload["dailyEntries"])
    assert [entry["label"] for entry in payload["incomeEntries"]] == ["Paycheck", "Side Gig"]


def test_write_expense_breakdown_report_returns_public_url(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "https://bookiebot.example")
    monkeypatch.setenv("BOOKIEBOT_REPORT_SIGNING_SECRET", "test-secret")
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
    assert page.url.startswith("https://bookiebot.example/reports/expense-breakdown?token=")

    token = page.url.split("token=", 1)[1]
    payload = _verify_expense_report_token(token)
    assert payload["actor_key"] == "hannah"
    assert payload["owner_name"] == "Hannah"
    assert payload["persons"] == ["Hannah"]
    assert payload["year"] == 2026
    assert payload["month"] == 5
    assert payload["filename"] == page.path.name


def test_expense_report_payload_resolves_exact_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_DIR", str(tmp_path))
    filename = "expense-breakdown-brian-2026-06-snapshot.html"
    snapshot = tmp_path / filename
    snapshot.write_text("<html>snapshot</html>", encoding="utf-8")

    payload = {
        "actor_key": "brian",
        "owner_name": "Brian",
        "persons": ["Brian (BofA)"],
        "year": 2026,
        "month": 6,
        "filename": filename,
    }

    assert _static_report_path_for_payload(payload) == snapshot


def test_expense_report_payload_falls_back_to_latest_matching_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_DIR", str(tmp_path))
    older = tmp_path / "expense-breakdown-brian-2026-06-older.html"
    newer = tmp_path / "expense-breakdown-brian-2026-06-newer.html"
    other_month = tmp_path / "expense-breakdown-brian-2026-05-other.html"
    older.write_text("<html>older</html>", encoding="utf-8")
    newer.write_text("<html>newer</html>", encoding="utf-8")
    other_month.write_text("<html>other</html>", encoding="utf-8")
    os.utime(older, (100, 100))
    os.utime(newer, (200, 200))
    os.utime(other_month, (300, 300))

    payload = {
        "actor_key": "brian",
        "owner_name": "Brian",
        "persons": ["Brian (BofA)"],
        "year": 2026,
        "month": 6,
    }

    assert _static_report_path_for_payload(payload) == newer
