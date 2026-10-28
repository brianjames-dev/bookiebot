"""HTTP authorization and explicit confirmation contracts; no production activity."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app,phone_transactions,transactions as tx
from unit_tests.reports.test_transactions import saved as saved, access as access, body, B, H

HEADERS={"X-BookieBot-App":"1","Origin":"http://127.0.0.1"}


@pytest_asyncio.fixture
async def client(saved,monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL","http://127.0.0.1")
    monkeypatch.setattr(phone_app,"build_app_access_store",lambda:saved.access)
    monkeypatch.setattr(tx,"build_transaction_commands",lambda:saved.commands)
    app=web.Application();phone_transactions.register_phone_transaction_routes(app)
    http=TestClient(TestServer(app),cookie_jar=CookieJar(unsafe=True));await http.start_server()
    token=saved.access.issue_pairing(B,"brian");cookie,_=saved.access.consume_pairing(token)
    def connect(value=cookie): http.session.cookie_jar.update_cookies({phone_app._cookie_name():value})
    yield SimpleNamespace(http=http,saved=saved,connect=connect,cookie=cookie)
    await http.close()


@pytest.mark.asyncio
async def test_auth_and_same_origin_required_before_financial_service(client,monkeypatch):
    writer=Mock(side_effect=AssertionError("No financial service"));monkeypatch.setattr(tx.TransactionCommands,"command",writer)
    for path in ["/app/transactions", "/app/transactions/commands/request"]:
        assert (await client.http.get(path)).status==401
    for path in ["/app/transactions","/app/transactions/review"]:
        assert (await client.http.post(path,headers=HEADERS,json={})).status==401
    client.connect()
    for path in ['/app/transactions','/app/transactions/review']:
        for headers in [{}, {**HEADERS,"Origin":"https://foreign.invalid"},
                        {**HEADERS,"Origin":"null"}, {**HEADERS,"Sec-Fetch-Site":"cross-site"}]:
            assert (await client.http.post(path,headers=headers,json={})).status==403
    assert (await client.http.post('/app/transactions',headers=HEADERS,data='x'*8193)).status==400
    writer.assert_not_called()


@pytest.mark.asyncio
async def test_authenticated_list_preview_confirm_and_check_saved_result(client):
    client.connect();saved=client.saved
    response=await client.http.get('/app/transactions',params={"month":saved.month})
    assert response.status==200 and response.headers['Cache-Control']=='private, no-store'
    assert len((await response.json())["items"])==3
    value=body(saved)
    preview=await client.http.post('/app/transactions/review',headers=HEADERS,json={**value,"owner":"hannah"})
    assert preview.status==200
    review=(await preview.json())["review"]
    assert not any(key.startswith('_') for key in review)
    command={**value,"reviewVersion":review["reviewVersion"],"requestId":"isolated-request-0000001"}
    first=await client.http.post('/app/transactions',headers=HEADERS,json=command)
    result=await first.json();assert first.status==200 and result['success']
    again=await client.http.post('/app/transactions',headers=HEADERS,json=command)
    assert await again.json()==result
    status=await client.http.get('/app/transactions/commands/'+command['requestId'])
    assert await status.json()==result
    assert (await client.http.get('/app/transactions',params={'month':'2099-01'})).status==400


@pytest.mark.asyncio
async def test_revoked_session_cannot_read_transactions_or_saved_commands(client):
    client.connect();client.saved.access.revoke_session(client.cookie)
    assert (await client.http.get('/app/transactions')).status==401
    assert (await client.http.post('/app/transactions/review',headers=HEADERS,json=body(client.saved))).status==401


@pytest.mark.asyncio
async def test_read_failure_returns_error_not_empty_history(client,monkeypatch):
    client.connect();monkeypatch.setattr(tx,'listing',Mock(side_effect=TimeoutError('private upstream payload')))
    response=await client.http.get('/app/transactions')
    data=await response.json()
    assert response.status==503 and 'items' not in data and 'private upstream payload' not in str(data)
