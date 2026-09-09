from dataclasses import replace
from copy import deepcopy
from datetime import date
from types import SimpleNamespace

import pytest

from bookiebot.reimbursements import migration, projection
from bookiebot.reimbursements.store import ReimbursementConflictError, ReimbursementStore
from bookiebot.sheets.collaboration import _allocation_row, SharedAllocation, SHARED_REIMBURSEMENT_HEADERS, split_amounts
from unit_tests.reimbursements.test_projection import Book, receipt_row
from unit_tests.reimbursements.test_store import access, command, payment, payload  # noqa: F401


def allocation(**changes):
    return replace(SharedAllocation(
        allocation_id="allocation-1", created_at="2026-01-03T12:00:00-08:00", updated_at="2026-01-03T12:00:00-08:00",
        actor_key="676638528590970917", owner_key="brian", payer="Brian (BofA)", partner="Hannah",
        source_action_id="expense-1", split_action_id="split-1", source_worksheet="expense", source_category="need_expenses",
        source_row=3, expense_date="1/3/2026", item="T", location="Gameday", gross_amount=464.72,
        split_method="income", payer_share=300.81, partner_share=163.91,
        responsible_owner_key="brian", original_person="Brian (BofA)", responsible_person="Brian (BofA)"), **changes)


@pytest.fixture
def setup(access, monkeypatch):
    store = ReimbursementStore(access)
    store.initialize()
    book = Book()
    sheet = book.add_sheet("January")
    sheet.write(2, 29, ["1/3/2026", "T", "300.81", "Gameday", "Brian (BofA)"])
    book.add_sheet("September")
    client = SimpleNamespace(open_by_key=lambda key: book)
    histories = {}
    def set_history(owner, *items, raw_only=False):
        ledger = SimpleNamespace(year=2026, worksheet=SimpleNamespace(spreadsheet_id=owner + "-ledger"),
                                 rows=[SHARED_REIMBURSEMENT_HEADERS, *[_allocation_row(item) for item in items]])
        records = [] if raw_only else [SimpleNamespace(allocation=item, year=2026, worksheet=ledger.worksheet) for item in items]
        histories[owner] = SimpleNamespace(records=records, ledgers=[ledger], require_complete=lambda: None)
    set_history("brian", allocation())
    set_history("hannah")
    monkeypatch.setattr(migration, "actor_key_for_owner", lambda owner: owner)
    monkeypatch.setattr(migration, "read_reimbursement_history", lambda actor: histories[actor])
    monkeypatch.setattr(migration, "get_shared_expenses_spreadsheet_id", lambda year: "shared")
    monkeypatch.setattr(migration, "get_budget_spreadsheet_id_for_user", lambda actor, year: actor + "-budget")
    monkeypatch.setattr(projection, "get_shared_expenses_spreadsheet_id", lambda year: "shared")
    monkeypatch.setattr(migration, "verify_budget_links", lambda *args, **kwargs: None)
    return SimpleNamespace(store=store, book=book, sheet=sheet, client=client, set_history=set_history,
                           projector=projection.SheetsProjection(client), histories=histories)


def test_plan_is_read_only_then_apply_moves_verified_unpaid_source_to_gross(setup):
    plan = migration.plan_migration(setup.client)
    assert not plan["issues"] and len(plan["allocations"]) == 1
    assert setup.sheet.read(2, 31, 32) == ["300.81"]
    assert not setup.book.batch_calls and not setup.book.value_calls
    assert not setup.store.snapshot("brian")["allocations"]
    assert migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert setup.sheet.read(2, 31, 32) == [464.72]
    assert not setup.store.snapshot("brian")["events"]
    assert migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert len(setup.store.snapshot("brian")["allocations"]) == 1


