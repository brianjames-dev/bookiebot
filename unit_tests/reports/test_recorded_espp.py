from datetime import datetime

from bookiebot.reports import expense_breakdown as report
from bookiebot.sheets.savings_plan import PLAN_LABELS, WITHHOLDING_HEADER
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reports.test_income_projection import build, income_rows


def rows(*entries, saved=0, projection='off'):
    result = income_rows(*entries, settings=(
        ('Main Income Source', 'xAI'), ('Income Projection Mode', projection),
        ('Expected Income Amount', '3400'), ('Paycheck Anchor Date', '10/23/2026'),
        tuple(PLAN_LABELS), ('xAI', '5%', '10/23/2026', '15%', '7.5%', ''),
        ('Enter Monthly Savings Contribution', 'IDEAL = $0', 'MINIMUM = $0', str(saved)),
    ))
    result[0].append(WITHHOLDING_HEADER)
    return result


def test_actual_withholding_updates_income_saved_and_history_without_spent_or_left(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 23, tzinfo=PACIFIC_TZ))
    payload = report.expense_breakdown_client_payload(build(
        rows(('10/9/2026', 'xAI income', '4500.00', ''),
             ('10/23/2026', 'xAI income', '3400.00', '300.00'), saved=440.00), month=report.BudgetMonth(2026, 10)))
    view = payload['modeViews']['current']
    assert view['savingsInvesting']['esppContribution'] == 300.00
    assert view['metrics']['monthlyIncome'] == 8200.00
    assert view['metrics']['amountSaved'] == 740.00
    assert view['metrics']['totalExpenses'] == 0
    assert view['metrics']['incomeAfterExpenses'] == 7460.00
    assert payload['savingsInvesting']['history']['totalContributed'] == 300.00
    assert view['savingsInvesting']['cashMinimum'] == 727.50
    details = payload['metricExplanations']['current']
    assert next(item for item in details['income']['components'] if item['label'] == 'ESPP withheld from payroll')['source'] == 'recorded'
    assert any('20% of total take-home' in note for note in details['saved']['notes'])
    assert not any('15% ideal' in note for note in details['saved']['notes'])


def test_missing_actual_is_partial_and_estimates_cannot_fill_it(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 23, tzinfo=PACIFIC_TZ))
    payload = report.expense_breakdown_client_payload(build(rows(('10/23/2026', 'xAI', '3400.00', '')),
                                                           month=report.BudgetMonth(2026, 10)))
    assert payload['savingsInvesting']['current']['esppContribution'] == 0
    assert not payload['savingsInvesting']['current']['complete']
    assert payload['savingsInvesting']['history']['coverage'] == 'partial'


def test_next_month_projects_last_confirmed_deduction_without_increasing_history(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 11, 1, tzinfo=PACIFIC_TZ))
    october = report.BudgetHistoryRows(report.BudgetMonth(2026, 10), rows(('10/23/2026', 'xAI', '3400.00', '300.00')))
    payload = report.expense_breakdown_client_payload(build(rows(projection='biweekly'), [october], month=report.BudgetMonth(2026, 11)))
    assert payload['savingsInvesting']['current']['esppContribution'] == 0
    assert payload['savingsInvesting']['projected']['estimatedEsppContribution'] == 600.00
    assert payload['savingsInvesting']['projected']['cashSaved'] == 0
    assert payload['savingsInvesting']['history']['totalContributed'] == 300.00


def test_new_enrollment_without_a_confirmed_reference_never_uses_net_rate(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 1, tzinfo=PACIFIC_TZ))
    payload = report.expense_breakdown_client_payload(build(rows(projection='biweekly'), month=report.BudgetMonth(2026, 10)))
    projected = payload['savingsInvesting']['projected']
    assert projected['esppContribution'] == 0
    assert not projected['complete'] and projected['warnings']
