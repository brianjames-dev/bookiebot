"""Isolated original-month corrections; no current-month credits or live writes."""
from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace
import json

import pytest

from bookiebot.reports import bill_cancellation as end, bill_settings as bills, transactions as tx
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, SETTINGS_LOG_TAB, BillConflict
from bookiebot.sheets.recurring_rows import encode, runtime_tables
from bookiebot.sheets.recurring_charges import BillCharge, CHARGES_TAB, encode_charges, decode_charges
from unit_tests.sheets.test_recurring_storage import Transport, B, TODAY
from unit_tests.sheets.test_recurring import plan
from unit_tests.reports.test_bill_settings import access as access


@pytest.fixture
def setup(monkeypatch):
    p=replace(plan(),id='subscription_primary',name='Service',source_label='Service',source_tab=SUBSCRIPTION_TAB,
        amount_cents=1500,pull_day=1,kind='subscription',split_method='none',monthly_source=False,request_id='baseline',version='p1')
    other=replace(p,id='subscription_other',name='Other',source_label='Other',amount_cents=500,version='p2')
    rows={BILL_TAB:[],SUBSCRIPTION_TAB:encode([p,other],SUBSCRIPTION_TAB,[]),'Subscriptions':[]}
    for title in ['August','September','October','November','December']:
        rows[title]=[['','Subscriptions (Needs)','20'],['','(Needs) Subtotal:','=SUM(C1:C1)']]
    t=Transport(rows)
    send=t.batch_update
    def evaluate(identity,batch):
        import re
        send(identity,batch)
        for title,table in t.formulas.items():
            for r,line in enumerate(table):
                for c,value in enumerate(line):
                    if match:=re.fullmatch(r'=SUM\((.*?)\)(?:\+N\("[^"\n]+"\))?',str(value)):
                        from openpyxl.utils import column_index_from_string
                        amounts=[]
                        for token in match[1].split(','):
                            ref=re.fullmatch(r"'([^']+)'!([A-Z]+)(\d+)",token)
                            try:amounts.append(storage.numeric(storage.cell(t.rows[ref[1]],int(ref[3]),column_index_from_string(ref[2]))) if ref else float(token))
                            except (ValueError,KeyError):break
                        else:t.rows[title][r][c]=str(sum(amounts))
    t.batch_update=evaluate
    for title in ['August','September','October','November','December']:
        t.formulas[title][0][2]='=SUM(Subscriptions!C2:C3)'
    client=SimpleNamespace(http_client=t)
    monkeypatch.setattr('bookiebot.reports.phone_history.now_pacific',lambda:datetime(2026,12,31,12))
    monkeypatch.setattr(end,'configured_years',lambda *args:[2026])
    monkeypatch.setattr(end,'bank_refs',lambda owner:set())
    monkeypatch.setattr(bills,'read_workbook',lambda actor,today:storage.read_workbook(actor,today,client=client))
    return SimpleNamespace(p=p,other=other,t=t,source=lambda:bills.read_workbook(B,TODAY))


def body(s,**kwargs):
    source=s.source()
    return {'operation':'end','id':s.p.id,'version':s.p.version,'settingsVersion':source.settings.version,
            'effectiveFrom':'2026-09',**kwargs}


def test_review_lists_original_months_and_individual_removals_without_writes(setup):
    s=setup;value=end.review_end(B,s.source(),body(s),TODAY)
    assert value['cancellation']['removeMonths']==['2026-09','2026-10','2026-11']
    assert value['cancellation']['removedCents']==4500
    assert [i['amountCents'] for i in value['cancellation']['items']]==[1500]*3
    subset=end.review_end(B,s.source(),body(s,removeMonths=['2026-09','2026-11']),TODAY)
    assert subset['cancellation']['removedCents']==3000 and subset['reviewVersion']!=value['reviewVersion']
    assert not s.t.sent


