from datetime import datetime

import pytest

from bookiebot.reports import expense_breakdown as report
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


@pytest.fixture(autouse=True)
def september(monkeypatch):
    monkeypatch.setattr(report, "now_pacific", lambda: datetime(2026, 9, 5, tzinfo=PACIFIC_TZ))


def income_rows(*entries, settings=()):
    return [
        ["Date", "Source", "Amount"],
        *[list(entry) for entry in entries],
        ["Monthly Income:", "", str(sum(float(entry[2]) for entry in entries))],
        *[list(setting) for setting in settings],
    ]


def build(rows, history=(), month=report.BudgetMonth(2026, 9)):
    return report.build_expense_breakdown_report(
        actor_key="brian", owner_name="Brian", persons=["Brian"], month=month,
        worksheets=report.ReportWorksheets(
            shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet(rows),
            subscriptions=InMemoryWorksheet([]), budget_history=tuple(history),
        ),
    )


def test_september_keeps_july_source_despite_blank_august_settings_and_rewards():
    july = report.BudgetHistoryRows(report.BudgetMonth(2026, 7), income_rows(
        ("7/31/2026", "xAI", "3000"),
        settings=(("Biweekly Income Source:", "xAI"), ("Biweekly Income Start:", "7/2/2026")),
    ))
    august = report.BudgetHistoryRows(report.BudgetMonth(2026, 8), income_rows(
        ("8/14/2026", "xAI paycheck", "3100"),
        ("8/28/2026", "xAI income", "3200"), ("8/31/2026", "Credit card rewards", "75"),
    ))
    result = build(income_rows(("9/3/2026", "Credit card rewards", "50")), [august, july])
    payload = report.expense_breakdown_client_payload(result)
    assert result.income_projection_config.source_label == "xAI"
    assert result.income_projection_config.anchor_date == datetime(2026, 7, 2)
    assert payload["incomeProjection"]["currentAmount"] == 50
    assert payload["incomeProjection"]["projectedAmount"] == 6450
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(11, 3200), (25, 3200)]


@pytest.mark.parametrize("label", ["Credit card rewards", "Paycheck", "xAI bonus", "Other payroll"])
def test_unconfigured_or_mismatched_income_is_never_promoted_to_main_income(label):
    for settings in [(), (("Main Income Source", "xAI"),)]:
        result = build(income_rows(("9/3/2026", label, "50"), settings=settings))
        assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 50
        assert not any(e.projected_only for e in result.calendar_events)


@pytest.mark.parametrize("salary_received,other,expected", [(0, 0, 6000), (0, 50, 6050), (3000, 50, 6050), (6500, 50, 6550)])
def test_fixed_monthly_salary_adds_only_unreceived_salary_and_preserves_other_income(salary_received, other, expected):
    rows = income_rows(
        ("9/2/2026", "xAI", str(salary_received)), ("9/3/2026", "Rewards", str(other)),
        settings=(("Main Income Source", "xAI"), ("Income Projection Mode", "fixed monthly"), ("Fixed Monthly Income", "$6,000.00")),
    )
    result = build(rows)
    payload = report.expense_breakdown_client_payload(result)
    assert result.income_total == salary_received + other
    assert payload["modeViews"]["current"]["metrics"]["monthlyIncome"] == salary_received + other
    assert payload["modeViews"]["projected"]["metrics"]["monthlyIncome"] == expected
    assert sum(e.amount for e in result.calendar_events if e.kind == "income") == expected
    remaining = [e for e in result.calendar_events if e.projected_only]
    assert [(e.label, e.day) for e in remaining] == ([("Projected salary remainder", 30)] if salary_received < 6000 else [])


