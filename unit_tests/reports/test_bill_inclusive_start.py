"""Inclusive recurring rules and actual Transactions, using isolated sheets."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

import pytest

from bookiebot.reports import bill_settings as bills, transactions as tx
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, selected
from bookiebot.sheets.recurring_changes import prepare_change
from bookiebot.sheets.recurring_charges import CHARGES_TAB, BillCharge, decode_charges, encode_charges, source_anchor
from bookiebot.sheets.recurring_rows import encode, runtime_tables
from unit_tests.reports.test_bill_settings import saved as saved, B, TODAY
from unit_tests.reports.test_goals_store import access as access
from unit_tests.sheets.test_recurring import form


def rent_fixture(saved, *, recorded=True):
    old = replace(saved.loan, name='Rent', source_label='Rent', amount_cents=None, category='rent',
        pull_day=1, request_id='baseline', effective_until='2026-12')
    future = replace(old, amount_cents=300000, effective_from='2026-12', effective_until='9999-12',
        version='future-v1', request_id='future-config')
    t = saved.client.http_client
    t.rows[BILL_TAB] = t.formulas[BILL_TAB] = encode([old, future], BILL_TAB, [])
    for month in ('October', 'November', 'December'):
        value = '2000' if month != 'December' and recorded else '0'
        t.rows[month][0] = ['', 'Rent', value]
        t.formulas[month][0] = ['', 'Rent', value]
    return old


def body_for(source, plan, **changes):
    fields = form(name=plan.name, type=plan.kind, amount='3000', pullDay=plan.pull_day,
        category=plan.category, splitMethod='none', effectiveFrom='2026-11')
    fields.update(changes)
    return {'operation':'update', 'id':plan.id, 'version':plan.version,
        'settingsVersion':source.settings.version, 'bill':fields}


def transactions(saved, monkeypatch, month='2026-11', as_of=datetime(2026,11,13,12)):
    monkeypatch.setattr(tx, 'now_pacific', lambda: as_of)
    monkeypatch.setattr('bookiebot.reports.phone_history.now_pacific', lambda: as_of)
    monkeypatch.setattr(tx, 'get_gspread_client', lambda: SimpleNamespace())
    monkeypatch.setattr(tx, 'get_budget_spreadsheet_id_for_user', lambda *args: 'personal')
    monkeypatch.setattr(tx, 'get_shared_expenses_spreadsheet_id', lambda *args: 'shared')
    monkeypatch.setattr(tx.shared, 'enabled', lambda: False)
    monkeypatch.setattr(tx, 'read_workbook_tabs', lambda client, book, titles, **kwargs:
        {title:deepcopy(saved.client.http_client.rows[title]) for title in titles if title in saved.client.http_client.rows}
        if book == 'personal' else {title:[] for title in titles if not title.startswith('_')})
    return tx.load_transactions(B, month, fresh=True)


def test_recorded_rent_can_really_start_in_november_and_remains_one_actual_transaction(saved, monkeypatch):
    p = rent_fixture(saved)
    before_rows = transactions(saved,monkeypatch)
    assert len(before_rows)==1 and before_rows[0]['date']=='2026-11-01', 'A legacy incomplete price cannot hide recorded Rent'
    source = bills.read_workbook(B, TODAY)
    assert source.settings.earliest_months[p.id] == '2026-12'
    request = body_for(source, p)
    checked = bills.review(B, request)
    assert checked['effectiveFrom'] == checked['after']['effectiveFrom'] == '2026-11'
    assert not saved.client.http_client.sent, 'Review must stay read-only'
    before = deepcopy(saved.client.http_client.rows['November'])
    command = {**request, 'reviewVersion':checked['reviewVersion'], 'requestId':'inclusive-rent-123456'}
    result = saved.commands.command(B, command)
    assert result['state'] == 'done' and result['success']
    after = bills.read_workbook(B, TODAY)
    current = selected(list(after.settings.plans), '2026-11')[0]
    assert current.effective_from == '2026-11' and current.amount_cents == 300000
    assert selected(list(after.settings.plans), '2026-12')[0].amount_cents == 300000
    assert saved.client.http_client.rows['November'] == before
    charges = decode_charges(after.rows[CHARGES_TAB])
    assert len(charges) == 1 and charges[0].recorded and not charges[0].virtual
    rows = [r for r in transactions(saved, monkeypatch) if r['billPlanId'] == p.id]
    assert len(rows) == 1
    assert (rows[0]['date'], rows[0]['amountCents']) == ('2026-11-01', 200000)
    assert rows[0]['id']==before_rows[0]['id']
    assert saved.commands.command(B, command) == result
    assert len(saved.client.http_client.sent) == 1


def test_unrecorded_current_rent_is_projected_and_visible_in_actual_transactions(saved, monkeypatch):
    p = rent_fixture(saved, recorded=False)
    source = bills.read_workbook(B, TODAY)
    change = prepare_change(source.settings, body_for(source, p), today=TODAY)
    storage.configuration_batch(source, change, 'unrecorded-rent-123456', 'fp', '{}', today=TODAY).send()
    assert float(saved.client.http_client.rows['November'][0][2]) == 3000
    assert CHARGES_TAB not in saved.client.http_client.rows
    rows = [r for r in transactions(saved, monkeypatch) if r['billPlanId'] == p.id]
    assert len(rows) == 1 and rows[0]['date'] == '2026-11-01' and rows[0]['amountCents'] == 300000


def test_a_due_virtual_subscription_keeps_its_recorded_price_until_separate_current_review(saved, monkeypatch):
    monkeypatch.setattr('bookiebot.reports.phone_history.now_pacific', lambda: datetime(2026,12,31,12))
    p = replace(saved.loan, id='virtual_sub_123', kind='subscription', name='Service', source_label='Service',
        source_tab=SUBSCRIPTION_TAB, amount_cents=1000, pull_day=1, monthly_source=False, request_id='baseline')
    t = saved.client.http_client
    t.rows[BILL_TAB] = t.formulas[BILL_TAB] = []
    t.rows[SUBSCRIPTION_TAB] = t.formulas[SUBSCRIPTION_TAB] = encode([p], SUBSCRIPTION_TAB, [])
    t.properties[SUBSCRIPTION_TAB] = {'title':SUBSCRIPTION_TAB, 'sheetId':99,
        'gridProperties':{'rowCount':100, 'columnCount':32}}
    for title in ('November', 'December'):
        t.rows[title] = [['', 'Subscriptions (Needs)', '10'], ['', '(Needs) Subtotal:', '=SUM(C1:C1)']]
        t.formulas[title] = [['', 'Subscriptions (Needs)', '=SUM(Subscriptions!C2)'], ['', '(Needs) Subtotal:', '=SUM(C1:C1)']]
    # Use the real legacy summary reference recognized by the projection.
    t.formulas['November'][0][2] = t.formulas['December'][0][2] = '=SUM(Subscriptions!C2)'
    source = bills.read_workbook(B, TODAY)
    request = body_for(source, p, amount='20')
    checked = bills.review(B, request)
    assert checked['effectiveFrom'] == '2026-11'
    result = saved.commands.command(B, {**request, 'reviewVersion':checked['reviewVersion'], 'requestId':'virtual-configuration-123456'})
    assert result['success']
    source = bills.read_workbook(B, TODAY)
    current = next(p for p in source.settings.records() if p.id == 'virtual_sub_123')
    assert current.amount_cents == 2000 and current.effective_from == '2026-11'
    charge = source.charge(current, '2026-11')
    assert charge['virtual'] and charge['recorded'] and charge['billAmountCents'] == 1000
    _, virtual, _ = runtime_tables('brian', source.rows[BILL_TAB], source.rows[SUBSCRIPTION_TAB], [], source.rows[CHARGES_TAB])
    assert [r['amountCents'] for r in tx._subscription_rows(B, '2026-11', virtual, as_of=TODAY)] == [1000]
    assert [r['amountCents'] for r in tx._subscription_rows(B, '2026-12', virtual, as_of=TODAY.replace(month=12, day=31))] == [2000]
    adopt = bills._amount_review(source, {'operation':'adopt', 'id':current.id, 'month':'2026-11',
        'settingsVersion':source.settings.version, 'chargeVersion':charge['version']}, TODAY)
    assert adopt['amount'] == 1000
    batch, native = bills.charge_batch(source, adopt, 'separate-adoption-123456')
    batch.send()
    stored = decode_charges(t.rows[CHARGES_TAB])
    assert len(stored) == 1 and not stored[0].virtual and native.initial_amount_cents == 1000
    rows = transactions(saved,monkeypatch)
    assert len(rows)==1 and rows[0]['billPlanId']==p.id and rows[0]['amountCents']==1000 and rows[0]['date']=='2026-11-01'


def test_recorded_utility_keeps_invoice_date_autopay_and_category_when_the_rule_starts_now(saved, monkeypatch):
    from bookiebot.reports import expense_breakdown as report
    p = replace(saved.loan, kind='variable', name='Utility', source_label='Utility', category='bills_utilities',
        amount_cents=None, pull_day=22, request_id='baseline')
    t = saved.client.http_client
    t.rows[BILL_TAB] = t.formulas[BILL_TAB] = encode([p], BILL_TAB, [])
    for title in ('November','December'):
        t.rows[title] = [['','Utility','7' if title=='November' else '0',''],
            ['','(Needs) Subtotal:','=SUM(C1:C1)'], ['','(Wants) Subtotal:','','=SUM(D1:D1)']]
        t.formulas[title] = deepcopy(t.rows[title])
    original = BillCharge(p.id,'2026-11','2026-11-01','Utility',p.category,t.properties['November']['sheetId'],1,3,
        source_anchor(p.id,'2026-11'),1000,True,'original-action','original-request','2026-11-01', 'brian')
    t.rows[CHARGES_TAB] = t.formulas[CHARGES_TAB] = encode_charges([original], [])
    t.properties[CHARGES_TAB] = {'title':CHARGES_TAB,'sheetId':99}
    source = bills.read_workbook(B,TODAY)
    change = prepare_change(source.settings,body_for(source,p,type='fixed',amount='20',pullDay=15,category='subscriptions_wants'),today=TODAY)
    storage.configuration_batch(source,change,'utility-current-rule-123456','fp','{}',today=TODAY).send()
    source = bills.read_workbook(B,TODAY)
    current = next(p for p in source.settings.records() if p.id==original.plan_id)
    assert current.kind=='fixed' and current.effective_from=='2026-11'
    charge = decode_charges(source.rows[CHARGES_TAB])[0]
    assert charge.charge_date=='2026-11-01' and charge.payment_date=='2026-11-22'
    assert charge.source_action_id=='original-action' and charge.request_id=='original-request'
    assert t.rows['November'][0][2:] == ['7','']
    assert float(t.rows['December'][0][2])==0 and float(t.rows['December'][0][3])==20
    runtime,_,_ = runtime_tables('brian',source.rows[BILL_TAB],[],[],source.rows[CHARGES_TAB])
    items = report._payment_items(t.rows['November'],runtime,report.BudgetMonth(2026,11),as_of=TODAY)
    assert [(i.date,i.status,i.group,i.amount) for i in items] == [('2026-11-22','queued','bills_utilities',7)]
    assert not transactions(saved,monkeypatch)
    rows = transactions(saved,monkeypatch,as_of=datetime(2026,11,22,12))
    assert len(rows)==1 and rows[0]['amountCents']==700 and rows[0]['date']=='2026-11-22'


def test_current_rule_lost_response_recovers_from_one_atomic_receipt_without_rewriting_cash(saved):
    p = rent_fixture(saved)
    source = bills.read_workbook(B,TODAY)
    request = body_for(source,p)
    checked = bills.review(B,request)
    command = {**request,'reviewVersion':checked['reviewVersion'],'requestId':'current-rule-lost-response-123456'}
    send = saved.client.http_client.batch_update
    def lost(book,batch):
        send(book,batch)
        raise TimeoutError('lost acknowledgement')
    saved.client.http_client.batch_update = lost
    assert saved.commands.command(B,command)['state']=='uncertain'
    result = saved.commands.saved(B,command['requestId'])
    assert result['state']=='done' and result['success'] and not result.get('splitPending')
    assert len(saved.client.http_client.sent)==1 and saved.client.http_client.rows['November'][0][2]=='2000'
    assert saved.commands.command(B,command)==result


def test_zero_cash_recorded_occurrence_is_not_recreated_or_resplit(saved,monkeypatch):
    from bookiebot.core import recurring_bills
    from unittest.mock import Mock
    p = rent_fixture(saved,recorded=False)
    t = saved.client.http_client
    original = BillCharge(p.id,'2026-11','2026-11-01','Rent','rent',t.properties['November']['sheetId'],1,3,
        source_anchor(p.id,'2026-11'),200000,True,'original-action','original-request','2026-11-01','brian')
    t.rows[CHARGES_TAB] = t.formulas[CHARGES_TAB] = encode_charges([original],[])
    t.properties[CHARGES_TAB] = {'title':CHARGES_TAB,'sheetId':99}
    source = bills.read_workbook(B,TODAY)
    change = prepare_change(source.settings,body_for(source,p,splitMethod='income'),today=TODAY)
    storage.configuration_batch(source,change,'zero-current-rule-123456','fp','{}',today=TODAY).send()
    assert t.rows['November'][0][2]=='0'
    charge = decode_charges(t.rows[CHARGES_TAB])[0]
    assert charge.initial_amount_cents==original.initial_amount_cents and charge.source_action_id==original.source_action_id
    writer = Mock(side_effect=AssertionError('Recorded cash cannot post again'))
    monkeypatch.setattr(recurring_bills,'now_pacific',lambda:datetime(2026,11,13,12))
    monkeypatch.setattr(bills,'build_commands',lambda:saved.commands)
    monkeypatch.setattr(bills,'carry_year',lambda *args:False)
    monkeypatch.setattr(bills,'prepare_month',lambda *args:False)
    monkeypatch.setattr(bills,'record_charge',writer)
    monkeypatch.setattr('bookiebot.reimbursements.service.enabled',lambda:True)
    assert recurring_bills.process_owner(B)==0
    writer.assert_not_called()


def test_new_current_month_split_covers_an_unrecorded_elapsed_due_date_exactly_once(saved,monkeypatch):
    from bookiebot.core import recurring_bills
    from unittest.mock import Mock
    p = rent_fixture(saved,recorded=False)
    source = bills.read_workbook(B,TODAY)
    change = prepare_change(source.settings,body_for(source,p,splitMethod='income'),today=TODAY)
    assert change.after.split_starts_on=='2026-11-01'
    storage.configuration_batch(source,change,'current-eligible-split-123456','fp','{}',today=TODAY).send()
    writer = Mock(return_value={'success':True,'detail':'Recorded.'})
    monkeypatch.setattr(recurring_bills,'now_pacific',lambda:datetime(2026,11,13,12))
    monkeypatch.setattr(bills,'build_commands',lambda:saved.commands)
    monkeypatch.setattr(bills,'carry_year',lambda *args:False)
    monkeypatch.setattr(bills,'prepare_month',lambda *args:False)
    monkeypatch.setattr(bills,'record_charge',writer)
    monkeypatch.setattr('bookiebot.reimbursements.service.enabled',lambda:True)
    monkeypatch.setattr(recurring_bills.time,'time',lambda:300.)
    assert recurring_bills.process_owner(B)==1
    assert writer.call_args.args[1]['date']=='2026-11-01'
    monkeypatch.setattr(recurring_bills.time,'time',lambda:600.)
    assert recurring_bills.process_owner(B)==0 and writer.call_count==1


def test_autopay_crossing_invalidates_an_earlier_current_month_review(saved,monkeypatch):
    p = rent_fixture(saved)
    p = replace(p,pull_day=15,amount_cents=200000)
    t = saved.client.http_client
    future = replace(p,effective_from='2026-12',effective_until='9999-12',amount_cents=300000,version='future-v1')
    t.rows[BILL_TAB] = t.formulas[BILL_TAB] = encode([p,future],BILL_TAB,[])
    t.formulas['November'][0][2] = "='_BookieBot Bill Schedule'!J2"
    monkeypatch.setattr(bills,'now_pacific',lambda:datetime(2026,11,14,12))
    source = bills.read_workbook(B,TODAY.replace(day=14))
    request = body_for(source,p)
    checked = bills.review(B,request)
    monkeypatch.setattr(bills,'now_pacific',lambda:datetime(2026,11,15,12))
    current = bills.read_workbook(B,TODAY.replace(day=15))
    assert source.settings.version != current.settings.version
    result = saved.commands.command(B,{**request,'reviewVersion':checked['reviewVersion'],'requestId':'crossed-due-review-123456'})
    assert result['state']=='done' and not result['success'] and not t.sent
