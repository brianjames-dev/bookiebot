from datetime import datetime
import json
import os
from pathlib import Path
import re

import pytest

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
from bookiebot.reports.web import _static_report_path_for_payload, _static_report_path_for_request, _verify_expense_report_token
from bookiebot.sheets import routing
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


def _row(values: dict[str, str], width: int = 28) -> list[str]:
    row = [""] * width
    for column, value in values.items():
        index = 0
        for char in column:
            index = index * 26 + (ord(char.upper()) - 64)
        row[index - 1] = value
    return row


class FakeSpreadsheet:
    def __init__(self, worksheets: dict[str, InMemoryWorksheet]):
        self._worksheets = worksheets

    def worksheet(self, title: str):
        if title not in self._worksheets:
            raise ValueError(title)
        return self._worksheets[title]


class FailingOptionalOpenGC:
    def __init__(self, personal_id: str, shared_id: str, personal_sheet: InMemoryWorksheet, shared_sheet: InMemoryWorksheet):
        self.personal_id = personal_id
        self.shared_id = shared_id
        self.personal_sheet = personal_sheet
        self.shared_sheet = shared_sheet
        self.open_counts: dict[str, int] = {}

    def open_by_key(self, key: str):
        self.open_counts[key] = self.open_counts.get(key, 0) + 1
        if key == self.personal_id:
            if self.open_counts[key] > 1:
                raise RuntimeError("optional workbook open failed")
            return FakeSpreadsheet({"May": self.personal_sheet})
        if key == self.shared_id:
            return FakeSpreadsheet({"May": self.shared_sheet})
        raise RuntimeError(key)


def test_parse_budget_month_accepts_names_and_relative_months():
    now = datetime(2026, 7, 2, 12, 0, tzinfo=routing.PACIFIC_TZ)

    assert parse_budget_month(None, now=now) == BudgetMonth(2026, 7)
    assert parse_budget_month("June", now=now) == BudgetMonth(2026, 6)
    assert parse_budget_month("June 2025", now=now) == BudgetMonth(2025, 6)
    assert parse_budget_month("2026-05", now=now) == BudgetMonth(2026, 5)
    assert parse_budget_month("last month", now=now) == BudgetMonth(2026, 6)


def test_daily_spending_bars_share_the_blue_corner_radius():
    source = (Path(__file__).resolve().parents[2] / "web/expense-report/src/report-app.tsx").read_text()
    chart_source = source.split("function DailySpendingChart", 1)[1].split("function dailySpendingYAxisDomain", 1)[0]

    assert "const DAILY_SPENDING_BAR_RADIUS: [number, number, number, number] = [2, 2, 2, 2]" in source
    assert chart_source.count("radius={DAILY_SPENDING_BAR_RADIUS}") == 3
    assert "radius={[6, 6, 2, 2]}" not in chart_source


def test_daily_spending_includes_bills_and_compresses_strong_outliers():
    source = (Path(__file__).resolve().parents[2] / "web/expense-report/src/report-app.tsx").read_text()

    assert '(event.kind !== "subscription" && event.kind !== "bill")' in source
    assert 'event.group === "rent" ? "Rent" : "Bills & Utilities"' in source
    assert 'event.kind === "subscription" && event.group === "subscriptions_wants" ? "wants" : "needs"' in source
    assert "peak >= 500 && referencePeak > 0 && peak >= referencePeak * 2.5" in source
    assert 'data-bb-daily-spending-axis-mode="compressed"' in source
    assert "Axis compressed above {formatMoney(axis.breakAt)}" in source
    assert 'dataKey="chartNeedsAmount"' in source
    assert 'dataKey="chartWantsAmount"' in source
    assert 'dataKey="chartAmount"' in source
    assert "point.needsAmount" in source
    assert "point.wantsAmount" in source


def test_load_report_worksheets_uses_resolved_month_tabs_when_optional_workbook_open_fails(monkeypatch):
    month = BudgetMonth(2026, 5)
    personal_id = routing.get_budget_spreadsheet_id_for_user(routing.DEFAULT_BRIAN_DISCORD_USER_IDS[0], month.year)
    shared_id = routing.get_shared_expenses_spreadsheet_id(month.year)
    personal_sheet = InMemoryWorksheet([["Monthly Income", "$5,000.00"]], title="May")
    shared_sheet = InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28], title="May")
    gc = FailingOptionalOpenGC(personal_id, shared_id, personal_sheet, shared_sheet)

    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: gc)

    worksheets = expense_breakdown.load_report_worksheets(
        routing.DEFAULT_BRIAN_DISCORD_USER_IDS[0],
        month,
    )

    assert worksheets.personal_budget is personal_sheet
    assert worksheets.shared_expenses is shared_sheet
    assert worksheets.subscriptions is None
    assert worksheets.bill_schedule is None
    assert worksheets.budget_history == ()