def test_configuration_carries_forward_but_new_employer_does_not_inherit_old_salary_or_anchor():
    old = report.BudgetHistoryRows(report.BudgetMonth(2026, 7), income_rows(settings=(
        ("Main Income Source", "xAI"), ("Biweekly Income Start", "7/2/2026"), ("Fixed Monthly Income", "6000"),
    )))
    inherited = build(income_rows(), [old]).income_projection_config
    assert inherited.source_label == "xAI"
    assert inherited.fixed_monthly_amount == 6000
    assert inherited.mode == "fixed monthly"
    changed = build(income_rows(settings=(("Main Income Source", "New employer"),)), [old]).income_projection_config
    assert changed.source_label == "New employer"
    assert changed.fixed_monthly_amount is None
    assert changed.anchor_date is None
    assert changed.mode != "fixed monthly"


@pytest.mark.parametrize("settings", [
    (("Income Projection Mode", "off"),),
    (("Income Projection Mode", "typo"),),
    (("Income Projection Mode", "fixed monthly"), ("Fixed Monthly Income", "invalid")),
    (("Income Projection Mode", "fixed monthly"), ("Fixed Monthly Income", "-100")),
])
def test_off_and_invalid_settings_do_not_fall_back_to_old_salary(settings):
    old = report.BudgetHistoryRows(report.BudgetMonth(2026, 7), income_rows(settings=(
        ("Main Income Source", "xAI"), ("Fixed Monthly Income", "6000"),
    )))
    result = build(income_rows(("9/2/2026", "xAI", "3000"), settings=settings), [old])
    assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 3000


def test_completed_month_is_actual_only_and_cannot_inherit_future_settings():
    future = report.BudgetHistoryRows(report.BudgetMonth(2026, 10), income_rows(settings=(("Main Income Source", "Future"),)))
    result = build(income_rows(("8/2/2026", "xAI", "3000"), settings=(
        ("Main Income Source", "xAI"), ("Fixed Monthly Income", "6000"),
    )), [future], month=report.BudgetMonth(2026, 8))
    assert result.income_projection_config.source_label == "xAI"
    assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 3000
    assert not any(e.projected_only for e in result.calendar_events)


def test_fixed_monthly_setting_is_not_actual_income_even_without_table_headers():
    result = build([["Main Income Source", "xAI"], ["Fixed Monthly Income", "6000"]])
    assert result.income_total == 0
    assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 6000


def test_salary_settings_survive_year_boundary_and_blank_months(monkeypatch):
    from bookiebot.sheets import auth, routing
    from unit_tests.reports.test_expense_breakdown import FakeSpreadsheet

    july = InMemoryWorksheet(income_rows(settings=(("Main Income Source", "xAI"), ("Fixed Monthly Income", "6000"))))
    old_book = FakeSpreadsheet({"July": july, "December": InMemoryWorksheet([])})

    class GC:
        def open_by_key(self, key):
            assert key == "budget-2026"
            return old_book

    monkeypatch.setattr(auth, "get_gspread_client", GC)
    monkeypatch.setattr(routing, "get_budget_spreadsheet_id_for_user", lambda actor, year: f"budget-{year}")
    month = report.BudgetMonth(2027, 2)
    history = report._optional_previous_year_budget_history("brian", month)
    result = build(income_rows(), history, month=month)
    assert result.income_projection_config.source_label == "xAI"
    assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 6000


def test_source_persists_but_old_paycheck_amount_does_not():
    july = report.BudgetHistoryRows(report.BudgetMonth(2026, 7), income_rows(
        ("7/31/2026", "xAI", "3000"), settings=(("Main Income Source", "xAI"),),
    ))
    result = build(income_rows(("9/3/2026", "Rewards", "50")), [july])
    payload = report.expense_breakdown_client_payload(result)
    assert payload["incomeProjectionSettings"]["source"] == "xAI"
    assert "waiting for a matching paycheck" in payload["incomeProjectionSettings"]["description"]
    assert payload["incomeProjection"]["projectedAmount"] == 50


