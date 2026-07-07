from datetime import datetime
import json
import os
import re

import bookiebot.reports.expense_breakdown as expense_breakdown
from bookiebot.reports.expense_breakdown import (
    BudgetHistoryRows,
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
        ["Name:", "Needs (50%):", "Wants (30%):", "Savings (20%):"],
        ["Rent", "$1,750.00"],
        ["PG&E", "$140.00"],
        ["Water", "$60.00"],
        ["Groceries", "$55.00"],
        ["Auto/Gas", "$12.00"],
        ["Static Bills & Subscriptions (Needs)", "$1,410.00"],
        ["DMV Registration", "$184.00"],
        ["(Needs) Subtotal:", "$0.00"],
        ["Eating out", "$30.00"],
        ["Shopping", "$15.00"],
        ["Subscriptions (Wants)", "$10.00"],
        ["Monthly Income", "$3,500.00"],
        ["Margins:", "", "$2,000.00", "", "$750.00"],
        _row(
            {
                "B": "Enter 1st Paycheck Deposit",
                "C": "Ideal $900.00",
                "D": "Minimum $250.00",
                "E": "$250.00",
            }
        ),
        _row(
            {
                "B": "Enter 2nd Paycheck Deposit",
                "C": "Minimum $250.00",
                "D": "Ignore this $999.00",
                "E": "$350.00",
            }
        ),
        _row({"B": "Total Savings Deposited", "E": "$600.00"}),
    ]
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "Wants", "", "(Yearly)"],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["5th", "Netflix", "$15.00", "", "10th", "Spotify", "$10.00", "", "10/29", "Amazon Prime", "$152.90", "", "2/4", "MacroFactor", "$71.99"],
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
            budget_history=(
                BudgetHistoryRows(
                    BudgetMonth(2026, 4),
                    [
                        ["PG&E", "$120.00"],
                        ["Water", "$50.00"],
                    ],
                ),
                BudgetHistoryRows(BudgetMonth(2026, 5), personal_rows),
            ),
        ),
    )

    assert report.grand_total == 3666.0
    assert report.shared_total == 75.0
    assert report.personal_total == 3666.0
    assert report.income_total == 3500.0
    assert report.remaining_budget == 2000.0
    assert report.remaining_wants_budget == 750.0
    assert report.amount_saved == 600.0
    assert report.savings_goal == 900.0
    assert report.breakdown["rent"]["amount"] == 1750.0
    assert report.breakdown["bills_utilities"]["amount"] == 200.0
    assert report.breakdown["static_bills_subscriptions_needs"]["amount"] == 1410.0
    assert report.breakdown["need_expenses"]["amount"] == 184.0
    assert report.breakdown["subscriptions_wants"]["amount"] == 10.0
    assert report.breakdown["grocery"]["amount"] == 55.0
    assert report.breakdown["gas"]["amount"] == 12.0
    assert report.breakdown["food"]["amount"] == 30.0
    assert report.breakdown["shopping"]["amount"] == 15.0
    assert [(item.label, item.amount) for item in report.need_expenses] == [("DMV Registration", 184.0)]
    assert [entry.location for entry in report.entries] == ["Chipotle", "Trader Joe's"]
    assert [entry.location for entry in report.entries if entry.person == "Brian (AL)"] == []
    assert [(entry.label, entry.amount) for entry in report.income_entries] == [
        ("Paycheck", 3000.0),
        ("Side Gig", 500.0),
    ]

    html = render_expense_breakdown_html(report)
    assert "Expense Breakdown" in html
    assert "Budget Charts" in html
    assert "Burn Rate" in html
    assert "bb-burn-rate-active-dot" in html
    assert "bb-pie-metric-label" in html
    assert "bb-pie-metric-label-line" in html
    assert "Food and shopping pace" not in html
    assert "Merchant Concentration" not in html
    assert "Spending By Person / Card" not in html
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
    assert payload["year"] == 2026
    assert payload["month"] == 5
    assert payload["daysInMonth"] == 31
    assert payload["elapsedDays"] == 31
    assert payload["dailyTotals"] == [
        {"label": "1", "amount": 50.0},
        {"label": "2", "amount": 25.0},
    ]
    assert payload["budgetGroups"][0]["label"] == "Needs"
    assert payload["metrics"]["fixedCommitments"] == 3370.0
    assert payload["metrics"]["remainingNeedsBudget"] == 2000.0
    assert payload["metrics"]["remainingWantsBudget"] == 750.0
    assert payload["metrics"]["amountSaved"] == 600.0
    assert payload["metrics"]["savingsGoal"] == 900.0
    burn_rate = payload["burnRate"]
    burn_rate_series = burn_rate.pop("series")
    assert burn_rate == {
        "budget": 795.0,
        "spent": 45.0,
        "remaining": 750.0,
        "daysInMonth": 31,
        "elapsedDays": 31,
        "expectedSpend": 795.0,
        "allowedDailyAverage": 25.65,
        "actualDailyAverage": 1.45,
        "dailyDifference": -24.2,
        "totalDifference": -750.0,
        "status": "under",
    }
    assert len(burn_rate_series) == 31
    assert burn_rate_series[0] == {
        "day": 1,
        "label": "1",
        "dailySpend": 0.0,
        "actualSpend": 0.0,
        "expectedSpend": 25.65,
        "variance": -25.65,
    }
    assert burn_rate_series[1] == {
        "day": 2,
        "label": "2",
        "dailySpend": 45.0,
        "actualSpend": 45.0,
        "expectedSpend": 51.29,
        "variance": -6.29,
    }
    assert burn_rate_series[-1] == {
        "day": 31,
        "label": "31",
        "dailySpend": 0.0,
        "actualSpend": 45.0,
        "expectedSpend": 795.0,
        "variance": -750.0,
    }
    assert "Needs vs Wants" in html
    assert "Fixed Commitments" in html
    assert "Personal Outflows" not in html
    assert "Expense Highlights" in html
    assert "Largest" in html
    assert "Most Frequent" in html
    assert "Largest Expenses" not in html
    assert "Frequent Merchants" not in html
    assert "Largest Shared Expenses" not in html
    assert "Frequent Merchants / Locations" not in html
    assert "bb-subscription-calendar" in html
    assert "bb-subscription-all-grid" in html
    assert "bb-subscription-compact-table" in html
    assert "bb-subscription-tab-content" in html
    assert "bb-subscription-tooltip" in html
    assert "Pull Date" in html
    assert "Kind" not in html
    assert "Subscription calendar and source-of-truth itemized lists" not in html
    assert "Interactive views powered by shadcn/ui patterns and Recharts" not in html
    assert "Shared transaction activity grouped by day" not in html
    assert "React + shadcn/ui" not in html
    assert "Generated " in html
    assert "bb-theme-toggle" in html
    assert "bookiebot-expense-report-theme" in html
    assert "prefers-color-scheme: dark" in html
    assert "data-theme" in html
    assert "Highest day" in html
    assert "Days counted" in html
    assert "Daily Spending" in html
    assert "Need Expenses" in html
    assert "Rent" in html
    assert any(item["label"] == "Bills & Utilities" for item in payload["breakdown"])
    assert payload["needExpenses"] == [
        {"label": "DMV Registration", "amount": 184.0, "group": "Need Expenses", "status": "entered"}
    ]
    assert {item["label"]: item for item in payload["utilityHistory"]} == {
        "PG&E": {
            "key": "pg_e",
            "label": "PG&E",
            "currentAmount": 140.0,
            "averageAmount": 120.0,
            "deltaAmount": 20.0,
            "history": [
                {"label": "Apr", "month": 4, "amount": 120.0},
                {"label": "May", "month": 5, "amount": 140.0},
            ],
        },
        "Water": {
            "key": "water",
            "label": "Water",
            "currentAmount": 60.0,
            "averageAmount": 50.0,
            "deltaAmount": 10.0,
            "history": [
                {"label": "Apr", "month": 4, "amount": 50.0},
                {"label": "May", "month": 5, "amount": 60.0},
            ],
        },
    }
    assert "rentPayments" not in payload
    assert "incomeEntries" not in payload
    assert "Income Entries" not in html
    assert "bb-bills-chart-box" in html
    assert "bb-bill-history-list" in html
    assert "width:fit-content" in html
    assert "bb-card-title-row" in html
    assert "All Shared Expense Transactions" not in html
    assert "Source Sheet Data" not in html
    assert "Personal Budget" not in html
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == ["Amazon Prime", "Netflix"]
    assert [item["name"] for item in payload["subscriptionsWants"]] == ["MacroFactor", "Spotify"]
    assert any(entry["location"] == "Trader Joe's" for entry in payload["dailyEntries"])