def test_selected_charges_correct_each_original_month_and_keep_deselected_history(setup):
    s=setup;source=s.source()
    batch,audit=end.book_batch(source,s.p,'2026-09',['2026-09','2026-11'],TODAY,set(),'actual-end-request-123456')
    end.receipt(batch,'actual-end-request-123456','digest',{'success':True},audit,TODAY);batch.send()
    assert [float(s.t.rows[m][0][2]) for m in ['August','September','October','November']]==[20,5,20,5]
    assert s.t.rows['September'][1][2]=='=SUM(C1:C1)'
    charges=decode_charges(s.t.rows[CHARGES_TAB]);assert [(c.plan_id,c.month,c.initial_amount_cents) for c in charges]==[(s.p.id,'2026-10',1500)]
    _,virtual,_=runtime_tables('brian',s.t.rows[BILL_TAB],s.t.rows[SUBSCRIPTION_TAB],[],s.t.rows[CHARGES_TAB])
    for month,expected in [('2026-08',2000),('2026-09',500),('2026-10',2000),('2026-11',500),('2026-12',500)]:
        assert sum(r['amountCents'] for r in tx._subscription_rows(B,month,virtual,as_of=date(2026,12,31)))==expected
    headers=s.t.rows[SETTINGS_LOG_TAB][0]
    saved=json.loads(s.t.rows[SETTINGS_LOG_TAB][1][headers.index(end.AUDIT_COLUMN)])
    assert saved['cells'][0]['month']=='2026-09' and saved['beforePlans'] and saved['afterPlans']
    assert len(s.t.sent)==1


def test_bank_link_and_subtotal_mismatch_are_kept_not_silently_removed(setup):
    s=setup;source=s.source()
    refs={'billplan:'+s.p.id+'#pull=2026-10-01'}
    items=end.book_items(source,s.p,'2026-09',TODAY,refs)
    assert not items[1]['removable'] and 'Bank-linked' in items[1]['reason']
    with pytest.raises(BillConflict):end.book_batch(source,s.p,'2026-09',['2026-10'],TODAY,refs)
    s.t.rows['September'][0][2]='21';source=s.source()
    item=end.book_items(source,s.p,'2026-09',TODAY,set())[0]
    assert not item['removable'] and 'verification' in item['reason']
    assert not s.t.sent


@pytest.mark.parametrize('category,column', [('static_bills_subscriptions_needs',3),('subscriptions_wants',4)])
@pytest.mark.parametrize('period,title', [('2026-08','August'),('2026-11','November')])
def test_repaired_subtotal_unblocks_virtual_charge_without_changing_transactions(setup,category,column,period,title):
    from copy import deepcopy
    s=setup;p=replace(s.p,category=category);other=replace(s.other,category=category)
    annual=replace(other,id='annual_other_month',name='Annual service',source_label='Annual service',
        amount_cents=700,cadence='yearly',pull_months=(7,),version='annual-v1')
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([p,other,annual],SUBSCRIPTION_TAB,[])
    label='Subscriptions (Wants)' if column==4 else 'Subscriptions (Needs)'
    for month in ('August','September','October','November','December'):
        row=['',label,'',''];row[column-1]='27' if month==title else '20'
        s.t.rows[month]=[row]
        s.t.formulas[month]=deepcopy(s.t.rows[month])
    frozen=end._frozen(s.source(),p,period,TODAY)
    s.t.rows[CHARGES_TAB]=s.t.formulas[CHARGES_TAB]=encode_charges([frozen],[])
    s.t.properties[CHARGES_TAB]={'title':CHARGES_TAB,'sheetId':99}
    source=s.source()
    assert not end._summary_verified(source,period,category)
    assert 'verification' in next(i for i in end.book_items(source,p,period,TODAY,set()) if i['month']==period)['reason']
    def transactions():
        _,virtual,_=runtime_tables('brian',s.t.rows[BILL_TAB],s.t.rows[SUBSCRIPTION_TAB],[],s.t.rows[CHARGES_TAB])
        return tx._subscription_rows(B,period,virtual,as_of=date(2026,12,31))
    before_rows=deepcopy(s.t.rows);before_formulas=deepcopy(s.t.formulas);before_transactions=transactions()
    # Repair the derived subtotal only; the annual charge is due in July.
    s.t.rows[title][0][column-1]='20';s.t.formulas[title][0][column-1]='20'
    source=s.source()
    assert end._summary_verified(source,period,category)
    assert next(i for i in end.book_items(source,p,period,TODAY,set()) if i['month']==period)['removable']
    assert transactions()==before_transactions
    before_rows[title][0][column-1]='20';before_formulas[title][0][column-1]='20'
    assert s.t.rows==before_rows and s.t.formulas==before_formulas and not s.t.sent
    # Subtotal repair never bypasses independent bank/Shared safeguards.
    linked={'billplan:'+p.id+'#pull='+period+'-01'}
    assert 'Bank-linked' in next(i for i in end.book_items(source,p,period,TODAY,linked) if i['month']==period)['reason']
    source.allocations=[{'id':'shared','payerOwner':'brian','sourceWorksheet':'income','sourceYear':2026,
        'sourceSheetTitle':title,'billPlanId':p.id,'lifecycle':'active'}]
    assert 'Shared' in next(i for i in end.book_items(source,p,period,TODAY,set()) if i['month']==period)['reason']


