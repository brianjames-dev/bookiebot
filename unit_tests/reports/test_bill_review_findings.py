from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from unittest.mock import Mock

import pytest

from bookiebot.reports import bill_settings as bills
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, normalize_plan
from bookiebot.sheets.recurring_rows import encode, decode, runtime_tables
from unit_tests.sheets.test_recurring import plan, form
from unit_tests.sheets.test_recurring_storage import B, TODAY, fixture
from unit_tests.reports.test_bill_settings import saved as saved
from unit_tests.reports.test_goals_store import access as access


@pytest.mark.parametrize('legacy', [False, True])
@pytest.mark.parametrize('wants', [False, True])
@pytest.mark.parametrize('other_zero', ['0', '=SUM(0)'])
def test_adoption_removes_only_this_occurrence_from_sheet_summary_and_future_projection(legacy, wants, other_zero, monkeypatch):
    monkeypatch.setattr(bills, 'now_pacific', lambda: datetime(2026, 11, 13, 12))
    client, _ = fixture()
    transport = client.http_client
    category = 'subscriptions_wants' if wants else 'static_bills_subscriptions_needs'
    column = 4 if wants else 3
    sub = plan(id='subscription_123', kind='subscription', name='Zoom', source_label='Zoom',
               source_tab=SUBSCRIPTION_TAB, amount_cents=2500, pull_day=3, category=category,
               version='sub-v1', monthly_source=False)
    if legacy:
        visible = [[''] * 16 for _ in range(7)]
        start = 9 if wants else 1
        visible[4][start] = 'Monthly Wants' if wants else 'Monthly Needs'
        visible[5][start:start + 3] = ['Recurring:', 'Name:', 'Amount:']
        visible[6][start:start + 3] = ['3rd', 'Zoom', '25']
        transport.rows['Subscriptions'] = visible
        transport.formulas['Subscriptions'] = deepcopy(visible)
    else:
        encoded = encode([sub], SUBSCRIPTION_TAB, [])
        transport.rows[SUBSCRIPTION_TAB] = encoded
        transport.formulas[SUBSCRIPTION_TAB] = deepcopy(encoded)
        transport.properties[SUBSCRIPTION_TAB] = {'title': SUBSCRIPTION_TAB, 'sheetId': 99, 'gridProperties': {'rowCount': 100, 'columnCount': 32}}
    for title in ('November', 'December'):
        transport.rows[title] = [['', 'Subscriptions (Wants)' if wants else 'Subscriptions (Needs)', '', ''],
                                 ['', '(Wants) Subtotal:' if wants else '(Needs) Subtotal:', '', '']]
        transport.rows[title][0][column - 1] = '25'
        transport.rows[title][0][2 if wants else 3] = other_zero
        transport.formulas[title] = deepcopy(transport.rows[title])
        transport.formulas[title][0][column - 1] = '=SUM(Subscriptions!L5)' if wants else '=SUM(Subscriptions!D5)'
        letter = 'D' if wants else 'C'
        transport.formulas[title][1][column - 1] = f'=SUM({letter}1:{letter}1)'
        transport.rows[title].append(['', 'Student Loan', '60.23'])
        transport.formulas[title].append(['', 'Student Loan', '60.23'])
        if wants:
            transport.rows[title].append(['', '(Needs) Subtotal:', '=SUM(C3:C3)'])
            transport.formulas[title].append(['', '(Needs) Subtotal:', '=SUM(C3:C3)'])
    source = storage.read_workbook(B, TODAY, client=client)
    sub = next(p for p in source.settings.plans if p.name == 'Zoom')
    checked = {'plan': sub, 'info': source.charge(sub, '2026-11'), 'amount': 2500, 'date': '2026-11-03'}
    batch, _ = bills.charge_batch(source, checked, 'adopt-request-123456')
    adopted_index = len(source.rows['November']) + 1
    assert not transport.sent
    batch.send()
    assert transport.formulas['November'][0][column - 1] == '=SUM(0)'
    assert transport.formulas['November'][0][2 if wants else 3] == other_zero
    assert transport.rows['November'][adopted_index][1] == 'Zoom'
    assert float(transport.rows['November'][adopted_index][column - 1]) == 25
    assert transport.rows['December'][0][column - 1] == '25'
    # Both the normal configuration projection and background month preparation
    # must continue excluding an adopted occurrence, even after full repayment.
    transport.rows['November'][adopted_index][column - 1] = '0'
    transport.formulas['November'][adopted_index][column - 1] = '0'
    for update_existing in (False, True):
        current = storage.read_workbook(B, TODAY, client=client)
        batch = storage.SheetBatch(current)
        storage.project_sources(batch, list(current.settings.plans),
            {t: current.rows.get(t, []) for t in (BILL_TAB, SUBSCRIPTION_TAB)},
            start_month='2026-11', today=TODAY, update_existing=update_existing)
        batch.send()
        assert transport.formulas['November'][0][column - 1] == '=SUM(0)'
        assert transport.formulas['December'][0][column - 1].startswith('=SUM(')
        assert transport.formulas['December'][0][2 if wants else 3] == other_zero
        monthly, virtual, _ = runtime_tables('brian', current.rows[BILL_TAB], current.rows[SUBSCRIPTION_TAB], [], current.rows[bills.CHARGES_TAB])
        assert not any(p.id == sub.id and p.due_date('2026-11') for p in decode(virtual, SUBSCRIPTION_TAB))
        assert any(p.id == sub.id and p.category == category for p in decode(monthly, BILL_TAB))


