from datetime import date

import pytest

from bookiebot.sheets.savings_plan import SETTINGS_HEADERS, WITHHOLDING_HEADER, calculate_savings, read_savings_plan


def actual_plan():
    return read_savings_plan([
        list(SETTINGS_HEADERS), ['10/23/2026', '', 'xAI', '5%'],
        ['Date:', 'Source:', 'Amount:', WITHHOLDING_HEADER],
    ])


def calculate(entries, total=None):
    return calculate_savings(actual_plan(), sum(entry[1] for entry in entries) if total is None else total,
                             entries, date(2026, 10, 1), date(2026, 10, 31))


def test_confirmed_gross_based_deduction_fills_twenty_percent_goal():
    result = calculate([('xAI income', 3400.00, '10/23/2026', '300.00')])
    assert result['esppContribution'] == 300.00
    assert result['takeHomeBeforeEspp'] == 3700.00
    assert result['totalSavingsGoal'] == 740.00
    assert result['cashIdeal'] == 440.00
    assert result['cashMinimum'] == 277.50
    assert result['categoryBudgets'] == {'needs': 1850.00, 'wants': 1110.00, 'savings': 440.00}
    assert sum(result['categoryBudgets'].values()) == 3400.00
    assert result['complete'] and result['warnings'] == []
    assert actual_plan().payload()['cashIdealRate'] is None


def test_mixed_month_retains_pre_enrollment_and_other_income_cash_targets():
    result = calculate([('xAI income', 4500.00, '10/9/2026', ''),
                        ('Rewards', 1600.00, '10/22/2026', ''),
                        ('xAI income', 3400.00, '10/23/2026', '300.00')])
    assert result['esppContribution'] == 300.00
    assert result['takeHomeBeforeEspp'] == 9800.00
    assert result['cashIdeal'] == 1660.00
    assert result['cashMinimum'] == 887.50
    assert result['cashIdeal'] + result['esppContribution'] == pytest.approx(result['totalSavingsGoal'])


@pytest.mark.parametrize('withheld', [None, '', 'nope', '-1', 'NaN', 'Infinity'])
def test_missing_or_invalid_actual_is_flagged_and_never_inferred(withheld):
    result = calculate([('xAI', 3400.00, '10/23/2026', withheld)])
    assert result['esppContribution'] == 0
    assert not result['complete']
    assert 'ESPP withheld' in result['warnings'][0]


def test_confirmed_zero_is_valid_and_does_not_inherit_a_prior_paycheck():
    result = calculate([('xAI', 3400.00, '10/23/2026', '0')])
    assert result['esppContribution'] == 0
    assert result['complete'] and not result['warnings']


def test_source_and_date_boundaries_corrections_delete_and_restore():
    first = ('xAI', 3400.00, '10/23/2026', '300.00')
    second = ('xAI payroll', 3500, '10/30/2026', '310.01')
    assert calculate([first, second])['esppContribution'] == 610.01
    assert calculate([first])['esppContribution'] == 300.00
    assert calculate([first, second])['esppContribution'] == 610.01
    for entry in [('xAI', 3400.00, '10/22/2026', '300.00'), ('Rewards', 3400.00, '10/23/2026', '300.00')]:
        result = calculate([entry])
        assert result['esppContribution'] == 0
        assert not result['complete']


def test_high_withholding_keeps_cash_nonnegative_and_exposes_target_conflicts():
    result = calculate([('xAI', 100, '10/23/2026', '100')])
    assert result['cashIdeal'] == 0
    assert result['cashMinimum'] == 15
    assert len(result['warnings']) == 2
    assert sum(result['categoryBudgets'].values()) == 100


def test_orphaned_withholding_is_not_a_complete_zero():
    plan = read_savings_plan([list(SETTINGS_HEADERS), ['10/23/2026', '', 'xAI', '5%'],
        ['Date:', 'Source:', 'Amount:', WITHHOLDING_HEADER], ['', '', '', '300.00'], ['Monthly Income:', '', '0']])
    result = calculate_savings(plan, 0, [], date(2026,10,1), date(2026,10,31))
    assert not result['complete'] and 'completed paycheck' in result['warnings'][0]


def test_inconsistent_income_total_keeps_investment_history_incomplete():
    result = calculate([('xAI', 3400.00, '10/23/2026', '300.00')], total=100)
    assert not result['complete']
    assert any('Income total' in warning for warning in result['warnings'])
