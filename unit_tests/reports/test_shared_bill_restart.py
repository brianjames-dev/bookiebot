"""Restart accepted bills through real commands; no live workbook mutations."""
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
from uuid import uuid4

import pytest
from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer

from bookiebot.reimbursements import service
from bookiebot.reports import bill_settings, shared_bills, shared_bill_forecast, transactions
from bookiebot.reports import phone_app, phone_bills, phone_shared_bills
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reimbursements.test_store import payment
from unit_tests.reports.test_shared_bill_updates import (
    household, catalog, store, BRIAN, HANNAH, people, accept_utilities,
    configuration_body, bill_views, november_history, original_rows,
    financial_report, transaction_rows, calendar_bill_cents,
)


def save(household, body):
    checked = bill_settings.review(BRIAN,body)
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    result = household.commands.command(BRIAN,command)
    assert result['success'], result
    assert household.commands.command(BRIAN,command)==result
    return checked,command,result


def stop(household, name, start):
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name==name)
    return save(household,{'operation':'end','id':plan.id,'version':plan.version,
        'settingsVersion':source.settings.version,'effectiveFrom':start,'removeMonths':[]})


def one_bill(household, actor, name):
    rows = bill_views(household,actor)
    assert len(rows)==4, 'Keep the original four bill identities, with no new setup mirror'
    matches = [b for b in rows if b['name']==name]
    assert len(matches)==1
    return matches[0]


def view_payload(household, actor):
    return shared_bills.enrich_listing(actor,bill_settings.listing(actor),store=household.catalog)


@pytest.mark.parametrize('name', ['Rent','Water','PG&E','Recology'])
@pytest.mark.parametrize('action', ['restart','undo-cancellation'])
def test_restart_same_recorded_cycle_reuses_shared_id_and_never_reposts_cash(household,monkeypatch,name,action):
    monkeypatch.setattr('bookiebot.reports.bill_cancellation.bank_refs',lambda _owner:set())
    accept_utilities(household)
    before = november_history(household)
    ledger = deepcopy(household.ledger.snapshot('brian'))
    original = {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}
    identities = {actor:one_bill(household,actor,name)['id'] for actor in (BRIAN,HANNAH)}
    memberships = deepcopy(household.catalog.links(people(household.catalog)[0]))
    _,stopped,stop_result = stop(household,name,'2026-11')
    assert all(not one_bill(household,actor,name)['active'] for actor in (BRIAN,HANNAH))
    export_target = os.getenv('BOOKIEBOT_SHARED_BILL_RESTART_FIXTURE') if action=='restart' and name=='Water' else None
    stopped_views = {actor:view_payload(household,actor) for actor in (BRIAN,HANNAH)} if export_target else None
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name==name)
    if action=='restart':
        body = {**configuration_body(household,name,plan.split_method,plan.payer_basis_points,'2026-11'),
            'applyCurrentCharge':False}
    else:
        body = {'operation':'restore-end','id':plan.id,'version':plan.version,
            'settingsVersion':source.settings.version,'undoOf':stopped['requestId']}
    checked,restarted,_ = save(household,body)
    assert not checked['before']['active'] and checked['after']['active']
    assert checked['before']['id']==checked['after']['id']==plan.id
    # A late replay/recovery of Stop cannot undo a later successful restart.
    assert household.commands.command(BRIAN,stopped)==stop_result
    for actor in (BRIAN,HANNAH):
        value = one_bill(household,actor,name)
        assert value['active'] and value['id']==identities[actor]
        assert value['sharing']['status']=='active'
        assert value['charge']['recorded']
    member = one_bill(household,HANNAH,name)['sharing']['state']
    old = next(a for a in before[2] if a['item']==name)
    assert member['allocationIds']==[old['id']]
    assert member['memberShareCents']==member['receivedCents']==old['partnerShareCents']
    assert member['remainingCents']==0
    assert household.catalog.links(people(household.catalog)[0])==memberships
    assert household.ledger.snapshot('brian')==ledger
    assert november_history(household)==before
    assert {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}==original
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.id==plan.id)
    with pytest.raises(ValueError,match='already recorded'):
        bill_settings.review(BRIAN,{'operation':'scheduled' if name=='Rent' else 'amount','id':plan.id,
            'month':'2026-11','settingsVersion':source.settings.version,
            'chargeVersion':source.charge(plan,'2026-11')['version'],**({} if name=='Rent' else {'amount':'999'})})
    if export_target:
        from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
        Path(export_target).write_text(json.dumps({'stopped':stopped_views,'review':checked,'command':restarted,
            'result':household.commands.saved(BRIAN,restarted['requestId']),
            'active':{actor:view_payload(household,actor) for actor in (BRIAN,HANNAH)},
            'reports':{actor:expense_breakdown_client_payload(financial_report(household,actor)) for actor in (BRIAN,HANNAH)},
            'transactions':{actor:transactions.listing(actor,{'month':'2026-11','view':'daily','scope':'spending','fresh':'1'}) for actor in (BRIAN,HANNAH)},
            'actors':{'Brian':BRIAN,'Hannah':HANNAH},'ids':identities}))


