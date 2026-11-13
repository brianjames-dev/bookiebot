from dataclasses import replace
from datetime import date

import pytest

from bookiebot.sheets.recurring import BillConflict, BillValidation, selected
from bookiebot.sheets.recurring_changes import BillSnapshot, prepare_change
from unit_tests.sheets.test_recurring import plan, form

TODAY = date(2026, 11, 13)


def snapshot(**kwargs):
    return BillSnapshot(owner="brian", plans=(plan(version="v1"),), version="source-v1", period="2026-11", earliest_months=kwargs)


def update(**kwargs):
    return {"operation": "update", "id": "loan", "version": "v1", "settingsVersion": "source-v1", "bill": form(), **kwargs}


def test_review_is_pure_and_changes_future_only():
    source = snapshot()
    change = prepare_change(source, update(bill=form(amount="70.00", effectiveFrom="2026-12")), today=TODAY)
    assert source.plans[0].amount_cents == 6023
    assert selected(change.rows("request"), "2026-11")[0].amount_cents == 6023
    assert selected(change.rows("request"), "2026-12")[0].amount_cents == 7000
    assert change.public()["reviewVersion"] == change.review_version


def test_new_split_default_starts_after_existing_charge_and_carries_on_non_split_edits():
    change = prepare_change(snapshot(), update(), today=TODAY)
    assert change.after.split_starts_on == "2026-11-14"
    saved = replace(change.after, version="v2")
    state = replace(snapshot(), plans=(saved,))
    next_change = prepare_change(state, update(version="v2", bill=form(account="Other bank")), today=date(2026, 11, 15))
    assert next_change.after.split_starts_on == "2026-11-14"
    assert next_change.after.monthly_source


def test_delete_is_a_future_tombstone_and_existing_charge_month_is_guarded():
    state = snapshot(loan="2026-12")
    body = {"operation": "delete", "id": "loan", "version": "v1", "settingsVersion": "source-v1", "effectiveFrom": "2026-11"}
    with pytest.raises(BillValidation, match="already recorded"):
        prepare_change(state, body, today=TODAY)
    change = prepare_change(state, {**body, "effectiveFrom": "2026-12"}, today=TODAY)
    assert not change.after.active
    assert selected(change.rows("stop"), "2026-11")
    assert not selected(change.rows("stop"), "2026-12")


def test_missing_payment_date_can_be_repaired_without_changing_recorded_money_or_split():
    source = replace(snapshot(loan="2026-12"), plans=(replace(plan(version="v1"), pull_day=0, split_method="none", monthly_source=True),))
    body = update(bill=form(splitMethod="none", pullDay=12))
    change = prepare_change(source, body, today=TODAY)
    assert change.after.pull_day == 12 and change.after.amount_cents == 6023
    with pytest.raises(BillValidation, match="already recorded"):
        prepare_change(source, update(bill=form(splitMethod="none", pullDay=12, amount="70.00")), today=TODAY)


@pytest.mark.parametrize("changes", [{"id": "foreign"}, {"settingsVersion": "stale"}, {"version": "stale"}, {"owner": "hannah"}, {"spreadsheetId": "foreign"}])
def test_foreign_stale_and_injected_authority_never_reach_a_change(changes):
    with pytest.raises((BillConflict, BillValidation)):
        prepare_change(snapshot(), update(**changes), today=TODAY)


def test_create_identity_is_owner_bound_and_review_binds_all_fields():
    body = {"operation": "create", "draftId": "new-bill-draft-1234", "settingsVersion": "source-v1", "bill": form(name="New loan")}
    first = prepare_change(snapshot(), body, today=TODAY)
    assert prepare_change(snapshot(), body, today=TODAY).after.id == first.after.id
    other = prepare_change(replace(snapshot(), owner="hannah"), body, today=TODAY)
    assert first.after.id != other.after.id
    changed = prepare_change(snapshot(), {**body, "bill": form(name="New loan", amount="70.00")}, today=TODAY)
    assert first.review_version != changed.review_version
    with pytest.raises(BillConflict, match="already saved"):
        prepare_change(replace(snapshot(), plans=(*snapshot().plans, first.after)), body, today=TODAY)