def test_previous_year_budget_history_loads_prior_december_for_january(monkeypatch):
    december = InMemoryWorksheet([["12/31/2026", "xAI", "$3,774.11"]], title="December")
    spreadsheet = FakeSpreadsheet({"December": december})

    class PreviousYearGC:
        def open_by_key(self, key: str):
            assert key == "budget-2026"
            return spreadsheet

    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: PreviousYearGC())
    monkeypatch.setattr(
        "bookiebot.sheets.routing.get_budget_spreadsheet_id_for_user",
        lambda actor_key, year: f"budget-{year}",
    )

    history = expense_breakdown._optional_previous_year_budget_history(
        "brian",
        BudgetMonth(2027, 1),
    )

    assert history == (
        BudgetHistoryRows(BudgetMonth(2026, 12), [["12/31/2026", "xAI", "$3,774.11"]]),
    )


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

    assert report.grand_total == 2271.0
    assert report.shared_total == 75.0
    assert report.personal_total == 2271.0
    assert report.income_total == 3500.0
    assert report.remaining_budget == -466.0
    assert report.remaining_wants_budget == 995.0
    assert report.amount_saved == 600.0
    assert report.savings_goal == 900.0
    assert report.breakdown["rent"]["amount"] == 1750.0
    assert report.breakdown["bills_utilities"]["amount"] == 200.0
    assert report.breakdown["static_bills_subscriptions_needs"]["amount"] == 15.0
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
    assert "Budget Charts" not in html
    assert "Burn Rate" in html
    assert "bb-burn-rate-active-dot" in html
    assert "bb-pie-metric-label" in html
    assert "bb-pie-metric-label-line" in html
    assert "bb-category-pie-host" in html
    assert "data-bb-pie-fit-padding" in html
    assert "bb-category-pressure" in html
    assert "data-bb-category-balance-alert" in html
    assert "Food and shopping pace" not in html
    assert "Merchant Concentration" not in html
    assert "Spending By Person / Card" not in html
    assert 'id="bookiebot-expense-report-root"' in html
    assert "window.process = window.process ||" in html
    assert "bb-chart-stack" in html
    assert "bb-chart-carousel" in html
    assert "bb-chart-carousel-dot" in html
    assert "bb-metric-toggle" in html
    assert "bb-panel-head" in html
    assert "bb-burn-rate-summary" in html
    assert "bb-signal-strip" not in html
    assert "bb-details-panel" in html
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert [item["label"] for item in payload["breakdown"]][:3] == [
        "Rent",
        "Bills & Utilities",
        "Subs (Needs)",
    ]
    assert payload["year"] == 2026
    assert payload["month"] == 5
    assert payload["daysInMonth"] == 31
    assert payload["elapsedDays"] == 31
    assert payload["dailyTotals"] == [
        {"label": "1", "amount": 50.0},
        {"label": "2", "amount": 25.0},
        {"label": "No date", "amount": 184.0},
    ]
    assert payload["budgetGroups"][0]["label"] == "Needs"
    assert payload["metrics"]["fixedCommitments"] == 1975.0
    assert payload["metrics"]["remainingNeedsBudget"] == -466.0
    assert payload["metrics"]["remainingWantsBudget"] == 995.0
    assert payload["metrics"]["needsRollover"] == 2000.0
    assert payload["metrics"]["wantsRollover"] == 750.0
    assert payload["metrics"]["amountSaved"] == 600.0
    assert payload["metrics"]["savingsGoal"] == 900.0
    assert payload["metrics"]["incomeAfterExpenses"] == 629.0
    assert payload["incomeProjection"] == {"currentAmount": 3500.0, "projectedAmount": 3500.0, "savingsGoal": 700.0}
    burn_rate = payload["burnRate"]
    burn_rate_series = burn_rate.pop("series")
    assert burn_rate == {
        "budget": 584.0,
        "spent": 55.0,
        "remaining": 529.0,
        "daysInMonth": 31,
        "elapsedDays": 31,
        "expectedSpend": 584.0,
        "allowedDailyAverage": 18.84,
        "actualDailyAverage": 1.77,
        "dailyDifference": -17.07,
        "totalDifference": -529.0,
        "status": "under",
    }
    assert len(burn_rate_series) == 31
    assert burn_rate_series[0] == {
        "day": 1,
        "label": "1",
        "dailySpend": 0.0,
        "actualSpend": 0.0,
        "expectedSpend": 18.84,
        "variance": -18.84,
    }
    assert burn_rate_series[1] == {
        "day": 2,
        "label": "2",
        "dailySpend": 45.0,
        "actualSpend": 45.0,
        "expectedSpend": 37.68,
        "variance": 7.32,
    }
    assert burn_rate_series[-1] == {
        "day": 31,
        "label": "31",
        "dailySpend": 0.0,
        "actualSpend": 55.0,
        "expectedSpend": 584.0,
        "variance": -529.0,
    }
    assert "Needs vs Wants" not in html
    assert "Fixed Commitments" not in html
    assert "Personal Outflows" not in html
    assert "Remaining Needs Budget" not in html
    assert "Remaining Wants Budget" not in html
    assert "Income After Expenses" not in html
    assert "Budget remaining" in html
    assert "Wants Left" not in html
    assert "View all" in html
    assert "Expense Highlights" in html
    assert "Largest" in html
    assert "Most Frequent" in html
    assert "Largest Expenses" not in html
    assert "Frequent Merchants" not in html
    assert "Largest Shared Expenses" not in html
    assert "Frequent Merchants / Locations" not in html
    assert "bb-subscription-calendar" in html
    assert "bb-subscription-analytics" in html
    assert "Subs" in html
    assert "bb-subscription-summary" in html
    assert "Projected view" not in html
    assert "Current view" not in html
    assert "Categories" in html
    assert "Bill details" not in html
    assert "bb-bill-history-dot" in html
    assert "bb-chart-carousel-slide" in html
    assert "bb-calendar-day-today" in html
    assert "data-bb-calendar-filter" in html
    assert "data-bb-calendar-static-label" in html
    assert "data-bb-calendar-changing-value" in html
    assert "bb-calendar-marker-transition" in html
    assert "data-bb-pie-layout-motion" in html
    assert "data-bb-pie-layout-travel-x" in html
    assert "data-bb-pie-motion-isolated" in html
    assert "data-bb-pie-animation-synchronized" in html
    assert "--bb-pie-layout-offset-x" in html
    assert "bb-subscription-all-grid" in html
    assert "bb-subscription-compact-table" in html
    assert "bb-subscription-tab-content" in html
    assert "bb-subscription-tooltip" in html
    assert "Pull Date" not in html
    assert "bb-cadence-short" in html
    assert "Kind" not in html
    assert "Subscription calendar and source-of-truth itemized lists" not in html
    assert "Interactive views powered by shadcn/ui patterns and Recharts" not in html
    assert "Shared transaction activity grouped by day" not in html
    assert "React + shadcn/ui" not in html
    assert "Generated " not in html
    assert "bb-theme-toggle" in html
    assert "bb-theme-toggle-icon" in html
    assert "bb-theme-toggle-label" not in html
    assert "bookiebot-expense-report-theme" in html
    assert "prefers-color-scheme: dark" in html
    assert "data-theme" in html
    assert "data-graph-surface" not in html
    assert "bookiebot-dismiss-chart-tooltips" not in html
    assert "bb-touch-tooltip-auto-dismiss" in html
    assert "data-bb-last-transform" in html
    assert "data-bb-tooltip-motion-ready" in html
    assert "data-bb-tooltip-dismiss-revision" in html
    assert "data-bb-chart-interaction-revision" in html
    for trigger in ("projection", "category-mix", "calendar", "daily-spending", "expense-highlights"):
        assert f'data-bb-tooltip-dismiss-trigger":"{trigger}"' in html
    assert "bb-chart-tooltip-frame-dismissing" in html
    assert "bb-theme-toggle-moon" in html
    assert "bb-table-row-divider" in html
    assert "Highest day" in html
    assert "Days counted" in html
    assert "Daily Spending" in html
    assert "bb-daily-spending-grid" in html
    assert "bb-daily-spending-x-axis-label" in html
    assert "Income left" in html
    assert "Need Expenses" not in html
    assert "Need" in html
    assert "Rent" in html
    assert any(item["label"] == "Bills & Utilities" for item in payload["breakdown"])
    assert payload["needExpenses"] == [
        {"label": "DMV Registration", "amount": 184.0, "group": "Need", "status": "entered"}
    ]
    assert payload["topEntries"][0] == {
        "date": "",
        "category": "Need",
        "amount": 184.0,
        "person": "Hannah",
        "item": "DMV Registration",
        "location": "",
    }
    assert [entry["amount"] for entry in payload["topEntries"]] == sorted(
        (entry["amount"] for entry in payload["topEntries"]),
        reverse=True,
    )
    assert {"PG&E", "Water", "Netflix", "Spotify"} <= {
        entry["item"] for entry in payload["topEntries"]
    }
    assert all(entry["item"] != "Rent" for entry in payload["topEntries"])
    assert payload["merchantTotals"][0] == {"label": "DMV Registration", "amount": 184.0}
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
    assert "bb-bills-analytics" in html
    assert "bb-bills-analytics-head" in html
    assert "bb-bills-chart-box" in html
    assert "bb-bill-history-list" in html
    assert "width:fit-content" in html
    assert "bb-card-title-row" in html
    assert "All Shared Expense Transactions" not in html
    assert "Source Sheet Data" not in html
    assert "Personal Budget" not in html
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == ["Netflix"]
    assert [item["name"] for item in payload["subscriptionsWants"]] == ["Spotify"]
    assert any(entry["location"] == "Trader Joe's" for entry in payload["dailyEntries"])
    assert any(
        entry["category"] == "Need"
        and entry["item"] == "DMV Registration"
        and entry["date"] == ""
        for entry in payload["dailyEntries"]
    )