def test_biweekly_income_requires_a_real_or_configured_anchor():
    result = build(income_rows(("", "xAI", "3000"), settings=(("Main Income Source", "xAI"),)))
    payload = report.expense_breakdown_client_payload(result)
    assert payload["incomeProjection"]["projectedAmount"] == 3000
    assert "set Biweekly Income Start" in payload["incomeProjectionSettings"]["description"]


def test_fixed_monthly_total_is_independent_of_three_paycheck_months():
    result = build(income_rows(settings=(("Main Income Source", "xAI"), ("Fixed Monthly Income", "6000"),
        ("Biweekly Income Start", "10/2/2026"))), month=report.BudgetMonth(2026, 10))
    payload = report.expense_breakdown_client_payload(result)
    assert payload["incomeProjection"]["projectedAmount"] == 6000
    assert payload["incomeProjectionSettings"]["description"] == "xAI · fixed $6,000.00/month"


def test_fixed_amount_requires_source_and_settings_do_not_consume_adjacent_fields():
    result = build([["Main Income Source", "", "Biweekly Income Start", "7/2/2026"], ["Fixed Monthly Income", "6000"]])
    payload = report.expense_breakdown_client_payload(result)
    assert result.income_projection_config.source_label is None
    assert payload["incomeProjection"]["projectedAmount"] == 0
    assert "Set Main Income Source" in payload["incomeProjectionSettings"]["description"]


def test_source_matching_normalizes_case_and_spacing_without_matching_bonus_suffix():
    result = build(income_rows(("9/2/2026", " XAI ", "3000"), ("9/3/2026", "xAI bonus", "100"),
        settings=(("Main Income Source", "xai"), ("Fixed Monthly Income", "6000"))))
    assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 6100


@pytest.mark.parametrize("suffix", ["income", "paycheck", "payroll", "salary", "wages"])
def test_standard_payroll_suffixes_match_but_rewards_and_bonus_labels_do_not(suffix):
    result = build(income_rows(("9/2/2026", f"xAI {suffix}", "3000"),
        ("9/3/2026", "xAI bonus", "100"), ("9/4/2026", "xAI rewards income", "50"),
        settings=(("Main Income Source", "xAI"), ("Fixed Monthly Income", "6000"))))
    assert report.expense_breakdown_client_payload(result)["incomeProjection"]["projectedAmount"] == 6150


@pytest.mark.parametrize("actual_day", [9, 10, 11])
def test_permanent_paycheck_anchor_does_not_shift_for_early_or_late_deposits(actual_day):
    result = build(income_rows((f"9/{actual_day}/2026", "xAI paycheck", "3000"), settings=(
        ("Main Income Source", "xAI"), ("Income Projection Mode", "biweekly"),
        ("Paycheck Anchor Date", "7/2/2026"),
    )))
    assert result.income_projection_config.anchor_is_fixed
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(24, 3000)]
    assert [e.day for e in result.calendar_events if not e.projected_only] == [actual_day]


def test_permanent_anchor_carries_across_months_years_and_never_projects_before_start():
    settings = report._income_projection_config([
        ["Main Income Source", "xAI"], ["Paycheck Anchor Date", "7/2/2026"],
    ])
    inherited = report._income_projection_config_with_history(report.IncomeProjectionConfig(), (
        report.BudgetHistoryRows(report.BudgetMonth(2026, 7), [["Main Income Source", "xAI"], ["Paycheck Anchor Date", "7/2/2026"]]),
    ), report.BudgetMonth(2027, 1))
    assert inherited.anchor_is_fixed
    for year in [2026, 2027, 2035]:
        month = report.BudgetMonth(year, 9)
        days = report._projected_biweekly_pay_days([], month, settings)
        assert len(days) in [2, 3]
        assert all((datetime(year, 9, day) - datetime(2026, 7, 2)).days % 14 == 0 for day in days)
    assert report._projected_biweekly_pay_days([], report.BudgetMonth(2026, 6), settings) == []


