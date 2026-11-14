from dataclasses import replace

import pytest

from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, BillConflict, selected, versioned
from bookiebot.sheets.recurring_rows import BILL_HEADERS, SUB_HEADERS, decode, encode, header, legacy_plans, managed, runtime_tables


def test_legacy_rent_is_fixed_without_enrolling_or_inventing_a_price():
    rows = [["bill_key", "display_name", "recurrence", "pull_day", "source_label", "tracking_mode"],
            ["rent", "Rent", "monthly", "1", "Rent", "manual"],
            ["pge", "PG&E", "monthly", "22", "PG&E", "manual"]]
    original = [r[:] for r in rows]
    rent, utility = legacy_plans("brian", rows, [])
    assert rent.kind == "fixed" and rent.category == "rent" and rent.amount_cents is None
    assert utility.kind == "variable"
    assert rows == original and not managed(rows)


BILLS = [list(BILL_HEADERS), ["loan", "Student Loan", "monthly", "12", "", "Student Loan", "Checking", "Keep note", "old", "60.23", "automatic"],
         ["water", "Water", "quarterly", "", "", "Water", "Checking", "Not configured", "old"]]
SUBS = [["cadence", "name", "amount", "pull_day", "pull_month", "kind", "source_range"],
        ["monthly", "Music", "12.99", "13", "", "Wants", "Subscriptions!J7:L7"]]


def test_legacy_sources_migrate_and_roundtrip_without_changing_amounts_or_categories():
    plans = legacy_plans("brian", BILLS, SUBS)
    assert len(plans) == 3
    for tab, original in ((BILL_TAB, BILLS), (SUBSCRIPTION_TAB, [])):
        rows = encode(plans, tab, original)
        assert managed(rows)
        actual = decode(rows, tab)
        assert actual == [p for p in plans if p.source_tab == tab]
    assert next(p for p in plans if p.name == "Music").category == "subscriptions_wants"
    assert next(p for p in plans if p.name == "Water").public("2026-11")["needsSetup"]


def test_price_versions_keep_prior_results_and_unknown_cells_including_unnamed_columns():
    base = BILLS[1] + [""] * (len(BILL_HEADERS) - len(BILLS[1]))
    original = [list(BILL_HEADERS) + ["Personal note", ""], base + ["  keep spaces  ", "unheaded data"]]
    plans = legacy_plans("brian", original, [])
    initial = encode(plans, BILL_TAB, original)
    future = replace(plans[0], amount_cents=7023, effective_from="2026-12")
    updated = encode(versioned(plans, future, "new-price"), BILL_TAB, initial)
    assert updated[0][len(BILL_HEADERS):len(BILL_HEADERS) + 2] == ["Personal note", ""]
    assert all(row[len(BILL_HEADERS):len(BILL_HEADERS) + 2] == ["  keep spaces  ", "unheaded data"] for row in updated[1:])
    assert all(row[7] == "Keep note" for row in updated[1:])
    decoded = decode(updated, BILL_TAB)
    assert selected(decoded, "2026-11")[0].amount_cents == 6023
    assert selected(decoded, "2026-12")[0].amount_cents == 7023


def test_existing_normalized_subscription_metadata_does_not_trigger_managed_mode():
    assert not managed(SUBS)
    assert not managed([list(SUB_HEADERS) + ["active", "id", "budget_owner_key"]])
    with pytest.raises(BillConflict, match="incomplete"):
        managed([list(SUB_HEADERS) + ["plan_id"]])


def test_corrupt_managed_versions_and_duplicates_fail_closed():
    plans = legacy_plans("brian", BILLS[:2], [])
    rows = encode(plans, BILL_TAB, BILLS[:2])
    for field, bad in [("effective_from", "2026-13"), ("payer_basis_points", "-1"), ("active", "perhaps"), ("plan_id", "foreign!")]:
        changed = [row[:] for row in rows]
        changed[1][header(rows).index(field)] = bad
        with pytest.raises(BillConflict):
            decode(changed, BILL_TAB)
    with pytest.raises(BillConflict, match="overlapping"):
        decode([*rows, rows[1][:]], BILL_TAB)
    with pytest.raises(BillConflict, match="duplicate headers"):
        managed([["cadence", "Cadence"]])


def test_owner_and_original_source_are_bound_to_plan_identity():
    brian = legacy_plans("brian", BILLS[:2], SUBS)
    hannah = legacy_plans("hannah", BILLS[:2], SUBS)
    assert not {p.id for p in brian} & {p.id for p in hannah}
    assert legacy_plans("brian", BILLS[:2], SUBS) == brian
    with pytest.raises(BillConflict, match="same source name"):
        legacy_plans("brian", [BILLS[0], BILLS[1], BILLS[1]], [])


def test_legacy_runtime_is_unchanged_and_hidden_cache_never_becomes_authority_by_accident():
    assert runtime_tables("brian", BILLS, [], SUBS) == (BILLS, SUBS, False)
    assert runtime_tables("brian", BILLS, [["cadence", "name", "amount", "pull_day"]], SUBS) == (BILLS, SUBS, False)


def test_managed_subscription_moves_to_monthly_source_only_from_its_split_start_month():
    plans = legacy_plans("brian", [], SUBS)
    shared = replace(plans[0], effective_from="2026-12", split_method="equal", payer_basis_points=5000,
                     monthly_source=True)
    versions = versioned(plans, shared, "start-sharing")
    encoded = encode(versions, SUBSCRIPTION_TAB, [])
    bill_view, sub_view, active = runtime_tables("brian", [], encoded, SUBS)
    assert active
    bills, subs = decode(bill_view, BILL_TAB), decode(sub_view, SUBSCRIPTION_TAB)
    assert selected(subs, "2026-11")[0].amount_cents == 1299
    assert not selected(bills, "2026-11")
    assert not selected(subs, "2026-12")
    assert selected(bills, "2026-12")[0].amount_cents == 1299
    assert selected(bills, "2026-12")[0].source_range.startswith("billplan:")


def test_bill_enrollment_does_not_drop_unmigrated_subscription_sources():
    plans = legacy_plans("brian", BILLS, [])
    bill_view, sub_view, _ = runtime_tables("brian", encode(plans, BILL_TAB, BILLS), [], SUBS)
    assert selected(decode(bill_view, BILL_TAB), "2026-11")[0].source_tab == BILL_TAB
    assert selected(decode(sub_view, SUBSCRIPTION_TAB), "2026-11")[0].name == "Music"
    assert selected(decode(sub_view, SUBSCRIPTION_TAB), "2026-11")[0].source_range == "Subscriptions!J7:L7"


def test_subscription_enrollment_keeps_legacy_bill_references_and_reminder_keys():
    bill_rows = [list(BILL_HEADERS), ["student loan", *BILLS[1][1:]]]
    subs = legacy_plans("brian", [], SUBS)
    bill_view, _, _ = runtime_tables("brian", bill_rows, encode(subs, SUBSCRIPTION_TAB, []), SUBS)
    parsed = decode(bill_view, BILL_TAB)[0]
    assert parsed.source_range == f"{BILL_TAB}!A2:L2"
    assert bill_view[1][header(bill_view).index("bill_key")] == "student loan"
