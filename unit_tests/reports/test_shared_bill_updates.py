"""Two workbook owners, real bill/split/receipt writers, isolated storage only."""
from copy import deepcopy
from dataclasses import asdict
from datetime import datetime
import calendar
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
from uuid import uuid4

import pytest
from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
from gspread.utils import a1_to_rowcol

from bookiebot.reimbursements import projection, service, store as ledger_module, mirror
from bookiebot.reports import bill_settings, expense_breakdown as report, phone_app, phone_bills, phone_history, phone_shared_bills, shared_bills, shared_bill_forecast, transactions
from bookiebot.sheets import auth, recurring_storage, routing, undo
from bookiebot.sheets.recurring import BILL_TAB, BillPlan
from bookiebot.sheets.recurring_rows import encode
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reimbursements.test_projection import Book, Sheet
from unit_tests.reimbursements.test_store import payment
from unit_tests.reports.test_accounts import store
from unit_tests.reports.test_shared_bills import catalog, people, BRIAN, HANNAH


class Workbook(Book):
    def add_sheet(self, title, rows=None):
        sheet = Worksheet(self, title, len(self.sheets)+1, rows)
        self.sheets[title] = sheet
        return sheet

    def value(self, title, row, column):
        value = self.worksheet(title).read(row-1, column-1, column)[0]
        if not isinstance(value, str) or not value.startswith('='):
            return str(value)
        reference = re.fullmatch(r"='([^']+)'!([A-Z]+\d+)", value)
        if reference:
            return self.value(reference[1], *a1_to_rowcol(reference[2]))
        sums = re.findall(r'SUM\(([A-Z]+\d+)(?::([A-Z]+\d+))?\)', value)
        assert sums, f'Unsupported test formula: {value}'
        amount = 0
        for first, last in sums:
            r1, c1 = a1_to_rowcol(first); r2, c2 = a1_to_rowcol(last or first)
            amount += sum(float(self.value(title, r, c) or 0) for r in range(r1, r2+1) for c in range(c1, c2+1))
        return str(amount)


class Worksheet(Sheet):
    def get_all_values(self):
        return [[self.book.value(self.title, r+1, c+1) for c in range(len(row))]
                for r, row in enumerate(self.rows)]

    def append_row(self, values):
        self.rows.append(deepcopy(values))

    def update(self, values, *, range_name, **_kwargs):
        row, column = a1_to_rowcol(range_name.split(':')[0])
        for offset, value in enumerate(values):
            self.write(row-1+offset, column-1, value)

    def cell(self, row, column):
        return SimpleNamespace(value=self.book.value(self.title, row, column))


class SheetsTransport:
    def __init__(self, books):
        self.books = books

    def fetch_sheet_metadata(self, identity):
        book = self.books[identity]
        return {'sheets': [{'properties': {'title': s.title, 'sheetId': s.id,
            'gridProperties': {'rowCount': s.row_count, 'columnCount': s.col_count}}} for s in book.sheets.values()],
            'namedRanges': deepcopy(list(book.names.values()))}

    def values_batch_get(self, identity, ranges, params):
        book = self.books[identity]
        titles = [r.strip("'").replace("''", "'") for r in ranges]
        return {'valueRanges': [{'range': region+'!A1:AZ1000', 'values': deepcopy(book.worksheet(title).rows)
            if params['valueRenderOption'] == 'FORMULA' else book.worksheet(title).get_all_values()}
            for region, title in zip(ranges, titles)]}

    def batch_update(self, identity, body):
        return self.books[identity].batch_update(body)


