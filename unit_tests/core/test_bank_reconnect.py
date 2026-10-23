from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import pytest

from bookiebot.core import bank_link


@pytest.mark.asyncio
async def test_scoped_reconnect_routes_never_exchange_or_accept_item_override(monkeypatch):
    monkeypatch.setenv('BANK_LINK_SIGNING_SECRET', 'test-reconnect-secret')
    service = SimpleNamespace(config=SimpleNamespace(public_base_url='https://bookie.test'),
        create_reconnect_link=AsyncMock(return_value='https://secure.plaid.com/hl/test'),
        complete_reconnect=AsyncMock(return_value=SimpleNamespace(added=2, modified=1, removed=1)),
        link_public_token=AsyncMock(side_effect=AssertionError('Never create another Item')))
    monkeypatch.setattr(bank_link, 'build_banking_service', lambda: service)
    token = bank_link.create_bank_link_setup_token(actor_key='123', owner_key='brian', item_db_id=3)
    assert bank_link.verify_bank_link_setup_token(token)['item_db_id'] == '3'
    async with TestClient(TestServer(bank_link.create_bank_link_app())) as client:
        page = await client.get('/bank/link', params={'token': token})
        assert page.status == 200
        assert page.headers['Referrer-Policy'] == 'no-referrer'
        assert 'Reconnect bank' in await page.text()
        response = await client.post('/bank/link-token', json={'setup_token': token, 'item_db_id': 999, 'owner_key': 'hannah'})
        assert response.status == 200
        assert (await response.json())['hosted_link_url'].startswith('https://secure.plaid.com/')
        assert service.create_reconnect_link.call_args.args[:2] == ('brian', 3)
        response = await client.post('/bank/exchange-public-token', json={'setup_token': token, 'public_token': 'fake'})
        assert response.status == 400
        response = await client.post('/bank/reconnect-complete', json={'setup_token': token, 'item_db_id': 999})
        assert response.status == 200
        service.complete_reconnect.assert_awaited_once_with('brian', 3)
        new_token = bank_link.create_bank_link_setup_token(actor_key='123', owner_key='brian')
        response = await client.post('/bank/reconnect-complete', json={'setup_token': new_token})
        assert response.status == 400
        response = await client.post('/bank/reconnect-complete', json={'setup_token': token + 'tampered'})
        assert response.status == 401
    service.link_public_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconnect_completion_cannot_claim_success_before_real_sync(monkeypatch):
    monkeypatch.setenv('BANK_LINK_SIGNING_SECRET', 'test-reconnect-secret')
    service = SimpleNamespace(complete_reconnect=AsyncMock(side_effect=RuntimeError('provider unavailable')))
    monkeypatch.setattr(bank_link, 'build_banking_service', lambda: service)
    token = bank_link.create_bank_link_setup_token(actor_key='123', owner_key='brian', item_db_id=3)
    async with TestClient(TestServer(bank_link.create_bank_link_app())) as client:
        response = await client.post('/bank/reconnect-complete', json={'setup_token': token})
        assert response.status == 502
        assert 'ok' not in await response.json()