def test_restart_preserves_partial_receipt_and_one_transaction_for_an_open_split(household,monkeypatch):
    monkeypatch.setattr('bookiebot.reports.bill_cancellation.bank_refs',lambda _owner:set())
    accept_utilities(household)
    old_history = november_history(household)
    household.clock[0] = datetime(2026,12,1,12,tzinfo=PACIFIC_TZ)
    save(household,{**configuration_body(household,'Water','custom',6000,'2026-12'),'applyCurrentCharge':False})
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name=='Water')
    save(household,{'operation':'amount','id':plan.id,'month':'2026-12','amount':'200',
        'settingsVersion':source.settings.version,'chargeVersion':source.charge(plan,'2026-12')['version']})
    allocation = next(a for a in household.ledger.snapshot('brian')['allocations'] if a['sourceSheetTitle']=='December')
    service.command('brian',{**payment(allocation,1000),'date':'2026-12-01'})
    before = deepcopy(household.ledger.snapshot('brian'))
    rows = [r for r in transaction_rows(HANNAH,'2026-12') if r['title']=='Water']
    assert len(rows)==1 and rows[0]['amountCents']==1000
    stop(household,'Water','2026-12')
    save(household,{**configuration_body(household,'Water','custom',6000,'2026-12'),'applyCurrentCharge':False})
    assert household.ledger.snapshot('brian')==before
    shared = one_bill(household,HANNAH,'Water')['sharing']['state']
    assert shared['receivedCents']==1000 and shared['remainingCents']==7000
    assert shared['allocationIds']==[allocation['id']]
    after = [r for r in transaction_rows(HANNAH,'2026-12') if r['title']=='Water']
    assert len(after)==1 and after[0]['id']==rows[0]['id'] and after[0]['amountCents']==1000
    assert after[0]['repayment']['outstandingCents']==7000
    assert november_history(household)==old_history


@pytest.mark.asyncio
async def test_two_authenticated_apps_invalidate_stopped_cache_on_restart_without_reinviting(household,monkeypatch):
    import bookiebot.reports.bill_checkin as checkin
    monkeypatch.setattr('bookiebot.reports.bill_cancellation.bank_refs',lambda _owner:set())
    accept_utilities(household)
    original = november_history(household)
    ledger = deepcopy(household.ledger.snapshot('brian'))
    monkeypatch.setattr(checkin,'build_store',lambda:checkin.BillCheckinStore(household.catalog.access))
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL','http://127.0.0.1')
    monkeypatch.setattr(phone_app,'build_app_access_store',lambda:household.catalog.access)
    monkeypatch.setattr(bill_settings,'build_commands',lambda:household.commands)
    app = web.Application();phone_bills.register_phone_bill_routes(app);phone_shared_bills.register_shared_bill_routes(app)
    app.router.add_post('/app/connect',phone_app._connect_phone)
    headers = {'X-BookieBot-App':'1','Origin':'http://127.0.0.1'}
    async with TestServer(app) as server, TestClient(server,cookie_jar=CookieJar(unsafe=True)) as brian, TestClient(server,cookie_jar=CookieJar(unsafe=True)) as hannah:
        for http,actor,owner in ((brian,BRIAN,'brian'),(hannah,HANNAH,'hannah')):
            response = await http.post('/app/connect',headers=headers,json={'token':household.catalog.access.issue_pairing(actor,owner)})
            assert response.status==200
        async def get(http,path):
            response = await http.get(path);assert response.status==200,await response.text();return await response.json()
        async def post(path,body):
            response = await brian.post(path,headers=headers,json=body);assert response.status==200,await response.text();return await response.json()
        identities = [next(b for b in (await get(http,'/app/bills'))['bills'] if b['name']=='Water')['id'] for http in (brian,hannah)]
        before = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
        plan = next(p for p in source.settings.records() if p.name=='Water')
        body = {'operation':'end','id':plan.id,'version':plan.version,'settingsVersion':source.settings.version,'effectiveFrom':'2026-11','removeMonths':[]}
        reviewed = (await post('/app/bills/review',body))['review']
        stopped = {**body,'reviewVersion':reviewed['reviewVersion'],'requestId':uuid4().hex}
        stopped_result = await post('/app/bills',stopped)
        assert stopped_result['success']
        for http in (brian,hannah):
            assert not next(b for b in (await get(http,'/app/bills'))['bills'] if b['name']=='Water')['active']
        stopped_cursors = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        body = {**configuration_body(household,'Water','equal',5000,'2026-11'),'applyCurrentCharge':False}
        checked = (await post('/app/bills/review',body))['review']
        assert not checked['before']['active'] and checked['after']['active']
        assert [await get(http,'/app/account/changes') for http in (brian,hannah)]==stopped_cursors
        denied = await hannah.post('/app/bills/review',headers=headers,json=body)
        assert denied.status in {400,409}, 'Only the payer can restart the recurring source'
        restarted = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
        result = await post('/app/bills',restarted)
        assert result['success'] and await post('/app/bills',restarted)==result
        assert await post('/app/bills',stopped)==stopped_result
        for http,identity,initial,ended in zip((brian,hannah),identities,before,stopped_cursors):
            current = await get(http,'/app/account/changes')
            assert current['revision']>ended['revision']>initial['revision']
            assert current['ledgerVersion']==ended['ledgerVersion']==initial['ledgerVersion']
            bills = (await get(http,'/app/bills'))['bills']
            assert len(bills)==4
            value = next(b for b in bills if b['name']=='Water')
            assert value['id']==identity and value['active'] and value['sharing']['status']=='active'
        assert household.ledger.snapshot('brian')==ledger
        assert november_history(household)==original


