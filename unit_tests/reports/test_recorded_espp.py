from datetime import datetime
import pytest

from bookiebot.reports import expense_breakdown as report
from bookiebot.sheets.savings_plan import PLAN_LABELS, SETTINGS_HEADERS, WITHHOLDING_HEADER
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


def test_biweekly_deductions_keep_month_and_lifetime_totals_separate(monkeypatch):
    october = report.BudgetHistoryRows(report.BudgetMonth(2026, 10),
                                      rows(('10/23/2026', 'xAI income', '3500', '275.50')))
    first = ('11/6/2026', 'xAI income', '3800', '310.75')

    def november(day, *additional):
        monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 11, day, tzinfo=PACIFIC_TZ))
        source = build(rows(first, *additional, projection='biweekly'), [october],
                       month=report.BudgetMonth(2026, 11))
        return report.expense_breakdown_client_payload(source)

    before = november(19)
    assert [event['day'] for event in before['calendarEvents'] if event['kind'] == 'income' and event['projectedOnly']] == [20]
    espp = before['savingsInvesting']
    assert espp['current']['esppContribution'] == 310.75
    assert espp['projected']['esppContribution'] == 621.50
    assert espp['projected']['estimatedEsppContribution'] == 310.75
    assert espp['history']['totalContributed'] == 586.25

    posted = november(20, ('11/20/2026', 'xAI paycheck', '3400', ''))
    missing = posted['savingsInvesting']
    assert not missing['current']['complete']
    assert missing['history']['coverage'] == 'partial'
    assert missing['current']['esppContribution'] == 310.75
    assert missing['projected']['estimatedEsppContribution'] == 278.04
    assert missing['projected']['esppContribution'] == 588.79
    assert missing['current']['postedEsppEstimates'] == [{'date': '2026-11-20', 'amount': 278.04}]
    assert missing['history']['totalContributed'] == 586.25
    assert not any(event['kind'] == 'income' and event['projectedOnly'] for event in posted['calendarEvents'])
    for metric in ('income', 'saved'):
        explanation = posted['metricExplanations']['projected'][metric]
        assert [part for part in explanation['components'] if 'ESPP estimate' in part['label']] == [
            {'label': 'ESPP estimate for logged paycheck', 'amount': 278.04,
             'source': 'calculated', 'date': '2026-11-20'},
        ]
        assert round(sum(part['amount'] for part in explanation['components']), 2) == explanation['value']

    corrected = november(20, ('11/20/2026', 'xAI paycheck', '3800', ''))['savingsInvesting']
    assert corrected['projected']['estimatedEsppContribution'] == 310.75

    actual = november(20, ('11/20/2026', 'xAI paycheck', '3400', '345.67'))['savingsInvesting']
    assert actual['current']['esppContribution'] == 656.42
    assert actual['projected']['esppContribution'] == 656.42
    assert actual['projected']['estimatedEsppContribution'] == 0
    assert 'postedEsppEstimates' not in actual['current']
    assert actual['history']['totalContributed'] == 931.92


@pytest.mark.parametrize('day,source,withheld,new_rate', [
    (19, 'xAI paycheck', '', False),  # Future-dated deposit.
    (20, 'xAI bonus', '', False),
    (20, 'xAI paycheck', '0', False),  # A confirmed zero is authoritative.
    (20, 'xAI paycheck', 'needs correction', False),
    (20, 'xAI paycheck', '', True),  # No actual reference at the new rate.
])
def test_posted_espp_estimate_requires_matching_prior_payroll_and_empty_withholding(
    monkeypatch, day, source, withheld, new_rate,
):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 11, day, tzinfo=PACIFIC_TZ))
    inputs = rows(('11/6/2026', 'xAI income', '3800', '310.75'), ('11/20/2026', source, '3400', withheld))
    if new_rate:
        inputs.extend([list(SETTINGS_HEADERS), ['10/23/2026', '', 'xAI', '5%'], ['11/20/2026', '', 'xAI', '6%']])
    payload = report.expense_breakdown_client_payload(build(inputs, month=report.BudgetMonth(2026, 11)))
    assert 'postedEsppEstimates' not in payload['savingsInvesting']['current']
    assert payload['savingsInvesting']['projected']['estimatedEsppContribution'] == 0
