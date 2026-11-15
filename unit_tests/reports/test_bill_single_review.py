"""Single-review scope is explicit, stale-safe, and read-only until Confirm."""
from copy import deepcopy
from unittest.mock import Mock
import pytest

from bookiebot.reports import bill_settings as bills
from bookiebot.sheets.recurring import BillConflict, BillValidation
from unit_tests.reports.test_bill_settings import saved as saved, access as access
from unit_tests.sheets.test_recurring_storage import B, TODAY, update


def occurrence(saved, monkeypatch, **changes):
    monkeypatch.setattr("bookiebot.reimbursements.service.enabled", lambda: True)
    row = {"id":"2026-11:source", "month":"2026-11", "version":"current-v1", "date":"2026-11-12",
           "billPlanId":saved.loan.id, "title":saved.loan.name, "amountCents":6023, "split":"",
           "splitOptions":{"payerCents":6023}, "capabilities":{"update":True,"split":True,"cancel_split":True}, "reasons":{}}
    row.update(changes)
    monkeypatch.setattr(bills, "charge_transaction", lambda *args: {"item":deepcopy(row)})
    return row


def request(saved, **changes):
    source = bills.read_workbook(B,TODAY)
    body = update(source,saved.loan)
    body["bill"].update(effectiveFrom="2026-11", **changes)
    return {**body,"applyCurrentCharge":False}


def test_type_only_review_has_no_current_charge_detour_and_does_not_write(saved,monkeypatch):
    occurrence(saved,monkeypatch)
    checked = bills.review(B,request(saved,type="subscription",amount="60.23",category="static_bills_subscriptions_needs"))
    assert checked["before"]["type"] == "fixed" and checked["after"]["type"] == "subscription"
    assert checked["currentChange"] is None
    assert not saved.client.http_client.sent


def test_combined_current_amount_and_split_are_reviewed_before_any_write(saved,monkeypatch):
    row = occurrence(saved,monkeypatch)
    body = request(saved,amount="90",splitMethod="equal")
    checked = bills.review(B,body)
    current = checked["currentChange"]
    assert current["source"] == row
    assert current["amountChanged"] and current["splitChanged"]
    assert current["target"]["amountCents"] == 9000
    assert current["target"]["payerCents"] == current["target"]["partnerCents"] == 4500
    assert checked["applyCurrentCharge"] is False
    opted = bills.review(B,{**body,"applyCurrentCharge":True})
    assert opted["reviewVersion"] != checked["reviewVersion"]
    assert not saved.client.http_client.sent
    command = {**body,"applyCurrentCharge":True,"reviewVersion":opted["reviewVersion"],"requestId":"single-review-current-123456"}
    result = saved.commands.command(B,command)
    assert result["success"] and result["currentChange"] == opted["currentChange"]
    assert saved.client.http_client.rows["November"][0][2] == "60.23", "The optional canonical charge edit is separately claimed"
    assert saved.commands.command(B,command) == result
    assert len(saved.client.http_client.sent)==1


def test_current_choice_cannot_be_added_after_review_or_use_a_stale_charge(saved,monkeypatch):
    row = occurrence(saved,monkeypatch)
    body = request(saved,amount="90")
    checked = bills.review(B,body)
    result = saved.commands.command(B,{**body,"applyCurrentCharge":True,"reviewVersion":checked["reviewVersion"],"requestId":"changed-current-choice-123456"})
    assert not result["success"] and not saved.client.http_client.sent
    body["applyCurrentCharge"]=True
    checked = bills.review(B,body)
    row["version"]="changed-elsewhere"
    result = saved.commands.command(B,{**body,"reviewVersion":checked["reviewVersion"],"requestId":"stale-current-source-123456"})
    assert not result["success"] and not saved.client.http_client.sent


def test_protected_current_charge_does_not_block_future_configuration(saved,monkeypatch):
    occurrence(saved,monkeypatch,capabilities={"update":False,"split":False},reasons={"update":"Received repayments need correction first."})
    body = request(saved,amount="90")
    checked = bills.review(B,body)
    assert "repayments" in checked["currentChange"]["blockedReason"]
    with pytest.raises(BillValidation,match="repayments"):
        bills.review(B,{**body,"applyCurrentCharge":True})
    assert not saved.client.http_client.sent


def test_future_scope_never_inspects_or_offers_current_charge(saved,monkeypatch):
    reader=Mock(side_effect=AssertionError("Future-only changes do not need a current editor"))
    monkeypatch.setattr(bills,"charge_transaction",reader)
    body=request(saved,amount="90");body["bill"]["effectiveFrom"]="2026-12"
    assert bills.review(B,body)["currentChange"] is None
    reader.assert_not_called()


