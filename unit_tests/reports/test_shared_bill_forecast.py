from dataclasses import asdict,replace
from datetime import date,datetime
from types import SimpleNamespace

import pytest

from unit_tests.reports.test_shared_bills import catalog,people,apply
from unit_tests.reports.test_accounts import store
from bookiebot.reports import shared_bill_forecast as forecasts, expense_breakdown as report
from bookiebot.sheets import recurring_storage
from bookiebot.sheets.recurring import BillPlan,BILL_TAB
from bookiebot.sheets.routing import PACIFIC_TZ
from bookiebot.reports.expense_breakdown import BudgetMonth,CalendarEvent,PaymentItem,ReportWorksheets
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet

HANNAH='830984827904851969'


def forecast(**changes):
    return replace(forecasts.SharedBillForecast('shared-rent','2026-11','Rent','rent','2026-11-01',100000,
        member_label='Rent'),**changes)


def test_forecast_subtracts_paid_or_queued_recipient_amounts_once():
    item=forecast()
    assert forecasts.remaining_forecast(item,[], 'Rent')==100000
    assert forecasts.remaining_forecast(item,[PaymentItem('Rent',700,'rent','paid')],'Rent')==30000
    assert forecasts.remaining_forecast(item,[PaymentItem('Rent',1000,'rent','queued')],'Rent')==0
    assert forecasts.remaining_forecast(item,[PaymentItem('Rent',1200,'rent','paid')],'Rent')==0
    # A same-name expense without verified bill lineage cannot fulfill it.
    assert forecasts.remaining_forecast(item,[PaymentItem('Rent',1000,'rent')],'')==100000


def test_shared_forecast_replaces_only_verified_estimate_and_keeps_actual_calendar_events():
    events=[CalendarEvent('bill','Rent',900,1,'rent',True,True),CalendarEvent('bill','Water',90,19,'bills_utilities',True,True)]
    result=report._with_shared_bill_forecasts(events,(forecast(),),BudgetMonth(2026,11),[],[])
    assert [(e.label,e.amount) for e in result]==[('Water',90),('Rent',1000)]
    paid=CalendarEvent('bill','Rent',700,1,'rent')
    result=report._with_shared_bill_forecasts([paid],(forecast(),),BudgetMonth(2026,11),[PaymentItem('Rent',700,'rent','paid')],[])
    assert result[0]==paid and result[1].amount==300 and result[1].projected_only
    # Adjacent-month known payments also fulfill the forecast when that month's
    # PaymentItem list is unavailable in the current report.
    assert report._with_shared_bill_forecasts([replace(paid,amount=1000)],(forecast(),),BudgetMonth(2026,11),[],[])==[replace(paid,amount=1000)]


def test_forecast_uses_payer_plan_original_canonical_cycle_and_gross_invoice_history(catalog,monkeypatch):
    apply(catalog,'invite');apply(catalog,'accept',revision=1)
    monkeypatch.setattr(forecasts,'build_store',lambda:catalog)
    monkeypatch.setattr(forecasts,'now_pacific',lambda:datetime(2026,11,15,tzinfo=PACIFIC_TZ))
    plan=BillPlan('rent-plan','variable','Rent',None,'monthly',22,(),'rent','','Rent',BILL_TAB,
        effective_from='2026-01',split_method='equal')
    allocations=[{'billPlanId':'rent-plan','payerOwner':'brian','partnerOwner':'hannah','sourceYear':2026,
        'sourceSheetTitle':month,'grossCents':total,'payerShareCents':total//2,'partnerShareCents':total//2,
        'partnerSourceLabel':'Rent'} for month,total in [('September',12000),('October',20000),('November',18000)]]
    source=SimpleNamespace(settings=SimpleNamespace(plans=[plan]),allocations=allocations,rows={})
    reads=[]
    def load(actor,today):reads.append(actor);return source
    monkeypatch.setattr(recurring_storage,'read_workbook',load)
    result=forecasts.forecast_inputs(HANNAH,['2026-11','2026-12'])
    assert len(reads)==1
    assert result[0].target_cents==9000 and result[0].prediction is None
    # Available past gross invoices, excluding November's incomplete cycle:
    # ($120 + $200)/2 * 50% = $80, even if net payer source cells are zero.
    assert result[1].target_cents==8000 and result[1].prediction['sampleCount']==2
    assert result[1].prediction['basis']=='shared_bill_invoice'
    assert result[1].prediction['amountCents']==8000
    apply(catalog,'stop',revision=2)
    assert forecasts.forecast_inputs(HANNAH,['2026-12'])==()