def test_income_entries_parse_shifted_dated_header_layout():
    rows = [
        ["", "Date:", "Source:", "Amount:", "Biweekly Income Source:", "xAI"],
        ["", "07/02/2026", "xAI", "$3,774.59", "Biweekly Income Start:", "07/02/2026"],
        ["", "07/15/2026", "Internet stipend", "$150.00"],
        ["", "", "<Enter Source>", "$0.00"],
        ["", "", "Monthly Income:", "$3,924.59"],
    ]

    entries, total = expense_breakdown._income_entries(rows)
    config = expense_breakdown._income_projection_config(rows)

    assert total == 3924.59
    assert [(entry.label, entry.amount, entry.date) for entry in entries] == [
        ("xAI", 3774.59, "07/02/2026"),
        ("Internet stipend", 150.0, "07/15/2026"),
    ]
    assert config.source_label == "xAI"
    assert config.anchor_date == datetime(2026, 7, 2)


def test_shared_need_expense_section_feeds_need_category_and_daily_activity():
    shared_rows = [
        ["hdr"] * 36,
        ["hdr"] * 36,
        _row(
            {
                "AD": "05/06/2026",
                "AE": "DMV Registration",
                "AF": "184",
                "AG": "DMV",
                "AH": "Hannah",
            },
            width=36,
        ),
        _row(
            {
                "AD": "05/07/2026",
                "AE": "Car repair",
                "AF": "250",
                "AG": "Auto Shop",
                "AH": "Brian (BofA)",
            },
            width=36,
        ),
        _row(
            {
                "AD": "06/01/2026",
                "AE": "Doctor copay",
                "AF": "40",
                "AG": "Kaiser",
                "AH": "Hannah",
            },
            width=36,
        ),
    ]
    personal_rows = [
        ["Name:", "Needs (50%):", "Wants (30%):", "Savings (20%):"],
        ["Legacy Personal Need", "$999.00"],
        ["(Needs) Subtotal:", "$0.00"],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet(shared_rows),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    assert report.breakdown["need_expenses"]["amount"] == 184.0
    assert report.shared_total == 184.0
    assert [(item.label, item.amount, item.status, item.date) for item in report.need_expenses] == [
        ("DMV Registration", 184.0, "entered", "05/06/2026")
    ]
    assert len(report.entries) == 1
    assert report.entries[0] == expense_breakdown.ExpenseEntry(
        date="05/06/2026",
        category="need_expenses",
        amount=184.0,
        person="Hannah",
        item="DMV Registration",
        location="DMV",
    )

    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))

    assert payload["dailyTotals"] == [{"label": "6", "amount": 184.0}]
    assert payload["needExpenses"] == [
        {"label": "DMV Registration", "amount": 184.0, "group": "Need", "status": "entered"}
    ]
    assert payload["topEntries"][0] == {
        "date": "05/06/2026",
        "category": "Need",
        "amount": 184.0,
        "person": "Hannah",
        "item": "DMV Registration",
        "location": "DMV",
    }
    assert payload["merchantTotals"][0] == {"label": "DMV", "amount": 184.0}
    assert payload["merchantOccurrences"][0] == {"label": "DMV", "count": 1, "amount": 184.0}
    assert all(entry["item"] != "Legacy Personal Need" for entry in payload["dailyEntries"])


