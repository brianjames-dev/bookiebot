from datetime import datetime
from pathlib import Path
import shutil
import subprocess

import pytest

from bookiebot.reports import expense_breakdown as report
from bookiebot.sheets.savings_plan import ESPP_LABEL, SETTINGS_HEADERS, PLAN_LABELS
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reports.test_income_projection import build, income_rows


def test_monthly_savings_ui_runtime():
    if not shutil.which("node") or not Path("web/expense-report/node_modules/typescript").exists():
        pytest.skip("Frontend test dependencies unavailable")
    subprocess.run(["node", "unit_tests/reports/monthly_savings_ui_test.cjs"], check=True, capture_output=True, text=True)


def plan_rows(*entries, first="2026-09-11", source="xAI", saved=1200, projection="off", expected="3800"):
    return income_rows(*entries, settings=(
        ("Main Income Source", source), ("Income Projection Mode", projection),
        ("Expected Income Amount", expected), ("Paycheck Anchor Date", "2026-09-11"),
        tuple(PLAN_LABELS), (source, "5%", first, "15%", "7.5%", ""),
        ("Enter Monthly Savings Contribution", "IDEAL = $999", "MINIMUM = $499", str(saved)),
    ))


@pytest.fixture(autouse=True)
def september(monkeypatch):
    monkeypatch.setattr(report, "now_pacific", lambda: datetime(2026, 9, 15, tzinfo=PACIFIC_TZ))


def test_app_sheet_targets_agent_details_and_money_left_share_cash_basis():
    result = build(plan_rows(("9/11/2026", "xAI paycheck", "7600"), ("9/12/2026", "Rewards", "1000")))
    payload = report.expense_breakdown_client_payload(result)
    for mode in ("current", "projected"):
        view = payload["modeViews"][mode]
        assert view["metrics"]["monthlyIncome"] == 8600
        assert view["metrics"]["amountSaved"] == 1200
        assert view["metrics"]["savingsIdeal"] == 1400
        assert view["metrics"]["savingsMinimum"] == 700
        assert view["metrics"]["incomeAfterExpenses"] == 7400
        assert view["savingsInvesting"]["esppContribution"] == 400
        assert view["savingsInvesting"]["combinedContributions"] == 1600
        assert view["categoryBudgets"] == {"needs": 4500, "wants": 2700, "savings": 1400}
    assert payload["incomeProjection"]["savingsGoal"] == 1400
    assert payload["metricExplanations"]["current"]["saved"]["value"] == 1200


def test_projection_estimates_only_remaining_enrolled_paychecks_and_keeps_cash_saved_actual():
    result = build(plan_rows(("9/11/2026", "xAI", "3800"), ("9/12/2026", "Rewards", "100"), projection="biweekly", saved=300))
    payload = report.expense_breakdown_client_payload(result)
    current, projected = (payload["modeViews"][mode] for mode in ("current", "projected"))
    assert current["savingsInvesting"]["esppContribution"] == 200
    assert projected["savingsInvesting"]["esppContribution"] == 400
    assert projected["metrics"]["monthlyIncome"] == 7700
    assert projected["metrics"]["savingsIdeal"] == 1220
    assert projected["metrics"]["savingsMinimum"] == 610
    assert projected["metrics"]["amountSaved"] == 300
    assert projected["metrics"]["incomeAfterExpenses"] == 7400
    assert payload["savingsInvesting"]["history"]["totalContributed"] == 200


def test_future_start_and_pending_start_do_not_reclassify_paychecks():
    for first in ("2026-10-01", ""):
        payload = report.expense_breakdown_client_payload(build(plan_rows(("9/11/2026", "xAI", "7600"), first=first)))
        assert payload["savingsProjection"]["currentIdeal"] == 1520
        assert payload["savingsInvesting"]["current"]["esppContribution"] == 0


def test_legacy_other_owner_does_not_inherit_enrollment_from_employer():
    payload = report.expense_breakdown_client_payload(build(income_rows(("9/11/2026", "xAI", "7600"))))
    assert "savingsInvesting" not in payload
    assert payload["savingsProjection"]["currentIdeal"] == 1520