def test_subscription_tables_include_yearly_items_outside_selected_month_without_changing_fallback_totals():
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "Wants", "", "(Yearly)"],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["5th", "Netflix", "$15.00", "", "10th", "Spotify", "$10.00", "", "10/29", "Amazon Prime", "$152.90", "", "2/4", "MacroFactor", "$71.99"],
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet([]),
            subscriptions=InMemoryWorksheet(subscriptions_rows),
        ),
    )

    assert report.breakdown["static_bills_subscriptions_needs"]["amount"] == 15.0
    assert report.breakdown["subscriptions_wants"]["amount"] == 10.0

    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == ["Amazon Prime", "Netflix"]
    assert [item["name"] for item in payload["subscriptionsWants"]] == ["MacroFactor", "Spotify"]


def test_current_month_burn_rate_series_only_includes_elapsed_days(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 5, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    shared_rows = [
        ["hdr"] * 28,
        ["hdr"] * 28,
        _row({"N": "07/02/2026", "O": "Lunch", "P": "30", "Q": "Cafe", "R": "Hannah"}),
        _row({"V": "07/05/2026", "W": "Book", "X": "20", "Y": "Bookstore", "Z": "Hannah"}),
    ]
    personal_rows = [
        ["Eating out", "$30.00"],
        ["Shopping", "$20.00"],
        ["Margins:", "", "$10.00", "", "$100.00"],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet(shared_rows),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    burn_rate = payload["burnRate"]

    assert burn_rate["daysInMonth"] == 31
    assert burn_rate["elapsedDays"] == 5
    assert payload["elapsedDays"] == 5
    assert [point["day"] for point in burn_rate["series"]] == [1, 2, 3, 4, 5]
    assert all(point["variance"] is not None for point in burn_rate["series"])


def test_build_expense_breakdown_report_reports_zero_savings_deposits():
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(
                [
                    _row({"B": "Enter 1st Paycheck Deposit", "E": "$0.00"}),
                    _row({"B": "Enter 2nd Paycheck Deposit", "E": "$0.00"}),
                    _row({"B": "Total Savings Deposited", "E": "$0.00"}),
                ]
            ),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    assert report.amount_saved == 0.0
    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert payload["metrics"]["amountSaved"] == 0.0


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