@pytest.fixture
def household(catalog, monkeypatch):
    clock = [datetime(2026, 11, 16, 12, tzinfo=PACIFIC_TZ)]
    ledger = ledger_module.ReimbursementStore(catalog.access); ledger.initialize()
    commands = bill_settings.BillCommands(catalog.access); commands.initialize()
    books = {f'{owner}-{year}': Workbook() for owner in ('brian', 'hannah', 'shared') for year in (2026, 2027)}
    client = SimpleNamespace(http_client=SheetsTransport(books), open_by_key=books.__getitem__)
    budget_id = lambda actor, year: f'{routing.get_user_config(actor).budget_owner_key}-{year}'
    for module in (routing, bill_settings, recurring_storage, transactions, service, ledger_module, shared_bill_forecast, report, phone_history):
        if hasattr(module, 'now_pacific'):
            monkeypatch.setattr(module, 'now_pacific', lambda: clock[0])
    for module in (routing, recurring_storage, transactions, projection, mirror):
        if hasattr(module, 'get_budget_spreadsheet_id_for_user'):
            monkeypatch.setattr(module, 'get_budget_spreadsheet_id_for_user', budget_id)
        if hasattr(module, 'get_shared_expenses_spreadsheet_id'):
            monkeypatch.setattr(module, 'get_shared_expenses_spreadsheet_id', lambda year: f'shared-{year}')
    for module in (auth, transactions):
        monkeypatch.setattr(module, 'get_gspread_client', lambda: client)
    for module in (service, ledger_module):
        monkeypatch.setattr(module, 'build_reimbursement_store', lambda: ledger)
    monkeypatch.setattr(shared_bills, 'build_store', lambda: catalog)
    monkeypatch.setattr(shared_bill_forecast, 'build_store', lambda: catalog)
    monkeypatch.setattr(report, '_optional_previous_year_budget_history', lambda *_a, **_k: ())
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED', 'true')
    specs = [('Rent', 'fixed', 1, 300000, 100000), ('Water', 'variable', 18, 9000, 3000),
        ('PG&E', 'variable', 22, 15000, 5000), ('Recology', 'variable', 20, 12000, 4000)]
    plans = [BillPlan('payer-'+name.lower().replace('&',''), kind, name, gross if kind == 'fixed' else None,
        'quarterly' if name == 'Recology' else 'monthly', day, (2,5,8,11) if name == 'Recology' else (),
        'rent' if name == 'Rent' else 'bills_utilities', 'Checking', name, BILL_TAB,
        split_method='equal', monthly_source=True, version='original-'+name.lower(), request_id='baseline')
        for name, kind, day, gross, share in specs]
    legacy_rows = [['bill_key','display_name','recurrence','pull_day','pull_months','source_label','account','notes','updated_at'],
        *[[name.lower().replace('&',''),name,'quarterly' if name=='Recology' else 'monthly','','',name,'','','']
          for name, *_ in specs]]
    for owner in ('brian', 'hannah'):
        for year in (2026, 2027):
            book = books[f'{owner}-{year}']
            book.add_sheet(BILL_TAB, encode(plans, BILL_TAB, []) if owner == 'brian' and year == 2026 else legacy_rows)
            book.add_sheet('Subscriptions', [])
            for month in calendar.month_name[1:]:
                rows = [['','Income'],['','Date','Source','Amount'],['',f'{list(calendar.month_name).index(month)}/1/{year}','Paycheck','5000'],
                    ['','Monthly Income:','','5000']]
                rows += [['', name, str(gross/100) if owner=='brian' and year==2026 and month=='November' else '0'] for name,_,_,gross,_ in specs]
                rows += [['','Total Needs','=SUM(C5:C8)'],['','Total Wants','','0']]
                book.add_sheet(month, rows)
    for year in (2026, 2027):
        shared = books[f'shared-{year}']; shared.sheets = {}
        for month in calendar.month_name[1:]:
            shared.add_sheet(month, [])
            shared.add_sheet(f'_BookieBot Action Log - {year}-{list(calendar.month_name).index(month):02d}', [undo._LOG_HEADERS])
    november_ids = []
    for index, (name, _, _, gross, share) in enumerate(specs, 5):
        source_id = 'november-'+name.lower()
        allocation = ledger.register_allocation(dict(id=source_id, payerOwner='brian', partnerOwner='hannah', payerPerson='Brian (BofA)',
            item=name, location='', expenseDate='2026-11-01', category=name.lower(), sourceWorksheet='income',
            sourceRow=index, sourceActionId=source_id, splitActionId='split-'+source_id, sourceYear=2026,
            sourceSpreadsheetId='brian-2026', sourceSheetTitle='November', sourceColumnMap={'item':2,'amount':3},
            sourceValues={'item':name,'amount':str(gross/100)}, grossCents=gross, payerShareCents=gross-share,
            partnerShareCents=share, settledCents=0, method='income', accounting='cash_v1'))
        action = undo.UndoAction(worksheet='income', kind='restore_cells', row=index, columns=[3], previous_values=[''],
            new_values=[str(gross/100)], metadata={'type':'payment','category':name.lower()}, description=name)
        books['shared-2026'].worksheet('_BookieBot Action Log - 2026-11').append_row(
            [source_id,'2026-11-01T12:00:00-08:00',BRIAN,'active','',json.dumps(asdict(action))])
        assert projection.sync_pending(ledger)
        received = service.command('brian', {**payment(allocation, share), 'date':'2026-11-01'})
        assert not received['projectionPending']
        november_ids.append(source_id)
    people(catalog)
    for plan in plans:
        invite = shared_bills.review(BRIAN, {'action':'invite','billId':plan.id}, store=catalog)
        saved = shared_bills.command(BRIAN, {'action':'invite','billId':plan.id,'reviewVersion':invite['reviewVersion'],
            'requestId':uuid4().hex}, store=catalog)
        if plan.name == 'Rent':
            review = shared_bills.review(HANNAH, {'action':'accept','shareId':saved['id']}, store=catalog)
            shared_bills.command(HANNAH, {'action':'accept','shareId':saved['id'],'reviewVersion':review['reviewVersion'],
                'requestId':uuid4().hex}, store=catalog)
    transactions._CACHE.clear()
    yield SimpleNamespace(clock=clock, ledger=ledger, commands=commands, catalog=catalog, books=books, client=client,
        plans=plans, november_ids=november_ids)
    transactions._CACHE.clear()


