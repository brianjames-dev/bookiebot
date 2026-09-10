from datetime import datetime

import pytest

from bookiebot.reports import expense_breakdown as reports
from bookiebot.reports.widget_summaries import report_content
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


def _outflows(payload):
    return [event for event in payload["calendarEvents"] if event["kind"] != "income"]


def _schedule(expected="59"):
    return [
        BILL_SCHEDULE_HEADERS,
        ["student_loan", "Student Loan", "monthly", "12", "", "Student Loan", "", "", "", expected],
    ]


def _report(monkeypatch, rows, *, month=9, today=9, schedule=None, subscriptions=None, history=()):
    monkeypatch.setattr(reports, "now_pacific", lambda: datetime(2026, 9, today, 12, tzinfo=PACIFIC_TZ))
    report = reports.build_expense_breakdown_report(
        actor_key="brian", owner_name="Brian", persons=["Brian"], month=reports.BudgetMonth(2026, month),
        worksheets=reports.ReportWorksheets(
            shared_expenses=InMemoryWorksheet([]),
            personal_budget=InMemoryWorksheet([["Monthly Income", "$1,000"], *rows]),
            subscriptions=InMemoryWorksheet(subscriptions or []),
            bill_schedule=InMemoryWorksheet(_schedule() if schedule is None else schedule),
            budget_history=history,
        ),
    )
    return report, reports.expense_breakdown_client_payload(report)


@pytest.mark.parametrize("actual", ["", "$0.00"])
@pytest.mark.parametrize("today", [9, 18])
def test_expected_bill_stays_projected_even_after_its_due_day(monkeypatch, actual, today):
    report, payload = _report(monkeypatch, [["Student Loan", actual]], today=today)
    current, projected = payload["modeViews"]["current"], payload["modeViews"]["projected"]
    assert report.payments == []
    assert current["metrics"]["totalExpenses"] == 0
    assert current["metrics"]["incomeAfterExpenses"] == 1000
    assert projected["metrics"]["totalExpenses"] == 59
    assert projected["metrics"]["incomeAfterExpenses"] == 941
    assert current["categorySpending"]["needs"] == 0
    assert projected["categorySpending"]["needs"] == 59
    assert projected["categoryBalances"]["remaining"]["needs"] == 441
    assert report.budget_breakdown["bills_utilities"]["amount"] == 59
    assert report.utility_history == []
    assert payload["topEntries"] == []
    assert payload["dailyEntries"] == []
    assert _outflows(payload) == [{
        "kind": "bill", "label": "Student Loan", "amount": 59, "day": 12,
        "group": "bills_utilities", "projectedOnly": True, "amountEstimated": True,
    }]
    assert projected["calendarEvents"] == current["calendarEvents"]


@pytest.mark.parametrize("mode", ["current", "projected"])
def test_upcoming_widget_reuses_the_scheduled_expectation(monkeypatch, mode):
    _, payload = _report(monkeypatch, [["Student Loan", "0"]])
    assert report_content(payload, "upcoming", mode, "2026-09-09")["payments"] == [
        {"label": "Student Loan", "amount": 59, "date": "2026-09-12", "kind": "bill"},
    ]


@pytest.mark.parametrize("actual", ["$59.00", "$119.92"])
@pytest.mark.parametrize("month", [8, 9, 10])
def test_recorded_student_loan_supersedes_expectation_without_renaming_history(monkeypatch, actual, month):
    amount = float(actual[1:])
    report, payload = _report(monkeypatch, [["Student Loan", actual]], month=month)
    assert [(item.label, item.amount) for item in report.payments] == [("Student Loan", amount)]
    assert report.utility_history[0].label == "Student Loan"
    assert report.utility_history[0].current_amount == amount
    assert report.utility_history[0].history == [(report.month.name[:3], month, amount)]
    assert _outflows(payload)[0]["amount"] == amount
    assert "amountEstimated" not in _outflows(payload)[0]
    for mode in ("current", "projected"):
        assert payload["modeViews"][mode]["metrics"]["totalExpenses"] == amount
        assert payload["modeViews"][mode]["categorySpending"]["needs"] == amount


def test_expected_bill_does_not_rewrite_closed_month_or_actual_history(monkeypatch):
    history = (
        reports.BudgetHistoryRows(reports.BudgetMonth(2026, 7), [["Student Loan", "$119.92"]]),
        reports.BudgetHistoryRows(reports.BudgetMonth(2026, 8), [["Student Loan", "$0"]]),
    )
    report, payload = _report(monkeypatch, [["Student Loan", "0"]], month=8, history=history)
    assert _outflows(payload) == []
    assert report.utility_history[0].history == [("Jul", 7, 119.92), ("Aug", 8, 0)]
    for mode in ("current", "projected"):
        assert payload["modeViews"][mode]["metrics"]["totalExpenses"] == 0


def test_future_month_expected_bill_and_unrelated_bill_are_both_counted_once(monkeypatch):
    report, payload = _report(monkeypatch, [["Student Loan", "0"], ["PG&E", "$100"]], month=10,
        history=(reports.BudgetHistoryRows(reports.BudgetMonth(2026, 8), [["PG&E", "$80"]]),))
    # Incomplete optional history must never overwrite the authoritative current bill rows.
    assert sum(item.current_amount for item in report.utility_history) == 0
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == 100
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 159
    assert _outflows(payload)[0]["day"] == 12


