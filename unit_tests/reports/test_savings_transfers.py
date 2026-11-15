from contextlib import nullcontext
from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace

import pytest

from bookiebot.reports import savings_transfers as service, bill_settings as bills, expense_breakdown as reports
from bookiebot.sheets import savings_transfers as ledger
from bookiebot.sheets.recurring import BillConflict, BillValidation, SETTINGS_LOG_TAB
from unit_tests.sheets.test_recurring_storage import Transport, B
from unit_tests.reports.test_goals_store import access as access
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet

TODAY = date(2026, 11, 15)


@pytest.fixture
def setup(monkeypatch, access):
    access.initialize()
    transport = Transport({'November': [['', 'Do not change this actual', '81.23']]})
    client = SimpleNamespace(http_client=transport)
    monkeypatch.setattr('bookiebot.sheets.auth.get_gspread_client', lambda: client)
    monkeypatch.setattr(ledger, 'storage_book', lambda *a: (2026, 'synthetic-personal'))
    for target in ('bookiebot.sheets.routing.now_pacific', 'bookiebot.reports.savings_transfers.now_pacific', 'bookiebot.reports.bill_settings.now_pacific'):
        monkeypatch.setattr(target, lambda: datetime(2026, 11, 15, 12))
    goals = [{'id':'goal-1234','name':'Emergency fund','version':1,'archived':False}]
    monkeypatch.setattr(service, '_goals', lambda owner: goals if owner == 'brian' else [])
    monkeypatch.setattr('bookiebot.reimbursements.projection.projection_lock', lambda _: nullcontext())
    monkeypatch.setattr('bookiebot.reimbursements.service.build_reimbursement_store', lambda: SimpleNamespace())
    commands = bills.BillCommands(access); commands.initialize()
    return SimpleNamespace(t=transport, client=client, commands=commands, goals=goals)


def draft(**patch):
    snapshot = service.listing(B)
    return {'operation':'transfer-create','year':snapshot['year'],'settingsVersion':snapshot['settingsVersion'],
        'draftId':'transfer-draft-123456', 'transfer':{'name':'Emergency savings','amount':'150.00','frequency':'monthly',
        'startsOn':'2026-11-15','goalId':'goal-1234','fromAccount':'Checking','toAccount':'Savings',**patch}}


def confirm(body, request='transfer-command-123456'):
    return {**body,'reviewVersion':bills.review(B,body)['reviewVersion'],'requestId':request}


def test_review_is_read_only_and_configuration_uses_one_recoverable_batch(setup):
    s=setup;body=confirm(draft())
    assert not s.t.sent
    first=s.commands.command(B,body)
    assert first['success'] and first['state']=='done'
    assert s.commands.command(B,body)==first and len(s.t.sent)==1
    assert s.t.rows['November']==[['','Do not change this actual','81.23']]
    rows=ledger.read_all(B,today=TODAY)
    assert len(rows)==1 and ledger.occurrences(rows,TODAY,TODAY)[0]['amountCents']==15000
    assert s.t.rows[SETTINGS_LOG_TAB][1][0]==body['requestId']
    assert s.t.properties[ledger.TRANSFER_TAB]['hidden']
    with pytest.raises(BillConflict):s.commands.command(B,{**body,'transfer':{**body['transfer'],'amount':'1.00'}})


@pytest.mark.parametrize('patch',[{'goalId':'someone-elses-goal'},{'amount':'-1'},{'amount':'1.001'},{'startsOn':'2026-11-14'},{'frequency':'daily'}])
def test_invalid_or_foreign_goal_reviews_cannot_write(setup,patch):
    with pytest.raises((BillValidation,BillConflict)):bills.review(B,draft(**patch))
    assert not setup.t.sent


def test_goal_archived_after_review_or_source_changed_refuses_before_writer(setup):
    s=setup;body=confirm(draft())
    s.goals[0]['archived']=True
    result=s.commands.command(B,body)
    assert not result['success'] and result['state']=='done' and not s.t.sent