def test_reviewed_wrong_owner_correction_verifies_old_share_and_identity_then_reverses_new_receipt(setup):
    old = allocation(owner_key="hannah", payer="Hannah", partner="Brian", payer_share=163.91, partner_share=300.81,
                     original_person="Hannah", responsible_person="Hannah", responsible_owner_key="hannah")
    setup.set_history("brian", old, raw_only=True)
    setup.sheet.write(2, 29, ["1/3/2026", "T", "163.91", "Gameday", "Hannah"])
    plan = migration.plan_migration(setup.client, corrections={old.allocation_id: {"payerOwner": "brian", "item": "Hannah's T"}})
    assert plan["issues"] == []
    value = plan["allocations"][0]
    assert value["sourceValues"]["person"] == "Hannah" and value["sourceValues"]["amount"] == "163.91"
    assert value["payerPerson"] == "Brian (BofA)" and value["item"] == "Hannah's T"
    payer, partner = split_amounts(464.72, "income", "brian")
    assert value["payerShareCents"] == round(payer * 100) and value["partnerShareCents"] == round(partner * 100)
    assert migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert setup.sheet.read(2, 29, 34) == ["1/3/2026", "Hannah's T", 464.72, "Gameday", "Brian (BofA)"]
    current = setup.store.get_allocation(old.allocation_id)
    event = setup.store.command("brian", payment(current, 5000))["events"][0]
    assert projection.sync_pending(setup.store, setup.projector)
    assert setup.sheet.read(2, 31, 32) == [414.72] and receipt_row(setup.book, event["id"])[2] == 50
    setup.store.command("brian", command("reverse", eventId=event["id"]))
    assert projection.sync_pending(setup.store, setup.projector)
    assert setup.sheet.read(2, 31, 32) == [464.72] and receipt_row(setup.book, event["id"])[2] == 0


@pytest.mark.parametrize("received", [50, 163.91])
def test_paid_legacy_history_stays_read_only_with_no_invented_counterpart_expenses(setup, received):
    setup.set_history("brian", allocation(received_amount=received, received_at="2026-01-05", status="reimbursed" if received == 163.91 else "outstanding"))
    setup.client.open_by_key = lambda key: pytest.fail("Paid history must not inspect or alter historical source rows")
    plan = migration.plan_migration(setup.client)
    assert not plan["issues"] and plan["allocations"][0]["accounting"] == "legacy_net"
    original_source = deepcopy(setup.sheet.rows)
    def open_ledger(key):
        assert key == "brian-ledger", "Only the generated ledger view may be opened, never the historical source"
        return setup.book
    setup.client.open_by_key = open_ledger
    assert migration.apply_migration(setup.store, plan, projector=setup.projector)
    snapshot = setup.store.snapshot("brian")
    assert snapshot["events"] == [] and snapshot["allocations"][0]["baselineSettledCents"] == round(received * 100)
    with pytest.raises(ReimbursementConflictError, match="read-only"):
        setup.store.command("brian", payment(snapshot["allocations"][0], 100))
    assert setup.sheet.rows == original_source
    assert all(name.startswith("BB_ledger_") for name in setup.book.names)
    assert setup.book.worksheet("Shared Reimbursements").rows[1][20] == f"{received:.2f}"


@pytest.mark.parametrize("column,value,reason", [(31, "300.82", "amount"), (31, "bad", "whole cents"),
    (31, "300.810", "whole cents"), (33, "Hannah", "person"), (30, "Other item", "item"),
    (32, "Other store", "location"), (29, "1/4/2026", "date")])
def test_mismatched_or_malformed_source_creates_plan_issue_and_blocks_all_apply(setup, column, value, reason):
    setup.sheet.write(2, column, [value])
    plan = migration.plan_migration(setup.client)
    assert any(reason in issue for issue in plan["issues"])
    with pytest.raises(ValueError, match="Resolve every"):
        migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert setup.store.snapshot("brian")["allocations"] == []
    assert not setup.book.batch_calls and not setup.book.value_calls


def test_one_invalid_allocation_blocks_other_valid_plan_allocations(setup):
    setup.set_history("brian", allocation(), allocation(allocation_id="bad", source_action_id="bad-source", gross_amount=float("nan")))
    plan = migration.plan_migration(setup.client)
    assert len(plan["allocations"]) == 1 and plan["issues"]
    with pytest.raises(ValueError):
        migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert setup.store.snapshot("brian")["allocations"] == []


def test_conflicting_owner_copies_are_not_silently_overwritten(setup):
    setup.set_history("hannah", allocation(item="Different"))
    plan = migration.plan_migration(setup.client)
    assert any("conflicting copies" in issue for issue in plan["issues"])
    with pytest.raises(ValueError):
        migration.apply_migration(setup.store, plan, projector=setup.projector)