def test_entered_or_split_payments_are_preserved(setup):
    s=setup;source=s.source()
    source.allocations=[{'id':'allocation','payerOwner':'brian','sourceWorksheet':'income','sourceYear':2026,
        'sourceSheetTitle':'October','billPlanId':s.p.id,'lifecycle':'active'}]
    item=next(i for i in end.book_items(source,s.p,'2026-09',TODAY,set()) if i['month']=='2026-10')
    assert not item['removable'] and 'Shared' in item['reason']
    assert next(i for i in end.book_items(source,s.p,'2026-09',TODAY,set()) if i['month']=='2026-11')['removable'], 'An older split cannot protect an unrelated later occurrence'
    with pytest.raises(BillConflict):end.book_batch(source,s.p,'2026-09',['2026-10'],TODAY,set())
    assert not s.t.sent


@pytest.fixture
def commands(setup,access,monkeypatch):
    from contextlib import nullcontext
    monkeypatch.setattr(bills,'now_pacific',lambda:datetime(2026,11,13,12))
    monkeypatch.setattr('bookiebot.reimbursements.projection.projection_lock',lambda _:nullcontext())
    monkeypatch.setattr('bookiebot.reimbursements.service.build_reimbursement_store',lambda:SimpleNamespace(snapshot=lambda *a,**kw:{'allocations':[]}))
    service=bills.BillCommands(access);service.initialize();return service


def confirmation(s,**options):
    request=body(s,**options);checked=bills.review(B,request)
    return {**request,'removeMonths':checked['cancellation']['removeMonths'],'reviewVersion':checked['reviewVersion'],'requestId':'end-reviewed-request-123456'}


def test_end_command_is_atomic_exactly_once_and_undo_restores_original_months(setup,commands):
    s=setup;request=confirmation(s,removeMonths=['2026-09','2026-11'])
    result=commands.command(B,request)
    assert result['state']=='done' and result['success'] and not result['historyCommands']
    assert commands.command(B,request)==result and len(s.t.sent)==1
    source=s.source();p=next(p for p in source.settings.records() if p.id==s.p.id)
    assert not p.active and end.latest_cancellation(source,p.id)==request['requestId']
    undo={'operation':'restore-end','id':p.id,'version':p.version,'settingsVersion':source.settings.version,'undoOf':request['requestId']}
    checked=bills.review(B,undo)
    assert checked['cancellation']['direction']=='restore' and checked['cancellation']['removedCents']==3000
    restored=commands.command(B,{**undo,'reviewVersion':checked['reviewVersion'],'requestId':'restore-reviewed-request-123456'})
    assert restored['success'] and len(s.t.sent)==2
    assert [float(s.t.rows[m][0][2]) for m in ['September','October','November']]==[20,20,20]
    assert next(p for p in s.source().settings.records() if p.id==s.p.id).active
    assert end.latest_cancellation(s.source(),s.p.id) is None


def test_selection_source_and_undo_conflicts_never_write(setup,commands):
    s=setup;request=confirmation(s)
    changed={**request,'removeMonths':['2026-09']}
    assert not commands.command(B,changed)['success'] and not s.t.sent
    request={**confirmation(s),'requestId':'valid-cancellation-123456'}
    assert commands.command(B,request)['success']
    source=s.source();p=next(p for p in source.settings.records() if p.id==s.p.id)
    s.t.rows['September'][0][2]='6'
    undo={'operation':'restore-end','id':p.id,'version':p.version,'settingsVersion':s.source().settings.version,'undoOf':request['requestId']}
    with pytest.raises(BillConflict,match='total changed'):
        bills.review(B,undo)
    assert len(s.t.sent)==1


