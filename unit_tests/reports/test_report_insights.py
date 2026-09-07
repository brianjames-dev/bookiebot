from dataclasses import replace
from datetime import datetime

import pytest

from bookiebot.reports import expense_breakdown as reports
from bookiebot.reports.report_insights import compare_report_periods, metric_explanations
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


NOW = datetime(2026, 9, 7, 12, tzinfo=PACIFIC_TZ)


def base_report(monkeypatch):
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)
    return reports.build_expense_breakdown_report(
        actor_key="676638528590970917", owner_name="Brian", persons=["Brian (BofA)"],
        month=reports.BudgetMonth(2026, 9), worksheets=reports.ReportWorksheets(
            shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet([])),
    )


def test_comparison_sources_keep_real_dates_separate_from_schedule_dates(monkeypatch):
    report = base_report(monkeypatch)
    report.entries = [reports.ExpenseEntry("9/3/2026", "food", 25, "Brian", "Lunch"),
                      reports.ExpenseEntry("", "food", 10, "Brian", "Undated")]
    report.payments = [reports.PaymentItem("Rent", 2000, "rent")]
    report.income_entries = [reports.PaymentItem("Salary", 3000, "income", date="9/4/2026"),
                             reports.PaymentItem("Other income", 100, "income")]
    report.income_total = 3100
    report.personal_total = 2060
    report.calendar_events = [
        reports.CalendarEvent("bill", "Rent", 2000, 1, "rent"),
        reports.CalendarEvent("income", "Other income", 100, 1, "income"),
        reports.CalendarEvent("subscription", "Music", 15, 2, "subscriptions_wants"),
        reports.CalendarEvent("subscription", "Future", 20, 20, "subscriptions_wants", projected_only=True),
    ]
    data = reports.expense_breakdown_client_payload(report)["comparisonData"]
    assert [(item["label"], item["date"]) for item in data["recordedExpenses"]] == [
        ("Lunch", "2026-09-03"), ("Undated", None), ("Rent", None)]
    assert [(item["label"], item["date"]) for item in data["recordedIncome"]] == [("Salary", "2026-09-04"), ("Other income", None)]
    assert [(item["label"], item["amount"]) for item in data["scheduledExpenses"]] == [("Music", 15)]
    assert data["unitemizedExpenses"] == 10
    assert data["unitemizedIncome"] == 0


@pytest.mark.parametrize("income,saved", [(0, 0), (3000, 300), (100.01, 15.99)])
def test_explanations_always_sum_to_each_exact_current_and_projected_metric(monkeypatch, income, saved):
    report = base_report(monkeypatch)
    report.income_total = income
    report.income_entries = [reports.PaymentItem("Salary", income, "income", date="9/4/2026")]
    report.income_projection_config = reports.IncomeProjectionConfig(
        source_label="Salary", mode="fixed monthly", expected_amount=5000)
    report.personal_total = 3050
    report.category_budgets = {"needs": income * .5, "wants": income * .3, "savings": income * .2}
    report.category_spending = {"needs": 3000, "wants": 50, "savings": saved}
    report.breakdown = {"rent": {"label": "Rent", "amount": 3000}, "food": {"label": "Food", "amount": 50}}
    report.amount_saved = saved
    report.savings_deposits = [reports.SavingsDeposit(1, saved, 500, 250)]
    payload = reports.expense_breakdown_client_payload(report)
    keys = {"income": "monthlyIncome", "spent": "totalExpenses", "left": "incomeAfterExpenses", "saved": "amountSaved"}
    for mode in ("current", "projected"):
        for key, metric in keys.items():
            detail = payload["metricExplanations"][mode][key]
            assert detail["value"] == payload["modeViews"][mode]["metrics"][metric]
            assert round(sum(item["amount"] for item in detail["components"]), 2) == detail["value"]
    current = payload["metricExplanations"]["current"]
    projected = payload["metricExplanations"]["projected"]
    assert current["income"]["components"][0]["date"] == "2026-09-04"
    assert projected["income"]["components"][-1]["source"] == "scheduled"
    assert current["saved"]["value"] == projected["saved"]["value"] == saved
    assert "not a bank-account balance" in projected["saved"]["notes"][0]
    assert any("covers" in note for note in current["left"]["notes"]) or income == 0


def test_explanations_preserve_legacy_sheet_totals_and_do_not_invent_transactions(monkeypatch):
    report = base_report(monkeypatch)
    report.income_total = 1000
    report.income_entries = []
    report.personal_total = 150
    report.amount_saved = 25
    payload = reports.expense_breakdown_client_payload(report)
    details = payload["metricExplanations"]["current"]
    assert details["income"]["components"] == [{"label": "Other recorded income from the sheet", "amount": 1000, "source": "sheet", "date": None}]
    assert details["spent"]["components"] == [{"label": "Other sheet outflows", "amount": 150, "source": "sheet", "date": None}]
    assert details["saved"]["components"] == [{"label": "Other saved amount from the sheet", "amount": 25, "source": "sheet", "date": None}]


