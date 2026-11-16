import asyncio
from types import SimpleNamespace
from uuid import uuid4

from aiohttp import CookieJar,web
from aiohttp.test_utils import TestClient,TestServer
import pytest
import pytest_asyncio

from unit_tests.reports.test_accounts import store
from unit_tests.reports.test_shared_bills import catalog,listing,BRIAN,HANNAH
from bookiebot.reports import phone_app,phone_shared_bills,shared_bills,bill_settings

HEADERS={'X-BookieBot-App':'1','Origin':'http://127.0.0.1'}


@pytest_asyncio.fixture
async def client(catalog,monkeypatch):
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL','http://127.0.0.1')
    monkeypatch.setattr(phone_app,'build_app_access_store',lambda:catalog.access)
    monkeypatch.setattr(shared_bills,'build_store',lambda:catalog)
    monkeypatch.setattr(bill_settings,'listing',listing)
    from bookiebot.reimbursements import service
    monkeypatch.setattr(service,'enabled',lambda:False)
    app=web.Application();phone_shared_bills.register_shared_bill_routes(app)
    app.router.add_post('/app/connect',phone_app._connect_phone)
    async with TestClient(TestServer(app),cookie_jar=CookieJar(unsafe=True)) as http:
        yield SimpleNamespace(http=http,catalog=catalog)


async def connect(client,actor=BRIAN,owner='brian'):
    access=client.catalog.access
    response=await client.http.post('/app/connect',json={'token':access.issue_pairing(actor,owner)},headers=HEADERS)
    assert response.status==200
    return response.cookies['bb_phone_local'].value


@pytest.mark.asyncio
async def test_shared_routes_require_private_session_and_same_origin_before_source_reads(client,monkeypatch):
    read=[];monkeypatch.setattr(shared_bills,'review',lambda *_:read.append(True))
    assert (await client.http.get('/app/account/changes')).status==401
    assert (await client.http.post('/app/bills/sharing/review',json={},headers=HEADERS)).status==401
    assert (await client.http.get('/app/bills/sharing/commands/'+uuid4().hex)).status==401
    await connect(client)
    for headers in ({},{**HEADERS,'Origin':'null'},{**HEADERS,'Origin':'https://other.example'},
                    {**HEADERS,'Sec-Fetch-Site':'cross-site'}):
        assert (await client.http.post('/app/bills/sharing',json={},headers=headers)).status==403
    assert read==[]


@pytest.mark.asyncio
async def test_membership_one_review_confirmation_recovery_and_owner_cursors(client):
    await connect(client)
    body={'action':'invite','billId':'rent-plan'}
    response=await client.http.post('/app/bills/sharing/review',json=body,headers=HEADERS)
    review=(await response.json())['review']
    assert response.status==200 and review['memberName']=='Hannah' and 'Private account' not in str(review)
    assert not any(k.startswith('_') for k in review)
    assert (await (await client.http.get('/app/account/changes')).json())=={'revision':0,'ledgerVersion':''}
    stale=await client.http.post('/app/bills/sharing',json={**body,'reviewVersion':'old','requestId':uuid4().hex},headers=HEADERS)
    assert stale.status==409 and (await stale.json())['notApplied']
    command={**body,'reviewVersion':review['reviewVersion'],'requestId':uuid4().hex}
    confirmed=await client.http.post('/app/bills/sharing',json=command,headers=HEADERS)
    value=await confirmed.json();assert value['status']=='pending'
    assert await (await client.http.post('/app/bills/sharing',json=command,headers=HEADERS)).json()==value
    assert await (await client.http.get('/app/bills/sharing/commands/'+command['requestId'])).json()==value
    assert await (await client.http.get('/app/account/changes?owner=hannah')).json()=={'revision':1,'ledgerVersion':''}
    await connect(client,HANNAH,'hannah')
    assert (await client.http.get('/app/bills/sharing/commands/'+command['requestId'])).status==404
    assert await (await client.http.get('/app/account/changes')).json()=={'revision':1,'ledgerVersion':''}
    refused=await client.http.post('/app/bills/sharing/review',json={'action':'invite','billId':'rent-plan','owner':'brian'},headers=HEADERS)
    assert refused.status==409


@pytest.mark.asyncio
async def test_revoked_session_during_slow_share_preparation_cannot_grant_access(client,monkeypatch):
    token=await connect(client)
    body={'action':'invite','billId':'rent-plan'}
    review=(await (await client.http.post('/app/bills/sharing/review',json=body,headers=HEADERS)).json())['review']
    original=shared_bills.review
    def revoke(actor,body,**kwargs):
        checked=original(actor,body,**kwargs);client.catalog.access.revoke_session(token);return checked
    monkeypatch.setattr(shared_bills,'review',revoke)
    response=await client.http.post('/app/bills/sharing',json={**body,'reviewVersion':review['reviewVersion'],'requestId':uuid4().hex},headers=HEADERS)
    assert response.status==409
    with client.catalog.access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS n FROM app_bill_shares').fetchone()['n']==0
        assert db.execute('SELECT COUNT(*) AS n FROM app_bill_share_events').fetchone()['n']==0


@pytest.mark.asyncio
async def test_cursor_detects_pending_payment_events_without_projection_or_amount_exposure(client,monkeypatch):
    from bookiebot.reimbursements import service
    monkeypatch.setattr(service,'enabled',lambda:True)
    state={'allocations':[{'id':'private-allocation','version':1,'projectedVersion':1}], 'events':[], 'resets':[]}
    reads=[]
    monkeypatch.setattr(service,'build_reimbursement_store',lambda:SimpleNamespace(snapshot=lambda owner:reads.append(owner) or state))
    await connect(client)
    first=await (await client.http.get('/app/account/changes')).json()
    state['events'].append({'id':'private-payment','status':'pending'})
    second=await (await client.http.get('/app/account/changes')).json()
    assert first['ledgerVersion']!=second['ledgerVersion']
    assert first['revision']==second['revision']==0
    assert 'private-' not in str(second) and reads==['brian','brian']
