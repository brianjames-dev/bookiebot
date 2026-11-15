from dataclasses import replace
from datetime import date

import pytest

from bookiebot.sheets.savings_transfers import Transfer, occurrences, encode, decode, storage_book
from bookiebot.sheets.recurring import BillConflict


def rule(**changes):
    return replace(Transfer('transfer_1234', 1, 'Emergency fund', 15000, 'monthly', '2026-01-31', '2026-01-31', 'goal-1'), **changes)


@pytest.mark.parametrize('frequency,expected', [
    ('once', ['2026-01-31']),
    ('biweekly', ['2026-01-31','2026-02-14','2026-02-28','2026-03-14','2026-03-28','2026-04-11','2026-04-25']),
    ('monthly', ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']),
    ('quarterly', ['2026-01-31', '2026-04-30']),
    ('yearly', ['2026-01-31']),
])
def test_scheduled_dates_preserve_month_end_anchor(frequency, expected):
    rows = occurrences([rule(frequency=frequency)], date(2026, 1, 1), date(2026, 4, 30))
    assert [r['date'] for r in rows] == expected
    assert all(r['amountCents'] == 15000 and r['goalId'] == 'goal-1' and r['readOnly'] for r in rows)
    assert len({r['id'] for r in rows}) == len(rows)


def test_future_edits_and_stopping_do_not_rewrite_elapsed_amounts_or_goal_links():
    old = rule()
    changed = replace(old, revision=2, amount_cents=20000, goal_id='goal-2', effective_from='2026-03-01')
    stopped = replace(changed, revision=3, active=False, effective_from='2026-04-01')
    values = occurrences([old, changed, stopped], date(2026, 1, 1), date(2026, 12, 31))
    assert [(v['date'], v['amountCents'], v['goalId']) for v in values] == [
        ('2026-01-31',15000,'goal-1'), ('2026-02-28',15000,'goal-1'), ('2026-03-31',20000,'goal-2')]
    assert occurrences([old,changed,stopped],date(2026,1,1),date(2026,12,31)) == values


def test_annual_rollover_keeps_the_same_canonical_personal_transfer_book(monkeypatch):
    monkeypatch.setattr('bookiebot.sheets.routing.get_budget_spreadsheet_id_for_user',
        lambda actor,year: 'personal-base' if year==2026 else 'personal-next')
    assert storage_book('actor',date(2026,12,31)) == storage_book('actor',date(2027,1,1)) == (2026,'personal-base')


def test_round_trip_and_corrupt_or_duplicated_definitions_fail_closed():
    p=rule(name='=A1',from_account='Checking',to_account='Savings')
    assert decode(encode([p]))==[p]
    with pytest.raises(BillConflict):decode(encode([p,p]))
    rows=encode([p]);rows[1][0]='different-id'
    with pytest.raises(BillConflict):decode(rows)


def test_yearly_leap_day_uses_last_day_without_losing_original_anchor():
    p=rule(frequency='yearly',starts_on='2024-02-29',effective_from='2024-02-29')
    assert [r['date'] for r in occurrences([p],date(2024,1,1),date(2028,12,31))]==[
        '2024-02-29','2025-02-28','2026-02-28','2027-02-28','2028-02-29']


def test_biweekly_midrange_edits_stop_and_year_boundary_retain_fourteen_day_anchor():
    original=rule(frequency='biweekly',starts_on='2026-11-15',effective_from='2026-11-15')
    changed=replace(original,revision=2,amount_cents=17500,goal_id='goal-2',effective_from='2026-11-20')
    stopped=replace(changed,revision=3,active=False,effective_from='2026-12-14')
    assert [(r['date'],r['amountCents'],r['goalId']) for r in occurrences(
        [original,changed,stopped],date(2026,11,16),date(2027,1,31))]==[
        ('2026-11-29',17500,'goal-2'),('2026-12-13',17500,'goal-2')]
    assert [r['date'] for r in occurrences([original],date(2026,12,28),date(2027,1,31))]==['2027-01-10','2027-01-24']
