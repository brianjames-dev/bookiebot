"""Real HTTP bootstrap/provider and confirmation boundaries; no Sheets writes."""
import json
from types import SimpleNamespace
from uuid import uuid4

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_accounts, phone_onboarding, phone_questions
from unit_tests.reports.test_managed_budget import store, user, setup, state, entry

HEADERS = {'X-BookieBot-App': '1', 'Origin': 'http://127.0.0.1'}


@pytest_asyncio.fixture
async def phone(store, monkeypatch):
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL', 'http://127.0.0.1')
    monkeypatch.setattr(phone_app, 'build_app_access_store', lambda: store.access)
    monkeypatch.setattr(phone_onboarding, 'managed_store', lambda _: store)
    app = web.Application()
    phone_onboarding.register_onboarding_routes(app)
    phone_accounts.register_phone_account_routes(app)
    phone_questions.register_phone_question_routes(app)
    app.router.add_get('/app/expenses/data', phone_app._report_data)
    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(client=client, store=store)


def headers(token):
    return {**HEADERS, 'Cookie': 'bb_phone_local=' + token}


@pytest.mark.asyncio
async def test_bootstrap_is_private_and_never_routes_new_identity_to_sheets(phone):
    client, store = phone.client, phone.store
    assert (await client.get('/app/bootstrap')).status == 401
    token, alex = user(store)
    response = await client.get('/app/bootstrap', headers=headers(token))
    assert response.headers['Cache-Control'] == 'private, no-store'
    assert (await response.json())['phase'] == 'onboarding'
    assert (await client.get('/app/expenses/data', headers=headers(token))).status == 401
    assert (await client.get('/app/budget', headers=headers(token))).status == 409
    setup(store, alex)
    assert (await (await client.get('/app/bootstrap', headers=headers(token))).json())['phase'] == 'ready'
    assert (await client.get('/app/budget?month=2026-11&owner=brian', headers=headers(token))).status == 200
    profile = await (await client.get('/app/account', headers=headers(token))).json()
    assert profile['id'] == alex.id and profile['google']['connected']


@pytest.mark.asyncio
async def test_legacy_sources_sessions_and_google_claims_stay_unchanged(phone):
    client, store = phone.client, phone.store
    token, _ = store.access.consume_pairing(store.access.issue_pairing('676638528590970917', 'brian'))
    response = await client.get('/app/bootstrap', headers=headers(token))
    assert (await response.json())['provider'] == 'sheets'
    assert (await client.get('/app/budget', headers=headers(token))).status == 409
    assert (await client.post('/app/budget/invite', headers=headers(token), json={})).status == 409
    assert store.access.get_session(token).owner_key == 'brian'
    with store.access.connect() as db:
        assert not db.execute('SELECT * FROM app_household_members').fetchall()
        assert not db.execute('SELECT * FROM app_user_identities').fetchall()


@pytest.mark.asyncio
async def test_setup_confirm_recovery_and_name_change_remain_authenticated(phone):
    client, store = phone.client, phone.store
    token, alex = user(store)
    body = {'requestId': uuid4().hex, 'operation': 'setup', 'name': 'Changed name',
            'incomeCents': 450000, 'allocation': [5000,3000,2000], 'startMonth': '2026-11', 'householdName': 'Our home'}
    review = await (await client.post('/app/budget/review', headers=headers(token), json=body)).json()
    assert not store.bootstrap(alex)['phase'] == 'ready'
    response = await client.post('/app/budget/confirm', headers=headers(token), json={'reviewId': review['reviewId']})
    assert response.status == 200
    assert (await response.json())['completed']
    recovery = await client.get('/app/budget/reviews/' + review['reviewId'], headers=headers(token))
    assert (await recovery.json())['completed']
    assert (await (await client.get('/app/bootstrap', headers=headers(token))).json())['account']['name'] == 'Changed name'
    assert (await client.post('/app/budget/confirm', headers=headers(token), json={'reviewId': review['reviewId']})).status == 200