def test_lost_response_recovers_receipt_without_repeating_transfer(setup):
    s=setup;body=confirm(draft());send=s.t.batch_update
    def lost(identity,batch):send(identity,batch);raise TimeoutError('lost acknowledgement')
    s.t.batch_update=lost
    assert s.commands.command(B,body)['state']=='uncertain'
    result=s.commands.saved(B,body['requestId'])
    assert result['success'] and result['state']=='done'
    assert s.commands.command(B,body)==result and len(s.t.sent)==1
    assert len(ledger.occurrences(ledger.read_all(B),TODAY,TODAY))==1


def test_future_edit_keeps_elapsed_saved_and_original_goal_link_then_stop_preserves_history(setup):
    s=setup;assert s.commands.command(B,confirm(draft()))['success']
    snapshot=service.listing(B);p=snapshot['transfers'][0]
    assert p['nextDate']=='2026-12-15','A transfer due today is already counted; editing defaults to its next future occurrence'
    update={'operation':'transfer-update','year':snapshot['year'],'id':p['id'],'revision':p['revision'],
        'settingsVersion':snapshot['settingsVersion'],'transfer':{**draft()['transfer'],'amount':'200.00','startsOn':'2026-12-15','goalId':''}}
    assert s.commands.command(B,confirm(update,'transfer-update-123456'))['success']
    rows=ledger.read_all(B)
    assert [(r['date'],r['amountCents'],r['goalId']) for r in ledger.occurrences(rows,TODAY,date(2026,12,31))]==[
        ('2026-11-15',15000,'goal-1234'),('2026-12-15',20000,'')]
    snapshot=service.listing(B);p=snapshot['transfers'][0]
    stop={'operation':'transfer-stop','year':snapshot['year'],'settingsVersion':snapshot['settingsVersion'],'id':p['id'],'revision':p['revision']}
    assert s.commands.command(B,confirm(stop,'transfer-stop-123456'))['success']
    assert [(r['date'],r['amountCents']) for r in ledger.occurrences(ledger.read_all(B),TODAY,date(2026,12,31))]==[('2026-11-15',15000)]


def test_same_occurrence_funds_goal_and_saved_once_and_never_spending_or_income(monkeypatch):
    monkeypatch.setattr(reports,'now_pacific',lambda:datetime(2026,11,15,12))
    plans=(ledger.Transfer('transfer-1234',1,'Emergency savings',15000,'monthly','2026-11-15','2026-11-15','goal-1234'),
        ledger.Transfer('transfer-5678',1,'Later savings',25000,'once','2026-11-20','2026-11-15','goal-1234'))
    raw=reports.ReportWorksheets(InMemoryWorksheet([],title='November'), InMemoryWorksheet([
        ['','Enter Monthly Savings Contribution','Ideal: $300','Minimum: $150','50']],title='November'),transfer_plans=plans)
    base=reports.build_expense_breakdown_report(actor_key=B,owner_name='Brian',persons=['Brian'],month=reports.BudgetMonth(2026,11),worksheets=replace(raw,transfer_plans=()))
    report=reports.build_expense_breakdown_report(actor_key=B,owner_name='Brian',persons=['Brian'],month=reports.BudgetMonth(2026,11),worksheets=raw)
    payload=reports.expense_breakdown_client_payload(report)
    assert report.amount_saved==(base.amount_saved or 0)+150
    assert report.grand_total==base.grand_total and report.income_total==base.income_total
    assert payload['modeViews']['current']['metrics']['amountSaved']==200
    assert payload['modeViews']['projected']['metrics']['amountSaved']==450
    assert report.net_total==base.net_total-150
    assert payload['modeViews']['projected']['categoryBalances']['remaining']['savings']==-450
    goal={'id':'goal-1234','balanceCents':5000,'contributionCents':5000,'contributionCount':1}
    monkeypatch.setattr(ledger,'read_all',lambda *a,**k:list(plans))
    result=service.goal_payload(B,{'goals':[goal]},today=TODAY)
    assert result['goals'][0]['balanceCents']==20000 and result['goals'][0]['contributionCount']==2
    assert goal['balanceCents']==5000,'Projection does not mutate or duplicate a SQL goal contribution'
    for mode,expected in [('current',200),('projected',450)]:
        details=payload['metricExplanations'][mode]['saved']
        assert sum(c['amount'] for c in details['components'])==expected
        assert not any(c['label']=='Other saved amount from the sheet' for c in details['components'])
        assert len([c for c in details['components'] if 'savings transfer' in c['label']])==(1 if mode=='current' else 2)


