from uuid import uuid4
import pytest
from bookiebot.reports import savings_workspace as workspace
from bookiebot.reports.goals_store import GoalsStore, GoalConflictError, GoalValidationError
from unit_tests.reports.test_goals_store import access, store, create, contribute


def row(identity='one', amount=1000, goal='', destination='Ally', day='2026-11-18'):
    return dict(id=identity, amountCents=amount, goalId=goal, toAccount=destination, date=day)


def view(store, rows=None, owner='brian'):
    return workspace.listing(store, owner, rows or [])


def change(store, operation, rows=None, **values):
    body = dict(operation=operation, requestId=uuid4().hex, workspaceVersion=view(store, rows)['version'], **values)
    return workspace.command(store, 'brian', body, lambda: rows or [])


def test_read_does_not_adopt_or_mutate_existing_balances(store):
    g = contribute(store, create(store))
    rows = [row(goal=g['id']), row('unlinked', 400)]
    result = view(store, rows)
    assert result['totals'] == dict(cash=126400, goals=126000, available=400)
    assert store.list_goals('brian')['goals'] == [g]
    with store.access.connect() as db:
        assert not db.execute('SELECT * FROM app_savings_profiles').fetchall()
        assert not db.execute('SELECT * FROM app_savings_accounts').fetchall()
    assert view(store, owner='hannah')['totals']['cash'] == 0


def test_icons_bank_metadata_and_replay_preserve_all_money(store):
    g = create(store)
    result = change(store, 'edit', goalId=g['id'], version=g['version'], name='Reserve', targetCents=g['targetCents'],
        startingCents=g['startingCents'], iconKey='plane', accountId='cash')
    assert result['goals'][0]['iconKey'] == 'plane'
    assert result['totals']['cash'] == result['totals']['goals'] == 100000
    body = dict(operation='account', requestId=uuid4().hex, workspaceVersion=result['version'], accountId='cash', name='My reserve', institutionId='chase')
    result = workspace.command(store, 'brian', body, lambda: [])
    assert workspace.command(store, 'brian', body, lambda: []) == result
    assert result['accounts'][0]['institutionId'] == 'chase'
    assert result['totals']['cash'] == 100000
    undo = change(store, 'undo', undoId=result['undoId'])
    assert undo['accounts'][0]['name'] == 'Savings'
    assert undo['totals'] == result['totals']
    with pytest.raises(GoalConflictError):
        change(store, 'undo', undoId=result['undoId'])


def test_allocations_do_not_mint_cash_and_undo_keeps_history(store):
    base = change(store, 'account', accountId='cash', name='Savings', institutionId='other', balanceCents=10000)
    made = change(store, 'create', name='Trip', iconKey='plane', accountId='cash', targetCents=9000, startingCents=4000)
    g = made['goals'][0]
    result = change(store, 'contribute', goalId=g['id'], version=g['version'], amountCents=1000, date='2020-01-01', note='Allocation')
    assert result['totals'] == dict(cash=10000, goals=5000, available=5000)
    undone = change(store, 'undo', undoId=result['undoId'])
    assert undone['totals'] == dict(cash=10000, goals=4000, available=6000)
    history = store.history('brian', g['id'])['contributions']
    assert len(history) == 1 and history[0]['reversedAt']
    with pytest.raises(GoalValidationError):
        change(store, 'contribute', goalId=g['id'], version=undone['goals'][0]['version'], amountCents=6000, date='2020-01-01')
    with pytest.raises(GoalValidationError):
        change(store, 'account', accountId='cash', name='Savings', institutionId='other', balanceCents=1)
    assert base['totals']['cash'] == 10000


@pytest.mark.parametrize('target,expected', [(100500,500), (100000,0), (90000,0)])
def test_new_deposits_cap_at_target_and_excess_stays_cash(store, target, expected):
    g = create(store)
    change(store, 'edit', goalId=g['id'], version=g['version'], name=g['name'], targetCents=target, startingCents=g['startingCents'])
    rows = [row(goal=g['id'])]
    result = view(store, rows)
    assert result['totals'] == dict(cash=101000, goals=100000+expected, available=1000-expected)
    assert result['goals'][0]['transferCents'] == expected
    assert result['accounts'][1]['balanceCents'] == 1000


def test_archive_releases_allocations_and_reroutes_future_transfers(store):
    g = create(store)
    rows = [row(goal=g['id'])]
    ended = change(store, 'archive', rows, goalId=g['id'], version=g['version'])
    later = view(store, [*rows, row('later', 2000, g['id'], day='2026-11-19')])
    assert later['totals'] == dict(cash=103000, goals=0, available=103000)
    assert later['goals'][0]['balanceCents'] == 101000  # Earlier allocation/history retained.
    restored = change(store, 'undo', rows, undoId=ended['undoId'])
    assert not restored['goals'][0]['archived']
    assert restored['goals'][0]['balanceCents'] == 101000


def test_past_allocations_stay_when_target_changes_and_corrections_never_duplicate_cash(store):
    g = create(store)
    rows = [row(goal=g['id'])]
    changed = change(store, 'edit', rows, goalId=g['id'], version=g['version'], name=g['name'], targetCents=100100, startingCents=g['startingCents'])
    assert changed['goals'][0]['balanceCents'] == 101000
    updated = view(store, [row(goal=g['id'], amount=50)])
    assert updated['totals']['cash'] == 100050
    assert updated['goals'][0]['transferCents'] == 50
    assert view(store)['totals']['cash'] == 100000


