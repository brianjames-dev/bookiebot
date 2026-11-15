from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace

import pytest

from bookiebot.reports import transactions as tx, transfer_occurrences as service, savings_transfers as schedules
from bookiebot.sheets import savings_transfers as ledger
from unit_tests.reports.test_savings_transfers import setup as setup, draft, confirm, TODAY, B
from unit_tests.reports.test_goals_store import access as access


@pytest.fixture
def state(setup,monkeypatch):
    s=setup
    monkeypatch.setattr(service,'now_pacific',lambda:datetime(2026,11,15,12))
    monkeypatch.setattr(tx,'now_pacific',lambda:datetime(2026,11,15,12))
    s.goals.append({'id':'goal-vacation','name':'Vacation','version':1,'archived':False})
    assert s.commands.command(B,confirm(draft()))['success']
    commands=tx.TransactionCommands(s.commands.access);commands.initialize()
    def rows():
        return tx._transfer_rows(B,'2026-11',ledger.read_all(B),as_of=TODAY,
            goals=s.goals,goal_names={g['id']:g['name'] for g in s.goals})
    return SimpleNamespace(source=s,commands=commands,rows=rows)


def edit(row,**updates):
    return {'id':row['id'],'month':row['month'],'version':row['version'],'operation':'update','updates':updates}


def prepared(body,request='occurrence-command-123456'):
    reviewed=tx.review(B,body)['review']
    return {**body,'version':reviewed['item']['version'],'reviewVersion':reviewed['reviewVersion'],'requestId':request}


def balances():
    raw={'goals':[{'id':key,'balanceCents':0,'contributionCents':0,'contributionCount':0} for key in ('goal-1234','goal-vacation')]}
    return {g['id']:g['balanceCents'] for g in schedules.goal_payload(B,raw,today=TODAY)['goals']}


def test_review_and_one_atomic_edit_adjust_saved_goal_and_history_without_editing_schedule(state):
    s=state.source;before=ledger.current(ledger.read_all(B))[0].public()
    body=prepared(edit(state.rows()[0],amount=17500,item='Corrected transfer',goalId='goal-vacation',fromAccount='',toAccount='Vacation account'))
    assert len(s.t.sent)==1,'Review has not written anything'
    result=state.commands.command(B,body)
    assert result['success'] and result['summary']['kind']=='transfer'
    assert state.commands.command(B,body)==result and len(s.t.sent)==2
    plans=ledger.read_all(B)
    assert ledger.current(plans)[0].public()==before
    assert s.t.rows['November']==[['','Do not change this actual','81.23']]
    assert [(i['date'],i['amountCents'],i['goalId']) for i in ledger.occurrences(plans,TODAY,date(2026,12,31))]==[
        ('2026-11-15',17500,'goal-vacation'),('2026-12-15',15000,'goal-1234')]
    assert balances()=={'goal-1234':0,'goal-vacation':17500}
    assert state.rows()[0]['title']=='Corrected transfer'
    assert not state.rows()[0]['capabilities']['split']
    with s.commands.access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS n FROM app_transaction_commands').fetchone()['n']==1


def test_delete_undo_and_repeated_undo_keep_other_occurrences_and_prevent_aba_reviews(state):
    row=state.rows()[0]
    stale=prepared(edit(row,amount=18000),'stale-before-delete-123456')
    body=prepared({'id':row['id'],'month':row['month'],'version':row['version'],'operation':'delete'})
    deleted=state.commands.command(B,body)
    assert deleted['success'] and state.rows()==[] and balances()['goal-1234']==0
    assert schedules.next_date(ledger.read_all(B),ledger.current(ledger.read_all(B))[0].id,TODAY)=='2026-12-15'
    undo=prepared({**deleted['undo'],'operation':'undo'},'undo-transfer-delete-123456')
    restored=state.commands.command(B,undo)
    assert restored['success'] and state.rows()[0]['amountCents']==15000 and balances()['goal-1234']==15000
    assert state.rows()[0]['version']!=row['version']
    assert state.commands.command(B,undo)==restored
    result=state.commands.command(B,stale)
    assert not result['success'] and state.rows()[0]['amountCents']==15000
    with pytest.raises(tx.TransactionConflict):tx.review(B,{**deleted['undo'],'operation':'undo'})