@pytest.mark.asyncio
@pytest.mark.parametrize('bad', [{}, {'Origin':'null','X-BookieBot-App':'1'}, {'Origin':'https://evil.test','X-BookieBot-App':'1'}, {**HEADERS,'Sec-Fetch-Site':'cross-site'}])
async def test_csrf_and_oversized_commands_cannot_change_budget(phone, bad):
    token, alex = user(phone.store)
    response = await phone.client.post('/app/budget/review', headers={**bad, 'Cookie':'bb_phone_local=' + token}, json={})
    assert response.status == 403
    response = await phone.client.post('/app/budget/review', headers=headers(token), data='x' * 9000)
    assert response.status == 400
    assert phone.store.bootstrap(alex)['phase'] == 'onboarding'


@pytest.mark.asyncio
async def test_managed_chat_reuses_read_only_ai_and_only_its_own_database_report(phone, monkeypatch):
    token, alex = user(phone.store)
    setup(phone.store, alex)
    entry(phone.store, alex)
    calls = []
    async def answer(question, payload, mode):
        calls.append((question, payload, mode))
        return {'answer':'Fixture answer', 'sources':['overview']}
    monkeypatch.setattr(phone_questions, 'answer_report_question', answer)
    response = await phone.client.post('/app/expenses/ask', headers=headers(token),
        json={'question':'How much did I spend?', 'month':'2026-11', 'mode':'current'})
    assert response.status == 200 and (await response.json())['answer'] == 'Fixture answer'
    assert calls[0][1]['ownerName'] == 'Alex'
    assert calls[0][1]['metrics']['totalExpenses'] == 80
    assert calls[0][2] == 'current'
    assert 'brian' not in json.dumps(calls).lower()


@pytest.mark.asyncio
async def test_connected_workbook_household_api_preserves_both_original_adapters(phone):
    client, store = phone.client, phone.store
    brian_token, _ = store.access.consume_pairing(store.access.issue_pairing('676638528590970917', 'brian'))
    hannah_token, _ = store.access.consume_pairing(store.access.issue_pairing('830984827904851969', 'hannah'))
    first = await client.post('/app/household/review', headers=headers(brian_token), json={'requestId':uuid4().hex,'operation':'create','name':'Home'})
    review = await first.json()
    assert first.status == 200
    assert (await client.post('/app/household/confirm', headers=headers(brian_token),json={'reviewId':review['reviewId']})).status == 200
    invitation = await (await client.post('/app/household/invite', headers=headers(brian_token),json={})).json()
    join = await (await client.post('/app/household/review', headers=headers(hannah_token),json={'requestId':uuid4().hex,'operation':'join','invite':invitation['token']})).json()
    assert (await client.post('/app/household/confirm', headers=headers(hannah_token),json={'reviewId':join['reviewId']})).status == 200
    result = await (await client.get('/app/household', headers=headers(hannah_token))).json()
    assert {m['name'] for m in result['household']['members']} == {'Brian','Hannah'}
    assert (await (await client.get('/app/bootstrap', headers=headers(brian_token))).json())['provider'] == 'sheets'
    assert (await (await client.get('/app/bootstrap', headers=headers(hannah_token))).json())['provider'] == 'sheets'


@pytest.mark.asyncio
async def test_mutations_reject_a_draft_from_another_signed_in_account(phone):
    token, alex = user(phone.store)
    setup(phone.store, alex)
    for path, body in [('/app/budget/review', {'requestId':uuid4().hex,'operation':'goal','name':'Old draft','targetCents':10000}),
                       ('/app/budget/confirm', {'reviewId':'a'*32}),('/app/budget/invite', {})]:
        response = await phone.client.post(path, headers=headers(token), json={**body, 'accountId':'another-account'})
        assert response.status == 409
        assert 'account changed' in (await response.json())['error']
    assert not state(phone.store, alex)['goals']
