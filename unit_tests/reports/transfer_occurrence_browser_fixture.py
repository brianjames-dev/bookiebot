"""Canonical isolated API snapshots for the shipped transfer editor browser test."""
import json
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from pytest import MonkeyPatch
from bookiebot.reports import transactions as tx, savings_transfers as schedules, transfer_occurrences as edits
from bookiebot.reports import expense_breakdown as reports
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.reports.goals_store import GoalsStore
from bookiebot.sheets import savings_transfers as ledger
from unit_tests.reports.test_savings_transfers import setup, draft, confirm, TODAY, B
from unit_tests.reports.test_transfer_occurrences import prepared
from unit_tests.reports.test_income_projection import income_rows
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet as WS


def main():
    with TemporaryDirectory() as directory, MonkeyPatch.context() as monkey:
        access=AppAccessStore(Path(directory)/'fixture.sqlite3')
        state=setup.__wrapped__(monkey,access)
        for target in (edits,tx,reports):monkey.setattr(target,'now_pacific',lambda:datetime(2026,11,15,12))
        goals=GoalsStore(access);goals.initialize()
        first=goals.command('brian',{'operation':'create','requestId':'fixture-goal-first-123456','name':'Emergency fund','targetCents':500000})['goal']
        second=goals.command('brian',{'operation':'create','requestId':'fixture-goal-second-123456','name':'Vacation','targetCents':500000})['goal']
        monkey.setattr(schedules,'_goals',lambda owner:goals.list_goals(owner)['goals'])
        assert state.commands.command(B,confirm(draft(goalId=first['id'])))['success']
        commands=tx.TransactionCommands(access);commands.initialize()
        expense={'id':'expense-fixture','actionId':'','month':'2026-11','date':'2026-11-14','version':'expense-version',
            'kind':'expense','category':'food','categoryLabel':'Food','title':'Fixture purchase','location':'Fixture merchant','person':'Brian (BofA)',
            'amountCents':2500,'split':'','fields':{'item':'Fixture purchase','amount':'25.00','date':'2026-11-14','location':'Fixture merchant'},
            'editableFields':[],'capabilities':{key:False for key in ('update','move','delete','split','cancel_split','undo')},'reasons':{}}
        def rows():
            names=goals.list_goals('brian')['goals']
            return [*tx._transfer_rows(B,'2026-11',ledger.read_all(B),as_of=TODAY,goals=names,goal_names={g['id']:g['name'] for g in names}),expense]
        def snapshot():
            with patch.object(tx,'load_transactions',return_value=rows()):
                listing=tx.listing(B,{'month':'2026-11','view':'daily','scope':'spending_or_transfers'})
                transfer_listing=tx.listing(B,{'month':'2026-11','view':'daily','kind':'transfer'})
            listing.update(commands.overview('brian','2026-11'))
            personal=income_rows(('11/1/2026','Fixture income','5000'),settings=(('Main Income Source','Fixture income'),('Income Projection Mode','off')))
            personal.append(['','Enter Monthly Savings Contribution','Ideal = $1000','Minimum = $500','50'])
            report=reports.build_expense_breakdown_report(actor_key=B,owner_name='Brian',persons=['Brian'],month=reports.BudgetMonth(2026,11),
                worksheets=reports.ReportWorksheets(WS([],title='November'),WS(personal,title='November'),transfer_plans=tuple(ledger.read_all(B))))
            return {'listing':listing,'transferListing':transfer_listing,'report':reports.expense_breakdown_client_payload(report),
                    'goals':schedules.goal_payload(B,goals.list_goals('brian'),today=TODAY),
                    'transferSettings':schedules.listing(B)}
        initial=snapshot();identity=rows()[0]['id'];steps=[]
        def run(body,request):
            before=snapshot();review=tx.review(B,body)['review'];command=prepared(body,request)
            result=commands.command(B,command);assert result['success']
            steps.append({'body':body,'review':review,'result':result,'before':before,'after':snapshot()})
            return result
        row=rows()[0]
        changed=run({'id':identity,'month':'2026-11','version':row['version'],'operation':'update',
            'updates':{'amount':17500,'item':'Ally top-up','fromAccount':'Daily checking','toAccount':'Vacation savings','goalId':second['id']}},'fixture-transfer-update-123456')
        run({**changed['undo'],'operation':'undo'},'fixture-undo-transfer-update-123456')
        row=rows()[0]
        deleted=run({'id':identity,'month':'2026-11','version':row['version'],'operation':'delete'},'fixture-transfer-delete-123456')
        run({**deleted['undo'],'operation':'undo'},'fixture-undo-transfer-delete-123456')
        settings=schedules.listing(B);plan=settings['transfers'][0]
        schedule_body={'operation':'transfer-update','year':settings['year'],'settingsVersion':settings['settingsVersion'],
            'id':plan['id'],'revision':plan['revision'],'transfer':{'name':plan['name'],'amount':'160.00',
                'frequency':plan['frequency'],'startsOn':plan['nextDate'],'goalId':plan['goalId'],
                'fromAccount':plan['fromAccount'],'toAccount':plan['toAccount']}}
        from bookiebot.reports import bill_settings
        print(json.dumps({'initial':initial,'steps':steps,'identity':identity,'goals':[first,second],
                         'scheduleReview':bill_settings.review(B,schedule_body),'scheduleBody':schedule_body}))


if __name__=='__main__':main()
