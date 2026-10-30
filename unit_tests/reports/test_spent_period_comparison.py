"""Matching-day comparisons use the overview's expense-only Spent basis."""
import calendar
from copy import deepcopy
from datetime import datetime

import pytest

from bookiebot.reports import batched_report_reads as batch, comparison_reads, expense_breakdown as reports
from bookiebot.reports.report_insights import compare_report_spending
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reports.test_batched_report_reads import ACTOR, client_for, configure

NOW = datetime(2026, 10, 29, 12, tzinfo=PACIFIC_TZ)


def month(year, number, current, projected=None, saved=1000):
    return {"ownerName": "Brian", "year": year, "month": number,
            "modeViews": {mode: {"metrics": {"totalExpenses": amount, "amountSaved": saved}}
                          for mode, amount in (("current", current), ("projected", projected if projected is not None else current))},
            # Deliberately different: neither dated activity nor legacy combined
            # Spent explanations may override the canonical expense total.
            "comparisonData": {"recordedExpenses": [{"date": None, "amount": 5}],
                "recordedIncome": [], "scheduledExpenses": [], "unitemizedExpenses": current - 5, "unitemizedIncome": 0,
                "modeExpenses": {mode: {"scheduledExpenses": [], "unitemizedExpenses": amount - 5}
                    for mode, amount in (("current", current), ("projected", projected if projected is not None else current))}},
            "metricExplanations": {"current": {"spent": {"value": current + saved}}}}


def compare(selected, baseline, mode="current", now=NOW, baseline_month=None):
    return compare_report_spending(selected, baseline, mode=mode, as_of=now, baseline_kind="selected-month",
                                 baseline_month=baseline_month or f"{baseline['year']:04d}-{baseline['month']:02d}")


@pytest.mark.parametrize("mode,amount,base,change,percent", [
    ("current", 2150.55, 2250.75, -100.20, -4.5),
    ("projected", 2450.95, 2350.75, 100.20, 4.3),
])
def test_exact_mode_totals_include_all_expenses_without_savings_or_mutation(mode, amount, base, change, percent):
    selected = month(2026, 10, 2150.55, 2450.95, saved=1996.62)
    baseline = month(2026, 9, 2250.75, 2350.75, saved=500)
    original = deepcopy((selected, baseline))
    result = compare(selected, baseline, mode)
    assert result["selected"]["spending"] == amount
    assert result["baseline"]["spending"] == base
    assert result["mode"] == mode
    assert result["changeAmount"] == change
    assert result["changePercent"] == percent
    assert result["status"] == "partial", "The comparison flags included amounts with unknown payment dates"
    assert (selected, baseline) == original
    assert "Savings and ESPP are excluded" in result["coverageNote"]


@pytest.mark.parametrize("year,number,base_year,base_number,last_day", [
    (2026, 3, 2026, 2, 28), (2024, 2, 2023, 2, 28), (2026, 1, 2025, 12, 31),
])
def test_matching_day_window_handles_short_month_leap_day_and_year_boundary(year, number, base_year, base_number, last_day):
    result = compare(month(year, number, 3100), month(base_year, base_number, 2800))
    assert result["selected"]["throughDate"] == f"{year}-{number:02d}-{last_day}"
    assert result["selected"]["spending"] == 3100
    assert result["baseline"]["throughDate"] == f"{base_year}-{base_number:02d}-{last_day}"
    assert result["changeAmount"] == 300


def test_current_month_on_either_side_limits_both_modes_to_same_pacific_day():
    now = datetime.fromisoformat("2026-10-30T01:00:00+00:00")
    result = compare(month(2026, 9, 100), month(2026, 10, 50, 150), now=now)
    assert result["selected"]["throughDate"] == "2026-09-29"
    assert result["baseline"]["throughDate"] == "2026-10-29"
    assert result["changeAmount"] == 50
    assert "still in progress" in result["coverageNote"]
    projected = compare(month(2026, 9, 100), month(2026, 10, 50, 150), mode="projected", now=now)
    assert projected["baseline"]["throughDate"] == "2026-10-29"
    assert projected["changeAmount"] == -50