def test_recurring_changes_keep_dated_adjustments_and_do_not_block_dated_undo(state):
    result=state.commands.command(B,prepared(edit(state.rows()[0],amount=18000)))
    listing=schedules.listing(B);p=listing['transfers'][0]
    update={'operation':'transfer-update','year':listing['year'],'settingsVersion':listing['settingsVersion'],
            'id':p['id'],'revision':p['revision'],'transfer':{**draft()['transfer'],'amount':'250.00','startsOn':'2026-12-15'}}
    assert state.source.commands.command(B,confirm(update,'future-schedule-update-123456'))['success']
    assert state.rows()[0]['amountCents']==18000
    assert state.commands.command(B,prepared({**result['undo'],'operation':'undo'},'undo-after-schedule-123456'))['success']
    assert [(i['date'],i['amountCents']) for i in ledger.occurrences(ledger.read_all(B),TODAY,date(2026,12,31))]==[
        ('2026-11-15',15000),('2026-12-15',25000)]


def test_lost_acknowledgement_recovers_atomic_receipt_without_repeating_writer(state):
    body=prepared(edit(state.rows()[0],amount=19000))
    original=state.source.t.batch_update
    def lost(identity,batch):
        original(identity,batch)
        raise TimeoutError('Lost acknowledgement')
    state.source.t.batch_update=lost
    assert state.commands.command(B,body)['state']=='uncertain'
    assert len(state.source.t.sent)==2
    result=state.commands.saved('brian',body['requestId'])
    assert result['state']=='done' and result['success'] and '_transferUndo' not in result
    assert state.commands.command(B,body)==result and len(state.source.t.sent)==2
    assert state.commands.saved('hannah',body['requestId']) is None
    assert balances()['goal-1234']==19000


@pytest.mark.parametrize('updates',[{'amount':0},{'amount':-1},{'amount':'100'},{'item':''},{'frequency':'yearly'},
    {'goalId':'foreign-goal'},{'date':'2026-12-01'},{'item':'A'*81}])
def test_invalid_or_unowned_adjustments_never_write(state,updates):
    with pytest.raises((tx.TransactionConflict,tx.TransactionValidation)):
        tx.review(B,edit(state.rows()[0],**updates))
    assert len(state.source.t.sent)==1


def test_future_and_wrong_month_transfers_are_not_editable(state):
    row=state.rows()[0]
    for body in (edit({**row,'id':row['id'].replace('2026-11-15','2026-12-15').replace('2026-11:','2026-12:'),'month':'2026-12'},amount=100),
                 {**edit(row,amount=100),'month':'2026-10'}):
        with pytest.raises((tx.TransactionConflict,tx.TransactionValidation)):tx.review(B,body)
    assert len(state.source.t.sent)==1


def test_pending_transaction_claim_blocks_goal_archive_before_source_read(state):
    from bookiebot.reports.goals_store import GoalConflictError
    with state.commands.access.connect(write=True) as db:
        db.execute("INSERT INTO app_transaction_commands VALUES (?,?,?,'uncertain','{}','{}',?)",
                   ('brian','pending-transfer-claim','fingerprint','2026-11-15T12:00:00+00:00'))
    with pytest.raises(GoalConflictError,match='financial change'):
        schedules.can_archive_goal(B,'brian','goal-1234',commands=state.source.commands)


def test_clearing_accounts_and_goal_updates_history_revision_without_mutating_goal_version(state):
    raw={'goals':[{'id':'goal-1234','version':1,'balanceCents':0,'contributionCents':0,'contributionCount':0}]}
    before=schedules.goal_payload(B,raw,today=TODAY)['goals'][0]
    result=state.commands.command(B,prepared(edit(state.rows()[0],goalId='',fromAccount='',toAccount='')))
    assert result['success']
    after=schedules.goal_payload(B,raw,today=TODAY)['goals'][0]
    assert after['version']==before['version']==1
    assert after['transferVersion']!=before['transferVersion'] and after['balanceCents']==0
    assert all(state.rows()[0]['fields'][key]=='' for key in ('goalId','fromAccount','toAccount'))
    store=SimpleNamespace(history=lambda *a,**k:{'contributions':[],'nextOffset':None})
    assert schedules.goal_history(B,'brian','goal-1234',0,store=store)['contributions']==[]
    assert state.commands.command(B,prepared({**result['undo'],'operation':'undo'},'restore-cleared-link-123456'))['success']
    assert schedules.goal_history(B,'brian','goal-1234',0,store=store)['contributions'][0]['amountCents']==15000


