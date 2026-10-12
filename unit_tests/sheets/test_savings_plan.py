from datetime import date

import pytest

from bookiebot.sheets.savings_plan import PLAN_LABELS, calculate_savings, read_savings_plan


def rows(first="2026-10-15", source="xAI", rate="5%", last=""):
    return [list(PLAN_LABELS), [source, rate, first, "15%", "7.5%", last]]


def calculate(entries, *, settings=None, total=None):
    return calculate_savings(read_savings_plan(settings if settings is not None else rows()),
                             total if total is not None else sum(entry[1] for entry in entries), entries,
                             date(2026, 10, 1), date(2026, 10, 31))


def test_enrolled_payroll_and_unrelated_income_conserve_cash():
    result = calculate([("xAI paycheck", 7600, "10/15/2026"), ("Rewards", 1000, "10/20/2026")])
    assert result["esppContribution"] == 400
    assert result["takeHomeBeforeEspp"] == 9000
    assert result["cashIdeal"] == 1400
    assert result["cashMinimum"] == 700
    assert result["categoryBudgets"] == {"needs": 4500, "wants": 2700, "savings": 1400}
    assert sum(result["categoryBudgets"].values()) == 8600


@pytest.mark.parametrize("label", ["xAI", "XAI payroll", "xAI income", "xAI wages", "xAI salary"])
def test_only_complete_employer_and_standard_payroll_suffixes_enroll(label):
    assert calculate([(label, 7600, "2026-10-15")])["esppContribution"] == 400


@pytest.mark.parametrize("label", ["xAI bonus", "Other xAI", "Sonic", "Rewards", "Paycheck"])
def test_other_income_keeps_twenty_percent_cash(label):
    result = calculate([(label, 1000, "2026-10-15")])
    assert result["esppContribution"] == 0
    assert result["cashIdeal"] == 200
    assert result["cashMinimum"] == 100


def test_midmonth_enrollment_undated_rows_and_stop_date():
    result = calculate([("xAI", 3800, "10/1/2026"), ("xAI", 3800, "10/15/2026"),
                        ("xAI", 3800, "10/29/2026"), ("xAI", 100, "")],
                       settings=rows(last="2026-10-20"))
    assert result["esppContribution"] == 200
    assert result["cashIdeal"] == 2140
    assert result["cashMinimum"] == 1070
    assert result["warnings"] == ["1 payroll entries need dates before ESPP can be calculated."]


@pytest.mark.parametrize("settings,status", [(rows(first=""), "pending"), (rows(source=""), "pending"),
    (rows(rate="0%"), "off"), (rows(rate="100%"), "invalid"), (rows(rate="NaN"), "invalid"),
    (rows(rate="4%"), "invalid"), (rows(first="garbage"), "invalid"), (rows(first="2026-02-30"), "invalid"),
    (rows(last="garbage"), "invalid"), ([], "off")])
def test_unconfigured_pending_invalid_and_disabled_plans_are_safe(settings, status):
    assert read_savings_plan(settings).status == status
    result = calculate([("xAI", 7600, "10/15/2026")], settings=settings)
    assert result["esppContribution"] == 0
    assert result["cashIdeal"] == 1520


def test_rounding_is_per_paycheck_and_corrections_are_derived():
    entries = [("xAI", 100.04, "10/15/2026"), ("xAI", 100.04, "10/29/2026")]
    result = calculate(entries)
    assert result["esppContribution"] == 10.54
    assert result["takeHomeBeforeEspp"] == 210.62
    assert result["categoryBudgets"] == {"needs": 105.31, "wants": 63.18, "savings": 31.59}
    assert calculate(entries[:1])["esppContribution"] == 5.27
    assert calculate([])["esppContribution"] == 0


def test_inconsistent_sheet_total_does_not_manufacture_withholding():
    result = calculate([("xAI", 7600, "10/15/2026")], total=100)
    assert result["esppContribution"] == 0
    assert result["warnings"]