def test_current_only_combined_review_keeps_exact_custom_cents_and_rejects_stale_or_foreign(saved,monkeypatch):
    occurrence(saved,monkeypatch)
    body={"operation":"current","id":saved.loan.id,"month":"2026-11","version":"current-v1","amountCents":20125,"method":"custom","payerShareCents":12345}
    checked=bills.review(B,body)
    assert checked["currentChange"]["target"]["partnerCents"]==7780
    assert checked["currentChange"]["target"]["payerCents"]==12345
    for patch in ({"version":"stale"},{"id":"foreign-bill"},{"month":"2026-10"},{"payerShareCents":20126}):
        with pytest.raises((BillConflict,BillValidation)):
            bills.review(B,{**body,**patch})
    assert not saved.client.http_client.sent


@pytest.mark.parametrize("value",["yes",1,None,{}])
def test_current_choice_requires_an_actual_boolean(saved,value):
    with pytest.raises(BillValidation,match="whether"):
        bills.review(B,{**request(saved),"applyCurrentCharge":value})
    assert not saved.client.http_client.sent


def test_configuration_keeps_the_actual_current_transaction_identity_and_version(saved,monkeypatch):
    from unit_tests.reports.test_bill_inclusive_start import rent_fixture, transactions, body_for
    plan=rent_fixture(saved)
    transactions(saved,monkeypatch)
    source=bills.read_workbook(B,TODAY)
    body={**body_for(source,plan),"applyCurrentCharge":True}
    checked=bills.review(B,body)
    before=checked["currentChange"]["source"]
    result=saved.commands.command(B,{**body,"reviewVersion":checked["reviewVersion"],"requestId":"real-current-source-version-123456"})
    assert result["success"]
    after=bills.charge_transaction(B,plan.id,"2026-11")["item"]
    assert (after["id"],after["version"],after["amountCents"],after["date"]) == (before["id"],before["version"],before["amountCents"],before["date"])


def test_virtual_type_conversion_preserves_original_until_confirmed_current_adoption(saved,monkeypatch):
    from dataclasses import replace
    from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB
    from bookiebot.sheets.recurring_rows import encode
    from unit_tests.reports.test_bill_inclusive_start import body_for, transactions
    plan=replace(saved.loan,id='virtual_conversion',kind='subscription',name='Service',source_label='Service',
        source_tab=SUBSCRIPTION_TAB,amount_cents=1000,pull_day=1,monthly_source=False,request_id='baseline')
    t=saved.client.http_client
    t.rows[BILL_TAB]=t.formulas[BILL_TAB]=[]
    t.rows[SUBSCRIPTION_TAB]=t.formulas[SUBSCRIPTION_TAB]=encode([plan],SUBSCRIPTION_TAB,[])
    t.properties[SUBSCRIPTION_TAB]={'title':SUBSCRIPTION_TAB,'sheetId':99,'gridProperties':{'rowCount':100,'columnCount':32}}
    for title in ('November','December'):
        t.rows[title]=[['','Subscriptions (Needs)','10'],['','(Needs) Subtotal:','=SUM(C1:C1)']]
        t.formulas[title]=[['','Subscriptions (Needs)','=SUM(Subscriptions!C2)'],['','(Needs) Subtotal:','=SUM(C1:C1)']]
    body={**body_for(bills.read_workbook(B,TODAY),plan,type='fixed',amount='20'),'applyCurrentCharge':True}
    checked=bills.review(B,body)
    assert checked['currentChange']['adopt'] and checked['currentChange']['source']['amountCents']==1000
    result=saved.commands.command(B,{**body,'reviewVersion':checked['reviewVersion'],'requestId':'virtual-type-conversion-123456'})
    assert result['success'] and result['currentChange']==checked['currentChange']
    source=bills.read_workbook(B,TODAY)
    current=next(p for p in source.settings.records() if p.id==plan.id)
    info=source.charge(current,'2026-11')
    assert current.kind=='fixed' and info['virtual'] and info['billAmountCents']==1000
    adopt=bills._amount_review(source,{'operation':'adopt','id':plan.id,'month':'2026-11',
        'settingsVersion':source.settings.version,'chargeVersion':info['version']},TODAY)
    assert adopt['amount']==1000
    batch,_=bills.charge_batch(source,adopt,'confirmed-original-adopt-123456');batch.send()
    rows=transactions(saved,monkeypatch)
    assert len(rows)==1 and rows[0]['billPlanId']==plan.id and rows[0]['amountCents']==1000 and rows[0]['date']=='2026-11-01'