@pytest.mark.parametrize("rows", [[], [["Student Loan Payment", "0"]], [["Student Loan reminder", "0"]],
    [["Student Loan", "0"], ["Student Loan", "0"]], [["Student Loan", "#REF!"]]])
def test_no_expected_bill_without_one_verified_dedicated_source(monkeypatch, rows):
    _, payload = _report(monkeypatch, rows)
    assert _outflows(payload) == []
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0


@pytest.mark.parametrize("expected", ["", "0", "-59", "NaN", "invalid"])
def test_retired_unconfigured_or_invalid_schedule_never_forecasts(monkeypatch, expected):
    _, payload = _report(monkeypatch, [["Student Loan", "0"]], schedule=_schedule(expected))
    assert _outflows(payload) == []
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0


@pytest.mark.parametrize("actual", ["", "$0"])
def test_student_loan_zero_cannot_read_the_neighboring_column_amount(monkeypatch, actual):
    report, payload = _report(monkeypatch, [["Student Loan", actual, "", "Other allocation", "$250"]])
    assert report.payments == []
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == 0
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 59


def test_expected_bill_cascades_into_burn_rate_without_hiding_unrelated_bills(monkeypatch):
    _, payload = _report(monkeypatch, [["Student Loan", "0"], ["PG&E", "$500"]])
    current, projected = payload["modeViews"]["current"], payload["modeViews"]["projected"]
    assert current["categorySpending"]["needs"] == 500
    assert projected["categorySpending"]["needs"] == 559
    assert current["burnRate"]["remaining"] - projected["burnRate"]["remaining"] == 59
    assert projected["metrics"]["totalExpenses"] == 559


def test_existing_subscription_loan_has_no_new_dedicated_bill_forecast(monkeypatch):
    subscriptions = [
        ["Needs", "", "(Monthly)"],
        ["Recurring:", "Name:", "Amount:"],
        ["12th", "Student Loan", "$180.95"],
    ]
    _, payload = _report(monkeypatch, [], subscriptions=subscriptions, today=18)
    assert [(event["kind"], event["amount"]) for event in _outflows(payload)] == [("subscription", 180.95)]
    for mode in ("current", "projected"):
        assert payload["modeViews"][mode]["metrics"]["totalExpenses"] == 180.95


def test_duplicate_expected_schedule_cannot_double_charge_projection(monkeypatch):
    schedule = _schedule()
    schedule.append(list(schedule[1]))
    _, payload = _report(monkeypatch, [["Student Loan", "0"]], schedule=schedule)
    assert _outflows(payload) == []
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0


@pytest.mark.parametrize("name", ["Student Loan", "STUDENT LOAN", "Student-Loan Payment"])
@pytest.mark.parametrize("today", [9, 18])
def test_active_matching_subscription_suppresses_only_the_bill_estimate(monkeypatch, name, today):
    subscriptions = [["Needs", "", "(Monthly)"], ["Recurring:", "Name:", "Amount:"],
                     ["12th", name, "$59"]]
    report, payload = _report(monkeypatch, [["Student Loan", "0"]], subscriptions=subscriptions, today=today)
    assert report.payments == []
    assert [(event["kind"], event["amount"]) for event in _outflows(payload)] == [("subscription", 59)]
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 59
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == (59 if today >= 12 else 0)
    assert report.budget_breakdown["bills_utilities"]["amount"] == 0


@pytest.mark.parametrize("name", ["Private Student Loan", "Student Loan Insurance", "Other Payment"])
def test_distinct_subscription_names_do_not_suppress_expected_bill(monkeypatch, name):
    subscriptions = [["Needs", "", "(Monthly)"], ["Recurring:", "Name:", "Amount:"],
                     ["12th", name, "$25"]]
    _, payload = _report(monkeypatch, [["Student Loan", "0"]], subscriptions=subscriptions)
    assert sorted((event["kind"], event["amount"]) for event in _outflows(payload)) == [("bill", 59), ("subscription", 25)]
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 84


def test_matching_subscription_cannot_hide_a_recorded_actual_bill(monkeypatch):
    subscriptions = [["Needs", "", "(Monthly)"], ["Recurring:", "Name:", "Amount:"],
                     ["12th", "Student Loan Payment", "$59"]]
    report, payload = _report(monkeypatch, [["Student Loan", "$119.92"]], subscriptions=subscriptions, today=18)
    assert report.payments[0].amount == 119.92
    assert report.utility_history[0].current_amount == 119.92
    assert sorted((event["kind"], event["amount"]) for event in _outflows(payload)) == [("bill", 119.92), ("subscription", 59)]
    for mode in ("current", "projected"):
        assert payload["modeViews"][mode]["metrics"]["totalExpenses"] == 178.92


@pytest.mark.parametrize("pull_day,amount", [("", "$59"), ("12th", "$0")])
def test_inactive_subscription_does_not_suppress_expected_bill(monkeypatch, pull_day, amount):
    subscriptions = [["Needs", "", "(Monthly)"], ["Recurring:", "Name:", "Amount:"],
                     [pull_day, "Student Loan", amount]]
    _, payload = _report(monkeypatch, [["Student Loan", "0"]], subscriptions=subscriptions)
    estimates = [event for event in _outflows(payload) if event.get("amountEstimated")]
    assert [(event["label"], event["amount"]) for event in estimates] == [("Student Loan", 59)]
