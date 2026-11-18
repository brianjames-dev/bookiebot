"""Overview's read model follows canonical cash without a Sheets projection."""
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess

import pytest

from bookiebot.reimbursements import service
from bookiebot.reimbursements.presentation import display_snapshot
from bookiebot.reimbursements.projection import _name
from bookiebot.reports import expense_breakdown as reports
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.config import category_layout
from bookiebot.sheets.routing import PACIFIC_TZ
from gspread.utils import a1_to_rowcol
from unit_tests.reimbursements.test_store import store, access, payload, payment, command, sync_allocations  # noqa:F401
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


def phases(store, monkeypatch, utility=False, materialized=False):
    shared = [['']*32 for _ in range(8)]
    layouts = category_layout(shared)
    def fields(category):
        return {key:a1_to_rowcol(col+'1')[1] for key,col in layouts[category]['columns'].items()}
    def purchase(identifier, category, row, owner):
        columns=fields(category)
        values={'date':'2026-11-01','item':identifier,'location':'Fixture '+identifier,'person':'Brian (BofA)' if owner=='brian' else 'Hannah','amount':'100.00'}
        for key,col in columns.items():shared[row-1][col-1]=values.get(key,'')
        return store.register_allocation(payload(id=identifier,payerOwner=owner,partnerOwner='hannah' if owner=='brian' else 'brian',payerPerson=values['person'],
            sourceActionId='source-'+identifier,sourceYear=2026,sourceSheetTitle='November',sourceWorksheet='expense',sourceRow=row,sourceColumnMap=columns,sourceValues=values,
            expenseDate='2026-11-01',item=identifier,location=values['location'],category=category,grossCents=10000,payerShareCents=6000,partnerShareCents=4000))
    shopping=purchase('shopping','shopping',3,'brian');grocery=purchase('grocery','grocery',4,'hannah')
    columns=fields('food')
    for key,value in {'date':'2026-11-05','item':'Lunch','location':'Unrelated lunch','person':'Brian (BofA)','amount':'25.00'}.items():shared[5][columns[key]-1]=value
    label='PG&E' if utility else 'Rent'
    rent=store.register_allocation(payload(id='rent',sourceActionId='rent-source',sourceYear=2026,sourceSheetTitle='November',sourceWorksheet='income',sourceRow=2,
        sourceColumnMap={'item':2,'amount':3},sourceValues={'item':label,'amount':'3000.00'},expenseDate='2026-11-01',item=label,location='',category='pge' if utility else 'rent',grossCents=300000,payerShareCents=200000,partnerShareCents=100000))
    sync_allocations(store)
    personal={owner:[['Monthly Income','5000'],['',label,'3000.00' if owner=='brian' else '0.00'],['Total Savings Deposited','','','','100.00']] for owner in ('brian','hannah')}
    schedules=[BILL_SCHEDULE_HEADERS,['rent',label,'monthly','22','',label,'','','','3000']]
    shared_meta={'sheets':[{'properties':{'sheetId':1,'title':'November'}}],'namedRanges':[{'name':_name('source',a['id']),'range':{'sheetId':1,'startRowIndex':a['sourceRow']-1,'endRowIndex':a['sourceRow']}} for a in (shopping,grocery)]}
    personal_meta={'sheets':[{'properties':{'sheetId':2,'title':'November'}}],'namedRanges':[{'name':_name('source','rent'),'range':{'sheetId':2,'startRowIndex':1,'endRowIndex':2}}]}
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED','true')
    monkeypatch.setattr(service,'build_reimbursement_store',lambda:store)
    monkeypatch.setattr(reports,'now_pacific',lambda:datetime(2026,11,17,12,tzinfo=PACIFIC_TZ))
    receipt_rows={}
    def project_fixture():
        """Emulate completed source cells while queued inverse jobs still wait."""
        raw=store.snapshot('brian');allocations={a['id']:a for a in raw['allocations']}
        for a in raw['allocations']:
            if a['sourceWorksheet']=='expense':shared[a['sourceRow']-1][a['sourceColumnMap']['amount']-1]=str((a['grossCents']-a['settledCents'])/100)
        bill=allocations['rent']
        personal['brian'][1][2]=str((bill['grossCents']-bill['settledCents'])/100);personal['hannah'][1][2]=str(bill['settledCents']/100)
        for e in raw['events']:
            a=allocations[e['allocationId']]
            if a['sourceWorksheet']!='expense':continue
            if e['id'] not in receipt_rows:
                if e['status']!='confirmed':continue
                shared.append(['']*32);receipt_rows[e['id']]=len(shared)
                shared_meta['namedRanges'].append({'name':_name('receipt',e['id']),'range':{'sheetId':1,'startRowIndex':len(shared)-1,'endRowIndex':len(shared)}})
            row=shared[receipt_rows[e['id']]-1];columns=fields(a['category']);prefix='Offset' if e['kind']=='offset' else 'Reimbursement'
            values={'date':e['date'],'item':prefix+' · '+a['item'],'location':prefix+' to '+a['payerOwner'].title()+' · '+a['location'],
                'person':'Brian (BofA)' if a['partnerOwner']=='brian' else 'Hannah','amount':str(e['amountCents']/100 if e['status']=='confirmed' else 0)}
            for key,col in columns.items():row[col-1]=values.get(key,'')
    output={}
    def capture(name):
        if materialized:project_fixture()
        inputs=deepcopy((shared,personal,schedules,shared_meta,personal_meta))
        snapshots={owner:service.snapshot(owner) for owner in ('brian','hannah')}
        report_payloads={}
        for owner in ('brian','hannah'):
            sheets=reports.ReportWorksheets(shared_expenses=InMemoryWorksheet(shared),personal_budget=InMemoryWorksheet(personal[owner]),bill_schedule=InMemoryWorksheet(schedules),shared_metadata=shared_meta,personal_metadata=personal_meta)
            model=reports.build_expense_breakdown_report(actor_key='676638528590970917' if owner=='brian' else '830984827904851969',owner_name=owner.title(),persons=['Brian (BofA)'] if owner=='brian' else ['Hannah'],month=reports.BudgetMonth(2026,11),worksheets=sheets)
            report_payloads[owner]=reports.expense_breakdown_client_payload(model)
        from bookiebot.reports.report_insights import compare_report_spending
        comparison={owner:{mode:compare_report_spending(report_payloads[owner],None,baseline_month='2026-10',baseline_kind='previous-month',mode=mode,as_of=datetime(2026,11,17,12,tzinfo=PACIFIC_TZ))['selected']['spending'] for mode in ('current','projected')} for owner in ('brian','hannah')}
        output[name]={'snapshots':snapshots,'reports':report_payloads,'comparison':comparison}
        assert (shared,personal,schedules,shared_meta,personal_meta)==inputs
        return snapshots
    initial=capture('initial')
    paid=store.command('brian',{**payment(shopping,3000),'date':'2026-11-10'})
    paid_state=capture('payment')
    queued=store.command('brian',command('queue_undo',action='reverse_operation',operationId=paid['operationId'],expectedUndoState=paid_state['brian']['undoState']))
    capture('paymentUndo')
    sync_allocations(store);store.command('brian',{'operation':'queued_undo','requestId':'queued-undo-'+queued['undoJob']['id']},_undo_job_id=queued['undoJob']['id']);sync_allocations(store)
    capture('paymentUndone')
    current={row['id']:row for row in store.snapshot('brian')['allocations']}
    offset=store.command('brian',command('offset',entries=[{'allocationId':identifier,'version':current[identifier]['version'],'amountCents':2000} for identifier in ('shopping','grocery')],date='2026-11-12'))
    offset_state=capture('offset')
    queued=store.command('brian',command('queue_undo',action='reverse_operation',operationId=offset['operationId'],expectedUndoState=offset_state['brian']['undoState']))
    capture('offsetUndo')
    sync_allocations(store);store.command('brian',{'operation':'queued_undo','requestId':'queued-undo-'+queued['undoJob']['id']},_undo_job_id=queued['undoJob']['id']);sync_allocations(store)
    capture('offsetUndone')
    bill=store.command('brian',{**payment(rent,20000),'date':'2026-11-01'})
    bill_state=capture('billPayment')
    queued=store.command('brian',command('queue_undo',action='reverse_operation',operationId=bill['operationId'],expectedUndoState=bill_state['brian']['undoState']))
    capture('billUndo')
    sync_allocations(store);store.command('brian',{'operation':'queued_undo','requestId':'queued-undo-'+queued['undoJob']['id']},_undo_job_id=queued['undoJob']['id']);sync_allocations(store)
    capture('billUndone')
    reset=store.command('brian',command('reset',expectedState=store.snapshot('brian')['resetState'],note='Isolated fixture'))
    reset_state=capture('reset')
    store.command('brian',command('queue_undo',action='undo_reset',resetId=reset['reset']['id'],version=reset['reset']['version'],expectedUndoState=reset_state['brian']['undoState']))
    capture('resetUndo')
    assert initial['brian']['allocations'][0]['grossCents']==store.snapshot('brian')['allocations'][0]['grossCents']
    return output