@pytest.mark.parametrize("change", [{"grossCents": -1}, {"id": "same"}, {"sourceActionId": "same-source"}])
def test_apply_validates_entire_plan_including_duplicate_sources_before_first_registration(setup, change):
    first = payload(id="same", sourceActionId="same-source")
    second = payload(**change)
    plan = {"schema": 1, "issues": [], "allocations": [first, second]}
    with pytest.raises(ValueError):
        migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert setup.store.snapshot("brian")["allocations"] == []


def test_wrong_owner_without_review_or_paid_owner_repair_is_an_issue(setup):
    old = allocation(owner_key="hannah", payer="Hannah", original_person="Hannah", responsible_person="Hannah")
    setup.set_history("brian", old, raw_only=True)
    assert "ownership disagrees" in migration.plan_migration(setup.client)["issues"][0]
    setup.set_history("brian", replace(old, received_amount=1), raw_only=True)
    assert "paid ownership" in migration.plan_migration(setup.client, corrections={old.allocation_id: {"payerOwner": "brian"}})["issues"][0]


@pytest.mark.parametrize("index,value", [(20, "nonsense"), (15, "464.720"), (17, "1,63.91"), (18, "-1")])
def test_wrong_owner_correction_never_coerces_malformed_saved_money_to_zero(setup, index, value):
    old = allocation(owner_key="hannah", payer="Hannah", original_person="Hannah", responsible_person="Hannah")
    setup.set_history("brian", old, raw_only=True)
    setup.histories["brian"].ledgers[0].rows[1][index] = value
    plan = migration.plan_migration(setup.client, corrections={old.allocation_id: {"payerOwner": "brian"}})
    assert plan["allocations"] == [] and "invalid saved allocation" in plan["issues"][0]


def test_existing_allocation_ids_are_not_reimported_or_reprojected(setup):
    setup.client.open_by_key = lambda key: pytest.fail("Existing allocation must be skipped before source lookup")
    plan = migration.plan_migration(setup.client, existing_ids={"allocation-1"})
    assert plan["allocations"] == [] and plan["issues"] == []


@pytest.fixture
def links(monkeypatch):
    source = [["", "", "", "", "", '=SUMIF(D:D,"Brian (BofA)",B:B)'],
              ["", "", "", "", "", '=SUMIF(D:D,"Hannah",B:B)']]
    rows = {"brian-budget": [["", "Groceries", '=IMPORTRANGE("shared", "\'January\'!F1")']],
            "hannah-budget": [["", "Groceries", '=IMPORTRANGE("shared", "\'January\'!F2")']], "shared": source}
    calls = []
    def read(key, title, *, value_render_option):
        assert value_render_option == "FORMULA" and title == "January"
        calls.append((key, title))
        return deepcopy(rows[key])
    client = SimpleNamespace(open_by_key=lambda key: SimpleNamespace(worksheet=lambda title:
        SimpleNamespace(get_all_values=lambda **kwargs: read(key, title, **kwargs))))
    monkeypatch.setattr(migration, "actor_key_for_owner", lambda owner: owner)
    monkeypatch.setattr(migration, "get_shared_expenses_spreadsheet_id", lambda year: "shared")
    monkeypatch.setattr(migration, "get_budget_spreadsheet_id_for_user", lambda actor, year: actor + "-budget")
    return SimpleNamespace(rows=rows, calls=calls, client=client)


def test_summary_chain_guard_verifies_both_people_and_reuses_only_current_run_rows(links):
    cache = {}
    for _ in range(2):
        for owner in ("brian", "hannah"):
            migration.verify_budget_links(links.client, owner, date(2026, 1, 3), "grocery", cache=cache)
    assert len(links.calls) == 3
    links.rows["brian-budget"][0][2] = "300.81"
    with pytest.raises(ValueError, match="verified live"):
        migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "grocery", cache={})


