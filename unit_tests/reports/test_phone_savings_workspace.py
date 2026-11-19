from uuid import uuid4
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
