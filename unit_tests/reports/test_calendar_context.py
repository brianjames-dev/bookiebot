"""Adjacent dates must not invent actual payments or alter Spent."""
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest
import bookiebot.reports.expense_breakdown as report
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import PACIFIC_TZ


def test_adjacent_future_recurs_by_schedule_and_never_copies_actuals(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 12, 31, tzinfo=PACIFIC_TZ))
    subscriptions = [
        report.SubscriptionItem('Monthly', 12.5, 'monthly', 'need', 31),
        report.SubscriptionItem('January annual', 80, 'yearly', 'want', 2, 1),
        report.SubscriptionItem('December annual', 99, 'yearly', 'want', 3, 12),
    ]
    bills = [BILL_SCHEDULE_HEADERS,
             ['rent', 'Rent', 'monthly', '1', '', 'Rent', '', '', '', '1500'],
             ['water', 'Water', 'monthly', '5', '', 'Water', '', '', ''],
             ['quarter', 'Quarterly', 'quarterly', '6', '2,5,8,11', 'Other', '', '', '', '60']]
    months = report._calendar_adjacent_months(report.BudgetMonth(2026, 12), subscriptions, bills, (), report.IncomeProjectionConfig(), None, [])
    assert not months[0].available
    future = months[1]
    assert future.month == report.BudgetMonth(2027, 1) and future.available
    events = {item.label: item for item in future.events}
    assert set(events) == {'Monthly', 'January annual', 'Rent', 'Water'}
    assert events['Monthly'].day == 31
    assert events['January annual'].day == 2
    assert events['Rent'].amount == 1500 and events['Rent'].amount_estimated
    assert events['Water'].amount == 0 and events['Water'].amount_unknown
    assert all(item.projected_only for item in future.events)
    assert report._calendar_event_payload(events['Water'])['amountUnknown'] is True


def test_adjacent_history_uses_already_read_rows_not_future_forecasts(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 31, tzinfo=PACIFIC_TZ))
    rows = [['Main Income Source', 'Salary'], ['Salary', '$2500', '9/15/2026']]
    history = (report.BudgetHistoryRows(report.BudgetMonth(2026, 9), rows),)
    calls = []
    original = report._calendar_events
    def tracked(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(report, '_calendar_events', tracked)
    context = report._calendar_adjacent_months(report.BudgetMonth(2026, 10), [], [], history, report.IncomeProjectionConfig(), None, [])
    assert context[0].available
    assert calls[0]['personal_rows'] is rows
    assert calls[0]['month'] == report.BudgetMonth(2026, 9)
    assert calls[0]['income_projection_config'] == report._income_projection_config(rows)


def test_future_bills_do_not_duplicate_subscriptions_or_guess_ambiguous_amounts(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 1, 31, tzinfo=PACIFIC_TZ))
    bills = [BILL_SCHEDULE_HEADERS,
             ['loan', 'Student Loan Payment', 'monthly', '15', '', 'Student Loan', '', '', '', '100'],
             ['one', 'Power A', 'monthly', '12', '', 'Power', '', '', '', '100'],
             ['two', 'Power B', 'monthly', '13', '', 'Power', '', '', '', '200']]
    context = report._calendar_adjacent_months(report.BudgetMonth(2026, 1), [report.SubscriptionItem('Student Loan', 90, 'monthly', 'need', 15)], bills, (), report.IncomeProjectionConfig(), None, [])
    events = context[1].events
    assert len([event for event in events if 'Student Loan' in event.label]) == 1
    assert all(event.amount_unknown and event.amount == 0 for event in events if event.kind == 'bill')


def test_future_income_uses_explicit_configuration(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 31, tzinfo=PACIFIC_TZ))
    config = report.IncomeProjectionConfig(source_label='Salary', mode='fixed monthly', expected_amount=6000)
    events = report._calendar_adjacent_months(report.BudgetMonth(2026, 10), [], [], (), config, None, [])[1].events
    assert len(events) == 1
    assert events[0].kind == 'income' and events[0].amount == 6000 and events[0].projected_only


def test_local_logos_have_pinned_content_and_inert_images():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('import_logos', root / 'scripts/update_company_logos.py')
    assert spec and spec.loader
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)
    catalog = json.loads((root / 'web/expense-report/src/company-logos.json').read_text())
    assert len(catalog) >= 80
    assert len({item['id'] for item in catalog}) == len(catalog)
    for item in catalog:
        data = (root / 'src/bookiebot/reports/assets' / item['asset']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        assert item['sha256'][:16] in item['asset']
        assert importer.validated_extension(data) == item['asset'].rsplit('.', 1)[1]
        assert item['source'].startswith('https://') and item['license']
    for svg in [b'<svg onload="alert(1)"/>', b'<svg><script/></svg>', b'<svg><use href="https://example.com/icon.svg"/></svg>', b'<svg><style>@import "https://example.com/a";</style></svg>']:
        with pytest.raises(ValueError):
            importer.validated_extension(svg)


def test_future_existing_rows_still_show_unknown_scheduled_bills(monkeypatch):
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 10, 31, tzinfo=PACIFIC_TZ))
    bills = [BILL_SCHEDULE_HEADERS, ['water', 'Water', 'monthly', '5', '', 'Water', '', '', '', '']]
    history = (report.BudgetHistoryRows(report.BudgetMonth(2026, 11), [['Water', '']]),)
    events = report._calendar_adjacent_months(report.BudgetMonth(2026, 10), [], bills, history, report.IncomeProjectionConfig(), None, [])[1].events
    assert len(events) == 1 and events[0].amount_unknown and events[0].label == 'Water'


def test_calendar_context_cannot_change_either_financial_mode():
    from dataclasses import replace
    from unit_tests.reports.test_income_projection import build, income_rows
    selected = build(income_rows(('9/1/2026', 'Fixture income', '5000')))
    with_context = report.expense_breakdown_client_payload(selected)
    without_context = report.expense_breakdown_client_payload(replace(selected, calendar_context=[]))
    assert with_context['calendarContext']
    for key in ('modeViews', 'metrics', 'categoryBalances', 'breakdown', 'burnRate', 'calendarEvents'):
        assert with_context[key] == without_context[key]


def test_provider_assignments_follow_the_bound_actor_not_a_client_name():
    from bookiebot.sheets.routing import DEFAULT_BRIAN_DISCORD_USER_IDS, DEFAULT_HANNAH_DISCORD_USER_IDS
    aliases = report._calendar_logo_aliases(DEFAULT_BRIAN_DISCORD_USER_IDS[0])
    assert aliases == {'water': 'santa-rosa-water', 'student loan': 'aidvantage', 'student loan payment': 'aidvantage'}
    assert report._calendar_logo_aliases(DEFAULT_HANNAH_DISCORD_USER_IDS[0]) == {}
    assert report._calendar_logo_aliases('unmapped-actor') == {}
    from dataclasses import replace
    from unit_tests.reports.test_income_projection import build, income_rows
    selected = build(income_rows(('9/1/2026', 'Fixture income', '5000')))
    assert report.expense_breakdown_client_payload(replace(selected, actor_key=DEFAULT_BRIAN_DISCORD_USER_IDS[0]))['calendarLogoAliases'] == aliases
    spoofed_name = replace(selected, actor_key=DEFAULT_HANNAH_DISCORD_USER_IDS[0], owner_name='Brian')
    assert report.expense_breakdown_client_payload(spoofed_name)['calendarLogoAliases'] == {}