def test_lost_end_acknowledgement_recovers_the_atomic_receipt_without_repeating(setup,commands):
    s=setup;request=confirmation(s);send=s.t.batch_update
    def lost(book,batch):send(book,batch);raise TimeoutError('lost acknowledgement')
    s.t.batch_update=lost
    assert commands.command(B,request)['state']=='uncertain'
    recovered=commands.saved(B,request['requestId'])
    assert recovered['state']=='done' and recovered['success']
    assert commands.command(B,request)==recovered and len(s.t.sent)==1


@pytest.mark.parametrize('finish_history',[True,False])
def test_cross_year_correction_and_restore_use_each_original_annual_receipt(setup,commands,monkeypatch,finish_history):
    s=setup
    from copy import deepcopy
    old=Transport(deepcopy(s.t.rows),deepcopy(s.t.formulas))
    historic=replace(s.p,amount_cents=1000,version='old-price')
    old.rows[SUBSCRIPTION_TAB]=old.formulas[SUBSCRIPTION_TAB]=encode([historic,s.other],SUBSCRIPTION_TAB,[])
    for title in ['August','September','October','November','December']:old.rows[title][0][2]='15'
    monkeypatch.setattr(storage,'get_budget_spreadsheet_id_for_user',lambda actor,year:'synthetic-'+str(year))
    monkeypatch.setattr(end,'configured_years',lambda *args:[2025,2026])
    monkeypatch.setattr(bills,'read_workbook',lambda actor,today:storage.read_workbook(actor,today,client=SimpleNamespace(http_client=old if today.year==2025 else s.t)))
    request=confirmation(s,effectiveFrom='2025-10',removeMonths=['2025-10','2026-09'])
    result=commands.command(B,request)
    assert result['success'] and len(result['historyCommands'])==1
    child=result['historyCommands'][0]
    assert child['year']==2025 and child['removeMonths']==['2025-10']
    recovery=commands.recoverable_flow('brian')
    assert recovery['stage']=='history' and recovery['historyCommands']==[child] and 'pending' not in recovery
    assert float(s.t.rows['September'][0][2])==5 and float(old.rows['October'][0][2])==15
    if finish_history:
        monkeypatch.setattr(bills,'now_pacific',lambda:datetime(2026,11,14,12))
        send=old.batch_update
        def lost(book,batch):send(book,batch);raise TimeoutError('lost historical acknowledgement')
        old.batch_update=lost
        assert commands.command(B,child)['state']=='uncertain'
        assert commands.recoverable_flow('brian')['pending']['body']==child
        assert commands.saved(B,child['requestId'])['success'], 'Recovery reads the original historical receipt, never the current workbook'
        assert float(old.rows['October'][0][2])==5 and float(old.rows['November'][0][2])==15
        assert commands.command(B,child)['success'] and len(old.sent)==1
        assert commands.recoverable_flow('brian') is None
        old.batch_update=send
    source=s.source();p=next(p for p in source.settings.records() if p.id==s.p.id)
    undo={'operation':'restore-end','id':p.id,'version':p.version,'settingsVersion':source.settings.version,'undoOf':request['requestId']}
    checked=bills.review(B,undo)
    restored=commands.command(B,{**undo,'reviewVersion':checked['reviewVersion'],'requestId':'cross-year-restore-123456'})
    assert restored['success'] and len(restored['historyCommands'])==int(finish_history)
    if finish_history:assert commands.command(B,restored['historyCommands'][0])['success']
    assert float(old.rows['October'][0][2])==15 and float(s.t.rows['September'][0][2])==20
    assert commands.recoverable_flow('brian') is None, 'An undone cancellation must not resurface its old unfinished stages'


def test_stop_now_can_keep_the_current_recorded_charge_without_deferring_the_end(setup,commands):
    s=setup;request=confirmation(s,effectiveFrom='2026-11',removeMonths=[])
    assert commands.command(B,request)['success']
    assert float(s.t.rows['November'][0][2])==20
    p=next(p for p in s.source().settings.records() if p.id==s.p.id)
    assert not p.active and p.effective_from=='2026-11'
    _,virtual,_=runtime_tables('brian',s.t.rows[BILL_TAB],s.t.rows[SUBSCRIPTION_TAB],[],s.t.rows[CHARGES_TAB])
    assert sum(r['amountCents'] for r in tx._subscription_rows(B,'2026-11',virtual,as_of=date(2026,12,31)))==2000
    assert sum(r['amountCents'] for r in tx._subscription_rows(B,'2026-12',virtual,as_of=date(2026,12,31)))==500