def accept_utilities(household):
    member = people(household.catalog)[1]
    for link in household.catalog.links(member):
        if link['status'] != 'pending': continue
        checked = shared_bills.review(HANNAH, {'action':'accept','shareId':link['id']}, store=household.catalog)
        body = {'action':'accept','shareId':link['id'],'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
        assert shared_bills.command(HANNAH, body, store=household.catalog)['status'] == 'active'
        assert shared_bills.command(HANNAH, body, store=household.catalog)['status'] == 'active'


def configuration_body(household, name, method, basis, start, amount=None, pull_day=None):
    source = bill_settings.read_workbook(BRIAN, household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name == name)
    return {'operation':'update','id':plan.id,'version':plan.version,'settingsVersion':source.settings.version,
        'bill':{'name':plan.name,'type':plan.kind,'amount':amount if amount is not None else '' if plan.amount_cents is None else str(plan.amount_cents/100),
            'cadence':plan.cadence,'pullDay':plan.pull_day if pull_day is None else pull_day,'pullMonths':list(plan.pull_months),'category':plan.category,
            'account':plan.account,'effectiveFrom':start,'splitMethod':method,'payerBasisPoints':basis}}


def configure(household, name, method, basis, start, amount=None, pull_day=None):
    body = configuration_body(household,name,method,basis,start,amount,pull_day)
    checked = bill_settings.review(BRIAN, body)
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    result = household.commands.command(BRIAN, command)
    assert result['success'], result
    assert household.commands.command(BRIAN, command) == result


def financial_report(household, actor):
    current = household.clock[0]
    owner = routing.get_user_config(actor).budget_owner_key
    book = household.books[f'{owner}-{current.year}']
    month = report.BudgetMonth(current.year,current.month)
    source = report.ReportWorksheets(shared_expenses=household.books[f'shared-{current.year}'].worksheet(month.name),
        personal_budget=book.worksheet(month.name),bill_schedule=book.worksheet(BILL_TAB),
        bill_charges=book.sheets.get('_BookieBot Bill Charges'),
        shared_bill_forecasts=shared_bill_forecast.forecast_inputs(actor,[f'{current.year:04d}-{current.month:02d}']))
    return report.build_expense_breakdown_report(actor_key=actor,owner_name=owner.title(),
        persons=routing.get_user_config(actor).expense_persons,month=month,worksheets=source)


def calendar_bill_cents(household, actor, name):
    result = financial_report(household,actor)
    return sum(round(e.amount*100) for e in result.calendar_events if e.kind=='bill' and e.label==name)


def overview_totals(household, actor):
    payload = report.expense_breakdown_client_payload(financial_report(household,actor))
    return {mode:round(value['metrics']['totalExpenses']*100) for mode,value in payload['modeViews'].items()}


def bill_views(household, actor):
    return shared_bills.enrich_listing(actor, bill_settings.listing(actor), store=household.catalog)['bills']


def transaction_rows(actor, month):
    return transactions.listing(actor, {'month':month,'view':'daily','fresh':'1'})['items']


def original_rows(actor):
    # Include the payer's original queued November bills: advancing the clock
    # legitimately makes those saved autopay dates actual, without new entries.
    return [(r['id'],r['date'],r['amountCents'],r.get('displayAmountCents'))
        for r in transactions.load_transactions(actor,'2026-11',fresh=True,include_scheduled=True)
        if r['title'] in {'Rent','Water','PG&E','Recology'}]


def november_history(household):
    return deepcopy(([household.books[owner+'-2026'].worksheet('November').rows for owner in ('brian','hannah','shared')],
        household.books['shared-2026'].worksheet('_BookieBot Action Log - 2026-11').rows,
        [household.ledger.get_allocation(identity) for identity in household.november_ids]))


@pytest.mark.parametrize('name,period,method,basis,expected', [
    ('Water','2026-12','equal',5000,(6173,6172)),
    ('PG&E','2026-12','custom',6000,(7407,4938)),
    ('Recology','2027-02','income',6473,(7991,4354)),
])
def test_accepted_utility_new_invoice_and_split_updates_both_owners_without_rewriting_history(household, name, period, method, basis, expected):
    before = november_history(household)
    november_rows = {actor: original_rows(actor) for actor in (BRIAN,HANNAH)}
    accept_utilities(household)
    assert len(bill_views(household,HANNAH)) == 4
    configure(household,name,method,basis,'2026-12')
    household.clock[0] = datetime.fromisoformat(period+'-01T12:00:00').replace(tzinfo=PACIFIC_TZ)
    if period.startswith('2027'):
        source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
        assert bill_settings.carry_year(BRIAN,source,household.commands)
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name == name)
    body = {'operation':'amount','id':plan.id,'month':period,'amount':'123.45','settingsVersion':source.settings.version,
        'chargeVersion':source.charge(plan,period)['version']}
    checked = bill_settings.review(BRIAN,body)
    assert (checked['share']['payerCents'],checked['share']['partnerCents']) == expected
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    saved = household.commands.command(BRIAN,command)
    assert saved['success'] and not saved.get('splitPending'), saved
    assert household.commands.command(BRIAN,command) == saved
    allocations = [a for a in household.ledger.snapshot('brian')['allocations'] if a['sourceSheetTitle']==calendar.month_name[int(period[5:])]
        and a['sourceYear']==int(period[:4]) and a['billPlanId']==plan.id]
    assert len(allocations) == 1
    value = allocations[0]
    shared = next(b for b in bill_views(household,HANNAH) if b['name']==name)
    assert shared['sharing']['state']['memberShareCents'] == expected[1]
    assert shared['sharing']['state']['remainingCents'] == expected[1]
    assert calendar_bill_cents(household,HANNAH,name) == expected[1]
    assert calendar_bill_cents(household,BRIAN,name) == 12345
    original_totals = {actor:overview_totals(household,actor) for actor in (BRIAN,HANNAH)}
    assert not [r for r in transaction_rows(BRIAN,period) if r['title']==name], 'The payer still waits for autopay'
    queued = next(r for r in transactions.load_transactions(BRIAN,period,fresh=True,include_scheduled=True) if r['title']==name)
    # A real partial repayment should replace the disclosure with one cash row.
    receive = {**payment(value,1000),'date':period+'-01'}
    result = service.command('brian',receive)
    assert not result['projectionPending']
    rows = [r for r in transaction_rows(HANNAH,period) if r['title']==name]
    assert len(rows) == 1, 'A partial reimbursement must not duplicate its transaction with another purchase context'
    assert rows[0]['date'] == period+'-01' and rows[0].get('displayAmountCents',rows[0]['amountCents']) == 1000
    if period=='2026-12':
        all_rows = transactions.load_transactions(HANNAH,'all',fresh=True)
        assert len([r for r in all_rows if r['month']==period and r['title']==name])==1
        assert len([r for r in all_rows if r['month']=='2026-11' and r['title']==name])==1
    assert calendar_bill_cents(household,HANNAH,name) == expected[1], 'Cash plus the unpaid projected remainder must equal one share'
    assert calendar_bill_cents(household,BRIAN,name) == 11345
    hannah_totals = overview_totals(household,HANNAH)
    assert hannah_totals['current']==original_totals[HANNAH]['current']+1000
    assert hannah_totals['projected']==original_totals[HANNAH]['projected']
    assert overview_totals(household,BRIAN)['projected']==original_totals[BRIAN]['projected']-1000
    if name=='Water' and (target := os.getenv('BOOKIEBOT_SHARED_BILL_BROWSER_FIXTURE')):
        Path(target).write_text(json.dumps({'report':report.expense_breakdown_client_payload(financial_report(household,HANNAH)),
            'transactions':transactions.listing(HANNAH,{'month':period,'view':'daily','scope':'spending','fresh':'1'}),
            'bills':{**bill_settings.listing(HANNAH),'bills':bill_views(household,HANNAH)},
            'rowId':rows[0]['id'],'remainingCents':expected[1]-1000}))
    # A later recurring rule does not rewrite the confirmed invoice's split.
    following = f'{int(period[:4])+(period[5:] == "12"):04d}-{int(period[5:])%12+1:02d}'
    configure(household,name,'custom',7000,following)
    current = household.ledger.get_allocation(value['id'])
    assert (current['payerShareCents'],current['partnerShareCents']) == expected
    for actor in (BRIAN,HANNAH):
        view = next(b for b in bill_views(household,actor) if b['name']==name)
        assert view['nextChange']['splitMethod'] == 'custom' and view['nextChange']['payerBasisPoints'] == 7000
    rest = {**payment(current,expected[1]-1000),'date':period+'-01'}
    settled = service.command('brian',rest)
    assert not settled['projectionPending']
    event_count = len(household.ledger.snapshot('brian')['events'])
    service.command('brian',rest)
    assert len(household.ledger.snapshot('brian')['events']) == event_count
    rows = [r for r in transaction_rows(HANNAH,period) if r['title']==name]
    assert len(rows)==1 and rows[0]['amountCents']==expected[1] and rows[0]['date']==period+'-01'
    assert calendar_bill_cents(household,HANNAH,name) == expected[1]
    assert overview_totals(household,HANNAH)['current']==original_totals[HANNAH]['current']+expected[1]
    assert overview_totals(household,HANNAH)['projected']==original_totals[HANNAH]['projected']
    household.clock[0] = household.clock[0].replace(day=plan.pull_day)
    rows = [r for r in transaction_rows(BRIAN,period) if r['title']==name]
    assert len(rows)==1 and rows[0]['id']==queued['id'], 'Autopay reveals the original entry rather than posting another one'
    assert rows[0]['date']==f'{period}-{plan.pull_day:02d}' and rows[0]['displayAmountCents']==expected[0]
    assert len([r for r in transaction_rows(HANNAH,period) if r['title']==name])==1
    # Actually bill the following cycle using the changed rule; do not rely
    # only on the future settings JSON displaying the new percentage.
    previous_invoice = household.ledger.get_allocation(value['id'])
    future = next(p for p in bill_settings.read_workbook(BRIAN,household.clock[0].date()).settings.plans
        if p.id==plan.id and p.effective_from==following)
    due = future.next_date(datetime.fromisoformat(following+'-01').date())
    assert due is not None
    household.clock[0] = datetime(due.year,due.month,1,12,tzinfo=PACIFIC_TZ)
    if int(period[:4])!=due.year:
        assert bill_settings.carry_year(BRIAN,bill_settings.read_workbook(BRIAN,household.clock[0].date()),household.commands)
    next_period = f'{due.year:04d}-{due.month:02d}'
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    body = {'operation':'amount','id':plan.id,'month':next_period,'amount':'200.00','settingsVersion':source.settings.version,
        'chargeVersion':source.charge(next(p for p in source.settings.records() if p.id==plan.id),next_period)['version']}
    checked = bill_settings.review(BRIAN,body)
    assert (checked['share']['payerCents'],checked['share']['partnerCents'])==(14000,6000)
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    assert household.commands.command(BRIAN,command)['success']
    assert household.commands.command(BRIAN,command)['success']
    assert calendar_bill_cents(household,HANNAH,name)==6000
    member_view = next(b for b in bill_views(household,HANNAH) if b['name']==name)
    assert member_view['sharing']['state']['memberShareCents']==6000
    assert household.ledger.get_allocation(value['id'])==previous_invoice
    assert november_history(household) == before
    for actor in (BRIAN,HANNAH):
        assert original_rows(actor) == november_rows[actor]
    assert all(r['date']=='2026-11-01' for r in transaction_rows(HANNAH,'2026-11')
        if r['title'] in {'Rent','Water','PG&E','Recology'})