def test_goal_archive_requires_unlinking_future_transfers_and_preserves_due_allocations(monkeypatch):
    from bookiebot.reports.goals_store import GoalConflictError
    monkeypatch.setattr(service,'now_pacific',lambda:datetime(2026,11,15,12))
    p=ledger.Transfer('transfer-1234',1,'Savings',15000,'monthly','2026-11-15','2026-11-15','goal-1234')
    monkeypatch.setattr(ledger,'read_all',lambda *a,**k:[p])
    commands=SimpleNamespace(pending=lambda owner:None)
    with pytest.raises(GoalConflictError,match='Unlink or stop'):
        service.can_archive_goal(B,'brian','goal-1234',commands=commands)
    stopped=replace(p,revision=2,active=False,effective_from='2026-11-16')
    monkeypatch.setattr(ledger,'read_all',lambda *a,**k:[p,stopped])
    service.can_archive_goal(B,'brian','goal-1234',commands=commands)
    assert service.goal_payload(B,{'goals':[{'id':'goal-1234','balanceCents':0,'contributionCents':0,'contributionCount':0}]},today=TODAY)['goals'][0]['balanceCents']==15000


def test_mixed_manual_and_transfer_goal_history_has_stable_pages_and_no_future_entries(monkeypatch):
    monkeypatch.setattr(service,'now_pacific',lambda:datetime(2026,11,15,12))
    p=ledger.Transfer('transfer-1234',1,'Savings',15000,'monthly','2026-01-15','2026-01-15','goal-1234')
    monkeypatch.setattr(ledger,'read_all',lambda *a,**k:[p])
    manual=[{'id':f'manual-{i:03d}','date':'2026-11-01','createdAt':f'2026-11-01T00:00:{i%60:02d}','amountCents':100,'note':'','reversedAt':''} for i in range(55)]
    manual.sort(key=lambda r:(r['createdAt'],r['id']),reverse=True)
    store=SimpleNamespace(history=lambda owner,identity,offset:{'contributions':manual[offset:offset+25],'nextOffset':offset+25 if len(manual)>offset+25 else None})
    pages=[];offset=0
    while True:
        value=service.goal_history(B,'brian','goal-1234',offset,store=store);pages.extend(value['contributions'])
        if value['nextOffset'] is None:break
        offset=value['nextOffset']
    assert len(pages)==66 and len({r['id'] for r in pages})==66
    assert all(r['date']<=TODAY.isoformat() for r in pages)
    assert sum(bool(r.get('readOnly')) for r in pages)==11


def test_transactions_transfer_is_actual_only_inspectable_and_never_needs_or_wants(monkeypatch):
    from bookiebot.reports import transactions as tx
    p=ledger.Transfer('transfer-1234',1,'Emergency savings',15000,'monthly','2026-11-15','2026-11-15','goal-1234','Checking','Savings')
    assert tx._transfer_rows(B,'2026-11',[p],as_of=date(2026,11,14))==[]
    automatic=tx._transfer_rows(B,'2026-11',[p],as_of=TODAY,goal_names={'goal-1234':'Emergency fund'})
    assert len(automatic)==1 and automatic[0]['kind']=='transfer' and automatic[0]['categoryLabel']=='Savings transfer'
    assert automatic[0]['fields']['goalName']=='Emergency fund'
    assert not any(automatic[0]['capabilities'].values())
    needs={**automatic[0],'id':'needs','kind':'expense','category':'grocery','categoryLabel':'Grocery','amountCents':1000}
    wants={**needs,'id':'wants','category':'food','categoryLabel':'Food','amountCents':2000}
    income={**needs,'id':'income','kind':'income','category':'income','amountCents':100000}
    monkeypatch.setattr(tx,'load_transactions',lambda *a,**k:[needs,wants,*automatic,income])
    all_rows=tx.listing(B,{'month':'2026-11','scope':'spending_or_transfers','view':'daily'})
    assert len(all_rows['items'])==3 and all_rows['totalAmountCents']==3000
    assert all_rows['days'][0]['needsCents']==1000 and all_rows['days'][0]['wantsCents']==2000
    assert all_rows['listDays'][0]['totalCents']==18000
    assert len(tx.listing(B,{'month':'2026-11','kind':'transfer'})['items'])==1
    assert len(tx.listing(B,{'month':'2026-11','kind':'savings'})['items'])==1
    assert len(tx.listing(B,{'month':'2026-11','scope':'spending'})['items'])==2
    assert [r['id'] for r in tx.listing(B,{'month':'2026-11','bucket':'needs'})['items']]==['needs']
    days=tx._daily_totals(automatic)
    assert days[0]['totalCents']==15000 and days[0]['needsCents']==days[0]['wantsCents']==0
    with pytest.raises(tx.TransactionValidation):tx._normalized({'operation':'delete'},automatic[0])