def test_previously_frozen_virtual_charge_can_be_removed_and_undone(setup,commands):
    s=setup;source=s.source()
    saved=end._frozen(source,s.p,'2026-09',TODAY)
    s.t.rows[CHARGES_TAB]=s.t.formulas[CHARGES_TAB]=encode_charges([saved],[])
    s.t.properties[CHARGES_TAB]={'title':CHARGES_TAB,'sheetId':99}
    request=confirmation(s,removeMonths=['2026-09']);assert commands.command(B,request)['success']
    assert not any(c.month=='2026-09' for c in decode_charges(s.t.rows[CHARGES_TAB]))
    source=s.source();p=next(p for p in source.settings.records() if p.id==s.p.id)
    undo={'operation':'restore-end','id':p.id,'version':p.version,'settingsVersion':source.settings.version,'undoOf':request['requestId']}
    checked=bills.review(B,undo)
    assert commands.command(B,{**undo,'reviewVersion':checked['reviewVersion'],'requestId':'restore-frozen-request-123456'})['success']
    assert next(c for c in decode_charges(s.t.rows[CHARGES_TAB]) if c.month=='2026-09')==saved


def test_new_bank_link_after_review_is_a_prewrite_conflict(setup,commands,monkeypatch):
    s=setup;request=confirmation(s)
    monkeypatch.setattr(end,'bank_refs',lambda owner:{'billplan:'+s.p.id+'#pull=2026-09-01'})
    assert not commands.command(B,request)['success'] and not s.t.sent


def test_quarterly_charges_use_only_their_actual_billing_months(setup):
    s=setup;p=replace(s.p,cadence='quarterly',pull_months=(3,6,9,12))
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([p,s.other],SUBSCRIPTION_TAB,[])
    for title in ['August','October','November']:s.t.rows[title][0][2]='5'
    checked=end.review_end(B,s.source(),body(s),TODAY)
    assert checked['cancellation']['removeMonths']==['2026-09'] and checked['cancellation']['removedCents']==1500
    with pytest.raises(BillConflict):end.review_end(B,s.source(),body(s,removeMonths=['2026-10']),TODAY)
    assert not s.t.sent


def test_automatic_fixed_bill_cells_are_corrected_in_their_original_rows(setup):
    s=setup;p=replace(s.p,kind='fixed',source_tab=BILL_TAB,monthly_source=True)
    s.t.rows[BILL_TAB]=s.t.formulas[BILL_TAB]=encode([p],BILL_TAB,[])
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([s.other],SUBSCRIPTION_TAB,[])
    for title in ['August','September','October','November','December']:
        s.t.rows[title]=[['','Service','15'],['','Subscriptions (Needs)','5'],['','(Needs) Subtotal:','=SUM(C1:C2)']]
        s.t.formulas[title]=[['','Service',"='_BookieBot Bill Schedule'!J2"],['','Subscriptions (Needs)','=SUM(Subscriptions!C2)'],['','(Needs) Subtotal:','=SUM(C1:C2)']]
    assert end._automatic_formula(s.source(),p,'=SUMIF(\'_BookieBot Bill Schedule\'!F:F,"Service",\'_BookieBot Bill Schedule\'!J:J)')
    assert not end._automatic_formula(s.source(),p,"='_BookieBot Bill Schedule'!J2+0"), 'Mentioning a schedule cannot authorize removal of an arbitrary formula'
    batch,audit=end.book_batch(s.source(),p,'2026-09',['2026-09','2026-11'],TODAY,set());batch.send()
    assert [float(s.t.rows[t][0][2]) for t in ['August','September','October','November']]==[15,0,15,0]
    assert [float(s.t.rows[t][1][2]) for t in ['August','September','October','November']]==[5,5,5,5]
    assert [c['column'] for c in audit['cells']]==[3,3]