def test_recurring_rent_amount_and_split_retain_recorded_november_and_post_once_in_december(household):
    before = november_history(household)
    rows_before = {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}
    accept_utilities(household)
    configure(household,'Rent','custom',6000,'2026-11',amount='3200.00')
    member = next(b for b in bill_views(household,HANNAH) if b['name']=='Rent')
    assert member['amountCents']==128000, 'The recurring price is separate from the recorded November share'
    assert member['sharing']['state']['memberShareCents']==100000
    assert member['sharing']['state']['receivedCents']==100000
    household.clock[0] = household.clock[0].replace(month=12,day=1)
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name=='Rent')
    body = {'operation':'scheduled','id':plan.id,'month':'2026-12','settingsVersion':source.settings.version,
        'chargeVersion':source.charge(plan,'2026-12')['version']}
    checked = bill_settings.review(BRIAN,body)
    assert (checked['share']['payerCents'],checked['share']['partnerCents'])==(192000,128000)
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    result = household.commands.command(BRIAN,command)
    assert result['success'] and not result.get('splitPending'), result
    assert household.commands.command(BRIAN,command)==result
    rows = [r for r in transaction_rows(BRIAN,'2026-12') if r['title']=='Rent']
    assert len(rows)==1 and rows[0]['amountCents']==320000
    value = next(a for a in household.ledger.snapshot('brian')['allocations'] if a['sourceSheetTitle']=='December' and a['item']=='Rent')
    received = service.command('brian',{**payment(value,128000),'date':'2026-12-01'})
    assert not received['projectionPending']
    assert [r['displayAmountCents'] for r in transaction_rows(BRIAN,'2026-12') if r['title']=='Rent']==[192000]
    assert [r['amountCents'] for r in transaction_rows(HANNAH,'2026-12') if r['title']=='Rent']==[128000]
    # Recurring configuration may add protected charge metadata; the original
    # source cells, canonical allocations/receipts and transactions stay intact.
    assert november_history(household)==before
    assert {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}==rows_before


