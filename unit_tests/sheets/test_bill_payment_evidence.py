from datetime import date

import pytest

from bookiebot.sheets.bill_payment_evidence import settled_bill_dates
from bookiebot.sheets.bills import bill_payment_state


def evidence(**changes):
    return {"id": "paid-bill", "payerOwner": "brian", "partnerOwner": "hannah",
            "sourceWorksheet": "income", "sourceYear": 2026, "sourceSheetTitle": "November",
            "expenseDate": "2026-11-01", "category": "pg&e", "item": "PG&E",
            "sourceValues": {"item": "PG&E"}, "partnerShareCents": 5000,
            "settledCents": 5000, "clearedCents": 0, "lifecycle": "active", **changes}


def event(**changes):
    return {"allocationId": "paid-bill", "amountCents": 5000,
            "status": "confirmed", "date": "2026-11-02", **changes}


@pytest.mark.parametrize("owner", ["brian", "hannah"])
def test_confirmed_bill_uses_its_original_date_for_both_people(owner):
    result = settled_bill_dates([evidence()], [event()], owner=owner, as_of=date(2026, 11, 13))
    assert result == {("2026-11", "pge"): date(2026, 11, 1)}
    state = bill_payment_state("PG&E", 2026, 11, [], as_of=date(2026, 11, 13),
                              recorded_on=result["2026-11", "pge"])
    assert state.paid and state.withdrawal_date == date(2026, 11, 1)


@pytest.mark.parametrize("change", [
    {"settledCents": 4900}, {"clearedCents": 1}, {"lifecycle": "cancelled"},
    {"sourceWorksheet": "expense"}, {"sourceSheetTitle": "October"},
    {"expenseDate": "2026-11-30"}, {"sourceYear": 2025}, {"partnerShareCents": 0},
])
def test_incomplete_future_or_unrelated_evidence_cannot_release_a_bill(change):
    assert not settled_bill_dates([evidence(**change)], [event()], owner="brian", as_of=date(2026, 11, 13))


@pytest.mark.parametrize("change", [{"status": "pending"}, {"status": "reversed"},
                                    {"amountCents": 4900}, {"date": "2026-11-30"}, {"date": "unknown"}])
def test_only_confirmed_effective_receipts_establish_settlement(change):
    assert not settled_bill_dates([evidence()], [event(**change)], owner="brian", as_of=date(2026, 11, 13))


def test_ambiguous_sources_do_not_infer_a_payment_date():
    assert not settled_bill_dates([evidence(), evidence(id="other-bill")],
        [event(), event(allocationId="other-bill")], owner="brian", as_of=date(2026, 11, 13))
    assert not settled_bill_dates([evidence()], [event()], owner="other", as_of=date(2026, 11, 13))


def test_recipient_qualified_source_does_not_match_another_personal_bill():
    result = settled_bill_dates([evidence(partnerSourceLabel="Brian · Student Loan")], [event()],
        owner="hannah", as_of=date(2026, 11, 13))
    assert result == {("2026-11", "brianstudentloan"): date(2026, 11, 1)}