@pytest.mark.parametrize('category', ['rent', 'bills_utilities'])
def test_subscription_other_categories_have_monthly_source_in_new_and_saved_plans(category):
    normalized = normalize_plan(form(type='subscription', name='Zoom', category=category, splitMethod='none'),
        current=None, today=TODAY, plan_id='subscription_123')
    assert normalized.monthly_source
    # Plans saved by the original implementation must use the same accounting
    # route when read; inspection itself still does not mutate Sheets.
    original = replace(normalized, monthly_source=False, version='saved-v1')
    decoded = decode(encode([original], SUBSCRIPTION_TAB, []), SUBSCRIPTION_TAB)[0]
    assert decoded.monthly_source and decoded.category == category
    client, _ = fixture()
    client.http_client.rows[SUBSCRIPTION_TAB] = encode([original], SUBSCRIPTION_TAB, [])
    client.http_client.formulas[SUBSCRIPTION_TAB] = deepcopy(client.http_client.rows[SUBSCRIPTION_TAB])
    client.http_client.properties[SUBSCRIPTION_TAB] = {'title': SUBSCRIPTION_TAB, 'sheetId': 99, 'gridProperties': {'rowCount': 100, 'columnCount': 32}}
    source = storage.read_workbook(B, TODAY, client=client)
    assert not client.http_client.sent
    batch = storage.SheetBatch(source)
    storage.project_sources(batch, list(source.settings.plans),
        {t: source.rows.get(t, []) for t in (BILL_TAB, SUBSCRIPTION_TAB)}, start_month='2026-11', today=TODAY, update_existing=False)
    batch.send()
    rows = client.http_client.rows['November']
    index = next(i for i, r in enumerate(rows) if len(r) > 1 and r[1] == normalized.source_label)
    assert float(rows[index][2]) == 60.23
    monthly, _, _ = runtime_tables('brian', source.rows[BILL_TAB], source.rows[SUBSCRIPTION_TAB], [])
    assert next(p for p in decode(monthly, BILL_TAB) if p.id == normalized.id).category == category


@pytest.mark.parametrize('before,after', [('subscription', 'fixed'), ('subscription', 'variable'),
    ('fixed', 'subscription'), ('fixed', 'variable'), ('variable', 'subscription'), ('variable', 'fixed')])
def test_effective_type_changes_keep_identity_source_and_earlier_history(before, after):
    from bookiebot.sheets.recurring import versioned, selected
    tab = SUBSCRIPTION_TAB if before == 'subscription' else BILL_TAB
    original = plan(id='changing_type_123', kind=before, source_tab=tab, version='original-v1',
                    monthly_source=before != 'subscription')
    changed = normalize_plan(form(type=after, splitMethod='none', effectiveFrom='2026-12'),
                             current=original, today=TODAY, plan_id=original.id)
    versions = decode(encode(versioned([original], changed, 'change-type'), tab, []), tab)
    november, december = selected(versions, '2026-11')[0], selected(versions, '2026-12')[0]
    assert november.kind == before and november.amount_cents == original.amount_cents
    assert december.kind == after and december.id == november.id == original.id
    assert december.source_tab == november.source_tab == tab
    assert december.source_label == november.source_label == original.source_label
    assert december.monthly_source  # Preserve physical sources across later conversions.