def test_subscription_tables_and_totals_exclude_yearly_items_outside_selected_month():
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
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == ["Netflix"]
    assert [item["name"] for item in payload["subscriptionsWants"]] == ["Spotify"]
    assert payload["categorySpending"] == {
        "needs": 15.0,
        "wants": 10.0,
        "savings": 0.0,
    }


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
        ["Monthly Income", "$300.00"],
        ["Eating out", "$30.00"],
        ["Shopping", "$20.00"],
        ["Subscriptions (Wants)", "$30.00"],
    ]
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)"],
        ["", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:"],
        ["", "", "", "", "4th", "Spotify", "$10.00"],
        ["", "", "", "", "10th", "Future Want", "$20.00"],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet(shared_rows),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet(subscriptions_rows),
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
    assert burn_rate["spent"] == 60.0
    assert burn_rate["budget"] == 90.0
    assert payload["elapsedDays"] == 5
    assert [point["day"] for point in burn_rate["series"]] == [1, 2, 3, 4, 5]
    assert burn_rate["series"][3]["dailySpend"] == 10.0
    assert burn_rate["series"][-1]["actualSpend"] == 60.0
    assert all(point["variance"] is not None for point in burn_rate["series"])


def test_current_month_subscription_breakdown_uses_hit_so_far_totals(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 5, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "Wants", "", "(Yearly)"],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["1st", "Netflix", "$15.00", "", "4th", "Spotify", "$10.00", "", "7/4", "Amazon Prime", "$100.00", "", "7/6", "MacroFactor", "$72.00"],
        ["10th", "Need Later", "$35.00", "", "10th", "Want Later", "$20.00", "", "", "", "", "", "", "", ""],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(
                [
                    ["Static Bills & Subscriptions (Needs)", "$300.00"],
                    ["Subscriptions (Wants)", "$200.00"],
                ]
            ),
            subscriptions=InMemoryWorksheet(subscriptions_rows),
        ),
    )

    assert report.breakdown["static_bills_subscriptions_needs"]["amount"] == 115.0
    assert report.breakdown["subscriptions_wants"]["amount"] == 10.0
    assert report.budget_breakdown["static_bills_subscriptions_needs"]["amount"] == 150.0
    assert report.budget_breakdown["subscriptions_wants"]["amount"] == 102.0
    assert report.category_spending == {
        "needs": 115.0,
        "wants": 10.0,
        "savings": 0.0,
    }

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == [
        "Amazon Prime",
        "Need Later",
        "Netflix",
    ]
    assert [item["name"] for item in payload["subscriptionsWants"]] == [
        "MacroFactor",
        "Spotify",
        "Want Later",
    ]


def test_report_payload_tracks_merchant_occurrences_by_location_count():
    shared_rows = [
        ["hdr"] * 28,
        ["hdr"] * 28,
        _row({"A": "05/01/2026", "B": "5", "C": "Starbucks", "D": "Hannah"}),
        _row({"A": "05/02/2026", "B": "6", "C": "Starbucks", "D": "Hannah"}),
        _row({"A": "05/03/2026", "B": "100", "C": "Costco", "D": "Hannah"}),
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet(shared_rows),
            personal_budget=InMemoryWorksheet([]),
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

    assert payload["merchantTotals"][0] == {"label": "Costco", "amount": 100.0}
    assert payload["merchantOccurrences"][0] == {"label": "Starbucks", "count": 2, "amount": 11.0}
    assert payload["merchantOccurrences"][1] == {"label": "Costco", "count": 1, "amount": 100.0}
    assert "Occurrences" in html
    assert "bb-hidden-list-panel" in html
    assert "bb-chart-carousel-indicators" in html
    assert "bb-chart-carousel-track" in html
    assert "bb-chart-carousel-track-dragging" in html
    assert "No need expenses found" not in html


def test_current_month_calendar_events_include_projected_income_subscriptions_and_bills(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 5, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "Wants", "", "(Yearly)"],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["1st", "Netflix", "$15.00", "", "4th", "Spotify", "$10.00", "", "", "", "", "", "", "", ""],
        ["10th", "Need Later", "$35.00", "", "20th", "Want Later", "$20.00", "", "", "", "", "", "", "", ""],
    ]
    personal_rows = [
        ["Paycheck", "$2,000.00"],
        ["Rent", "$1,750.00"],
        ["PG&E", "$140.00"],
        ["Static Bills & Subscriptions (Needs)", "$300.00"],
        ["Subscriptions (Wants)", "$200.00"],
    ]
    bill_schedule_rows = [
        BILL_SCHEDULE_HEADERS,
        ["rent", "Rent", "monthly", "1", "", "Rent", "", "", ""],
        ["pge", "PG&E", "monthly", "20", "", "PG&E", "", "", ""],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet(subscriptions_rows),
            bill_schedule=InMemoryWorksheet(bill_schedule_rows),
        ),
    )

    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    events = {(item["kind"], item["label"]): item for item in payload["calendarEvents"]}
    projected_paychecks = [
        item
        for item in payload["calendarEvents"]
        if item["kind"] == "income" and item["label"] == "Projected paycheck"
    ]

    assert payload["incomeProjection"] == {"currentAmount": 2000.0, "projectedAmount": 6000.0, "savingsGoal": 1200.0}
    assert payload["breakdown"][2]["label"] == "Subs (Needs)"
    assert payload["breakdown"][2]["amount"] == 15.0
    assert events[("income", "Paycheck")] == {
        "kind": "income",
        "label": "Paycheck",
        "amount": 2000.0,
        "day": 2,
        "group": "income",
        "projectedOnly": False,
    }
    assert [(item["day"], item["amount"], item["projectedOnly"]) for item in projected_paychecks] == [
        (16, 2000.0, True),
        (30, 2000.0, True),
    ]
    assert events[("subscription", "Need Later")]["day"] == 10
    assert events[("subscription", "Need Later")]["projectedOnly"] is True
    assert events[("bill", "Rent")]["group"] == "rent"
    assert events[("bill", "Rent")]["projectedOnly"] is False
    assert events[("bill", "PG&E")]["group"] == "bills_utilities"
    assert events[("bill", "PG&E")]["day"] == 20
    assert events[("bill", "PG&E")]["projectedOnly"] is True
    assert "Calendar" in html