@pytest.mark.parametrize("amount,base,change,percent", [(0, 0, 0, None), (10, 0, 10, None), (-25.50, 50, -75.50, -151), (10, -50, 60, None)])
def test_zero_and_net_refunds(amount, base, change, percent):
    result = compare(month(2026, 10, amount), month(2026, 9, base))
    assert result["changeAmount"] == change
    assert result["changePercent"] == percent


@pytest.mark.parametrize("mode", ["current", "projected"])
def test_matching_days_remove_later_costs_but_include_subscriptions_bills_and_signed_adjustments(mode):
    selected, baseline = month(2026, 10, 770, 800), month(2026, 9, 1000)
    for value, late_amount, scheduled_amount in ((selected, 500, 20), (baseline, 700, 50)):
        data = value["comparisonData"]
        prefix = f"{value['year']}-{value['month']:02d}"
        data["recordedExpenses"] = [{"date": prefix + "-07", "amount": 100},
                                    {"date": prefix + "-30", "amount": late_amount},
                                    {"date": None, "amount": 200}]
        for item in data["modeExpenses"].values():
            item["scheduledExpenses"] = [{"date": prefix + "-02", "amount": scheduled_amount}]
            item["unitemizedExpenses"] = -50
    selected["comparisonData"]["modeExpenses"]["projected"]["scheduledExpenses"].append({"date": "2026-10-30", "amount": 30})
    result = compare(selected, baseline, mode)
    assert result["throughDay"] == 29
    assert result["selected"]["spending"] == 270  # 100 dated + 200 undated + 20 subscription - 50 adjustment.
    assert result["baseline"]["spending"] == 300
    assert result["changeAmount"] == -30
    assert result["changePercent"] == -10
    assert result["selected"]["unitemizedSpending"] == -50
    assert result["selected"]["undatedSpending"] == 200
    assert "included in full" in result["coverageNote"]


@pytest.mark.parametrize("today,expected_projected", [(9, 0), (18, 59.96)])
def test_expected_bill_only_enters_projected_window_when_due(monkeypatch, today, expected_projected):
    from unit_tests.reports.test_expected_bill_reports import _report
    _, selected = _report(monkeypatch, [["Student Loan", "0"]], today=today)
    baseline = month(2026, 8, 0)
    now = datetime(2026, 9, today, tzinfo=PACIFIC_TZ)
    current = compare(selected, baseline, now=now)
    projected = compare(selected, baseline, "projected", now=now)
    assert current["selected"]["spending"] == 0
    assert projected["selected"]["spending"] == expected_projected
    assert projected["selected"]["scheduledSpending"] == expected_projected


def test_recorded_bill_is_included_once_without_inventing_payment_date(monkeypatch):
    from unit_tests.reports.test_expected_bill_reports import _report
    _, selected = _report(monkeypatch, [["Student Loan", "59.96"]], today=9)
    for mode in ("current", "projected"):
        result = compare(selected, month(2026, 8, 0), mode, now=datetime(2026, 9, 9, tzinfo=PACIFIC_TZ))
        assert result["selected"]["spending"] == 59.96
        assert result["selected"]["undatedSpending"] == 59.96
        assert result["selected"]["datedSpending"] == 0
        assert result["selected"]["scheduledSpending"] == 0


def test_shorter_comparison_month_removes_leap_day_cost_without_losing_other_spent():
    selected, baseline = month(2024, 2, 600), month(2023, 2, 500)
    selected["comparisonData"]["recordedExpenses"].append({"date": "2024-02-29", "amount": 100})
    result = compare(selected, baseline)
    assert result["throughDay"] == 28
    assert result["shortMonthAdjusted"] is True
    assert result["selected"]["spending"] == 500
    assert result["changeAmount"] == 0