def test_permanent_anchor_removes_dated_and_undated_receipts_only_once():
    settings = report.IncomeProjectionConfig(source_label="xAI", anchor_date=datetime(2026, 7, 2), anchor_is_fixed=True)
    receipts = [report.PaymentItem("xAI", 3000, "income", date="7/17/2026"), report.PaymentItem("xAI", 3000, "income")]
    assert report._projected_biweekly_pay_days(receipts, report.BudgetMonth(2026, 7), settings) == [30]


def test_new_payday_anchor_can_use_prior_month_salary_amount_without_projecting_before_start():
    prior = report.BudgetHistoryRows(report.BudgetMonth(2026, 8), income_rows(("8/28/2026", "xAI", "3000")))
    result = build(income_rows(settings=(("Main Income Source", "xAI"), ("Paycheck Anchor Date", "9/10/2026"))), [prior])
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(10, 3000), (24, 3000)]


def grid_rows(*entries, source='xAI', mode='biweekly', amount='3775', anchor='7/2/2026'):
    return [[], ['', 'September'], [],
            ['', 'Main Income Source:', 'Income Projection Mode:', 'Expected Income Amount:', 'Paycheck Anchor Date:'],
            ['', source, mode, amount, anchor], [],
            ['', 'Date:', 'Source:', 'Amount:'],
            *[['', *entry] for entry in entries],
            ['', 'Monthly Income:', '', str(sum(float(entry[2]) for entry in entries))]]


@pytest.mark.parametrize('day', [7, 9, 10, 11, 13])
def test_expected_paycheck_does_not_change_after_a_smaller_actual(day):
    result = build(grid_rows((f'9/{day}/2026', 'xAI paycheck', '3100'), ('9/5/2026', 'Rewards', '50')))
    payload = report.expense_breakdown_client_payload(result)
    assert result.income_projection_config.expected_amount == 3775
    assert result.income_total == 3150
    assert payload['incomeProjection']['projectedAmount'] == 6925
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(24, 3775)]
    assert 'expected $3,775.00/paycheck' in payload['incomeProjectionSettings']['description']


def test_split_deposits_fill_one_pay_period_and_outside_window_fills_none():
    result = build(grid_rows(('9/9/2026', 'xAI', '2000'), ('9/11/2026', 'xAI', '1100'), ('9/20/2026', 'xAI', '100')))
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(24, 3775)]
    assert report.expense_breakdown_client_payload(result)['incomeProjection']['projectedAmount'] == 6975
    outside = build(grid_rows(('9/6/2026', 'xAI', '3100')))
    assert [e.day for e in outside.calendar_events if e.projected_only] == [10, 24]


@pytest.mark.parametrize('amount', ['', 'invalid', '-100', '0'])
def test_explicit_blank_or_invalid_expected_amount_never_uses_observed_or_prior_salary(amount):
    prior = report.BudgetHistoryRows(report.BudgetMonth(2026, 8), grid_rows(('8/27/2026', 'xAI', '3700')))
    result = build(grid_rows(('9/10/2026', 'xAI', '3100'), amount=amount), [prior])
    payload = report.expense_breakdown_client_payload(result)
    assert payload['incomeProjection']['projectedAmount'] == 3100
    assert 'set Expected Income Amount' in payload['incomeProjectionSettings']['description']


def test_expected_amount_requires_configured_anchor_even_if_deposit_has_date():
    result = build(grid_rows(('9/10/2026', 'xAI', '3100'), anchor=''))
    assert not any(e.projected_only for e in result.calendar_events)
    assert 'set Paycheck Anchor Date' in report.expense_breakdown_client_payload(result)['incomeProjectionSettings']['description']


def test_undated_income_does_not_consume_a_scheduled_paycheck():
    result = build(grid_rows(('', 'xAI', '3100')))
    assert [e.day for e in result.calendar_events if e.projected_only] == [10, 24]