def test_current_report_stays_actual_and_projected_includes_only_unpaid_share(monkeypatch):
    from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
    monkeypatch.setattr(report,'now_pacific',lambda:datetime(2026,11,15,tzinfo=PACIFIC_TZ))
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED','false')
    personal=InMemoryWorksheet([
        ['', 'Income','',''],['','Date','Source','Amount'],['','11/1/2026','Paycheck','3000'],
        ['', 'Rent','700'],['','Bills & Utilities','0'],['','Total Needs','700'],['','Total Wants','0'],
    ],title='November')
    ws=ReportWorksheets(shared_expenses=InMemoryWorksheet([],title='Expenses'),personal_budget=personal,
        bill_schedule=InMemoryWorksheet([BILL_SCHEDULE_HEADERS,['rent','Rent','monthly','1','','Rent','','','','']],title='Schedule'),
        shared_bill_forecasts=(forecast(),))
    baseline=report.build_expense_breakdown_report(actor_key=HANNAH,owner_name='Hannah',persons=['Hannah'],month=BudgetMonth(2026,11),worksheets=replace(ws,shared_bill_forecasts=()))
    actual=report.build_expense_breakdown_report(actor_key=HANNAH,owner_name='Hannah',persons=['Hannah'],month=BudgetMonth(2026,11),worksheets=ws)
    assert actual.grand_total==baseline.grand_total
    assert actual.grand_total==700 and actual.payments[0].status=='paid'
    # Build from the same immutable source; no forecast becomes a real payment.
    assert actual.payments==baseline.payments and actual.entries==baseline.entries
    assert actual.budget_breakdown['rent']['amount']-baseline.budget_breakdown['rent']['amount']==pytest.approx(300)
    assert next(e for e in actual.calendar_events if e.shared_forecast).amount==300
    payload=report.expense_breakdown_client_payload(actual)
    assert payload['modeViews']['current']['metrics']['totalExpenses']==700
    assert payload['modeViews']['projected']['metrics']['totalExpenses']==1000


@pytest.mark.parametrize('cancelled',[False,True])
def test_cleared_or_cancelled_cycle_does_not_reappear_in_recipient_forecast(catalog,monkeypatch,cancelled):
    apply(catalog,'invite');apply(catalog,'accept',revision=1)
    monkeypatch.setattr(forecasts,'build_store',lambda:catalog)
    monkeypatch.setattr(forecasts,'now_pacific',lambda:datetime(2026,11,15,tzinfo=PACIFIC_TZ))
    plan=BillPlan('rent-plan','fixed','Rent',20000,'monthly',22,(),'rent','','Rent',BILL_TAB,
        effective_from='2026-01',split_method='equal')
    allocation={'billPlanId':'rent-plan','payerOwner':'brian','partnerOwner':'hannah','sourceYear':2026,
        'sourceSheetTitle':'November','grossCents':20000,'payerShareCents':10000,'partnerShareCents':10000,
        'settledCents':2000 if not cancelled else 0,'outstandingCents':0,'clearedCents':8000,
        'partnerSourceLabel':'Rent','lifecycle':'void' if cancelled else 'active'}
    source=SimpleNamespace(settings=SimpleNamespace(plans=[plan]),allocations=[allocation],rows={})
    monkeypatch.setattr(recurring_storage,'read_workbook',lambda *_:source)
    current,future=forecasts.forecast_inputs(HANNAH,['2026-11','2026-12'])
    assert current.target_cents==(0 if cancelled else 2000)
    assert future.target_cents==10000, 'Ending this cycle’s split does not end the saved recurring rule'


def test_recorded_shared_cycle_retains_original_schedule_category_and_allocation(catalog,monkeypatch):
    import json
    from bookiebot.sheets.recurring_charges import BillCharge,CHARGES_TAB,encode_charges,source_anchor
    apply(catalog,'invite');apply(catalog,'accept',revision=1)
    monkeypatch.setattr(forecasts,'build_store',lambda:catalog)
    monkeypatch.setattr(forecasts,'now_pacific',lambda:datetime(2026,11,15,tzinfo=PACIFIC_TZ))
    original=BillPlan('rent-plan','fixed','Rent',20000,'monthly',22,(),'rent','','Rent',BILL_TAB,
        effective_from='2026-01',split_method='equal',version='original-v1')
    changed=replace(original,pull_day=28,category='bills_utilities',amount_cents=40000,split_method='none')
    charge=BillCharge(original.id,'2026-11','2026-11-01','Rent','rent',1,4,3,source_anchor(original.id,'2026-11'),
        20000,True,plan_snapshot=json.dumps(asdict(original)),payment_date='2026-11-22')
    allocation={'billPlanId':'rent-plan','payerOwner':'brian','partnerOwner':'hannah','sourceYear':2026,
        'sourceSheetTitle':'November','grossCents':20000,'payerShareCents':10000,'partnerShareCents':10000,
        'settledCents':2000,'outstandingCents':8000,'partnerSourceLabel':'Rent','billCategory':'rent'}
    source=SimpleNamespace(settings=SimpleNamespace(plans=[changed]),allocations=[allocation],rows={CHARGES_TAB:encode_charges([charge],[])})
    monkeypatch.setattr(recurring_storage,'read_workbook',lambda *_:source)
    result=forecasts.forecast_inputs(HANNAH,['2026-11','2026-12'])
    assert len(result)==1 and result[0].category=='rent' and result[0].date=='2026-11-22'
    assert result[0].target_cents==10000 and result[0].prediction is None