def test_report_payload_total_expenses_excludes_savings_subtotal():
    personal_rows = [
        ["Monthly Income", "$5,000.00"],
        ["Needs Subtotal", "$2,100.00"],
        ["Wants Subtotal", "$750.00"],
        ["Savings Subtotal", "$1,000.00"],
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
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

    assert report.personal_total == 2850.0
    assert payload["metrics"]["totalExpenses"] == 2850.0
    assert payload["metrics"]["incomeAfterExpenses"] == 2150.0


def test_report_recalculates_totals_from_selected_month_subscription_activity(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 26, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    personal_rows = [
        ["Monthly Income:", "$7,698.22"],
        ["BUDGET: $7,698.22", "$3,849.11", "$2,309.47", "$1,539.64", "Rollover:"],
        ["Name:", "Needs (50%):", "Wants (30%):", "Savings (20%):"],
        ["Rent", "$2,100.00"],
        ["PG&E", "$165.13"],
        ["Recology", "$0.00"],
        ["Water", "$141.43"],
        ["Groceries", "$393.87"],
        ["Auto/Gas", "$235.47"],
        ["Subscriptions (Needs)", "$382.26"],
        ["Various Need Transactions", "$680.31"],
        ["(Needs) Subtotal:", "$4,098.47 (106.48%)", "-$249.36"],
        ["Eating out", "$939.22"],
        ["Shopping", "$214.94"],
        ["Subscriptions (Wants)", "$111.95"],
        ["(Wants) Subtotal:", "$1,266.11 (54.82%)", "$794.00"],
        ["Enter Monthly Savings Contribution", "IDEAL = $1,539.64", "MINIMUM = $769.82", "$1,539.64"],
        ["(Savings) Subtotal:", "$1,539.64", "$794.00"],
        ["Margins:", "-$249.36", "$1,043.36", "$0.00"],
        ["Net Total:", "$794.00"],
    ]
    subscriptions_rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "Wants", "", "(Yearly)"],
        ["" for _ in range(15)],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:", "", "Date:", "Name:", "Amount:"],
        ["1st", "Needs elapsed", "$229.36", "", "1st", "Wants elapsed", "$33.97", "", "10/29", "Amazon Prime", "$152.90", "", "2/4", "MacroFactor", "$71.99"],
        ["", "", "", "", "30th", "Discovery+", "$5.99", "", "", "", "", "", "", "", ""],
    ]
    report = build_expense_breakdown_report(
        actor_key="brian",
        owner_name="Brian",
        persons=["Brian (BofA)", "Brian (AL)"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet(subscriptions_rows),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))

    assert payload["metrics"]["totalExpenses"] == 5133.70
    assert payload["metrics"]["incomeAfterExpenses"] == 1024.88
    assert payload["categoryBudgets"] == {
        "needs": 3849.11,
        "wants": 2309.47,
        "savings": 1539.64,
    }
    assert payload["categorySpending"] == {
        "needs": 3945.57,
        "wants": 1188.13,
        "savings": 1539.64,
    }
    assert payload["budgetGroups"] == [
        {"label": "Needs", "amount": 3945.57},
        {"label": "Wants", "amount": 1188.13},
    ]
    assert payload["categoryBalances"]["remaining"] == {
        "needs": 0.0,
        "wants": 1024.88,
        "savings": 0.0,
    }
    actual_breakdown = {item["key"]: item["amount"] for item in payload["breakdown"]}
    budget_breakdown = {item["key"]: item["amount"] for item in payload["budgetBreakdown"]}
    assert actual_breakdown["static_bills_subscriptions_needs"] == 229.36
    assert actual_breakdown["subscriptions_wants"] == 33.97
    assert budget_breakdown["static_bills_subscriptions_needs"] == 229.36
    assert budget_breakdown["subscriptions_wants"] == 39.96
    assert [item["name"] for item in payload["subscriptionsNeeds"]] == ["Needs elapsed"]
    assert [item["name"] for item in payload["subscriptionsWants"]] == [
        "Discovery+",
        "Wants elapsed",
    ]