def test_cross_month_early_and_late_deposits_fill_slots_without_moving_actual_income():
    august = report.BudgetHistoryRows(report.BudgetMonth(2026, 8), income_rows(('8/31/2026', 'xAI', '3100')))
    october = report.BudgetHistoryRows(report.BudgetMonth(2026, 10), income_rows(('10/2/2026', 'xAI', '3600')))
    result = build(grid_rows(anchor='9/2/2026'), [august, october])
    assert result.income_total == 0
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(16, 3775)]
    assert report.expense_breakdown_client_payload(result)['incomeProjection']['projectedAmount'] == 3775


def test_new_anchor_and_expected_amount_carry_forward_until_changed():
    july = report.BudgetHistoryRows(report.BudgetMonth(2026, 7), grid_rows())
    september = report.BudgetHistoryRows(report.BudgetMonth(2026, 9), grid_rows(anchor='9/4/2026', amount='3800'))
    result = build(income_rows(), [july, september], month=report.BudgetMonth(2035, 1))
    assert result.income_projection_config.expected_amount == 3800
    assert result.income_projection_config.anchor_date == datetime(2026, 9, 4)
    assert all((datetime(2035, 1, e.day) - datetime(2026, 9, 4)).days % 14 == 0 for e in result.calendar_events if e.projected_only)
    assert len([e for e in result.calendar_events if e.projected_only]) in [2, 3]


def test_monthly_expected_amount_ignores_anchor_and_persists():
    september = report.BudgetHistoryRows(report.BudgetMonth(2026, 9), grid_rows(mode='fixed monthly', amount='6000', anchor=''))
    result = build(income_rows(('1/2/2027', 'xAI', '3100'), ('1/3/2027', 'Rewards', '50')), [september], month=report.BudgetMonth(2027, 1))
    assert report.expense_breakdown_client_payload(result)['incomeProjection']['projectedAmount'] == 6050
    assert [(e.day, e.amount) for e in result.calendar_events if e.projected_only] == [(31, 2900)]


def test_blank_mode_defaults_to_biweekly_and_three_paycheck_month_uses_each_expected_amount():
    result = build(grid_rows(mode='', anchor='10/2/2026'), month=report.BudgetMonth(2026, 10))
    assert result.income_projection_config.mode == 'biweekly'
    assert [e.day for e in result.calendar_events if e.projected_only] == [2, 16, 30]
    assert report.expense_breakdown_client_payload(result)['incomeProjection']['projectedAmount'] == 11325


def test_monthly_mode_does_not_use_anchor_even_for_undated_actual_income():
    first = build(grid_rows(('', 'xAI', '3100'), mode='fixed monthly', amount='6000', anchor='7/2/2026'))
    second = build(grid_rows(('', 'xAI', '3100'), mode='fixed monthly', amount='6000', anchor='9/4/2026'))
    assert first.calendar_events == second.calendar_events


def test_december_receipt_can_fulfill_january_payday():
    december = report.BudgetHistoryRows(report.BudgetMonth(2026, 12), income_rows(('12/31/2026', 'xAI', '3100')))
    result = build(grid_rows(anchor='1/2/2027'), [december], month=report.BudgetMonth(2027, 1))
    assert result.income_total == 0
    assert [e.day for e in result.calendar_events if e.projected_only] == [16, 30]


def test_history_fetch_includes_following_month_but_future_settings_do_not_leak():
    from unit_tests.reports.test_expense_breakdown import FakeSpreadsheet
    book = FakeSpreadsheet({'September':InMemoryWorksheet(grid_rows()), 'October':InMemoryWorksheet(grid_rows(source='Future employer', amount='9999'))})
    history = report._budget_history_from_spreadsheet(book, report.BudgetMonth(2026,9))
    assert [item.month.month for item in history] == [9,10]
    result = build(grid_rows(), history)
    assert result.income_projection_config.source_label == 'xAI'
    assert result.income_projection_config.expected_amount == 3775