@pytest.mark.parametrize('day',[1,22])
def test_verified_member_display_name_fulfills_forecast_once_for_paid_or_queued_bill(monkeypatch,day):
    from bookiebot.sheets.recurring_rows import encode
    monkeypatch.setattr(report,'now_pacific',lambda:datetime(2026,11,15,tzinfo=PACIFIC_TZ))
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED','false')
    plan=BillPlan('member-rent','variable','Apartment',None,'monthly',day,(),'rent','','Rent',BILL_TAB,
        effective_from='2026-01',version='member-v1')
    personal=InMemoryWorksheet([
        ['', 'Income','',''],['','Date','Source','Amount'],['','11/1/2026','Paycheck','3000'],
        ['', 'Rent','700'],['','Bills & Utilities','0'],['','Total Needs','700'],['','Total Wants','0'],
    ],title='November')
    ws=ReportWorksheets(shared_expenses=InMemoryWorksheet([],title='Expenses'),personal_budget=personal,
        bill_schedule=InMemoryWorksheet(encode([plan],BILL_TAB,[]),title=BILL_TAB),
        shared_bill_forecasts=(forecast(member_plan_id=plan.id),))
    result=report.build_expense_breakdown_report(actor_key=HANNAH,owner_name='Hannah',persons=['Hannah'],
        month=BudgetMonth(2026,11),worksheets=ws)
    assert (result.payments or result.queued_bills)[0].label=='Apartment'
    assert next(e for e in result.calendar_events if e.shared_forecast).amount==300
    payload=report.expense_breakdown_client_payload(result)
    assert payload['modeViews']['current']['metrics']['totalExpenses']==(700 if day==1 else 0)
    assert payload['modeViews']['projected']['metrics']['totalExpenses']==1000


def test_renamed_verified_member_estimate_is_replaced_in_adjacent_context():
    from bookiebot.sheets.recurring_rows import encode
    plan=BillPlan('member-rent','variable','Apartment',None,'monthly',22,(),'rent','','Rent',BILL_TAB,
        effective_from='2026-01',version='member-v1')
    prediction=CalendarEvent('bill','Apartment',900,22,'rent',True,True)
    item=forecast(member_plan_id=plan.id)
    result=report._with_shared_bill_forecasts([prediction],(item,),BudgetMonth(2026,11),[],encode([plan],BILL_TAB,[]))
    assert len(result)==1 and result[0].shared_forecast and result[0].amount==1000
    actual=replace(prediction,amount=700,amount_estimated=False)
    result=report._with_shared_bill_forecasts([actual],(item,),BudgetMonth(2026,11),[],encode([plan],BILL_TAB,[]))
    assert result[0]==actual and result[1].shared_forecast and result[1].amount==300


def test_december_report_loads_shared_january_forecast_without_creating_worksheets(monkeypatch):
    monkeypatch.setattr(report,'now_pacific',lambda:datetime(2026,12,15,tzinfo=PACIFIC_TZ))
    source=ReportWorksheets(shared_expenses=InMemoryWorksheet([],title='Expenses'),personal_budget=InMemoryWorksheet([],title='December'))
    monkeypatch.setattr(report,'_load_report_worksheets',lambda *_:source)
    january=forecast(period='2027-01',date='2027-01-01');calls=[]
    def load(actor,periods):
        calls.append((actor,periods));return (january,) if '2027-01' in periods else ()
    monkeypatch.setattr(forecasts,'forecast_inputs',load)
    result=report.load_report_worksheets(HANNAH,BudgetMonth(2026,12))
    assert calls==[(HANNAH,['2026-12','2027-01'])]
    assert result.shared_bill_forecasts==(january,)
