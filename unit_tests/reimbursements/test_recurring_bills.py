from copy import deepcopy
from types import SimpleNamespace
import pytest

from bookiebot.reimbursements import projection
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring_charges import CHARGES_TAB, decode_charges
from unit_tests.reimbursements.test_projection import personal_rent as personal_rent, allocation, event
from unit_tests.reimbursements.test_store import access as access, store as store, payload


def wanted_source(personal_rent):
    projector, books, brian, hannah, _ = personal_rent
    brian.write(12, 1, ["Xfinity", 77, 100])
    hannah.write(12, 1, ["Brian · Xfinity", 88, 0])
    value = allocation(id="xfinity-shared", sourceWorksheet="income", sourceSheetTitle="October", sourceSpreadsheetId="brian-2026",
        sourceYear=2026, sourceRow=13, category="Xfinity", item="Xfinity", expenseDate="2026-10-02", billPlanId="xfinity_plan_123",
        billCategory="subscriptions_wants", partnerSourceLabel="Brian · Xfinity", sourceColumnMap={"item": 2, "amount": 4},
        sourceValues={"item": "Xfinity", "amount": "100"}, grossCents=10000, payerShareCents=6000, partnerShareCents=4000,
        settledCents=4000, sourceActionId="source-xfinity", events=[event("xfinity-payment", 4000, date="2026-10-03")])
    return projector, books, brian, hannah, value


def test_wants_bill_settlement_changes_only_d_and_preserves_each_owners_needs(personal_rent):
    projector, books, brian, hannah, value = wanted_source(personal_rent)
    projector.project(value)
    assert brian.read(12, 1, 4) == ["Xfinity", 77, 60]
    assert hannah.read(12, 1, 4) == ["Brian · Xfinity", 88, 40]
    projector.project(value)
    assert hannah.read(12, 1, 4) == ["Brian · Xfinity", 88, 40]
    assert not books["shared-2026"].batch_calls


def test_new_recipient_source_is_provisioned_once_from_canonical_plan_lineage(personal_rent, monkeypatch):
    projector, books, brian, hannah, value = wanted_source(personal_rent)
    hannah.write(12, 1, ["Own Student Loan", 88, 0])
    hannah.write(13, 1, ["(Needs) Subtotal:", "=SUM(C13:C13)", ""])
    hannah.write(14, 1, ["(Wants) Subtotal:", "", "=SUM(D13:D13)"])
    class Transport:
        def fetch_sheet_metadata(self, key):
            book = books[key]
            return {"sheets": [{"properties": {"title": s.title, "sheetId": s.id, "gridProperties": {"rowCount": 1000, "columnCount": 40}}} for s in book.sheets.values()], "namedRanges": list(book.names.values())}
        def values_batch_get(self, key, ranges, params):
            return {"valueRanges": [{"range": r + "!A1:AN1000", "values": books[key].worksheet(r.strip("'")).get_all_values()} for r in ranges]}
        def batch_update(self, key, body):
            return books[key].batch_update(body)
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    monkeypatch.setattr(storage, "get_budget_spreadsheet_id_for_user", projection.get_budget_spreadsheet_id_for_user)
    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: SimpleNamespace(http_client=Transport()))
    projector.project(value)
    rows = hannah.get_all_values()
    receipt = next(r for r in rows if len(r) > 1 and r[1] == "Brian · Xfinity")
    assert receipt[3] == 40
    assert hannah.read(12, 1, 4) == ["Own Student Loan", 88, 0]
    charges = decode_charges([[str(c) for c in r] for r in books["hannah-2026"].worksheet(CHARGES_TAB).get_all_values()])
    assert len(charges) == 1 and charges[0].plan_id == value["billPlanId"]
    assert "SUM(D17)" in str(hannah.get_all_values()[14][3])
    projector.project(value)
    assert sum(len(r) > 1 and r[1] == "Brian · Xfinity" for r in hannah.get_all_values()) == 1


def test_canonical_bill_metadata_survives_storage_and_requires_a_complete_identity(store):
    data = payload(sourceWorksheet="income", billPlanId="bill_plan_123", billCategory="subscriptions_wants", partnerSourceLabel="Brian · Xfinity")
    value = store.register_allocation(data)
    assert value["billPlanId"] == "bill_plan_123" and value["billCategory"] == "subscriptions_wants"
    assert store.get_allocation(value["id"])["partnerSourceLabel"] == "Brian · Xfinity"
    from bookiebot.reimbursements.store import ReimbursementValidationError
    for changes in ({"billPlanId": "="}, {"billCategory": "arbitrary"}, {"sourceWorksheet": "expense"}):
        with pytest.raises(ReimbursementValidationError):
            store.register_allocation({**payload(), **{k: v for k, v in data.items() if k in {"billPlanId", "billCategory", "partnerSourceLabel"}}, **changes})