@pytest.mark.asyncio
async def test_two_authenticated_apps_observe_acceptance_rules_and_invoices_through_shared_cursors(household,monkeypatch):
    from bookiebot.reports.bill_checkin import BillCheckinStore
    import bookiebot.reports.bill_checkin as checkin
    monkeypatch.setattr('bookiebot.reports.bill_cancellation.bank_refs',lambda _owner:set())
    preferences = BillCheckinStore(household.catalog.access)
    monkeypatch.setattr(checkin,'build_store',lambda:preferences)
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL','http://127.0.0.1')
    monkeypatch.setattr(phone_app,'build_app_access_store',lambda:household.catalog.access)
    monkeypatch.setattr(bill_settings,'build_commands',lambda:household.commands)
    app = web.Application(); phone_bills.register_phone_bill_routes(app); phone_shared_bills.register_shared_bill_routes(app)
    app.router.add_post('/app/connect',phone_app._connect_phone)
    headers = {'X-BookieBot-App':'1','Origin':'http://127.0.0.1'}
    async with TestServer(app) as server, TestClient(server,cookie_jar=CookieJar(unsafe=True)) as brian, TestClient(server,cookie_jar=CookieJar(unsafe=True)) as hannah:
        for http,actor,owner in ((brian,BRIAN,'brian'),(hannah,HANNAH,'hannah')):
            response = await http.post('/app/connect',json={'token':household.catalog.access.issue_pairing(actor,owner)},headers=headers)
            assert response.status==200
        async def get(http,path):
            response = await http.get(path); assert response.status==200,await response.text(); return await response.json()
        async def post(http,path,body):
            response = await http.post(path,json=body,headers=headers); assert response.status==200,await response.text(); return await response.json()
        original = november_history(household)
        cursors = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        invitations = [b for b in (await get(hannah,'/app/bills'))['bills'] if b['sharing']['status']=='pending']
        assert len(invitations)==3
        for bill in invitations:
            body = {'action':'accept','shareId':bill['sharing']['id']}
            reviewed = (await post(hannah,'/app/bills/sharing/review',body))['review']
            command = {**body,'reviewVersion':reviewed['reviewVersion'],'requestId':uuid4().hex}
            result = await post(hannah,'/app/bills/sharing',command)
            assert result['status']=='active'
            assert await post(hannah,'/app/bills/sharing',command)==result
        for http,before in zip((brian,hannah),cursors):
            after = await get(http,'/app/account/changes')
            assert after['revision']==before['revision']+3
            assert after['ledgerVersion']==before['ledgerVersion']
        before_rule = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        body = configuration_body(household,'PG&E','custom',6000,'2026-12')
        reviewed = (await post(brian,'/app/bills/review',body))['review']
        assert [await get(http,'/app/account/changes') for http in (brian,hannah)]==before_rule
        command = {**body,'reviewVersion':reviewed['reviewVersion'],'requestId':uuid4().hex}
        assert (await post(brian,'/app/bills',command))['success']
        for http,before in zip((brian,hannah),before_rule):
            after = await get(http,'/app/account/changes')
            assert after['revision']>before['revision'] and after['ledgerVersion']==before['ledgerVersion']
            value = next(b for b in (await get(http,'/app/bills'))['bills'] if b['name']=='PG&E')
            assert value['nextChange']['payerBasisPoints']==6000
        household.clock[0] = household.clock[0].replace(month=12,day=1)
        before_invoice = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
        plan = next(p for p in source.settings.records() if p.name=='PG&E')
        body = {'operation':'amount','id':plan.id,'month':'2026-12','amount':'123.45',
            'settingsVersion':source.settings.version,'chargeVersion':source.charge(plan,'2026-12')['version']}
        reviewed = (await post(brian,'/app/bills/review',body))['review']
        command = {**body,'reviewVersion':reviewed['reviewVersion'],'requestId':uuid4().hex}
        assert (await post(brian,'/app/bills',command))['success']
        for http,before in zip((brian,hannah),before_invoice):
            after = await get(http,'/app/account/changes')
            assert after['revision']>before['revision'] and after['ledgerVersion']!=before['ledgerVersion']
        assert len((await get(hannah,'/app/bills'))['bills'])==4
        value = next(b for b in (await get(hannah,'/app/bills'))['bills'] if b['name']=='PG&E')
        assert value['sharing']['state']['purchaseTotalCents']==12345
        assert value['sharing']['state']['memberShareCents']==4938
        assert value['readOnly'] and not value['charge']['canConfirmAmount']
        before_receipt = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        allocation = next(a for a in household.ledger.snapshot('brian')['allocations']
            if a['sourceSheetTitle']=='December' and a['item']=='PG&E')
        service.command('brian',{**payment(allocation,1000),'date':'2026-12-01'})
        for http,before in zip((brian,hannah),before_receipt):
            after = await get(http,'/app/account/changes')
            assert after['revision']==before['revision'] and after['ledgerVersion']!=before['ledgerVersion'], 'Background canonical changes invalidate both apps without a membership write'
        value = next(b for b in (await get(hannah,'/app/bills'))['bills'] if b['name']=='PG&E')
        assert value['sharing']['state']['receivedCents']==1000 and value['sharing']['state']['remainingCents']==3938
        before_date = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        body = configuration_body(household,'PG&E','custom',6000,'2027-01',pull_day=29)
        reviewed = (await post(brian,'/app/bills/review',body))['review']
        assert (await post(brian,'/app/bills',{**body,'reviewVersion':reviewed['reviewVersion'],'requestId':uuid4().hex}))['success']
        for http,before in zip((brian,hannah),before_date):
            after = await get(http,'/app/account/changes')
            assert after['revision']>before['revision'] and after['ledgerVersion']==before['ledgerVersion']
            value = next(b for b in (await get(http,'/app/bills'))['bills'] if b['name']=='PG&E')
            assert value['nextChange']['pullDay']==29 and value['charge']['date']=='2026-12-22'
        before_stop = [await get(http,'/app/account/changes') for http in (brian,hannah)]
        source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
        plan = next(p for p in source.settings.records() if p.name=='PG&E')
        body = {'operation':'end','id':plan.id,'version':plan.version,'settingsVersion':source.settings.version,
            'effectiveFrom':'2027-01','removeMonths':[]}
        reviewed = (await post(brian,'/app/bills/review',body))['review']
        assert (await post(brian,'/app/bills',{**body,'reviewVersion':reviewed['reviewVersion'],'requestId':uuid4().hex}))['success']
        for http,before in zip((brian,hannah),before_stop):
            after = await get(http,'/app/account/changes')
            assert after['revision']>before['revision'] and after['ledgerVersion']==before['ledgerVersion']
            value = next(b for b in (await get(http,'/app/bills'))['bills'] if b['name']=='PG&E')
            assert not value['nextChange']['active'] and value['charge']['date']=='2026-12-22'
        assert household.ledger.get_allocation(allocation['id'])['settledCents']==1000
        assert november_history(household)==original


