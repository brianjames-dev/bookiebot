from types import SimpleNamespace
from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_transfers, bill_settings, savings_transfers
from unit_tests.reports.test_savings_transfers import setup as setup, draft, B
from unit_tests.reports.test_goals_store import access as access

HEADERS={'X-BookieBot-App':'1','Origin':'http://127.0.0.1'}


@pytest_asyncio.fixture
async def client(setup, monkeypatch):
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL','http://127.0.0.1')
    monkeypatch.setattr(phone_app,'build_app_access_store',lambda:setup.commands.access)
    monkeypatch.setattr(bill_settings,'build_commands',lambda:setup.commands)
    app=web.Application();phone_transfers.register_phone_transfer_routes(app)
    async with TestClient(TestServer(app),cookie_jar=CookieJar(unsafe=True)) as http:
        def connect(actor=B,owner='brian'):
            paired=setup.commands.access.consume_pairing(setup.commands.access.issue_pairing(actor,owner))
            http.session.cookie_jar.update_cookies({phone_app._cookie_name():paired[0]})
        yield SimpleNamespace(http=http,connect=connect,state=setup)


@pytest.mark.asyncio
async def test_transfer_session_same_origin_size_and_personal_scope(client):
    for path in ['/app/transfers','/app/transfers/commands/request']:
        assert (await client.http.get(path)).status==401
    assert (await client.http.post('/app/transfers/review',json={},headers=HEADERS)).status==401
    client.connect()
    for headers in ({},{**HEADERS,'Origin':'https://foreign.invalid'},{**HEADERS,'Sec-Fetch-Site':'cross-site'}):
        assert (await client.http.post('/app/transfers',json={},headers=headers)).status==403
    assert (await client.http.post('/app/transfers',data='x'*4097,headers=HEADERS)).status==400
    response=await client.http.get('/app/transfers?owner=hannah')
    assert response.status==200 and (await response.json())['ownerName']=='Brian'
    assert response.headers['Cache-Control']=='private, no-store'
    assert not client.state.t.sent


@pytest.mark.asyncio
async def test_api_one_review_no_writer_until_confirm_and_private_receipt_recovery(client):
    client.connect();body=draft()
    response=await client.http.post('/app/transfers/review',json=body,headers=HEADERS)
    assert response.status==200 and not client.state.t.sent
    review=(await response.json())['review']
    command={**body,'reviewVersion':review['reviewVersion'],'requestId':'phone-transfer-123456'}
    assert (await (await client.http.post('/app/transfers',json=command,headers=HEADERS)).json())['success']
    assert (await (await client.http.get('/app/transfers/commands/'+command['requestId'])).json())['success']
    assert len(client.state.t.sent)==1
    client.connect('830984827904851969','hannah')
    assert (await client.http.get('/app/transfers/commands/'+command['requestId'])).status==404


@pytest.mark.asyncio
async def test_revoked_session_after_transfer_read_discards_snapshot(client,monkeypatch):
    client.connect();original=savings_transfers.listing
    def revoke(actor):
        value=original(actor);client.state.commands.access.revoke_owner('brian');return value
    monkeypatch.setattr(savings_transfers,'listing',revoke)
    response=await client.http.get('/app/transfers')
    assert response.status==401 and 'Emergency fund' not in await response.text()


@pytest.mark.asyncio
async def test_prior_transactions_claim_rejects_confirmation_without_claiming_transfer(client):
    client.connect()
    body=draft()
    response=await client.http.post('/app/transfers/review',json=body,headers=HEADERS)
    command={**body,'reviewVersion':(await response.json())['review']['reviewVersion'],'requestId':'rejected-transfer-123456'}
    with client.state.commands.access.connect(write=True) as db:
        db.execute("INSERT INTO app_transaction_commands VALUES (?,?,?,'uncertain','{}','{}',?)",
                   ('brian','other-device-transaction','fingerprint','2026-11-15T12:00:00+00:00'))
    response=await client.http.post('/app/transfers',json=command,headers=HEADERS)
    assert response.status==409 and 'Transactions' in (await response.json())['error']
    assert (await client.http.get('/app/transfers/commands/'+command['requestId'])).status==404
    assert not client.state.t.sent