def test_wants_subscription_removal_preserves_needs_and_uses_the_wants_subtotal(setup):
    s=setup;p=replace(s.p,category='subscriptions_wants')
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([p,s.other],SUBSCRIPTION_TAB,[])
    for title in ['August','September','October','November','December']:
        s.t.rows[title]=[['','Subscriptions (Needs)','5'],['','Subscriptions (Wants)','','15'],['','(Needs) Subtotal:','=SUM(C1:C1)'],['','(Wants) Subtotal:','','=SUM(D2:D2)']]
        s.t.formulas[title]=[['','Subscriptions (Needs)','=SUM(Subscriptions!C3)'],['','Subscriptions (Wants)','','=SUM(Subscriptions!C2)'],['','(Needs) Subtotal:','=SUM(C1:C1)'],['','(Wants) Subtotal:','','=SUM(D2:D2)']]
    batch,audit=end.book_batch(s.source(),p,'2026-09',['2026-09'],TODAY,set());batch.send()
    assert float(s.t.rows['September'][0][2])==5 and float(s.t.rows['September'][1][3])==0
    assert audit['cells'][0]['column']==4 and float(s.t.rows['November'][1][3])==15


def test_foreign_or_unconfirmed_historical_child_cannot_write(setup,commands):
    s=setup
    request={'operation':'end-year','year':2025,'id':s.p.id,'version':'p1','settingsVersion':'sv',
             'effectiveFrom':'2025-09','removeMonths':['2025-09'],'rootRequestId':'unconfirmed-root','reviewVersion':'v','requestId':'foreign-history-request-123456'}
    assert not commands.command(B,request)['success'] and not s.t.sent


def test_confirmed_future_invoice_is_visible_and_keeps_its_saved_payment_date(setup):
    s=setup;p=replace(s.p,kind='variable',source_tab=BILL_TAB,monthly_source=True,amount_cents=None,pull_day=22)
    s.t.rows[BILL_TAB]=s.t.formulas[BILL_TAB]=encode([p],BILL_TAB,[])
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([s.other],SUBSCRIPTION_TAB,[])
    for title in ['November','December']:
        s.t.rows[title]=s.t.formulas[title]=[['','Service','15'],['','Subscriptions (Needs)','5'],['','(Needs) Subtotal:','=SUM(C1:C2)']]
    source=s.source();items=end.book_items(source,p,'2026-11',TODAY,set())
    assert [(i['month'],i['removable']) for i in items]==[('2026-11',False),('2026-12',False)]
    batch,_=end.book_batch(source,p,'2026-11',[],TODAY,set());batch.send()
    charges=decode_charges(s.t.rows[CHARGES_TAB])
    assert {(c.month,c.payment_date) for c in charges}=={('2026-11','2026-11-22'),('2026-12','2026-12-22')}
    assert float(s.t.rows['November'][0][2])==float(s.t.rows['December'][0][2])==15


def test_future_bank_link_is_preserved_even_before_the_scheduled_pull_day(setup):
    s=setup;source=s.source();refs={'billplan:'+s.p.id+'#pull=2026-12-01'}
    items=end.book_items(source,s.p,'2026-12',TODAY,refs)
    assert len(items)==1 and items[0]['reason']=='Bank-linked payment — keep'
    batch,_=end.book_batch(source,s.p,'2026-12',[],TODAY,refs);batch.send()
    assert next(c for c in decode_charges(s.t.rows[CHARGES_TAB]) if c.month=='2026-12').initial_amount_cents==1500