@pytest.mark.parametrize('name,period', [('Rent','2026-12'),('Water','2026-12'),('Recology','2027-02')])
def test_shared_payment_date_changes_update_future_bills_but_keep_recorded_dates_and_receipts(household, name, period):
    accept_utilities(household)
    original = november_history(household)
    original_transactions = {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}
    old_date = next(b for b in bill_views(household,BRIAN) if b['name']==name)['charge']['date']
    configure(household,name,'equal',5000,'2026-12',pull_day=27)
    for actor in (BRIAN,HANNAH):
        value = next(b for b in bill_views(household,actor) if b['name']==name)
        assert value['nextChange']['pullDay']==27
        assert value['charge']['date']==old_date
    household.clock[0] = datetime.fromisoformat(period+'-01T12:00:00').replace(tzinfo=PACIFIC_TZ)
    if period.startswith('2027'):
        assert bill_settings.carry_year(BRIAN,bill_settings.read_workbook(BRIAN,household.clock[0].date()),household.commands)
    future = next(f for f in shared_bill_forecast.forecast_inputs(HANNAH,[period]) if f.name==name)
    assert future.date==period+'-27'
    # An eligible, unrecorded current cycle can still move to a new date.
    configure(household,name,'equal',5000,period,pull_day=29)
    day = min(29,calendar.monthrange(int(period[:4]),int(period[5:]))[1])
    withdrawal = f'{period}-{day:02d}'
    for actor in (BRIAN,HANNAH):
        value = next(b for b in bill_views(household,actor) if b['name']==name)
        assert value['charge']['date']==withdrawal
    assert next(f for f in shared_bill_forecast.forecast_inputs(HANNAH,[period]) if f.name==name).date==withdrawal
    if name=='Rent':
        # Fixed schedules create the canonical split when autopay is due;
        # variable invoices may be confirmed earlier in the same month.
        household.clock[0] = household.clock[0].replace(day=29)
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name==name)
    body = {'operation':'scheduled' if name=='Rent' else 'amount','id':plan.id,'month':period,
        'settingsVersion':source.settings.version,'chargeVersion':source.charge(plan,period)['version'],
        **({} if name=='Rent' else {'amount':'123.45'})}
    checked = bill_settings.review(BRIAN,body)
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    saved = household.commands.command(BRIAN,command)
    assert saved['success'] and household.commands.command(BRIAN,command)==saved
    allocation = next(a for a in household.ledger.snapshot('brian')['allocations']
        if a['sourceYear']==int(period[:4]) and a['sourceSheetTitle']==calendar.month_name[int(period[5:])]
        and a.get('billPlanId')==plan.id)
    # A second schedule correction cannot move the already confirmed invoice.
    configure(household,name,'equal',5000,period,pull_day=15)
    assert household.ledger.get_allocation(allocation['id'])==allocation
    for actor in (BRIAN,HANNAH):
        value = next(b for b in bill_views(household,actor) if b['name']==name)
        assert value['charge']['date']==withdrawal
        events = [e for e in financial_report(household,actor).calendar_events if e.kind=='bill' and e.label==name]
        assert events and all(e.day==day for e in events)
    if name!='Rent':
        assert not [r for r in transaction_rows(BRIAN,period) if r['title']==name]
    queued = next(r for r in transactions.load_transactions(BRIAN,period,fresh=True,include_scheduled=True) if r['title']==name)
    household.clock[0] = household.clock[0].replace(day=day)
    actual = [r for r in transaction_rows(BRIAN,period) if r['title']==name]
    assert len(actual)==1 and actual[0]['id']==queued['id'] and actual[0]['date']==withdrawal
    assert november_history(household)==original
    assert {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}==original_transactions