def test_scheduled_transfers_and_payroll_espp_keep_separate_saved_components(monkeypatch):
    from unit_tests.reports.test_recorded_espp import rows
    from unit_tests.reports.test_income_projection import build
    monkeypatch.setattr(reports,'now_pacific',lambda:datetime(2026,11,15,12))
    report=build(rows(('11/6/2026','xAI','3400.00','300.00'),saved=50,projection='biweekly'),month=reports.BudgetMonth(2026,11))
    report.savings_transfers=[{'date':'2026-11-15','name':'Emergency savings','amountCents':15000},
                             {'date':'2026-11-20','name':'Later savings','amountCents':25000}]
    report.amount_saved=200
    payload=reports.expense_breakdown_client_payload(report)
    for mode,cash,espp in [('current',200,300),('projected',450,600)]:
        view=payload['modeViews'][mode]
        assert view['metrics']['amountSaved']==cash+espp
        assert view['savingsInvesting']['cashSaved']==cash and view['metrics']['totalExpenses']==0
        assert view['categorySpending']['savings']==cash
        assert sum(c['amount'] for c in payload['metricExplanations'][mode]['saved']['components'])==cash+espp
    assert payload['savingsInvesting']['history']['totalContributed']==300


def test_goal_archive_guard_uses_existing_owner_claim_and_keeps_due_transfer_allocation(setup,monkeypatch):
    from bookiebot.reports.goals_store import GoalsStore, GoalConflictError
    s=setup;store=GoalsStore(s.commands.access);store.initialize()
    goal=store.command('brian',{'operation':'create','requestId':'create-linked-goal-123456','name':'Emergency fund','targetCents':100000})['goal']
    monkeypatch.setattr(service,'_goals',lambda owner:store.list_goals(owner)['goals'])
    assert s.commands.command(B,confirm(draft(goalId=goal['id'])))['success']
    command={'operation':'archive','requestId':'archive-linked-goal-123456','goalId':goal['id'],'version':goal['version']}
    guard=lambda owner,identity:service.can_archive_goal(B,owner,identity,commands=s.commands)
    with pytest.raises(GoalConflictError,match='Unlink or stop'):
        store.command('brian',command,before_archive=guard)
    assert not store.list_goals('brian')['goals'][0]['archived']
    snapshot=service.listing(B);p=snapshot['transfers'][0]
    stop={'operation':'transfer-stop','year':snapshot['year'],'settingsVersion':snapshot['settingsVersion'],'id':p['id'],'revision':p['revision']}
    assert s.commands.command(B,confirm(stop,'stop-linked-transfer-123456'))['success']
    assert store.command('brian',command,before_archive=guard)['goal']['archived']
    raw=store.list_goals('brian')
    assert raw['goals'][0]['contributionCount']==0,'There is no duplicate SQL goal contribution'
    assert service.goal_payload(B,raw,today=TODAY)['goals'][0]['balanceCents']==15000


@pytest.mark.asyncio
async def test_legacy_savings_query_does_not_present_unavailable_transfer_data_as_zero(monkeypatch):
    from unittest.mock import AsyncMock
    from bookiebot.intents import handlers
    monkeypatch.setattr(handlers.su,'check_savings_deposited',AsyncMock(return_value={'unavailable':True,'deposited':False,'actual':0,'ideal':0,'minimum':0}))
    send=AsyncMock()
    await handlers.query_savings_handler({},SimpleNamespace(channel=SimpleNamespace(send=send)))
    assert 'Could not verify' in send.await_args.args[0]
    assert 'No monthly savings' not in send.await_args.args[0]
