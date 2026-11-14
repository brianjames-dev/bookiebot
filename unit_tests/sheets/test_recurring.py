from dataclasses import replace
from datetime import date

import pytest

from bookiebot.sheets.recurring import (
    BillConflict, BillPlan, BillValidation, BILL_TAB, FIRST_MONTH,
    normalize_plan, selected, split_cents, versioned,
)


def plan(**changes):
    return replace(BillPlan("loan", "fixed", "Student Loan", 6023, "monthly", 31, (),
                            "static_bills_subscriptions_needs", "Checking", "Student Loan", BILL_TAB), **changes)


def form(**changes):
    return {"name": "Student Loan", "type": "fixed", "amount": "60.23", "cadence": "monthly",
            "pullDay": 31, "pullMonths": [], "category": "static_bills_subscriptions_needs",
            "account": "Checking", "effectiveFrom": "2026-11", "splitMethod": "equal", **changes}


def test_end_sentinel_cannot_create_an_empty_price_interval():
    with pytest.raises(BillValidation, match="earlier starting month"):
        normalize_plan(form(effectiveFrom="9999-12"), current=None, today=date(2026, 11, 13), plan_id="new_plan_123")


def test_effective_versions_preserve_previous_months_and_replace_future():
    baseline = plan()
    december = replace(baseline, amount_cents=8000, effective_from="2026-12")
    versions = versioned([baseline], december, "december")
    assert selected(versions, "2026-10")[0].amount_cents == 6023
    assert selected(versions, "2026-11")[0].amount_cents == 6023
    assert selected(versions, "2026-12")[0].amount_cents == 8000
    november = replace(baseline, amount_cents=7000, effective_from="2026-11")
    versions = versioned(versions, november, "november")
    assert selected(versions, "2026-10")[0].effective_from == FIRST_MONTH
    assert selected(versions, "2027-01")[0].amount_cents == 7000
    assert selected(versions, "2026-11")[0].request_id == "november"


def test_stop_preserves_earlier_amount_and_retains_inactive_identity():
    versions = versioned([plan()], plan(active=False, effective_from="2026-12"), "stop")
    assert selected(versions, "2026-11")[0].amount_cents == 6023
    assert not selected(versions, "2026-12")
    stopped = selected(versions, "2026-12", include_inactive=True)[0]
    assert stopped.id == "loan" and not stopped.active
    assert stopped.due_date("2026-12") is None


def test_overlapping_versions_are_not_silently_deduplicated():
    with pytest.raises(BillConflict, match="overlapping"):
        selected([plan(), plan(amount_cents=9999)], "2026-11")


@pytest.mark.parametrize("period,expected", [("2026-02", "2026-02-28"), ("2028-02", "2028-02-29"), ("2026-04", "2026-04-30")])
def test_end_of_month_and_leap_years(period, expected):
    assert plan().due_date(period).isoformat() == expected


def test_quarterly_and_yearly_dates_respect_effective_interval():
    quarterly = plan(cadence="quarterly", pull_months=(2, 5, 8, 11), effective_from="2026-08")
    assert quarterly.due_date("2026-05") is None
    assert quarterly.next_date(date(2026, 9, 1)) == date(2026, 11, 30)
    annual = plan(cadence="yearly", pull_months=(2,), effective_from="2026-03")
    assert annual.next_date(date(2026, 3, 1)) == date(2027, 2, 28)


@pytest.mark.parametrize("changes", [
    {"amount": "NaN"}, {"amount": "1.234"}, {"amount": True}, {"amount": "-1"},
    {"pullDay": True}, {"pullDay": 0}, {"pullDay": 32}, {"effectiveFrom": "2026-10"},
    {"effectiveFrom": "2026-13"}, {"type": "unknown"}, {"owner": "hannah"},
    {"cadence": "quarterly", "pullMonths": [1, 2, 3, 4]}, {"cadence": "yearly", "pullMonths": []},
    {"splitMethod": "unknown"}, {"payerBasisPoints": True}, {"payerBasisPoints": 10001},
])
def test_invalid_configuration_never_becomes_a_plan(changes):
    with pytest.raises(BillValidation):
        normalize_plan(form(**changes), current=plan(), today=date(2026, 11, 13), plan_id="loan")


def test_quarterly_subscriptions_and_bill_wants_are_valid_configuration():
    for kind in ('subscription', 'variable', 'fixed'):
        value = normalize_plan(form(type=kind, cadence='quarterly', pullMonths=[2,5,8,11], category='subscriptions_wants'),
                               current=None, today=date(2026,11,13), plan_id='quarterly-plan')
        assert value.due_date('2027-02') == date(2027,2,28)
        assert value.due_date('2026-12') is None
    for category in ('rent', 'bills_utilities'):
        with pytest.raises(BillValidation, match='Needs or Wants'):
            normalize_plan(form(type='subscription', category=category), current=None, today=date(2026,11,13), plan_id='invalid-sub')


def test_source_identity_is_server_owned_and_variable_estimate_optional():
    renamed = normalize_plan(form(name="Federal loan"), current=plan(), today=date(2026, 11, 13), plan_id="loan")
    assert renamed.source_label == "Student Loan" and renamed.name == "Federal loan"
    variable = normalize_plan(form(type="variable", name="Electric", amount="", category="bills_utilities"),
                              current=None, today=date(2026, 11, 13), plan_id="new")
    assert variable.amount_cents is None and variable.kind == "variable"


@pytest.mark.parametrize("method,basis,expected", [("none", 10000, (10001, 0)), ("equal", 5000, (5001, 5000)),
    ("fronted", 0, (0, 10001)), ("custom", 3333, (3333, 6668)), ("income", 5000, (5732, 4269))])
def test_split_amounts_preserve_every_cent(method, basis, expected):
    result = split_cents(plan(split_method=method, payer_basis_points=basis), 10001, income_basis_points=5731)
    assert result == expected and sum(result) == 10001