@pytest.mark.parametrize('name,period', [('Rent','2027-01'),('Water','2027-01'),('PG&E','2027-01'),('Recology','2027-02')])
def test_future_restart_after_gap_and_year_carry_records_one_new_split_and_keeps_old_receipts(household,monkeypatch,name,period):
    monkeypatch.setattr('bookiebot.reports.bill_cancellation.bank_refs',lambda _owner:set())
    accept_utilities(household)
    before = november_history(household)
    original = {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}
    memberships = deepcopy(household.catalog.links(people(household.catalog)[0]))
    _,stopped,stop_result = stop(household,name,'2026-12')
    household.clock[0] = datetime(2026,12,1,12,tzinfo=PACIFIC_TZ)
    assert all(not one_bill(household,actor,name)['active'] for actor in (BRIAN,HANNAH))
    body = {**configuration_body(household,name,'custom',6000,'2027-01',amount='3200' if name=='Rent' else None),
        'applyCurrentCharge':False}
    checked,_,_ = save(household,body)
    assert not checked['before']['active'] and checked['after']['active']
    for actor in (BRIAN,HANNAH):
        value = one_bill(household,actor,name)
        assert not value['active'] and value['nextChange']['active']
        assert value['nextChange']['effectiveFrom']=='2027-01'
        assert not [r for r in transaction_rows(actor,'2026-12') if r['title']==name]
        assert calendar_bill_cents(household,actor,name)==0, 'Do not fill the stopped interval retroactively'
    household.clock[0] = datetime.fromisoformat(period+'-01T12:00:00').replace(tzinfo=PACIFIC_TZ)
    assert bill_settings.carry_year(BRIAN,bill_settings.read_workbook(BRIAN,household.clock[0].date()),household.commands)
    for actor in (BRIAN,HANNAH):
        assert one_bill(household,actor,name)['active']
    if name=='Recology':
        assert not [f for f in shared_bill_forecast.forecast_inputs(HANNAH,['2027-01']) if f.name==name]
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name==name)
    _,_,saved = save(household,{'operation':'scheduled' if name=='Rent' else 'amount','id':plan.id,
        'month':period,'settingsVersion':source.settings.version,'chargeVersion':source.charge(plan,period)['version'],
        **({} if name=='Rent' else {'amount':'200'})})
    assert not saved.get('splitPending')
    allocations = [a for a in household.ledger.snapshot('brian')['allocations']
        if a['sourceYear']==2027 and a.get('billPlanId')==plan.id]
    assert len(allocations)==1
    value = allocations[0]
    assert (value['payerShareCents'],value['partnerShareCents'])==((192000,128000) if name=='Rent' else (12000,8000))
    receipt = {**payment(value,value['partnerShareCents']),'date':period+'-01'}
    service.command('brian',receipt)
    events = deepcopy(household.ledger.snapshot('brian')['events'])
    service.command('brian',receipt)
    assert household.ledger.snapshot('brian')['events']==events
    assert household.commands.command(BRIAN,stopped)==stop_result
    household.clock[0] = household.clock[0].replace(day=plan.pull_day)
    for actor in (BRIAN,HANNAH):
        assert one_bill(household,actor,name)['active']
        assert len([r for r in transaction_rows(actor,period) if r['title']==name])==1
    assert household.catalog.links(people(household.catalog)[0])==memberships
    assert november_history(household)==before
    assert {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}==original