def test_backdated_fixed_cancellation_preserves_original_categories_across_a_protected_change(setup,commands):
    s=setup
    needs=replace(s.p,kind='fixed',source_tab=BILL_TAB,monthly_source=True)
    wants=replace(needs,category='subscriptions_wants',effective_from='2026-11',version='wants-v2')
    s.p=wants
    s.t.rows[BILL_TAB]=s.t.formulas[BILL_TAB]=encode([replace(needs,effective_until='2026-11'),wants],BILL_TAB,[])
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([s.other],SUBSCRIPTION_TAB,[])
    for title in ['August','September','October','November','December']:
        s.t.rows[title]=[['','Service','15',''],['','Subscriptions (Needs)','5'],['','(Needs) Subtotal:','=SUM(C1:C2)'],['','(Wants) Subtotal:','','=SUM(D1:D1)']]
        s.t.formulas[title]=[['','Service',"='_BookieBot Bill Schedule'!J2",''],['','Subscriptions (Needs)','=SUM(Subscriptions!C2)'],['','(Needs) Subtotal:','=SUM(C1:C2)'],['','(Wants) Subtotal:','','=SUM(D1:D1)']]
    s.t.formulas['November'][0][2]='15'
    s.t.rows['December'][0][2]='0';s.t.rows['December'][0][3]='15'
    s.t.formulas['December'][0][2]='0';s.t.formulas['December'][0][3]="='_BookieBot Bill Schedule'!J3"
    original=BillCharge(needs.id,'2026-11','2026-11-01','Service',needs.category,s.t.properties['November']['sheetId'],1,3,
        end.source_anchor(needs.id,'2026-11'),1500,True,source_action_id='original-recorded-charge',payer_owner='brian',
        plan_snapshot=json.dumps(end.asdict(needs)),payment_date='2026-11-01')
    s.t.rows[CHARGES_TAB]=s.t.formulas[CHARGES_TAB]=encode_charges([original],[])
    s.t.properties[CHARGES_TAB]={'title':CHARGES_TAB,'sheetId':99}
    request=confirmation(s,removeMonths=['2026-09','2026-10'])
    assert commands.command(B,request)['success']
    assert [float(s.t.rows[t][0][2]) for t in ['August','September','October','November']]==[15,0,0,15]
    assert s.t.rows['November'][0][3]=='' and s.t.rows['October'][0][3]=='','Removing old Needs charges never moves them to Wants'
    assert next(c for c in decode_charges(s.t.rows[CHARGES_TAB]) if c.month=='2026-11')==original
    source=s.source();p=next(p for p in source.settings.records() if p.id==s.p.id)
    undo={'operation':'restore-end','id':p.id,'version':p.version,'settingsVersion':source.settings.version,'undoOf':request['requestId']}
    checked=bills.review(B,undo)
    assert commands.command(B,{**undo,'reviewVersion':checked['reviewVersion'],'requestId':'restore-category-history-123456'})['success']
    assert [float(s.t.rows[t][0][2]) for t in ['September','October','November']]==[15,15,15]
    assert s.t.rows['October'][0][3]=='' and s.t.rows['November'][0][3]==''
    assert float(s.t.rows['December'][0][3])==15 and float(s.t.rows['December'][0][2])==0
    assert next(c for c in decode_charges(s.t.rows[CHARGES_TAB]) if c.month=='2026-11')==original


def test_undo_restores_automatic_fixed_formula_provenance_for_later_corrections(setup):
    s=setup;p=replace(s.p,kind='fixed',source_tab=BILL_TAB,monthly_source=True)
    s.t.rows[BILL_TAB]=s.t.formulas[BILL_TAB]=encode([p],BILL_TAB,[])
    s.t.rows[SUBSCRIPTION_TAB]=s.t.formulas[SUBSCRIPTION_TAB]=encode([s.other],SUBSCRIPTION_TAB,[])
    for title in ['August','September','October','November','December']:
        s.t.rows[title]=[['','Service','15'],['','Subscriptions (Needs)','5'],['','(Needs) Subtotal:','=SUM(C1:C2)']]
        s.t.formulas[title]=[['','Service',"='_BookieBot Bill Schedule'!J2"],['','Subscriptions (Needs)','=SUM(Subscriptions!C2)'],['','(Needs) Subtotal:','=SUM(C1:C2)']]
    batch,audit=end.book_batch(s.source(),p,'2026-09',['2026-09'],TODAY,set());batch.send()
    audit['rootRequestId']='original-fixed-cancellation'
    s.t.formulas['September'][0][2]='=0'
    with pytest.raises(BillConflict,match='source formula changed'):
        end.restore_book(s.source(),audit,TODAY)
    s.t.formulas['September'][0][2]='0'
    for table in (s.t.rows,s.t.formulas):table['September'][0].append('7')
    with pytest.raises(BillConflict,match='other budget column changed'):
        end.restore_book(s.source(),audit,TODAY)
    assert len(s.t.sent)==1,'A changed formula or opposite category column must reject before writing'
    for table in (s.t.rows,s.t.formulas):table['September'][0][3]=''
    restored,_=end.restore_book(s.source(),audit,TODAY);restored.send()
    source=s.source();identity=p.id;p=next(v for v in source.settings.records() if v.id==identity)
    assert end._automatic_formula(source,p,s.t.formulas['September'][0][2]),'Undo restores an owned price-version formula rather than converting automatic history into entered cash'
    assert next(i for i in end.book_items(source,p,'2026-09',TODAY,set()) if i['month']=='2026-09')['removable']