@pytest.mark.parametrize('name', ['Rent','Water','PG&E','Recology'])
def test_stopping_shared_bill_keeps_shared_history_and_removes_only_future_forecasts(household, monkeypatch, name):
    from bookiebot.reports import bill_cancellation
    monkeypatch.setattr(bill_cancellation,'bank_refs',lambda _owner:set())
    accept_utilities(household)
    original = november_history(household)
    original_transactions = {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}
    source = bill_settings.read_workbook(BRIAN,household.clock[0].date())
    plan = next(p for p in source.settings.records() if p.name==name)
    body = {'operation':'end','id':plan.id,'version':plan.version,'settingsVersion':source.settings.version,
        'effectiveFrom':'2026-11','removeMonths':[]}
    checked = bill_settings.review(BRIAN,body)
    november = next(item for item in checked['cancellation']['items'] if item['month']=='2026-11')
    assert not november['removable'] and 'Shared payment' in november['reason']
    with pytest.raises(ValueError,match='can no longer be removed'):
        bill_settings.review(BRIAN,{**body,'removeMonths':['2026-11']})
    command = {**body,'reviewVersion':checked['reviewVersion'],'requestId':uuid4().hex}
    saved = household.commands.command(BRIAN,command)
    assert saved['success'] and household.commands.command(BRIAN,command)==saved
    for actor in (BRIAN,HANNAH):
        value = next(b for b in bill_views(household,actor) if b['name']==name)
        assert not value['active']
        assert value['sharing']['status']=='active', 'Stopping a schedule does not revoke access to recorded repayments'
    shared = next(b for b in bill_views(household,HANNAH) if b['name']==name)
    allocation = next(a for a in original[2] if a['item']==name)
    assert shared['sharing']['state']['receivedCents']==allocation['settledCents']
    assert not [f for f in shared_bill_forecast.forecast_inputs(HANNAH,['2026-12','2027-02']) if f.name==name]
    household.clock[0] = datetime(2027,1,1,12,tzinfo=PACIFIC_TZ)
    assert bill_settings.carry_year(BRIAN,bill_settings.read_workbook(BRIAN,household.clock[0].date()),household.commands)
    for actor in (BRIAN,HANNAH):
        assert not next(b for b in bill_views(household,actor) if b['name']==name)['active']
        assert calendar_bill_cents(household,actor,name)==0
    assert not [f for f in shared_bill_forecast.forecast_inputs(HANNAH,['2027-02']) if f.name==name]
    assert november_history(household)==original
    assert {actor:original_rows(actor) for actor in (BRIAN,HANNAH)}==original_transactions