def test_known_month_formula_transport_uses_three_value_reads_and_no_metadata_lookups(links):
    calls = []
    def values_get(key, range_name, *, params):
        assert range_name == "'January'" and params == {"valueRenderOption": "FORMULA"}
        calls.append(key)
        return {"range": "'January'!A1:AJ100", "values": deepcopy(links.rows[key])}
    links.client.http_client = SimpleNamespace(values_get=values_get)
    links.client.open_by_key = lambda key: pytest.fail("Known tab reads must not request workbook/worksheet metadata")
    cache = {}
    for _ in range(2):
        for owner in ("brian", "hannah"):
            migration.verify_budget_links(links.client, owner, date(2026, 1, 3), "grocery", cache=cache)
    assert calls == ["brian-budget", "shared", "hannah-budget"]
    assert links.calls == [], "The Worksheet fallback remains available only for adapters without HTTP transport"


@pytest.mark.parametrize("response", [{}, {"range": "'February'!A1:B2", "values": []},
    {"range": "'January'!A1:B2", "values": "invalid"}, {"range": "'January'!A1:B2", "values": [[{}]]}])
def test_direct_formula_transport_rejects_invalid_or_wrong_month_results_without_fallback(links, response):
    links.client.http_client = SimpleNamespace(values_get=lambda *args, **kwargs: response)
    links.client.open_by_key = lambda key: pytest.fail("Bad HTTP results must not trigger metadata fallback")
    with pytest.raises(ValueError):
        migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "grocery")


def test_transport_failure_is_not_cached_or_retried_through_expensive_fallback(links):
    calls = []
    def unavailable(*args, **kwargs):
        calls.append(args)
        raise ConnectionError("Quota unavailable")
    links.client.http_client = SimpleNamespace(values_get=unavailable)
    links.client.open_by_key = lambda key: pytest.fail("HTTP failure must not trigger metadata fallback")
    cache = {}
    for _ in range(2):
        with pytest.raises(ConnectionError):
            migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "grocery", cache=cache)
    assert len(calls) == 2 and cache == {}


@pytest.mark.parametrize("formula", ["300.81", "=300.81", '=IMPORTRANGE("wrong", "January!F1")',
    '=IMPORTRANGE("shared", "December!F1")', '=SUM(C1:C3)', '=IMPORTRANGE("shared", "January!F9")'])
def test_numeric_frozen_or_unrelated_summary_formulas_fail_closed(links, formula):
    links.rows["brian-budget"][0][2] = formula
    with pytest.raises(ValueError, match="verified live"):
        migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "grocery")


@pytest.mark.parametrize("formula", ["300.81", "=300.81", '=SUMIF(D:D,"Hannah",B:B)',
    '=SUMIF(D:D,"Brian (BofA)",C:C)', '=SUMIF(D3:D100,"Brian (BofA)",B3:B100)'])
def test_upstream_shared_summary_must_be_live_correct_person_and_full_category_columns(links, formula):
    links.rows["shared"][0][5] = formula
    with pytest.raises(ValueError, match="verified live"):
        migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "grocery")


@pytest.mark.parametrize("rows", [[], [["Groceries", "1"], ["Groceries", "2"]]])
def test_missing_or_ambiguous_personal_category_summary_fails_closed(links, rows):
    links.rows["brian-budget"] = rows
    with pytest.raises(ValueError, match="verified live"):
        migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "grocery")


def test_actual_url_import_and_needs_label_are_supported(links):
    links.rows["brian-budget"] = [["", "Various Need Transactions", '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/shared", "\'January\'!F1")']]
    links.rows["shared"][0][5] = '=SUMIF(AH:AH, "Brian (BofA)", AF:AF)\n'
    migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "need_expenses")
    with pytest.raises(ValueError, match="verified live"):
        migration.verify_budget_links(links.client, "brian", date(2026, 1, 3), "need_expenses", person="Brian (AL)")


def test_unverified_summary_makes_migration_issue_before_registration_or_projection(setup, monkeypatch):
    calls = []
    def guard(client, owner, when, category, **kwargs):
        calls.append(owner)
        if owner == "hannah":
            raise ValueError("Frozen Hannah summary")
    monkeypatch.setattr(migration, "verify_budget_links", guard)
    plan = migration.plan_migration(setup.client)
    assert calls == ["brian", "hannah"] and "Frozen Hannah" in plan["issues"][0]
    with pytest.raises(ValueError):
        migration.apply_migration(setup.store, plan, projector=setup.projector)
    assert not setup.store.snapshot("brian")["allocations"] and not setup.book.batch_calls