@pytest.mark.parametrize('source_kind', ['fixed', 'subscription'])
@pytest.mark.parametrize('update_existing', [False, True])
def test_variable_conversion_clears_automatic_formulas_but_preserves_recorded_cash(source_kind, update_existing):
    tab = SUBSCRIPTION_TAB if source_kind == 'subscription' else BILL_TAB
    original = plan(id='changing_type_123', kind=source_kind, version='original-v1',
                    source_tab=tab, monthly_source=True, pull_day=31)
    client, _ = fixture([original])
    transport = client.http_client
    if tab == SUBSCRIPTION_TAB:
        transport.rows[tab] = encode([original], tab, [])
        transport.formulas[tab] = deepcopy(transport.rows[tab])
        transport.properties[tab] = {'title': tab, 'sheetId': 99, 'gridProperties': {'rowCount': 100, 'columnCount': 32}}
    # November is eligible, but December is a real, manually entered payment.
    transport.formulas['December'][0][2] = '60.23'
    transport.formulas['November'][0][2] = f"='{tab}'!{'C' if tab == SUBSCRIPTION_TAB else 'J'}2"
    source = storage.read_workbook(B, TODAY, client=client)
    # The normal minimum prevents overriding the already recorded December
    # payment. Test projection's independent protection as well.
    assert source.settings.earliest_months[original.id] == '2027-01'
    after = normalize_plan(form(type='variable', amount='60.23', splitMethod='none', effectiveFrom='2026-11'),
                           current=original, today=TODAY, plan_id=original.id)
    from bookiebot.sheets.recurring import versioned
    versions = versioned(list(source.settings.plans), after, 'change-type')
    tables = {t: encode(versions, t, source.formulas.get(t, [])) if t == tab else source.rows.get(t, [])
              for t in (BILL_TAB, SUBSCRIPTION_TAB)}
    # Use a normal unrecorded November snapshot, preserving the literal later
    # payment and the historical October amount regardless of configuration.
    source.settings.earliest_months[original.id] = '2026-11'
    batch = storage.SheetBatch(source)
    storage.project_sources(batch, versions, tables, start_month='2026-11', today=TODAY, update_existing=update_existing)
    assert not transport.sent
    batch.send()
    assert transport.rows['October'][0][2] == '60.23'
    assert transport.rows['November'][0][2] in {'', '0'}
    assert transport.rows['December'][0][2] == '60.23'
    assert not transport.formulas['December'][0][2].startswith('=')
    # A recorded source is preserved even if it happens to contain a known
    # schedule formula rather than a literal, in both projection routes.
    transport.rows['November'][0][2] = '60.23'
    transport.formulas['November'][0][2] = f"='{tab}'!{'C' if tab == SUBSCRIPTION_TAB else 'J'}2"
    source = storage.read_workbook(B, TODAY, client=client)
    source.recorded_plans.add((original.id, '2026-11'))
    batch = storage.SheetBatch(source)
    storage.project_sources(batch, versions, tables, start_month='2026-11', today=TODAY, update_existing=update_existing)
    batch.send()
    assert float(transport.rows['November'][0][2]) == 60.23


@pytest.mark.parametrize('failure', ['prewrite', 'rejected', 'lost', 'uncertain'])
def test_month_preparation_retries_only_definitive_no_write_failures(saved, monkeypatch, failure):
    extra = replace(saved.loan, id='new_plan_123', name='Insurance', source_label='Insurance', version='extra-v1')
    encoded = encode([saved.loan, extra], BILL_TAB, [])
    saved.client.http_client.rows[BILL_TAB] = encoded
    saved.client.http_client.formulas[BILL_TAB] = deepcopy(encoded)
    source = bills.read_workbook(B, TODAY)
    writer = saved.client.http_client.batch_update
    if failure == 'prewrite':
        reader = bills.read_workbook
        monkeypatch.setattr(bills, 'read_workbook', Mock(side_effect=RuntimeError('read failed')))
        assert not bills.prepare_month(B, source, saved.commands)
        monkeypatch.setattr(bills, 'read_workbook', reader)
    else:
        def failed(identity, body):
            if failure == 'rejected':
                from gspread.exceptions import APIError
                response = Mock(status_code=429)
                response.json.return_value = {'error': {'code': 429, 'message': 'quota'}}
                raise APIError(response)
            if failure == 'lost':
                writer(identity, body)
            raise TimeoutError('unknown outcome')
        saved.client.http_client.batch_update = Mock(side_effect=failed)
        assert not bills.prepare_month(B, source, saved.commands)
        saved.client.http_client.batch_update = writer
    if failure in ('prewrite', 'rejected'):
        assert bills.prepare_month(B, source, saved.commands)
        assert len(saved.client.http_client.sent) == 1
        with saved.commands.access.connect() as db:
            attempts = db.execute("SELECT state,result_json FROM app_bill_commands WHERE owner_key='brian'").fetchall()
        assert len(attempts) == 2 and all(r['state'] == 'done' for r in attempts)
        assert bills.prepare_month(B, source, saved.commands)
        assert len(saved.client.http_client.sent) == 1  # Successful retries stay idempotent too.
    else:
        assert not bills.prepare_month(B, source, saved.commands)
        assert len(saved.client.http_client.sent) == (1 if failure == 'lost' else 0)
        pending = saved.commands.pending('brian')
        assert pending
        recovered = saved.commands.saved(B, pending['requestId'])
        assert recovered['state'] == ('done' if failure == 'lost' else 'uncertain')