def test_report_payload_total_expenses_keeps_zero_savings_subtotal():
    personal_rows = [
        ["Monthly Income", "$5,000.00"],
        ["(Needs) Subtotal:", "$3,400.59 (180.18%)", "", "", "", "-$1,245.94"],
        ["(Wants) Subtotal:", "", "$957.95 (84.60%)", "", "", "-$1,071.51"],
        ["(Savings) Subtotal:", "", "", "", "$0.00", "-$316.59"],
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
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

    assert report.personal_total == 4358.54
    assert payload["metrics"]["totalExpenses"] == 4358.54


def test_needs_subscription_summary_is_not_duplicated_as_an_individual_expense():
    personal_rows = [
        ["Name:", "Needs (50%):", "Wants (30%):", "Savings (20%):"],
        ["Subscriptions (Needs)", "$554.06"],
        ["(Needs) Subtotal:", "$554.06"],
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    assert report.need_expenses == []
    assert report.breakdown["need_expenses"]["amount"] == 0.0
    assert report.personal_total == 554.06


def test_report_payload_prefers_category_rollovers_and_preserves_cross_category_impact():
    personal_rows = [
        ["", "BUDGET: $7,698.22", "$3,849.11", "$2,309.47", "$1,539.64", "Rollover:"],
        ["", "(Needs) Subtotal:", "$4,349.11 (113.00%)", "", "", "-$500.00"],
        ["", "(Wants) Subtotal:", "", "$649.43 (28.12%)", "", "$1,160.04"],
        ["", "Margins:", "-$500.00", "$1,660.04", "$1,539.64"],
    ]
    report = build_expense_breakdown_report(
        actor_key="brian",
        owner_name="Brian",
        persons=["Brian (BofA)"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    assert report.remaining_budget == -500.0
    assert report.remaining_wants_budget == 1660.04
    assert report.remaining_savings_budget == 1539.64
    assert report.needs_rollover == -500.0
    assert report.wants_rollover == 1160.04

    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    assert payload["metrics"]["remainingNeedsBudget"] == -500.0
    assert payload["metrics"]["remainingWantsBudget"] == 1660.04
    assert payload["metrics"]["remainingSavingsBudget"] == 1539.64
    assert payload["metrics"]["needsRollover"] == -500.0
    assert payload["metrics"]["wantsRollover"] == 1160.04
    assert payload["categoryBalances"] == {
        "raw": {"needs": -500.0, "wants": 1660.04, "savings": 1539.64},
        "remaining": {"needs": 0.0, "wants": 1160.04, "savings": 1539.64},
        "deficits": {"needs": 500.0, "wants": 0.0, "savings": 0.0},
        "transfers": [{"from": "wants", "to": "needs", "amount": 500.0}],
        "totalOverspend": 0.0,
    }
    assert payload["burnRate"]["remaining"] == 1160.04
    assert payload["burnRate"]["budget"] == 1160.04


@pytest.mark.parametrize(
    ("raw", "remaining", "transfers", "total_overspend"),
    [
        (
            (-500.0, 200.0, 1000.0),
            {"needs": 0.0, "wants": 0.0, "savings": 700.0},
            [
                {"from": "wants", "to": "needs", "amount": 200.0},
                {"from": "savings", "to": "needs", "amount": 300.0},
            ],
            0.0,
        ),
        (
            (200.0, -500.0, 300.0),
            {"needs": 0.0, "wants": 0.0, "savings": 0.0},
            [
                {"from": "savings", "to": "wants", "amount": 300.0},
                {"from": "needs", "to": "wants", "amount": 200.0},
            ],
            0.0,
        ),
        (
            (200.0, 400.0, -500.0),
            {"needs": 100.0, "wants": 0.0, "savings": 0.0},
            [
                {"from": "wants", "to": "savings", "amount": 400.0},
                {"from": "needs", "to": "savings", "amount": 100.0},
            ],
            0.0,
        ),
        (
            (100.0, -500.0, 300.0),
            {"needs": 0.0, "wants": -100.0, "savings": 0.0},
            [
                {"from": "savings", "to": "wants", "amount": 300.0},
                {"from": "needs", "to": "wants", "amount": 100.0},
            ],
            100.0,
        ),
    ],
)
def test_category_balance_cascade_uses_category_specific_donor_priorities(
    raw,
    remaining,
    transfers,
    total_overspend,
):
    payload = expense_breakdown._cascade_category_balances(*raw)

    assert payload["remaining"] == remaining
    assert payload["transfers"] == transfers
    assert payload["totalOverspend"] == total_overspend


def test_current_month_income_projection_uses_logged_income_date_as_biweekly_anchor(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 5, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet([["07/02/2026", "Paycheck", "$2,000.00"]]),
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
    income_events = [
        item
        for item in payload["calendarEvents"]
        if item["kind"] == "income"
    ]

    assert payload["incomeProjection"] == {"currentAmount": 2000.0, "projectedAmount": 6000.0, "savingsGoal": 1200.0}
    assert [(item["label"], item["day"], item["projectedOnly"]) for item in income_events] == [
        ("Paycheck", 2, False),
        ("Projected paycheck", 16, True),
        ("Projected paycheck", 30, True),
    ]


def test_current_month_income_projection_uses_configured_biweekly_source_and_start(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 5, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(
                [
                    ["Biweekly Income Source", "xAI"],
                    ["Biweekly Income Start", "07/09/2026"],
                    ["xAI", "$2,000.00"],
                    ["Bonus", "$500.00"],
                    ["Monthly Income:", "$2,500.00"],
                ]
            ),
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
    income_events = [
        item
        for item in payload["calendarEvents"]
        if item["kind"] == "income"
    ]

    assert payload["incomeProjection"] == {"currentAmount": 2500.0, "projectedAmount": 4500.0, "savingsGoal": 900.0}
    assert [(item["label"], item["day"], item["amount"], item["projectedOnly"]) for item in income_events] == [
        ("Bonus", 1, 500.0, False),
        ("xAI", 9, 2000.0, False),
        ("Projected paycheck", 23, 2000.0, True),
    ]


@pytest.mark.parametrize(("actual_day", "projected_day"), [(15, 29), (17, 31)])
def test_current_month_income_projection_reanchors_after_early_or_late_paycheck(
    monkeypatch,
    actual_day,
    projected_day,
):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, actual_day, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    report = build_expense_breakdown_report(
        actor_key="brian",
        owner_name="Brian",
        persons=["Brian"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(
                [
                    ["", "Date:", "Source:", "Amount:", "Biweekly Income Source:", "xAI"],
                    ["", "7/2/2026", "xAI", "$3,774.59", "Biweekly Income Start:", "7/2/2026"],
                    ["", "7/15/2026", "internet stipend", "$150.00"],
                    ["", f"7/{actual_day}/2026", "xAI", "$3,773.63"],
                    ["", "Monthly Income:", "", "$7,698.22"],
                ]
            ),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    paycheck_events = [
        item
        for item in payload["calendarEvents"]
        if item["kind"] == "income" and item["label"] in {"xAI", "Projected paycheck"}
    ]

    assert payload["incomeProjection"] == {
        "currentAmount": 7698.22,
        "projectedAmount": 11472.33,
        "savingsGoal": 2294.47,
    }
    assert [(item["label"], item["day"], item["projectedOnly"]) for item in paycheck_events] == [
        ("xAI", 2, False),
        ("xAI", actual_day, False),
        ("Projected paycheck", projected_day, True),
    ]


@pytest.mark.parametrize(
    ("previous_month", "selected_month", "previous_date", "expected_days"),
    [
        (BudgetMonth(2026, 7), BudgetMonth(2026, 8), "7/31/2026", [14, 28]),
        (BudgetMonth(2026, 12), BudgetMonth(2027, 1), "12/31/2026", [14, 28]),
    ],
)
def test_new_month_income_projection_uses_last_prior_month_paycheck(
    monkeypatch,
    previous_month,
    selected_month,
    previous_date,
    expected_days,
):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(selected_month.year, selected_month.month, 2, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    previous_rows = [
        ["", "Date:", "Source:", "Amount:", "Biweekly Income Source:", "xAI"],
        ["", previous_date, "xAI", "$3,774.11", "Biweekly Income Start:", "7/2/2026"],
        ["", "Monthly Income:", "", "$3,774.11"],
    ]
    selected_rows = [
        ["", "Date:", "Source:", "Amount:"],
        ["", "", "<Enter Source>", ""],
        ["", "Monthly Income:", "", "$0.00"],
    ]
    report = build_expense_breakdown_report(
        actor_key="brian",
        owner_name="Brian",
        persons=["Brian (BofA)"],
        month=selected_month,
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(selected_rows),
            subscriptions=InMemoryWorksheet([]),
            budget_history=(
                BudgetHistoryRows(previous_month, previous_rows),
                BudgetHistoryRows(selected_month, selected_rows),
            ),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    income_events = [item for item in payload["calendarEvents"] if item["kind"] == "income"]

    assert payload["incomeProjection"] == {
        "currentAmount": 0.0,
        "projectedAmount": 7548.22,
        "savingsGoal": 1509.64,
    }
    assert [(item["label"], item["day"], item["amount"], item["projectedOnly"]) for item in income_events] == [
        ("Projected paycheck", expected_days[0], 3774.11, True),
        ("Projected paycheck", expected_days[1], 3774.11, True),
    ]


def test_new_month_income_projection_keeps_other_income_actual(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 8, 2, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    previous_rows = [
        ["", "Date:", "Source:", "Amount:", "Biweekly Income Source:", "xAI"],
        ["", "7/31/2026", "xAI", "$3,774.11", "Biweekly Income Start:", "7/2/2026"],
        ["", "Monthly Income:", "", "$3,774.11"],
    ]
    selected_rows = [
        ["", "Date:", "Source:", "Amount:", "Biweekly Income Source:", "xAI"],
        ["", "8/1/2026", "Internet stipend", "$150.00", "Biweekly Income Start:", "7/2/2026"],
        ["", "Monthly Income:", "", "$150.00"],
    ]
    report = build_expense_breakdown_report(
        actor_key="brian",
        owner_name="Brian",
        persons=["Brian (BofA)"],
        month=BudgetMonth(2026, 8),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(selected_rows),
            subscriptions=InMemoryWorksheet([]),
            budget_history=(
                BudgetHistoryRows(BudgetMonth(2026, 7), previous_rows),
                BudgetHistoryRows(BudgetMonth(2026, 8), selected_rows),
            ),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))
    income_events = [item for item in payload["calendarEvents"] if item["kind"] == "income"]

    assert payload["incomeProjection"] == {
        "currentAmount": 150.0,
        "projectedAmount": 7698.22,
        "savingsGoal": 1539.64,
    }
    assert [(item["label"], item["day"], item["amount"], item["projectedOnly"]) for item in income_events] == [
        ("Internet stipend", 1, 150.0, False),
        ("Projected paycheck", 14, 3774.11, True),
        ("Projected paycheck", 28, 3774.11, True),
    ]


def test_current_month_paycheck_supersedes_prior_month_projection_reference():
    config = expense_breakdown.IncomeProjectionConfig(
        source_label="xAI",
        anchor_date=datetime(2026, 7, 2, tzinfo=routing.PACIFIC_TZ),
    )
    current_paycheck = expense_breakdown.PaymentItem(
        "xAI",
        3900.0,
        "income",
        date="8/15/2026",
    )
    prior_paycheck = expense_breakdown.PaymentItem(
        "xAI",
        3774.11,
        "income",
        date="7/31/2026",
    )

    assert expense_breakdown._projected_paycheck_amount(
        [current_paycheck],
        config,
        prior_paycheck,
    ) == 3900.0
    assert expense_breakdown._projected_biweekly_pay_days(
        [current_paycheck],
        BudgetMonth(2026, 8),
        config,
        prior_paycheck,
    ) == [29]


@pytest.mark.parametrize(
    "prior_row",
    [
        ["", "", "xAI", "$3,774.11"],
        ["", "7/31/2026", "Internet stipend", "$150.00"],
    ],
)
def test_prior_month_projection_reference_requires_dated_configured_paycheck(prior_row):
    history = (
        BudgetHistoryRows(
            BudgetMonth(2026, 7),
            [
                ["", "Date:", "Source:", "Amount:"],
                prior_row,
                ["", "Monthly Income:", "", "$3,774.11"],
            ],
        ),
    )

    assert expense_breakdown._prior_month_paycheck_reference(
        history,
        BudgetMonth(2026, 8),
        expense_breakdown.IncomeProjectionConfig(source_label="xAI"),
    ) is None


def test_savings_projection_uses_twenty_percent_of_income_not_paycheck_count(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 17, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    personal_rows = [
        ["", "Date:", "Source:", "Amount:", "Biweekly Income Source:", "xAI"],
        ["", "7/2/2026", "xAI", "$3,774.59", "Biweekly Income Start:", "7/2/2026"],
        ["", "7/15/2026", "internet stipend", "$150.00"],
        ["", "7/17/2026", "xAI", "$3,773.63"],
        ["", "Monthly Income:", "", "$7,698.22"],
        _row(
            {
                "B": "Enter Monthly Savings Contribution",
                "C": "IDEAL = $1,539.64",
                "D": "MINIMUM = $769.82",
                "E": "$2,294.47",
            }
        ),
        _row({"B": "Total Savings Deposited", "E": "$2,294.47"}),
    ]
    report = build_expense_breakdown_report(
        actor_key="brian",
        owner_name="Brian",
        persons=["Brian"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))

    assert report.amount_saved == 2294.47
    assert payload["savingsProjection"] == {
        "currentAmount": 2294.47,
        "projectedAmount": 2294.47,
        "currentIdeal": 1539.64,
        "currentMinimum": 769.82,
        "projectedIdeal": 2294.47,
        "projectedMinimum": 1147.23,
    }


def test_savings_minimum_rounds_ten_percent_of_income_directly(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 10, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    personal_rows = [
        ["", "7/10/2026", "Sonic", "$1,619.47"],
        ["", "Monthly Income:", "", "$1,619.47"],
        _row(
            {
                "B": "Enter Monthly Savings Contribution",
                "C": "IDEAL = $323.89",
                "D": "MINIMUM = $161.95",
                "E": "$0.00",
            }
        ),
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet(personal_rows),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))

    savings = payload["savingsProjection"]
    assert savings["currentAmount"] == 0.0
    assert savings["projectedAmount"] == 0.0
    assert savings["currentIdeal"] == 323.89
    assert savings["currentMinimum"] == 161.95
    assert savings["projectedIdeal"] == 647.79
    assert savings["projectedMinimum"] == 323.89


def test_report_frontend_keeps_saved_amount_actual_and_out_of_spending():
    source = (Path(__file__).resolve().parents[2] / "web/expense-report/src/report-app.tsx").read_text()

    assert "const savings = savingsForMode(report, projected)" in source
    assert "amount: savings.currentAmount" in source
    assert "amount: savings.projectedAmount" not in source
    assert "amountRowsTotal(breakdown) + amountSaved" not in source
    assert 'return filter === "all" && item.key !== "savings"' in source
    assert "amountSaved={activeReport.metrics.amountSaved}" in source
    assert "value={activeReport.metrics.amountSaved}" in source
    assert "incomeAfterExpenses: roundCurrency(budgetRemaining)" in source
    assert "const budgetRemaining = categoryBalanceTotal(categoryBalances)" in source
    assert "categorySpendingForBreakdown(" in source
    assert "projectedCategoryBalances(categoryBudgets, categorySpending)" in source
    assert "budgetData={activeReport.budgetBreakdown}" not in source
    assert "categoryMixRows(data, selectedRollover, filter, amountSaved)" in source
    assert "categoryBudgets={activeReport.categoryBudgets}" in source
    assert "Budget remaining" in source
    assert "usedPercent.toFixed(2)" in source
    assert "<SavingsMetricCard" in source
    assert "savingsMetricDescription" not in source
    assert "savingsPaycheckCount" not in source
    assert "bb-savings-progress-minimum-marker" in source


def test_report_frontend_calendar_largest_and_burn_rate_presentation_regressions():
    source = (Path(__file__).resolve().parents[2] / "web/expense-report/src/report-app.tsx").read_text()

    assert 'value={`${totalEvents.length} total`}' in source
    assert "const outflowTotal = totalEvents" in source
    assert '.filter((item) => item.kind !== "income")' in source
    assert '<CalendarChangingValue value={formatMoney(outflowTotal)} />' in source
    assert 'data-bb-calendar-summary="outflow"' in source
    assert '<div className="bb-subscription-total" data-bb-calendar-static-label="month">' in source
    assert "const largestEntries = topEntries" in source
    assert 'entry.category.trim().toLowerCase() !== "rent"' in source
    assert 'categoryMixPressure("wants", categoryBalances, burnRate.spent)' in source
    assert "Food + Shopping + Wants subscriptions" in source
    assert "after cross-category coverage" in source
    assert 'const dailySpendingDetailsOpen = useMediaQuery("(min-width: 861px)")' in source
    assert "defaultDetailsOpen={dailySpendingDetailsOpen}" in source
    assert '<div className="bb-header-title-row">' in source
    assert "bb-burn-rate-primary" in source


def test_largest_expenses_payload_keeps_all_transactions_in_descending_order():
    shared_rows = [
        ["hdr"] * 28,
        ["hdr"] * 28,
        *[
            _row(
                {
                    "A": f"05/{day:02d}/2026",
                    "B": str(day * 10),
                    "C": f"Merchant {day}",
                    "D": "Hannah",
                }
            )
            for day in range(1, 13)
        ],
    ]
    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 5),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet(shared_rows),
            personal_budget=InMemoryWorksheet([]),
            subscriptions=InMemoryWorksheet([]),
        ),
    )

    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        render_expense_breakdown_html(report),
    )
    assert payload_match is not None
    top_entries = json.loads(payload_match.group(1))["topEntries"]

    assert len(top_entries) == 12
    assert [entry["amount"] for entry in top_entries] == list(range(120, 0, -10))


def test_current_month_calendar_does_not_project_unentered_utility_average(monkeypatch):
    monkeypatch.setattr(
        expense_breakdown,
        "now_pacific",
        lambda: datetime(2026, 7, 5, 12, 0, tzinfo=routing.PACIFIC_TZ),
    )
    bill_schedule_rows = [
        BILL_SCHEDULE_HEADERS,
        ["pge", "PG&E", "monthly", "20", "", "PG&E", "", "", ""],
    ]

    report = build_expense_breakdown_report(
        actor_key="hannah",
        owner_name="Hannah",
        persons=["Hannah"],
        month=BudgetMonth(2026, 7),
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet([]),
            subscriptions=InMemoryWorksheet([]),
            bill_schedule=InMemoryWorksheet(bill_schedule_rows),
            budget_history=(
                BudgetHistoryRows(BudgetMonth(2026, 6), [["PG&E", "$100.00"]]),
                BudgetHistoryRows(BudgetMonth(2026, 7), []),
            ),
        ),
    )

    html = render_expense_breakdown_html(report)
    payload_match = re.search(
        r'<script id="bookiebot-expense-report-data" type="application/json">(.*?)</script>',
        html,
    )
    assert payload_match is not None
    payload = json.loads(payload_match.group(1))

    assert payload["utilityHistory"][0]["currentAmount"] == 0.0
    assert payload["utilityHistory"][0]["averageAmount"] == 100.0
    assert not any(
        item["kind"] == "bill" and item["label"] == "PG&E"
        for item in payload["calendarEvents"]
    )


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
                    _row({"B": "Enter Monthly Savings Contribution", "E": "$0.00"}),
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


def test_completed_expense_report_request_prefers_snapshot_unless_live_requested(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_DIR", str(tmp_path))
    monkeypatch.setattr(
        "bookiebot.reports.web._is_current_expense_report_payload",
        lambda payload: False,
    )
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

    assert _static_report_path_for_request(payload, {"token": "abc"}) == snapshot
    assert _static_report_path_for_request(payload, {"token": "abc", "live": "1"}) is None


def test_current_expense_report_request_renders_live_unless_snapshot_requested(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_DIR", str(tmp_path))
    monkeypatch.setattr(
        "bookiebot.reports.web._is_current_expense_report_payload",
        lambda payload: True,
    )
    filename = "expense-breakdown-brian-2026-08-stale.html"
    snapshot = tmp_path / filename
    snapshot.write_text("<html>stale</html>", encoding="utf-8")
    payload = {
        "actor_key": "brian",
        "owner_name": "Brian",
        "persons": ["Brian (BofA)"],
        "year": 2026,
        "month": 8,
        "filename": filename,
    }

    assert _static_report_path_for_request(payload, {"token": "abc"}) is None
    assert _static_report_path_for_request(payload, {"token": "abc", "snapshot": "1"}) == snapshot
    assert _static_report_path_for_request(payload, {"token": "abc", "live": "1"}) is None


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