def test_missing_month_or_metric_is_unavailable_and_identity_is_validated():
    selected, baseline = month(2026, 10, 100), month(2026, 9, 50)
    assert compare(selected, None, baseline_month="2026-09")["baseline"] is None
    del baseline["modeViews"]["projected"]
    assert compare(selected, baseline, "projected")["status"] == "unavailable"
    del selected["modeViews"]
    assert compare(selected, baseline)["selected"] is None
    baseline["ownerName"] = "Hannah"
    with pytest.raises(ValueError, match="same owner"):
        compare(selected, baseline)
    baseline["ownerName"] = "Brian"
    with pytest.raises(ValueError, match="month did not match"):
        compare(selected, baseline, baseline_month="2026-08")
    with pytest.raises(ValueError, match="Mode"):
        compare(selected, baseline, "invalid")


@pytest.mark.parametrize("year", [2024, 2025, 2026])
def test_every_batched_month_matches_opening_that_month_with_four_http_reads(monkeypatch, year):
    configure(monkeypatch, years=(year,))
    monkeypatch.setattr(batch, "now_pacific", lambda: NOW)
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)
    monkeypatch.setattr(comparison_reads, "now_pacific", lambda: NOW)
    monkeypatch.setattr(comparison_reads, "get_budget_spreadsheet_id_for_user", batch.get_budget_spreadsheet_id_for_user)
    monkeypatch.setattr(comparison_reads, "get_shared_expenses_spreadsheet_id", batch.get_shared_expenses_spreadsheet_id)
    count = NOW.month if year == NOW.year else 12
    personal = {calendar.month_name[n]: [["Rent", str(2000 + n)], ["PG&E", str(90 + n)],
                 ["Eating out", str(100 + n)], ["Enter Monthly Savings Contribution", "", "", "999"]]
                for n in range(1, count + 1)}
    personal["Subscriptions"] = [[], ["", "SUBSCRIPTIONS"], [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)"], [],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:"],
        ["1st", "Needs elapsed", "10", "", "1st", "Wants elapsed", "5"],
        ["30th", "Needs later", "20", "", "30th", "Wants later", "15"]]
    personal["_BookieBot Bill Schedule"] = [BILL_SCHEDULE_HEADERS,
        ["pge", "PG&E", "monthly", "20", "", "PG&E", "", "", ""]]
    tabs = {f"personal-{year}": personal, f"shared-{year}": {calendar.month_name[n]: [] for n in range(1, count + 1)}}
    client, calls = client_for(tabs)
    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: client)
    results = comparison_reads.load_comparison_year(dict(actor_key=ACTOR, owner_name="Brian", persons=["Brian (BofA)"], year=year))
    assert len(calls) == 4, "All months and both modes share the same two workbook batches"
    assert list(results) == list(range(1, count + 1))
    for number, actual in results.items():
        worksheets = batch.batched_report_worksheets(ACTOR, reports.BudgetMonth(year, number), client)
        expected = reports.expense_breakdown_client_payload(reports.build_expense_breakdown_report(
            actor_key=ACTOR, owner_name="Brian", persons=["Brian (BofA)"], month=reports.BudgetMonth(year, number), worksheets=worksheets))
        for mode in ("current", "projected"):
            assert actual["modeViews"][mode]["metrics"]["totalExpenses"] == expected["modeViews"][mode]["metrics"]["totalExpenses"]
            assert actual["modeViews"][mode]["metrics"]["totalExpenses"] > 2000
            full_window = compare(actual, month(2023, 12, 0), mode, now=datetime(2027, 1, 1, tzinfo=PACIFIC_TZ))
            assert full_window["selected"]["spending"] == expected["modeViews"][mode]["metrics"]["totalExpenses"], "A full comparison window must equal the overview exactly"
    # Later scheduled subscriptions make the two current-month modes distinct.
    if year == NOW.year:
        assert results[count]["modeViews"]["projected"]["metrics"]["totalExpenses"] > results[count]["modeViews"]["current"]["metrics"]["totalExpenses"]
