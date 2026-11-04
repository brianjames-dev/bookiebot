from datetime import datetime
from pathlib import Path
import subprocess

from bookiebot.reports import expense_breakdown as report
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reports.test_income_projection import income_rows
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


def test_bill_comparison_history_is_separate_from_utility_totals(monkeypatch):
    monkeypatch.setattr(report, "now_pacific", lambda: datetime(2026, 9, 5, tzinfo=PACIFIC_TZ))
    july = report.BudgetHistoryRows(report.BudgetMonth(2026, 7), [["Rent", "2000"], ["Water", "40"]])
    september_rows = income_rows(("9/1/2026", "Salary", "5000")) + [["Rent", "2100"], ["Water", "50"]]
    september = report.BudgetHistoryRows(report.BudgetMonth(2026, 9), september_rows)
    result = report.build_expense_breakdown_report(actor_key="brian", owner_name="Brian", persons=["Brian"],
        month=report.BudgetMonth(2026, 9), worksheets=report.ReportWorksheets(
            shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet(september_rows),
            bill_schedule=InMemoryWorksheet([BILL_SCHEDULE_HEADERS,
                ["rent", "Rent", "monthly", "1", "", "Rent", "", "", ""],
                ["water", "Water", "monthly", "1", "", "Water", "", "", ""]]),
            budget_history=(july, september)))
    payload = report.expense_breakdown_client_payload(result)
    assert {item.label for item in result.utility_history} == {"Water"}
    comparison = {item.label: item for item in result.bill_comparison_history}
    assert set(comparison) == {"Rent", "Water"}
    assert comparison["Rent"].history == [("Jul", 7, 2000), ("Sep", 9, 2100)]
    assert comparison["Rent"].average_amount == 2000
    assert result.breakdown["bills_utilities"]["amount"] == 50
    for view in payload["modeViews"].values():
        assert view["billComparisonHistory"] == payload["billComparisonHistory"]
        assert {item["label"] for item in view["utilityHistory"]} == {"Water"}


def test_bill_selection_and_comparison_runtime():
    root = Path(__file__).resolve().parents[2]
    subprocess.run(["node", "unit_tests/reports/bill_comparison_test.cjs"], cwd=root, check=True, capture_output=True, text=True)