def test_source_changes_stale_requests_and_foreign_undo_are_rejected(store):
    g = create(store)
    before = view(store)
    with pytest.raises(GoalConflictError):
        workspace.command(store, 'brian', dict(operation='archive', requestId=uuid4().hex, workspaceVersion=before['version'], goalId=g['id'], version=g['version']), lambda: [row()])
    result = change(store, 'edit', goalId=g['id'], version=g['version'], name=g['name'], targetCents=g['targetCents'], startingCents=g['startingCents'])
    with pytest.raises(GoalValidationError):
        workspace.command(store, 'hannah', dict(operation='undo', requestId=uuid4().hex, workspaceVersion=view(store, owner='hannah')['version'], undoId=result['undoId']), lambda: [])


def test_rollout_boundary_caps_new_deposits_before_first_configuration_write(store):
    g = create(store)
    # The existing amount remains untouched, even if it already exceeds a new target.
    g = store.command('brian',dict(operation='edit',requestId=uuid4().hex,goalId=g['id'],version=g['version'],name=g['name'],targetCents=100500,startingCents=g['startingCents']))['goal']
    rows=[row('recorded',1000,g['id'],day='2026-11-18'),row('future',2500,g['id'],day='2026-11-19')]
    result=view(store,rows)
    assert result['goals'][0]['balanceCents']==101000
    assert result['totals']==dict(cash=103500,goals=101000,available=2500)
    assert store.list_goals('brian')['goals'][0]['balanceCents']==100000


def test_generic_savings_destination_uses_original_cash_bucket(store):
    g=create(store)
    result=view(store,[row(goal=g['id'],destination='Savings')])
    assert len(result['accounts'])==1
    assert result['accounts'][0]['balanceCents']==101000


def test_concurrent_commands_cannot_allocate_the_same_available_cash_twice(store):
    from concurrent.futures import ThreadPoolExecutor
    change(store,'account',accountId='cash',name='Savings',institutionId='other',balanceCents=1000)
    before=view(store)
    bodies=[dict(operation='create',requestId=uuid4().hex,workspaceVersion=before['version'],name='Goal '+str(i),targetCents=1000,startingCents=700) for i in range(2)]
    def run(body):
        try:return workspace.command(store,'brian',body,lambda:[])
        except GoalConflictError:return None
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,bodies))
    assert sum(r is not None for r in results)==1
    assert view(store)['totals']==dict(cash=1000,goals=700,available=300)


def test_upcoming_account_metadata_can_be_configured_without_counting_future_money(store):
    source={'rows':[],'destinations':['Ally Savings'],'sourceVersion':'rule-one'}
    initial=workspace.listing(store,'brian',source)
    a=initial['accounts'][1]
    assert a['balanceCents']==0 and initial['totals']['cash']==0
    body=dict(operation='account',requestId=uuid4().hex,workspaceVersion=initial['version'],accountId=a['id'],name='Reserve',institutionId='ally',balanceCents=0)
    saved=workspace.command(store,'brian',body,lambda:source)
    assert saved['accounts'][1]['name']=='Reserve'
    assert saved['totals']['cash']==0
    source['rows']=[row(destination='Ally Savings',amount=500)]
    latest=workspace.listing(store,'brian',source)
    assert latest['accounts'][1]['id']==a['id'] and latest['accounts'][1]['balanceCents']==500


def test_retry_of_saved_receipt_returns_current_state_after_other_device_changes(store):
    first=view(store)
    body=dict(operation='account',requestId=uuid4().hex,workspaceVersion=first['version'],accountId='cash',name='Savings',institutionId='other',balanceCents=1000)
    receipt=workspace.command(store,'brian',body,lambda:[])
    changed=change(store,'account',accountId='cash',name='New name',institutionId='ally',balanceCents=2000)
    replay=workspace.command(store,'brian',body,lambda:[])
    assert replay['totals']['cash']==2000 and replay['accounts'][0]['name']=='New name'
    assert replay['version']==changed['version']
    assert replay['undoId'] is None  # Never offer to undo over the intervening change.
    assert receipt['totals']['cash']==1000


def test_restore_cannot_reclaim_cash_reallocated_to_another_goal(store):
    change(store,'account',accountId='cash',name='Savings',institutionId='other',balanceCents=10000)
    made=change(store,'create',name='Original',targetCents=10000,startingCents=10000)
    g=made['goals'][0]
    change(store,'archive',goalId=g['id'],version=g['version'])
    change(store,'create',name='Other goal',targetCents=10000,startingCents=10000)
    archived=next(g for g in view(store)['goals'] if g['archived'])
    with pytest.raises(GoalValidationError,match='available cash'):
        change(store,'restore',goalId=archived['id'],version=archived['version'])
    assert view(store)['totals']==dict(cash=10000,goals=10000,available=0)


def test_restore_checks_each_account_not_only_combined_available(store):
    g=create(store)
    rows=[row(goal=g['id'],amount=1000,destination='Ally')]
    change(store,'archive',rows,goalId=g['id'],version=g['version'])
    account=next(a for a in view(store,rows)['accounts'] if a['id']!='cash')
    change(store,'account',rows,accountId=account['id'],name='Ally',institutionId='ally',balanceCents=0)
    archived=view(store,rows)['goals'][0]
    assert view(store,rows)['totals']['available']==100000
    with pytest.raises(GoalValidationError,match='available cash'):
        change(store,'restore',rows,goalId=archived['id'],version=archived['version'])
