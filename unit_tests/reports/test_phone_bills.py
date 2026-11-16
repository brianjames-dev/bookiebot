from types import SimpleNamespace
from unittest.mock import Mock
from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_bills, bill_settings as service
from unit_tests.reports.test_bill_settings import saved as saved, command, B
from unit_tests.reports.test_goals_store import access as access

HEADERS = {"Origin": "http://127.0.0.1", "X-BookieBot-App": "1", "Content-Type": "application/json"}


@pytest.mark.asyncio
async def test_listing_reuses_only_current_owner_cursor_but_recovery_and_reviews_stay_fresh(client, monkeypatch):
    from bookiebot.reports import phone_shared_bills
    cursor = {'revision':1,'ledgerVersion':'ledger-1'}
    monkeypatch.setattr(phone_shared_bills,'change_cursor',lambda _owner:dict(cursor))
    read = Mock(wraps=service.listing)
    monkeypatch.setattr(service,'listing',read)
    client.connect()
    first = await (await client.http.get('/app/bills')).json()
    assert read.call_count==1
    pending = {'operation':'update','requestId':'isolated-in-flight-command'}
    monkeypatch.setattr(client.saved.commands,'pending',lambda _owner:pending)
    again = await (await client.http.get('/app/bills')).json()
    assert again['pendingCommand']==pending and 'pendingCommand' not in first
    assert read.call_count==1, 'Repeat opening avoids workbook reads, not recovery checks'
    cursor['revision']=2
    await client.http.get('/app/bills')
    assert read.call_count==2
    cursor['ledgerVersion']='background-receipt'
    await client.http.get('/app/bills')
    assert read.call_count==3
    response = await client.http.get('/app/bills?fresh=1')
    assert response.headers['Cache-Control']=='private, no-store' and read.call_count==4
    source_reads = Mock(wraps=service.read_workbook)
    monkeypatch.setattr(service,'read_workbook',source_reads)
    checked = command(client.saved)
    before = source_reads.call_count
    assert (await client.http.post('/app/bills/review',headers=HEADERS,json=checked)).status==200
    assert source_reads.call_count>before, 'Money reviews never use a cached listing'
    assert not client.saved.client.http_client.sent


@pytest.mark.asyncio
@pytest.mark.parametrize('continuous', [False,True])
async def test_shared_change_during_read_retries_once_and_never_returns_a_revoked_snapshot(client,monkeypatch,continuous):
    from bookiebot.reports import phone_shared_bills
    cursor = {'revision':1,'ledgerVersion':'stable'}
    monkeypatch.setattr(phone_shared_bills,'change_cursor',lambda _owner:dict(cursor))
    read = service.listing
    calls = []
    def changed(actor):
        calls.append(1)
        value = read(actor)
        value['bills'][0]['name']='Fresh view '+str(len(calls))
        if continuous or len(calls)==1:
            cursor['revision']+=1
        return value
    monkeypatch.setattr(service,'listing',changed)
    client.connect()
    response = await client.http.get('/app/bills')
    value = await response.json()
    assert len(calls)==2, 'A racing shared change has only one retry'
    if continuous:
        assert response.status==409 and 'bills' not in value
    else:
        assert response.status==200 and value['bills'][0]['name']=='Fresh view 2'
        await client.http.get('/app/bills')
        assert len(calls)==2


@pytest_asyncio.fixture
async def client(monkeypatch, saved):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: saved.commands.access)
    monkeypatch.setattr(service, "build_commands", lambda: saved.commands)
    from bookiebot.reports import bill_checkin
    monkeypatch.setattr(bill_checkin, 'build_store', lambda: bill_checkin._store(saved.commands.access))
    monkeypatch.setattr(bill_checkin, 'read_workbook', service.read_workbook)
    app = web.Application()
    phone_bills.register_phone_bill_routes(app)
    http = TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True))
    await http.start_server()
    token = saved.commands.access.issue_pairing(B, "brian")
    cookie, _ = saved.commands.access.consume_pairing(token)
    def connect():
        http.session.cookie_jar.update_cookies({phone_app._cookie_name(): cookie})
    yield SimpleNamespace(http=http, saved=saved, connect=connect, access=saved.commands.access)
    await http.close()