def test_projected_bill_remainder_is_scheduled_and_large_residual_is_not_called_rounding(monkeypatch):
    report = base_report(monkeypatch)
    report.breakdown = {"rent": {"label": "Rent", "amount": 50}}
    report.personal_total = 50
    report.calendar_events = [reports.CalendarEvent("bill", "Rent", 100, 20, "rent", projected_only=True)]
    payload = reports.expense_breakdown_client_payload(report)
    components = payload["metricExplanations"]["projected"]["spent"]["components"]
    assert [(item["amount"], item["source"]) for item in components] == [(50, "sheet"), (50, "scheduled")]
    payload["modeViews"]["current"]["metrics"]["incomeAfterExpenses"] += 100
    detail = metric_explanations(report, payload)["current"]["left"]
    assert detail["components"][-1]["label"] == "Additional balance from the sheet"
    assert detail["components"][-1]["amount"] == 100


def payload(year, month, expenses, *, scheduled=(), undated=0, adjustment=0, owner="Brian"):
    return {"ownerName": owner, "year": year, "month": month, "comparisonData": {
        "recordedExpenses": [{"date": f"{year}-{month:02d}-{day:02d}", "amount": amount} for day, amount in expenses]
            + ([{"date": None, "amount": undated}] if undated else []),
        "scheduledExpenses": [{"date": f"{year}-{month:02d}-{day:02d}", "amount": amount} for day, amount in scheduled],
        "recordedIncome": [], "unitemizedExpenses": adjustment, "unitemizedIncome": 0,
    }}


def compare(selected, baseline, *, now=NOW, kind="previous-month", baseline_month=None):
    return compare_report_periods(selected, baseline,
        baseline_month=baseline_month or f"{baseline['year']:04d}-{baseline['month']:02d}", baseline_kind=kind, as_of=now)


def test_current_month_compares_matching_elapsed_days_and_excludes_later_baseline_costs():
    result = compare(payload(2026, 9, [(1, 10), (7, 20), (8, 50)]),
                     payload(2026, 8, [(2, 20), (7, 40), (31, 1000)]))
    assert result["throughDay"] == 7
    assert result["selected"]["datedSpending"] == 30
    assert result["baseline"]["datedSpending"] == 60
    assert result["changeAmount"] == -30
    assert result["changePercent"] == -50
    assert result["status"] == "complete"


def test_short_month_clips_both_periods_to_equal_days():
    result = compare(payload(2026, 3, [(28, 10), (30, 500)]), payload(2026, 2, [(28, 20)]))
    assert result["shortMonthAdjusted"] is True
    assert result["throughDay"] == 28
    assert result["selected"]["datedSpending"] == 10
    assert result["changeAmount"] == -10
    assert "Both periods end on day 28" in result["coverageNote"]


def test_previous_year_leap_day_and_pacific_cutoff():
    selected = payload(2024, 2, [(28, 10), (29, 50)])
    baseline = payload(2023, 2, [(28, 20)])
    result = compare(selected, baseline, now=datetime(2024, 2, 29, tzinfo=PACIFIC_TZ), kind="previous-year")
    assert result["throughDay"] == 28
    assert result["changeAmount"] == -10
    result = compare(payload(2026, 9, [(7, 10), (8, 50)]), payload(2026, 8, [(7, 20)]),
                     now=datetime.fromisoformat("2026-09-08T01:00:00+00:00"))
    assert result["throughDay"] == 7
    assert result["selected"]["datedSpending"] == 10


def test_undated_scheduled_and_summary_adjustments_are_explicitly_excluded():
    result = compare(payload(2026, 9, [(1, 10)], scheduled=[(2, 15)], undated=2000, adjustment=-50),
                     payload(2026, 8, [(1, 20)]))
    assert result["status"] == "partial"
    assert result["selected"]["datedSpending"] == 10
    assert result["selected"]["undatedSpending"] == 2000
    assert result["selected"]["scheduledSpending"] == 15
    assert result["selected"]["unitemizedSpending"] == -50
    assert "excluded" in result["coverageNote"]


def test_missing_history_is_unavailable_not_zero_spending_and_zero_baseline_has_no_percentage():
    result = compare(payload(2026, 9, [(1, 10)]), None, baseline_month="2026-08")
    assert result["status"] == "unavailable"
    assert result["baseline"] is None
    assert result["changeAmount"] is None
    result = compare(payload(2026, 9, [(1, 10)]), payload(2026, 8, []))
    assert result["changeAmount"] == 10
    assert result["changePercent"] is None


def test_comparison_rejects_cross_owner_or_wrong_period_payloads():
    with pytest.raises(ValueError, match="same owner"):
        compare(payload(2026, 9, []), payload(2026, 8, [], owner="Hannah"))
    with pytest.raises(ValueError, match="month did not match"):
        compare(payload(2026, 9, []), payload(2026, 8, []), baseline_month="2026-07")


def test_historical_selected_month_against_current_month_clips_both_to_elapsed_days():
    result = compare(payload(2026, 7, [(7, 30), (8, 500)]), payload(2026, 9, [(7, 20), (8, 1000)]), kind="selected-month")
    assert result["throughDay"] == 7
    assert result["selected"]["datedSpending"] == 30
    assert result["baseline"]["datedSpending"] == 20
    assert result["changeAmount"] == 10
    assert "still in progress" in result["coverageNote"]