def test_history_uses_each_months_plan_and_excludes_future_and_projection():
    august = report.BudgetHistoryRows(report.BudgetMonth(2026, 8), plan_rows(("8/28/2026", "xAI", "3800"), first="2026-08-01"))
    future = report.BudgetHistoryRows(report.BudgetMonth(2026, 10), plan_rows(("10/9/2026", "xAI", "9999"), first="2026-08-01"))
    payload = report.expense_breakdown_client_payload(build(
        plan_rows(("9/11/2026", "xAI", "3800"), first="2026-08-01", projection="biweekly"), [future, august],
    ))
    assert payload["savingsInvesting"]["history"] == {
        "totalContributed": 400, "throughMonth": "2026-09", "coverage": "complete", "unavailableMonths": [],
        "source": "Calculated from available monthly payroll records",
    }


def test_missing_program_month_is_visible_as_partial_history():
    payload = report.expense_breakdown_client_payload(build(plan_rows(("9/11/2026", "xAI", "3800"), first="2026-08-01")))
    assert payload["savingsInvesting"]["history"]["coverage"] == "partial"
    assert payload["savingsInvesting"]["history"]["unavailableMonths"] == ["2026-08"]


def test_paycheck_correction_delete_and_restore_recompute_without_a_separate_espp_record():
    for amount, espp, target in [(7600, 400, 1200), (3800, 200, 600), (0, 0, 0), (7600, 400, 1200)]:
        payload = report.expense_breakdown_client_payload(build(plan_rows(("9/11/2026", "xAI", str(amount)), saved=0)))
        assert payload["savingsInvesting"]["current"]["esppContribution"] == espp
        assert payload["savingsProjection"]["currentIdeal"] == target


@pytest.mark.parametrize("inline", [False, True])
def test_compact_sheet_uses_annual_settings_in_current_projected_and_history(monkeypatch, inline):
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
    monkeypatch.setattr(report, "now_pacific", lambda: datetime(2026,10,24,tzinfo=PACIFIC_TZ))
    settings = [list(SETTINGS_HEADERS), ["10/23/2026", "", "xAI", "5%"],
                ["11/1/2026", "", "New employer", "4%"]]
    rows = income_rows(("10/9/2026","xAI","3800"), ("10/23/2026","xAI","3800"),
        ("10/24/2026","Rewards","100"), settings=(
            (ESPP_LABEL,"200"), ("Main Income Source","xAI"), ("Income Projection Mode","biweekly"),
            ("Expected Income Amount","3800"), ("Paycheck Anchor Date","10/9/2026"),
            ("Enter Monthly Savings Contribution","IDEAL = $1380","MINIMUM = $690","300")))
    if inline:
        rows=settings+rows
        settings=None
    result = report.build_expense_breakdown_report(actor_key="brian",owner_name="Brian",persons=["Brian"],
        month=report.BudgetMonth(2026,10), worksheets=report.ReportWorksheets(
            shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet(rows),
            savings_settings_rows=settings))
    payload=report.expense_breakdown_client_payload(result)
    for mode in ("current","projected"):
        view=payload["modeViews"][mode]
        assert view["savingsInvesting"]["esppContribution"]==200
        assert view["metrics"]["savingsIdeal"]==1380
        assert view["metrics"]["savingsMinimum"]==690
        assert view["metrics"]["amountSaved"]==300
    assert payload["savingsInvesting"]["history"]["totalContributed"]==200
    assert payload["savingsPlan"]["source"]=="xAI"  # Future employer does not change October's basis.


@pytest.mark.parametrize("inline", [False, True])
def test_compact_historical_months_keep_their_own_annual_schedule(inline):
    prior_settings=[list(SETTINGS_HEADERS), ["8/1/2026","","xAI","5%"]]
    future_settings=[list(SETTINGS_HEADERS), ["8/1/2026","","xAI","4%"]]
    august=report.BudgetHistoryRows(report.BudgetMonth(2026,8),
        income_rows(("8/28/2026","xAI","3800"),settings=((ESPP_LABEL,"200"),)),prior_settings)
    september=income_rows(("9/11/2026","xAI","3840"),settings=((ESPP_LABEL,"160"),))
    if inline:
        august=report.BudgetHistoryRows(august.month,prior_settings+august.rows)
        september=future_settings+september
        future_settings=None
    selected=report.BudgetHistoryRows(report.BudgetMonth(2026,9),september,future_settings)
    payload=report.expense_breakdown_client_payload(build(september,[august,selected]))
    assert payload["savingsInvesting"]["history"]["totalContributed"]==360
