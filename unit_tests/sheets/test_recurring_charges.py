from dataclasses import replace

import pytest

from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, BillConflict, selected
from bookiebot.sheets.recurring_charges import BillCharge, decode_charges, encode_charges, source_anchor
from bookiebot.sheets.recurring_rows import decode, encode, legacy_plans, runtime_tables
from unit_tests.sheets.test_recurring_rows import SUBS


def charge(plan_id="bill_source123456"):
    return BillCharge(plan_id, "2026-11", "2026-11-13", "Music", "subscriptions_wants", 123, 46, 4,
                      source_anchor(plan_id, "2026-11"), 1299, True, payer_owner="brian")


def test_charge_sources_roundtrip_and_preserve_extra_columns():
    row = charge()
    values = encode_charges([row], [])
    values[0].append("Private note"); values[1].append("keep me")
    updated = encode_charges([replace(row, source_action_id="action-1")], values)
    assert updated[1][-1] == "keep me"
    assert decode_charges(updated) == [replace(row, source_action_id="action-1")]


def test_duplicate_and_changed_source_addresses_never_become_another_bill():
    rows = encode_charges([charge()], [])
    for name, value in [("month", "2026-12"), ("amount_column", "3"), ("anchor", "foreign"), ("source_row", "0")]:
        changed = [r[:] for r in rows]
        changed[1][changed[0].index(name)] = value
        with pytest.raises(BillConflict):
            decode_charges(changed)
    with pytest.raises(BillConflict):
        decode_charges([*rows, rows[1]])


def test_adopted_existing_virtual_charge_is_counted_once_without_changing_other_months():
    plans = legacy_plans("brian", [], SUBS)
    adopted = charge(plans[0].id)
    bill_view, sub_view, _ = runtime_tables("brian", [], encode(plans, SUBSCRIPTION_TAB, []), SUBS,
                                           encode_charges([adopted], []))
    monthly, virtual = decode(bill_view, BILL_TAB), decode(sub_view, SUBSCRIPTION_TAB)
    assert selected(virtual, "2026-10")[0].amount_cents == 1299
    assert not selected(virtual, "2026-11")
    assert selected(monthly, "2026-11")[0].amount_cents == 1299
    assert selected(virtual, "2026-12")[0].amount_cents == 1299
    assert not selected(monthly, "2026-12")


def test_recipient_cash_source_is_readonly_and_never_a_scheduled_projection():
    item = replace(charge(), initial_amount_cents=0, source_label="Brian · Music", payer_owner="brian")
    bill_rows, _, _ = runtime_tables("hannah", [], [], [], encode_charges([item], []))
    view = decode(bill_rows, BILL_TAB)[0]
    assert view.monthly_source and not view.active and view.amount_cents is None
    assert view.source_label == "Brian · Music"
    assert view.next_date(__import__('datetime').date(2026, 11, 1)) is None
