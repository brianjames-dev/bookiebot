from uuid import uuid4
from datetime import datetime
import pytest
from unit_tests.reports.test_phone_goals import client, connect, create_body, HEADERS, HANNAH


@pytest.mark.asyncio
async def test_workspace_auth_same_origin_and_read_only_initial_load(client):
    assert (await client.http.get('/app/savings')).status == 401
    connect(client)
    legacy = (await (await client.http.post('/app/goals',json=create_body(),headers=HEADERS)).json())['goal']
    before = client.goals.list_goals('brian')
    result = await client.http.get('/app/savings?owner=hannah')
    data = await result.json()
    assert result.status == 200 and 'no-store' in result.headers['Cache-Control']
    assert data['goals'][0]['id'] == legacy['id']
    assert client.goals.list_goals('brian') == before
    body = dict(operation='account',requestId=uuid4().hex,workspaceVersion=data['version'],accountId='cash',name='Savings',institutionId='ally',balanceCents=5000)
    assert (await client.http.post('/app/savings',json=body)).status == 403
    response = await client.http.post('/app/savings',json=body,headers=HEADERS)
    assert response.status == 200, await response.text()
    recorded = await response.json()
    assert recorded['totals']['cash'] == 5000
    assert (await client.http.post('/app/savings',json=body,headers=HEADERS)).status == 200
    connect(client,HANNAH,'hannah')
    assert (await (await client.http.get('/app/savings')).json())['totals']['cash'] == 0
    assert (await client.http.post('/app/savings',json=body,headers=HEADERS)).status == 409


@pytest.mark.asyncio
async def test_cached_legacy_goal_clients_cannot_oversubscribe_adopted_cash(client):
    connect(client)
    async def post(operation,**fields):
        snapshot=await (await client.http.get('/app/savings')).json()
        response=await client.http.post('/app/savings',json=dict(operation=operation,requestId=uuid4().hex,workspaceVersion=snapshot['version'],**fields),headers=HEADERS)
        assert response.status==200,await response.text()
        return await response.json()
    await post('account',accountId='cash',name='Savings',institutionId='other',balanceCents=1000)
    a=(await post('create',name='A',targetCents=1000,startingCents=1000))['goals'][0]
    ended=await post('archive',goalId=a['id'],version=a['version'])
    await post('create',name='B',targetCents=1000,startingCents=1000)
    archived=next(g for g in ended['goals'] if g['id']==a['id'])
    response=await client.http.post('/app/goals',json=dict(operation='restore',requestId=uuid4().hex,goalId=a['id'],version=archived['version']),headers=HEADERS)
    assert response.status==400
    response=await client.http.post('/app/goals',json=dict(operation='create',requestId=uuid4().hex,name='C',targetCents=1000,startingCents=1),headers=HEADERS)
    assert response.status==400
    final=await (await client.http.get('/app/savings')).json()
    assert final['totals']==dict(cash=1000,goals=1000,available=0)


@pytest.mark.asyncio
async def test_due_transfer_end_goal_and_withdrawal_flow(client, monkeypatch):
    from bookiebot.sheets import routing, savings_transfers

    connect(client)
    today = datetime(2026, 11, 19, tzinfo=routing.PACIFIC_TZ)
    rules = []
    monkeypatch.setattr(routing, 'now_pacific', lambda: today)
    monkeypatch.setattr(savings_transfers, 'read_all', lambda actor, **kwargs: rules)

    async def read():
        response = await client.http.get('/app/savings')
        assert response.status == 200, await response.text()
        return await response.json()

    async def write(body, status=200):
        response = await client.http.post('/app/savings', json=body, headers=HEADERS)
        assert response.status == status, await response.text()
        return await response.json()

    async def command(operation, **fields):
        return await write(dict(operation=operation, requestId=uuid4().hex,
                                workspaceVersion=(await read())['version'], **fields))

    await command('account', accountId='cash', name='Savings', institutionId='other', balanceCents=10000)
    goal = (await command('create', name='Trip', targetCents=6000, startingCents=4000))['goals'][0]
    rules.append(savings_transfers.Transfer('trip', 1, 'Trip deposit', 3000, 'biweekly',
                                           '2026-11-20', '2026-11-20', goal['id'], 'Checking', 'Savings'))
    before = await read()
    assert before['totals'] == dict(cash=10000, goals=4000, available=6000)
    assert before['transfers'][0]['date'] == '2026-11-20'
    today = datetime(2026, 11, 20, tzinfo=routing.PACIFIC_TZ)
    due = await read()
    assert due['totals'] == dict(cash=13000, goals=6000, available=7000)
    assert await read() == due

    today = datetime(2026, 12, 4, tzinfo=routing.PACIFIC_TZ)
    completed = await read()
    assert completed['totals'] == dict(cash=16000, goals=6000, available=10000)

    # A confirmed withdrawal can exceed the goal using this account's free cash.
    body = dict(operation='archive', goalId=goal['id'], version=goal['version'],
                withdrawalAccountId='cash', withdrawalCents=7000,
                workspaceVersion=completed['version'], requestId=uuid4().hex)
    await write({**body, 'withdrawalCents': 16001}, status=400)
    assert await read() == completed
    ended = await write(body)
    assert ended['totals'] == dict(cash=9000, goals=0, available=9000)
    assert ended['goals'][0]['archived']
    assert ended['goals'][0]['balanceCents'] == 6000
    assert await write(body) == ended
    await write({**body, 'requestId': uuid4().hex, 'workspaceVersion': ended['version'],
                 'version': ended['goals'][0]['version']}, status=409)
    assert await read() == {k: v for k, v in ended.items() if k != 'undoId'}
    undone = await command('undo', undoId=ended['undoId'])
    assert undone['totals'] == completed['totals']
    assert not undone['goals'][0]['archived']
    ended = await command('archive', goalId=goal['id'], version=undone['goals'][0]['version'],
                          withdrawalAccountId='cash', withdrawalCents=6000)
    today = datetime(2026, 12, 18, tzinfo=routing.PACIFIC_TZ)
    after = await read()
    assert after['totals'] == dict(cash=13000, goals=0, available=13000)
    assert after['goals'][0]['balanceCents'] == 6000
    assert await read() == after
    assert rules[0].adjustments == ()