def test_distinct_dates_can_be_corrected_without_invalidating_each_others_review(state,monkeypatch):
    monkeypatch.setattr(service,'now_pacific',lambda:datetime(2026,12,16,12))
    rows=tx._transfer_rows(B,'2026-12',ledger.read_all(B),as_of=date(2026,12,16),goals=state.source.goals)
    november=prepared(edit(state.rows()[0],amount=16000),'november-transfer-edit-123456')
    december=prepared(edit(rows[0],amount=17000),'december-transfer-edit-123456')
    assert state.commands.command(B,december)['success']
    assert state.commands.command(B,november)['success']
    assert [(i['date'],i['amountCents']) for i in ledger.occurrences(ledger.read_all(B),TODAY,date(2027,1,31))]==[
        ('2026-11-15',16000),('2026-12-15',17000),('2027-01-15',15000)]


def test_archived_goals_cannot_receive_new_links_but_existing_history_is_correctable(state):
    state.source.goals[1]['archived']=True
    with pytest.raises(tx.TransactionConflict,match='active personal goals'):
        tx.review(B,edit(state.rows()[0],goalId='goal-vacation'))
    state.source.goals[0]['archived']=True
    assert state.commands.command(B,prepared(edit(state.rows()[0],amount=17000)))['success']
    assert balances()['goal-1234']==17000


def test_transfer_graph_keeps_three_separate_series_and_actual_tooltip_totals():
    import shutil
    import subprocess
    from pathlib import Path
    root=Path(__file__).resolve().parents[2]
    if not shutil.which('node') or not (root/'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install report dependencies for native graph runtime contracts')
    subprocess.run(['node',str(Path(__file__).with_name('transfer_graph_test.cjs'))],cwd=root,check=True,capture_output=True,text=True)


def test_corrected_occurrence_is_shared_by_report_calendar_mix_graph_and_goals(capsys):
    import json
    from unit_tests.reports.transfer_occurrence_browser_fixture import main
    main()
    fixture=json.loads(capsys.readouterr().out)
    for snapshot,cents in zip([fixture['initial']]+[s['after'] for s in fixture['steps']], [15000,17500,15000,0,15000],strict=True):
        view=snapshot['report']['modeViews']['current']
        assert view['metrics']['amountSaved']==view['categorySpending']['savings']==50+cents/100
        assert sum(e['amount'] for e in view['calendarEvents'] if e['kind']=='transfer')==cents/100
        assert snapshot['listing']['totalAmountCents']==2500
        assert sum(d.get('transferCents',0) for d in snapshot['listing']['days'])==cents
        assert sum(g['balanceCents'] for g in snapshot['goals']['goals'])==cents
        assert snapshot['transferSettings']['transfers'][0]['amountCents']==15000


@pytest.mark.asyncio
async def test_http_occurrence_review_confirm_replay_and_receipt_are_owner_scoped(state,monkeypatch):
    from aiohttp import CookieJar, web
    from aiohttp.test_utils import TestClient, TestServer
    from bookiebot.reports import phone_app,phone_transactions
    access=state.commands.access
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL','http://127.0.0.1')
    monkeypatch.setattr(phone_app,'build_app_access_store',lambda:access)
    monkeypatch.setattr(tx,'build_transaction_commands',lambda:state.commands)
    app=web.Application();phone_transactions.register_phone_transaction_routes(app)
    async with TestClient(TestServer(app),cookie_jar=CookieJar(unsafe=True)) as client:
        def connect(actor,owner):
            cookie,_=access.consume_pairing(access.issue_pairing(actor,owner))
            client.session.cookie_jar.update_cookies({phone_app._cookie_name():cookie})
        connect(B,'brian')
        body=edit(state.rows()[0],amount=17000)
        headers={'X-BookieBot-App':'1','Origin':'http://127.0.0.1'}
        assert (await client.post('/app/transactions/review',json=body,headers={**headers,'Origin':'null'})).status==403
        response=await client.post('/app/transactions/review',json=body,headers=headers)
        assert response.status==200 and len(state.source.t.sent)==1
        review=(await response.json())['review']
        assert not any(key.startswith('_') for key in review)
        command={**body,'reviewVersion':review['reviewVersion'],'requestId':'http-occurrence-edit-123456'}
        result=await (await client.post('/app/transactions',json=command,headers=headers)).json()
        assert result['success'] and '_transferUndo' not in result
        assert await (await client.post('/app/transactions',json=command,headers=headers)).json()==result
        assert await (await client.get('/app/transactions/commands/'+command['requestId'])).json()==result
        assert len(state.source.t.sent)==2
        connect('830984827904851969','hannah')
        assert (await client.get('/app/transactions/commands/'+command['requestId'])).status==404