def test_overview_cash_and_calendar_are_canonical_before_projection(store, monkeypatch):
    output=phases(store,monkeypatch)
    def spent(phase,owner,mode='current'):
        return output[phase]['reports'][owner]['modeViews'][mode]['metrics']['totalExpenses']
    assert spent('initial','brian')==125 and spent('initial','hannah')==100
    assert spent('payment','brian')==95 and spent('payment','hannah')==130
    assert spent('paymentUndo','brian')==125 and spent('paymentUndo','hannah')==100
    assert spent('offset','brian')==125 and spent('offset','hannah')==100
    assert spent('offsetUndo','brian')==125 and spent('offsetUndo','hannah')==100
    assert spent('billPayment','brian')==125
    assert spent('billPayment','brian','projected')==2925
    assert spent('billPayment','hannah')==300
    assert spent('billPayment','hannah','projected')==1100
    assert spent('billUndo','brian','projected')==3125 and spent('billUndo','hannah')==100
    if target:=os.getenv('BOOKIEBOT_OVERVIEW_FIXTURE'):Path(target).write_text(json.dumps(output))


@pytest.mark.parametrize('utility',[False,True])
@pytest.mark.parametrize('materialized',[False,True])
def test_frontend_overview_matches_independent_server_reports(store, monkeypatch, tmp_path, utility, materialized):
    output=phases(store,monkeypatch,utility,materialized)
    fixture=tmp_path/'overview.json';fixture.write_text(json.dumps(output));monkeypatch.setenv('BOOKIEBOT_OVERVIEW_FIXTURE',str(fixture))
    subprocess.run(['node','unit_tests/reports/overview_display_state_test.cjs'],cwd=Path(__file__).resolve().parents[2],check=True,capture_output=True,text=True)
