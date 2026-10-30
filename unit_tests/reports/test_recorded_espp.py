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


def test_actual_withholding_updates_income_and_saved_without_adding_to_spent_or_changing_left(monkeypatch):
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
    assert details['spent']['value'] == 0
    assert details['spent']['components'] == []
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
    for mode, saved in [('current', 0), ('projected', 600.00)]:
        details = payload['metricExplanations'][mode]['spent']
        assert details['value'] == 0
        assert details['components'] == []
        assert payload['modeViews'][mode]['metrics']['amountSaved'] == saved
        assert payload['modeViews'][mode]['metrics']['totalExpenses'] == 0
    assert '$600.00 of Saved is estimated ESPP from expected paychecks.' in payload['metricExplanations']['projected']['saved']['notes']


def test_spent_excludes_cash_actual_espp_and_projected_espp(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 11, 7, tzinfo=PACIFIC_TZ))
    source = build(rows(('11/6/2026', 'xAI', '3400.00', '300.00'), saved=440.00, projection='biweekly'),
                   month=report.BudgetMonth(2026, 11))
    source.breakdown = {'rent': {'label': 'Rent', 'amount': 125.00}}
    source.budget_breakdown = source.breakdown.copy()
    source.personal_total = 125.00
    payload = report.expense_breakdown_client_payload(source)
    for mode, espp, total in [('current', 300.00, 125.00), ('projected', 600.00, 125.00)]:
        view = payload['modeViews'][mode]
        details = payload['metricExplanations'][mode]['spent']
        assert view['savingsInvesting']['esppContribution'] == espp
        assert view['savingsInvesting']['cashSaved'] == 440.00
        assert details['value'] == total
        assert not any(item['label'] == 'Saved' for item in details['components'])
        assert view['metrics']['amountSaved'] == 440.00 + espp
        assert round(sum(item['amount'] for item in details['components']), 2) == total
        assert view['metrics']['totalExpenses'] == 125.00
        assert view['categorySpending']['savings'] == 440.00
        assert round(details['value'] + view['metrics']['amountSaved'] + view['metrics']['incomeAfterExpenses'], 2) == view['metrics']['monthlyIncome']
    assert payload['savingsInvesting']['history']['totalContributed'] == 300.00
    assert '$300.00 of Saved is estimated ESPP from expected paychecks.' in payload['metricExplanations']['projected']['saved']['notes']


def test_new_enrollment_without_a_confirmed_reference_never_uses_net_rate(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 1, tzinfo=PACIFIC_TZ))
    payload = report.expense_breakdown_client_payload(build(rows(projection='biweekly'), month=report.BudgetMonth(2026, 10)))
    projected = payload['savingsInvesting']['projected']
    assert projected['esppContribution'] == 0
    assert not projected['complete'] and projected['warnings']


def test_saving_more_reduces_left_without_becoming_spending(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 23, tzinfo=PACIFIC_TZ))
    views = []
    for saved in (0, 440):
        payload = report.expense_breakdown_client_payload(build(
            rows(('10/23/2026', 'xAI', '3400.00', '300.00'), saved=saved), month=report.BudgetMonth(2026, 10)))
        view = payload['modeViews']['current']
        assert view['metrics']['totalExpenses'] == payload['metricExplanations']['current']['spent']['value'] == 0
        assert view['metrics']['amountSaved'] == saved + 300
        assert payload['savingsInvesting']['history']['totalContributed'] == 300
        views.append(view)
    assert views[0]['metrics']['incomeAfterExpenses'] - views[1]['metrics']['incomeAfterExpenses'] == 440