@pytest.mark.asyncio
async def test_cookie_and_same_origin_before_any_bill_service(client, monkeypatch):
    read, write = Mock(side_effect=AssertionError("No read")), Mock(side_effect=AssertionError("No write"))
    monkeypatch.setattr(service, "listing", read)
    monkeypatch.setattr(service.BillCommands, "command", write)
    for path in ["/app/bills", "/app/bills/check-in", "/app/bills/commands/request", "/app/bills/plan/charge"]:
        assert (await client.http.get(path)).status == 401
    for path in ["/app/bills", "/app/bills/review", "/app/bills/check-in", "/app/bills/check-in/preferences"]:
        assert (await client.http.post(path, headers=HEADERS, json={})).status == 401
    client.connect()
    for headers in [{}, {**HEADERS, "Origin": "https://foreign.invalid"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}]:
        assert (await client.http.post("/app/bills", headers=headers, json={})).status == 403
    assert (await client.http.post("/app/bills", headers=HEADERS, data="x" * 8193)).status == 400
    assert (await client.http.post("/app/bills/review", headers=HEADERS, json=[])).status == 400
    read.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_checkin_claim_visible_ack_owner_scope_and_preference_validation(client, monkeypatch):
    from datetime import datetime
    from bookiebot.reports import bill_checkin
    from bookiebot.sheets.routing import PACIFIC_TZ
    client.connect()
    monkeypatch.setattr(bill_checkin, 'now_pacific', lambda: datetime(2026, 11, 15, 12, tzinfo=PACIFIC_TZ))
    eligible = Mock(return_value={'day':'2026-11-15', 'bills':[{'id':'pge','name':'PG&E','date':'2026-11-22','month':'2026-11','overdue':False}]})
    monkeypatch.setattr(bill_checkin, 'candidates', eligible)
    assert (await client.http.get('/app/bills/check-in')).status == 200
    body = {'action':'claim', 'token':'first-device-token'}
    for headers in ({}, {**HEADERS, 'Origin':'https://foreign.invalid'}):
        assert (await client.http.post('/app/bills/check-in', headers=headers, json=body)).status == 403
    assert (await client.http.post('/app/bills/check-in', headers=HEADERS, json={**body,'owner':'hannah'})).status == 400
    claimed = await (await client.http.post('/app/bills/check-in', headers=HEADERS, json=body)).json()
    assert claimed['claimed'] and claimed['bills'][0]['id'] == 'pge'
    other = await (await client.http.post('/app/bills/check-in', headers=HEADERS, json={**body,'token':'second-device-token'})).json()
    assert not other['claimed']
    shown = await (await client.http.post('/app/bills/check-in', headers=HEADERS, json={**body,'action':'shown'})).json()
    assert shown['shown']
    assert not (await (await client.http.post('/app/bills/check-in', headers=HEADERS, json=body)).json())['claimed']
    assert (await client.http.post('/app/bills/check-in/preferences', headers=HEADERS, json={'id':'not-your-bill','leadDays':7})).status == 400
    assert not client.saved.client.http_client.sent


@pytest.mark.asyncio
async def test_no_eligible_bills_does_not_consume_a_checkin_day(client, monkeypatch):
    from bookiebot.reports import bill_checkin
    client.connect()
    monkeypatch.setattr(bill_checkin, 'candidates', lambda *a, **kw: {'day':'2026-11-15','bills':[]})
    result = await (await client.http.post('/app/bills/check-in', headers=HEADERS, json={'action':'claim','token':'first-device-token'})).json()
    assert not result['claimed']
    with bill_checkin.build_store().access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS total FROM app_bill_checkin_days').fetchone()['total'] == 0


@pytest.mark.asyncio
async def test_private_bill_listing_review_confirm_and_idempotent_status(client):
    client.connect()
    response = await client.http.get("/app/bills")
    value = await response.json()
    assert response.status == 200 and response.headers["Cache-Control"] == "private, no-store"
    assert len(value["bills"]) == 1
    assert not {"spreadsheetId", "source_range", "source_row"} & value["bills"][0].keys()
    body = command(client.saved)
    assert (await client.http.post("/app/bills/review", headers=HEADERS, json={**body, "owner": "hannah"})).status == 400
    review = await client.http.post("/app/bills/review", headers=HEADERS, json=body)
    assert review.status == 200 and not client.saved.client.http_client.sent
    first = await client.http.post("/app/bills", headers=HEADERS, json=body)
    result = await first.json()
    assert first.status == 200 and result["success"]
    assert await (await client.http.post("/app/bills", headers=HEADERS, json=body)).json() == result
    assert await (await client.http.get("/app/bills/commands/" + body["requestId"])).json() == result
    assert len(client.saved.client.http_client.sent) == 1


@pytest.mark.asyncio
async def test_revoked_during_read_never_returns_bills(client, monkeypatch):
    client.connect()
    def revoked(actor):
        client.access.revoke_owner("brian")
        return {"private": "not returned"}
    monkeypatch.setattr(service, "listing", revoked)
    response = await client.http.get("/app/bills")
    assert response.status == 401 and "private" not in await response.json()


@pytest.mark.asyncio
async def test_upstream_failure_is_not_an_empty_list_or_a_private_payload(client, monkeypatch):
    client.connect()
    monkeypatch.setattr(service, "listing", Mock(side_effect=TimeoutError("private source data")))
    response = await client.http.get("/app/bills")
    data = await response.json()
    assert response.status == 503 and "bills" not in data and "private source data" not in str(data)


@pytest.mark.asyncio
async def test_confirmed_annual_flow_can_be_read_on_a_new_device_without_submitting_it(client,monkeypatch):
    client.connect()
    flow={'version':1,'stage':'history','configuration':{'operation':'end','id':'bill-fixture'},
          'historyIndex':0,'historyCommands':[{'operation':'end-year','year':2025,'requestId':'approved-history-id'}]}
    read=Mock(return_value=flow)
    monkeypatch.setattr(client.saved.commands,'recoverable_flow',read)
    before=len(client.saved.client.http_client.sent)
    response=await client.http.get('/app/bills')
    value=await response.json()
    assert response.status==200 and value['pendingFlow']==flow
    read.assert_called_once_with('brian')
    assert len(client.saved.client.http_client.sent)==before,'Reading a confirmed continuation cannot submit a writer'
