from decimal import Decimal
from dataclasses import replace
import calendar
from types import SimpleNamespace
from uuid import uuid4

import pytest

from bookiebot.reimbursements import migration, projection, service, store as store_module
from bookiebot.reimbursements.store import MAX_CENTS, ReimbursementConflictError, ReimbursementStore, ReimbursementValidationError
from bookiebot.sheets import auth, routing, undo
from unit_tests.reimbursements.test_projection import Book, receipt_row
from unit_tests.reimbursements.test_store import access, command, payment, payload  # noqa: F401

BRIAN = "676638528590970917"
FIELDS = {"date": 30, "item": 31, "amount": 32, "location": 33, "person": 34}
VALUES = {"date": "1/3/2026", "item": "Hannah's T", "amount": "464.72", "location": "Gameday", "person": "Brian (BofA)"}


@pytest.fixture
def setup(access, monkeypatch):
    monkeypatch.setattr(migration, "verify_budget_links", lambda *args, **kwargs: None)
    store = ReimbursementStore(access)
    store.initialize()
    book = Book()
    sheet = book.add_sheet("January")
    for month in list(calendar.month_name)[2:]:
        book.add_sheet(month)
    sheet.write(2, 29, list(VALUES.values()))
    client = SimpleNamespace(open_by_key=lambda key: book)
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(store_module, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(auth, "get_gspread_client", lambda: client)
    monkeypatch.setattr(routing, "get_shared_expenses_spreadsheet_id", lambda year: "shared")
    monkeypatch.setattr(routing, "get_budget_spreadsheet_id_for_user", lambda user, year: "budget")
    monkeypatch.setattr(projection, "get_shared_expenses_spreadsheet_id", lambda year: "shared")
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    logged = SimpleNamespace(id="source-" + uuid4().hex, action=undo.UndoAction(
        worksheet="expense", kind="clear_cells", row=3, columns=list(FIELDS.values()), previous_values=[],
        new_values=list(VALUES.values()), description="new need", metadata={"category": "need_expenses"}))
    history = []
    def record(actor, action):
        history.append(action)
        return "split-" + logged.id
    monkeypatch.setattr(undo, "record_undo_action", record)
    return SimpleNamespace(store=store, book=book, sheet=sheet, logged=logged, history=history)


def split(setup, **changes):
    params = dict(user_key=BRIAN, logged=setup.logged, ws=setup.sheet, fields=FIELDS, values=VALUES,
                  payer="Brian (BofA)", method="income", gross=464.72, payer_share=300.81, partner_share=163.91)
    return service.record_split(**(params | changes))


@pytest.mark.parametrize("value,expected", [(0, 0), (1.25, 125), ("$1,234.50", 123450), (" 0.01 ", 1),
                                            (Decimal("41.20"), 4120), (str(MAX_CENTS // 100), MAX_CENTS)])
def test_money_parser_preserves_exact_valid_cents(value, expected):
    assert service.money_cents(value) == expected


@pytest.mark.parametrize("value", [None, True, False, {}, "", "abc", "$", "12abc", "1,2.34", "1.001", "1.000",
                                    -1, "-0.00", float("nan"), float("inf"), "NaN", "Infinity", "1e2", "1.2.3",
                                    Decimal("Infinity"), Decimal("-1"), str(MAX_CENTS // 100 + 1)])
def test_money_parser_never_rounds_or_coerces_invalid_amounts_to_zero(value):
    with pytest.raises(ReimbursementValidationError):
        service.money_cents(value)


def test_split_then_partial_receipt_and_reversal_preserve_household_cash(setup):
    assert split(setup)[0]
    initial = setup.store.snapshot("brian")["allocations"][0]
    assert initial["grossCents"] == 46472 and initial["settledCents"] == 0
    assert setup.sheet.read(2, 31, 32) == [464.72]
    assert not setup.store.snapshot("brian")["events"]
    response = service.command("brian", payment(initial, 5000))
    assert response["projectionPending"] is False
    event = response["events"][0]
    assert setup.sheet.read(2, 31, 32) == [414.72]
    assert receipt_row(setup.book, event["id"])[2:] == [50.0, "Reimbursement to Brian · Gameday", "Hannah"]
    assert round(setup.sheet.read(2, 31, 32)[0] + receipt_row(setup.book, event["id"])[2], 2) == 464.72
    service.command("brian", command("reverse", eventId=event["id"]))
    assert setup.sheet.read(2, 31, 32) == [464.72]
    assert receipt_row(setup.book, event["id"])[2] == 0
    assert setup.store.snapshot("brian")["events"][0]["status"] == "reversed"


def test_debtor_report_does_not_reduce_source_before_confirmation(setup):
    split(setup)
    allocation = setup.store.snapshot("hannah")["allocations"][0]
    result = service.command("hannah", payment(allocation, 5000, "report_payment"))
    event = result["events"][0]
    assert setup.sheet.read(2, 31, 32) == [464.72]
    assert projection._name("receipt", event["id"]) not in setup.book.names
    assert result["allocations"][0]["version"] == allocation["version"]
    service.command("brian", command("confirm_payment", allocationId=allocation["id"], version=allocation["version"], eventId=event["id"]))
    assert setup.sheet.read(2, 31, 32) == [414.72]
    assert receipt_row(setup.book, event["id"])[2] == 50


def test_split_replay_does_not_duplicate_history_or_reset_confirmed_cash(setup):
    split(setup)
    allocation = setup.store.snapshot("brian")["allocations"][0]
    service.command("brian", payment(allocation, 5000))
    split(setup)
    assert len(setup.history) == 1
    assert len(setup.store.snapshot("brian")["allocations"]) == 1
    assert setup.sheet.read(2, 31, 32) == [414.72]
    with pytest.raises(ReimbursementConflictError):
        split(setup, payer_share=300, partner_share=164.72)


def test_split_does_not_project_unrelated_unavailable_allocation(setup, monkeypatch):
    unrelated = setup.store.register_allocation(payload(sourceSpreadsheetId="unavailable", sourceActionId="unrelated"))
    opened = []
    def open_book(key):
        opened.append(key)
        assert key != "unavailable", "A split must not wait for another allocation's workbook"
        return setup.book
    monkeypatch.setattr(auth, "get_gspread_client", lambda: SimpleNamespace(open_by_key=open_book))
    ok, message = split(setup)
    assert ok and "syncing" not in message
    current = setup.store.find_by_source(setup.logged.id, 2026)
    assert current["version"] == current["projectedVersion"]
    assert setup.store.get_allocation(unrelated["id"])["projectedVersion"] == 0
    assert opened.count("shared") == 1
    assert len(setup.history) == 1


def test_concurrent_split_workers_record_one_allocation_and_history_action(setup):
    from concurrent.futures import ThreadPoolExecutor
    from bookiebot.splits import run_split_operation
    def apply(_actor, **_kwargs):
        return split(setup)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(run_split_operation, apply, BRIAN, action_id=setup.logged.id) for _ in range(2)]
        assert all(task.result()[0] for task in pending)
    assert len(setup.history) == 1
    values = setup.store.snapshot("brian")["allocations"]
    assert len(values) == 1 and values[0]["version"] == values[0]["projectedVersion"]


@pytest.mark.parametrize("phase", ["lock", "sheet"])
def test_saved_split_projection_failure_returns_recoverable_success(setup, monkeypatch, phase):
    if phase == "lock":
        monkeypatch.setattr(projection, "sync_pending", lambda *_a, **_kw: (_ for _ in ()).throw(TimeoutError("Lock unavailable")))
    else:
        monkeypatch.setattr(auth, "get_gspread_client", lambda: SimpleNamespace(open_by_key=lambda _key: (_ for _ in ()).throw(TimeoutError("Sheet unavailable"))))
    ok, message = split(setup)
    assert ok and "The split is saved; expense sheets are still syncing" in message
    current = setup.store.find_by_source(setup.logged.id, 2026)
    assert current["version"] > current["projectedVersion"]
    assert len(setup.history) == 1


@pytest.mark.parametrize("changes", [{"payer": "Hannah"}, {"values": VALUES | {"person": "Hannah"}},
                                     {"values": VALUES | {"amount": "463.72"}}, {"values": VALUES | {"amount": "bad"}}])
def test_source_payer_and_amount_guard_precedes_registration(setup, changes):
    with pytest.raises(ReimbursementValidationError):
        split(setup, **changes)
    assert setup.store.snapshot("brian")["allocations"] == []
    assert setup.history == []
    assert not setup.book.batch_calls and not setup.book.value_calls


def test_fixed_bill_captures_verified_label_identity_without_mutating_callers(setup):
    setup.logged.action.worksheet = "income"
    setup.logged.action.metadata["category"] = "rent"
    setup.sheet.write(2, 1, ["Rent", 464.72])
    setup.sheet.cell = lambda row, col: SimpleNamespace(value=setup.sheet.read(row - 1, col - 1, col)[0])
    fields, values = {"amount": 3}, {"amount": "464.72"}
    assert split(setup, fields=fields, values=values)[0]
    result = setup.store.snapshot("brian")["allocations"][0]
    assert result["sourceColumnMap"] == {"amount": 3, "item": 2}
    assert result["sourceValues"] == {"amount": "464.72", "item": "Rent"}
    assert result["item"] == "Rent" and result["projectedVersion"] == result["version"]
    assert fields == {"amount": 3} and values == {"amount": "464.72"}


def test_fixed_bill_amount_correction_preserves_literal_source_label_and_canonical_item(setup, monkeypatch):
    label = "Rent payment (due 1st)"
    setup.sheet.write(2, 1, [label, 464.72])
    value = setup.store.register_allocation(payload(
        sourceActionId=setup.logged.id, sourceWorksheet="income", sourceSheetTitle="January",
        sourceSpreadsheetId="budget", sourceYear=routing.now_pacific().year, sourceRow=3,
        item="rent", category="rent", sourceColumnMap={"item": 2, "amount": 3},
        sourceValues={"item": label, "amount": "464.72"},
        grossCents=46472, payerShareCents=30081, partnerShareCents=16391,
    ))
    assert projection.sync_pending(setup.store)
    logged = SimpleNamespace(id=value["splitActionId"], action=undo.UndoAction(
        worksheet="income", kind="restore_cells", row=3, columns=[3], previous_values=[],
        new_values=["464.72"], description="split rent", metadata={
            "allocation_id": value["id"], "accounting": "cash_v1", "canonical_version": str(value["version"]),
        }))
    ok, message = service.mutate_recent_action(BRIAN, logged, "update", updates={"amount": "500"})
    assert ok and "syncing" not in message
    current = setup.store.get_allocation(value["id"])
    assert current["item"] == "rent"
    assert current["sourceValues"] == {"item": label, "amount": "500.00"}
    assert setup.sheet.read(2, 1, 3) == [label, 500]
    # Future settlement projection must still bind the original literal label.
    partner = Book()
    partner.add_sheet("January").write(2, 1, ["Rent", 0])
    monkeypatch.setattr(projection, "get_budget_spreadsheet_id_for_user", lambda _actor, _year: "partner")
    monkeypatch.setattr(auth, "get_gspread_client", lambda: SimpleNamespace(
        open_by_key=lambda key: partner if key == "partner" else setup.book))
    result = service.command("brian", payment(current, 1000))
    assert not result["projectionPending"]
    assert setup.sheet.read(2, 1, 3) == [label, 490]
    assert partner.worksheet("January").read(2, 1, 3) == ["Rent", 10]


def test_canonical_lookup_outage_fails_closed_and_undo_never_touches_sheet(setup, monkeypatch):
    split(setup)
    allocation = setup.store.snapshot("brian")["allocations"][0]
    assert service.is_managed(allocation["id"])
    logged = undo.LoggedAction(id=setup.logged.id, created_at="2026-01-03", user_key=BRIAN, action=setup.logged.action)
    guarded = undo._canonical_action(logged)
    assert guarded is not None and guarded.action.metadata["allocation_id"] == allocation["id"]
    capabilities = undo.action_capabilities(guarded.action)
    assert all((capabilities.can_update, capabilities.can_move, capabilities.can_change_split,
                capabilities.can_cancel_split, capabilities.can_delete))
    assert not capabilities.can_undo
    monkeypatch.setattr(undo, "get_sheets_repo", lambda: pytest.fail("Must guard before requesting a worksheet"))
    ok, message = undo._apply_undo_action(setup.logged.action, action_id=setup.logged.id)
    assert not ok and "reimbursement" in message.lower()
    def unavailable():
        raise ConnectionError("Canonical database unavailable")
    monkeypatch.setattr(service, "build_reimbursement_store", unavailable)
    with pytest.raises(ConnectionError):
        service.is_managed(allocation["id"])
    monkeypatch.setattr(store_module, "build_reimbursement_store", unavailable)
    with pytest.raises(ConnectionError):
        undo._canonical_action(logged)
    with pytest.raises(ConnectionError):
        undo._apply_undo_action(logged.action, action_id=logged.id)


def test_durable_receipt_replay_recovers_after_projection_setup_failure(setup, monkeypatch):
    split(setup)
    allocation = setup.store.snapshot("brian")["allocations"][0]
    body = payment(allocation, 5000)
    original = auth.get_gspread_client
    monkeypatch.setattr(auth, "get_gspread_client", lambda: (_ for _ in ()).throw(ConnectionError("offline")))
    with pytest.raises(ConnectionError):
        service.command("brian", body)
    assert setup.store.get_allocation(allocation["id"])["settledCents"] == 5000
    assert len(setup.store.snapshot("brian")["events"]) == 1
    monkeypatch.setattr(auth, "get_gspread_client", original)
    result = service.command("brian", body)
    assert not result["projectionPending"]
    assert len(result["events"]) == 1 and setup.sheet.read(2, 31, 32) == [414.72]


@pytest.mark.parametrize("received", [5000, 16391])
@pytest.mark.parametrize("old_person", ["Brian (BofA)", "Hannah"])
def test_bank_matching_keeps_one_original_gross_candidate_after_cash_settlement_and_payer_repair(setup, monkeypatch, received, old_person):
    from bookiebot.banking.reconciliation import find_action_log_candidates
    from unit_tests.banking.test_reconciliation import _transaction
    split(setup)
    allocation = setup.store.snapshot("brian")["allocations"][0]
    # A reviewed legacy payer repair does not rewrite the original bank event:
    # its actor and gross amount stay as captured, even if the old person was wrong.
    source = undo.LoggedAction(id=setup.logged.id, created_at="2026-01-03T12:00:00", user_key=BRIAN,
        action=replace(setup.logged.action, metadata={"type": "expense", "category": "need_expenses", "person": old_person},
                       new_values=["1/3/2026", "T", "464.72", "Gameday", old_person]))
    split_history = undo.LoggedAction(id=allocation["splitActionId"], created_at="2026-01-03T12:01:00", user_key=BRIAN, action=setup.history[0])
    monkeypatch.setattr(undo, "_read_log", lambda: [source, split_history])
    service.command("brian", payment(allocation, received))
    transaction = replace(_transaction("Gameday", 464.72), date="2026-01-03")
    actions = undo.read_active_logged_actions(BRIAN)
    candidates = find_action_log_candidates(transaction, actions, classification="expense")
    assert [(item.action_id, item.amount) for item in candidates] == [(source.id, 464.72)]
    assert undo.read_active_logged_actions("830984827904851969") == []
    assert len(actions) == 2 and len(setup.history) == 1, "Projection creates no duplicate bank-matchable action-log expense"
    assert setup.sheet.read(2, 31, 32) == [(46472 - received) / 100]


def selected(setup):
    value = setup.store.find_by_source(setup.logged.id, routing.now_pacific().year)
    return SimpleNamespace(id=value["splitActionId"], action=replace(setup.history[0], metadata={
        **setup.history[0].metadata, "canonical_version": str(value["version"])}))


def test_edit_split_changes_allocation_only_then_update_preserves_method(setup):
    split(setup)
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "split", split_method="equal")
    assert ok and "50/50" in message and "syncing" not in message
    value = setup.store.snapshot("brian")["allocations"][0]
    assert value["method"] == "equal" and value["partnerShareCents"] == 23236
    assert setup.sheet.read(2, 31, 32) == [464.72]
    assert len(setup.history) == 1
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "update", updates={"amount": "500.01", "location": "Costco"})
    assert ok and "syncing" not in message
    value = setup.store.snapshot("brian")["allocations"][0]
    assert value["method"] == "equal" and value["grossCents"] == 50001
    assert value["payerShareCents"] == 25001 and value["partnerShareCents"] == 25000
    assert setup.sheet.read(2, 29, 34) == ["1/3/2026", "Hannah's T", 500.01, "Costco", "Brian (BofA)"]
    response = service.command("brian", payment(value, 1000))
    assert not response["projectionPending"]
    assert setup.sheet.read(2, 31, 32) == [490.01]


def test_split_move_preserves_obligation_and_repeated_move_prompts_for_missing_item(setup, monkeypatch):
    split(setup)
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "move", destination_category="grocery")
    assert ok and "syncing" not in message
    value = setup.store.snapshot("brian")["allocations"][0]
    assert value["category"] == "grocery" and value["sourceColumnMap"] == {"date": 1, "amount": 2, "location": 3, "person": 4}
    assert value["partnerShareCents"] == 16391 and value["sourceRow"] == 3
    assert setup.sheet.read(2, 0, 4) == ["1/3/2026", 464.72, "Gameday", "Brian (BofA)"]
    assert setup.sheet.read(2, 29, 34) == [""] * 5
    pending = []
    monkeypatch.setattr(undo, "set_pending_move_item", lambda *args: pending.append(args))
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "move", destination_category="food")
    assert not ok and "item name" in message and pending
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "move", destination_category="food", updates={"item": "Dinner"})
    assert ok and "syncing" not in message
    assert setup.sheet.read(2, 13, 18) == ["1/3/2026", "Dinner", 464.72, "Gameday", "Brian (BofA)"]
    assert setup.sheet.read(2, 0, 4) == [""] * 4


@pytest.mark.parametrize("failure", ["none", "lost_batch", "neighbor_mirror"])
def test_shopping_to_needs_repairs_neighbor_and_books_full_reimbursement_under_needs(setup, monkeypatch, failure):
    from copy import deepcopy
    from bookiebot.reimbursements import mirror
    from bookiebot.sheets.collaboration import allocations_from_rows
    assert split(setup)[0]
    assert service.mutate_recent_action(BRIAN, selected(setup), "move", destination_category="shopping")[0]
    shopping = {"date": 22, "item": 23, "amount": 24, "location": 25, "person": 26}
    neighbor_values = {"date": "1/4/2026", "item": "Mirror-tap", "amount": "50.59", "location": "Amazon", "person": "Hannah"}
    setup.sheet.write(3, 21, list(neighbor_values.values()))
    neighbor = setup.store.register_allocation(payload(
        payerOwner="hannah", partnerOwner="brian", payerPerson="Hannah", category="shopping",
        item="Mirror-tap", location="Amazon", expenseDate="2026-01-04", sourceYear=2026,
        sourceWorksheet="expense", sourceSpreadsheetId="shared", sourceSheetTitle="January", sourceRow=4,
        sourceColumnMap=shopping, sourceValues=neighbor_values, grossCents=5059,
        payerShareCents=3000, partnerShareCents=2059))
    assert projection.sync_pending(setup.store)
    neighbor = setup.store.get_allocation(neighbor["id"])
    setup.sheet.write(4, 21, ["", "Curtains draft", "", "Amazon", ""])
    if failure == "lost_batch":
        setup.book.timeout_after_batch = True
    elif failure == "neighbor_mirror":
        original_mirror = mirror.mirror_allocation
        failed = False
        def fail_once(client, allocation, **kwargs):
            nonlocal failed
            if allocation["id"] == neighbor["id"] and not failed:
                failed = True
                raise TimeoutError("Neighbor mirror unavailable after compaction")
            return original_mirror(client, allocation, **kwargs)
        monkeypatch.setattr(mirror, "mirror_allocation", fail_once)
    stale = selected(setup)
    ok, message = service.mutate_recent_action(BRIAN, stale, "move", destination_category="needs")
    assert ok and ("syncing" in message) == (failure != "none")
    ok, message = service.mutate_recent_action(BRIAN, stale, "move", destination_category="needs")
    assert ok and "syncing" not in message
    current = setup.store.find_by_source(setup.logged.id, 2026)
    repaired = setup.store.get_allocation(neighbor["id"])
    assert repaired["sourceRow"] == 3 and repaired["version"] == repaired["projectedVersion"] == neighbor["version"]
    assert setup.sheet.read(2, 21, 26) == ["1/4/2026", "Mirror-tap", 50.59, "Amazon", "Hannah"]
    assert setup.sheet.read(3, 21, 26) == ["", "Curtains draft", "", "Amazon", ""]
    assert setup.sheet.read(4, 21, 26) == [""] * 5
    mapped = {row.allocation_id: row for row in allocations_from_rows(setup.book.worksheet("Shared Reimbursements").rows)}
    assert mapped[current["id"]].source_category == "need_expenses"
    assert mapped[neighbor["id"]].source_row == 3
    # Stable event/action identities expose current Needs details, never a second
    # Shopping purchase. Direct canonical Undo still cannot bypass the ledger.
    logged = undo.LoggedAction(current["splitActionId"], "2026-01-03", BRIAN, setup.history[0])
    active = undo.canonical_logged_actions([logged])[0]
    assert active.action.metadata["category"] == "need_expenses"
    assert not undo.action_capabilities(active.action).can_undo
    response = service.command("brian", payment(current, 16391))
    assert not response["projectionPending"]
    receipt = response["events"][0]
    full = setup.book.names[projection._name("receipt", receipt["id"])]["range"]
    assert (full["startColumnIndex"], full["endColumnIndex"]) == (29, 34)
    assert receipt_row(setup.book, receipt["id"])[1:] == ["Reimbursement · Hannah's T", 163.91, "Reimbursement to Brian · Gameday", "Hannah"]
    assert setup.sheet.read(current["sourceRow"] - 1, 31, 32) == [300.81]
    assert setup.sheet.read(2, 23, 24) == [50.59]
    mapped = {row.allocation_id: row for row in allocations_from_rows(setup.book.worksheet("Shared Reimbursements").rows)}
    assert mapped[current["id"]].source_category == "need_expenses"
    assert mapped[current["id"]].status == "reimbursed" and mapped[current["id"]].received_amount == 163.91
    # A reversed receipt retains its Needs event anchor and exactly one row.
    service.command("brian", command("reverse", eventId=receipt["id"]))
    assert receipt_row(setup.book, receipt["id"])[2] == 0
    assert setup.sheet.read(current["sourceRow"] - 1, 31, 32) == [464.72]
    # Reset Undo/Redo has its own event history and never changes the moved
    # purchase's category, source cells or recorded repayment/reversal events.
    before_rows = {name: deepcopy(sheet.rows) for name, sheet in setup.book.sheets.items() if name != "Shared Reimbursements"}
    before_events = setup.store.snapshot("brian")["events"]
    result = service.command("brian", command("reset", expectedState=setup.store.snapshot("brian")["resetState"]))
    for operation in ("undo_reset", "redo_reset"):
        record = result["resets"][0]
        result = service.command("brian", command(operation, resetId=record["id"], version=record["version"]))
        assert not result["projectionPending"]
        assert result["events"] == before_events
        assert {name: sheet.rows for name, sheet in setup.book.sheets.items() if name != "Shared Reimbursements"} == before_rows
        assert setup.store.get_allocation(current["id"])["category"] == "need_expenses"


@pytest.mark.parametrize("mirror_failure", [False, True])
def test_ordinary_move_and_undo_keep_canonical_neighbor_positions_and_settlements_aligned(setup, monkeypatch, mirror_failure):
    from copy import deepcopy
    from bookiebot.reimbursements import mirror
    from bookiebot.sheets.collaboration import allocations_from_rows
    from bookiebot.sheets.routing import sheet_user_context
    assert split(setup)[0]
    current = setup.store.find_by_source(setup.logged.id, 2026)
    # Add a plain purchase above the canonical T, as a native insert does.
    setup.sheet.insert(2, 29, 34)
    setup.sheet.write(2, 29, ["1/2/2026", "Plain purchase", 10, "Store", "Hannah"])
    setup.sheet.spreadsheet = setup.book
    setup.book.id = "shared"
    columns = list(FIELDS.values())
    with sheet_user_context(BRIAN):
        undo._shift_category_cells_up(setup.sheet, start_row=3, end_row=4, columns=columns)
    # T returns to row 3. Insert for Undo moves it to row 4 again, preserving its
    # named anchors and both ledger copies before the later reimbursement.
    monkeypatch.setattr(undo, "_update_contiguous_row", lambda ws, row, cols, vals: ws.write(row - 1, min(cols) - 1, vals))
    if mirror_failure:
        original_mirror = mirror.mirror_allocation
        def fail_once(client, allocation, **_kwargs):
            monkeypatch.setattr(mirror, "mirror_allocation", original_mirror)
            raise TimeoutError("Mirror unavailable after a successful legacy Undo")
        monkeypatch.setattr(mirror, "mirror_allocation", fail_once)
    with sheet_user_context(BRIAN):
        undo._restore_removed_category_row(setup.sheet, category="need_expenses", row=3, columns=columns,
            values=["1/2/2026", "Plain purchase", "10", "Store", "Hannah"], restored_ids=set(),
            log_data=undo._ActionLogData(ws=SimpleNamespace(), records=[]))
    if mirror_failure:
        assert setup.store.get_allocation(current["id"])["sourceRow"] == 3
        before = deepcopy(setup.sheet.rows)
        assert not service.snapshot("brian", retry_projection=True)["projectionPending"]
        assert setup.sheet.rows == before, "Metadata recovery must never repeat the structural operation"
    current = setup.store.get_allocation(current["id"])
    assert current["sourceRow"] == 4
    mirrored = allocations_from_rows(setup.book.worksheet("Shared Reimbursements").rows)[0]
    assert mirrored.source_row == 4
    response = service.command("brian", payment(current, 5000))
    assert not response["projectionPending"]
    assert setup.sheet.read(2, 31, 32) == ["10"]
    assert setup.sheet.read(3, 31, 32) == [414.72]


def test_row_metadata_recovery_failure_stays_visible_without_pending_financial_version(setup, monkeypatch):
    from copy import deepcopy
    from bookiebot.reimbursements import mirror
    assert split(setup)[0]
    setup.sheet.insert(2, 29, 34)
    before = deepcopy(setup.sheet.rows)
    original_mirror = mirror.mirror_allocation
    monkeypatch.setattr(mirror, "mirror_allocation", lambda *_args, **_kw: (_ for _ in ()).throw(TimeoutError("Mirror unavailable")))
    snapshot = service.snapshot("brian", retry_projection=True)
    assert snapshot["projectionPending"]
    assert all(value["version"] == value["projectedVersion"] for value in snapshot["allocations"])
    monkeypatch.setattr(mirror, "mirror_allocation", original_mirror)
    snapshot = service.snapshot("brian", retry_projection=True)
    assert not snapshot["projectionPending"] and snapshot["allocations"][0]["sourceRow"] == 4
    assert setup.sheet.rows == before


def test_cancel_update_reactivate_then_delete_split_preserves_original_history(setup):
    split(setup)
    original = setup.store.snapshot("brian")["allocations"][0]
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "cancel")
    assert ok and "syncing" not in message
    assert setup.store.snapshot("hannah")["allocations"] == []
    assert setup.sheet.read(2, 31, 32) == [464.72]
    mirror = setup.book.worksheet("Shared Reimbursements").get_all_values()
    assert "void" in mirror[1]
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "update", updates={"amount": "600"})
    assert ok and "syncing" not in message
    assert setup.store.snapshot("brian")["allocations"] == []
    assert setup.sheet.read(2, 31, 32) == [600]
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "split", split_method="equal")
    assert ok and "syncing" not in message
    value = setup.store.snapshot("hannah")["allocations"][0]
    assert value["id"] == original["id"] and value["outstandingCents"] == 30000
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "delete")
    assert ok and "syncing" not in message
    assert setup.store.snapshot("brian")["allocations"] == []
    assert setup.sheet.read(2, 29, 34) == [""] * 5
    assert len(setup.history) == 1
    assert setup.store.get_allocation(value["id"])["lifecycle"] == "deleted"


def test_correction_replay_recovers_lost_projection_response_without_duplicate_revision(setup):
    split(setup)
    stale = selected(setup)
    setup.book.timeout_after_values = True
    params = dict(user_key=BRIAN, logged=stale, operation="update", updates={"amount": "500", "location": "Costco"})
    ok, message = service.mutate_recent_action(**params)
    assert ok and "syncing" in message
    first = setup.store.snapshot("brian")["allocations"][0]
    assert first["version"] != first["projectedVersion"]
    assert setup.sheet.read(2, 31, 33) == [500, "Costco"]
    ok, message = service.mutate_recent_action(**params)
    assert ok and "syncing" not in message
    current = setup.store.get_allocation(first["id"])
    assert current["version"] == current["projectedVersion"] == first["version"]
    with setup.store.access.connect() as db:
        assert db.execute("SELECT COUNT(*) AS n FROM app_reimbursement_revisions").fetchone()["n"] == 1


def test_correction_stale_owner_and_unsupported_fields_cannot_change_source(setup):
    split(setup)
    stale = selected(setup)
    assert service.mutate_recent_action(BRIAN, stale, "update", updates={"location": "Costco"})[0]
    assert not service.mutate_recent_action(BRIAN, stale, "update", updates={"amount": "200"})[0]
    for updates in ({"person": "Hannah"}, {"date": "9/15/2026"}, {"amount": "100.001"}, {"amount": "0"}):
        ok, _ = service.mutate_recent_action(BRIAN, selected(setup), "update", updates=updates)
        assert not ok
    assert setup.sheet.read(2, 29, 34) == ["1/3/2026", "Hannah's T", 464.72, "Costco", "Brian (BofA)"]


def test_correction_after_reversed_receipt_keeps_old_receipt_zero_and_new_receipt_current(setup):
    split(setup)
    value = setup.store.snapshot("brian")["allocations"][0]
    paid = service.command("brian", payment(value, 5000))
    assert not service.mutate_recent_action(BRIAN, selected(setup), "update", updates={"amount": "500"})[0]
    event = paid["events"][0]
    service.command("brian", command("reverse", eventId=event["id"]))
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), "move", destination_category="grocery")
    assert ok and "syncing" not in message
    assert receipt_row(setup.book, event["id"])[2] == 0
    value = setup.store.snapshot("brian")["allocations"][0]
    paid = service.command("brian", payment(value, 2000))
    assert not paid["projectionPending"]
    assert setup.sheet.read(value["sourceRow"] - 1, 1, 2) == [444.72]
    assert receipt_row(setup.book, event["id"])[2] == 0


@pytest.mark.parametrize("operation", ["move", "delete"])
def test_move_delete_retry_finishes_saved_correction_without_repeating_write(setup, operation):
    split(setup)
    stale = selected(setup)
    if operation == "move":
        setup.book.timeout_after_batch = True
    else:
        setup.book.timeout_after_values = True
    params = dict(user_key=BRIAN, logged=stale, operation=operation)
    if operation == "move":
        params["destination_category"] = "grocery"
    ok, message = service.mutate_recent_action(**params)
    assert ok and "syncing" in message
    first = setup.store.get_allocation(stale.action.metadata["allocation_id"])
    ok, message = service.mutate_recent_action(**params)
    assert ok and "syncing" not in message
    current = setup.store.get_allocation(first["id"])
    assert current["version"] == current["projectedVersion"] == first["version"]


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_saved_correction_and_no_change_retry_survive_projection_setup_failure(setup, monkeypatch, operation):
    split(setup)
    stale = selected(setup)
    original = auth.get_gspread_client
    monkeypatch.setattr(auth, "get_gspread_client", lambda: (_ for _ in ()).throw(ConnectionError("offline")))
    params = dict(user_key=BRIAN, logged=stale, operation=operation)
    if operation == "update":
        params["updates"] = {"amount": "500"}
    for _ in range(2):
        ok, message = service.mutate_recent_action(**params)
        assert ok and "change is saved" in message
        assert "Open Shared in the app and refresh to retry syncing." in message
    pending = setup.store.get_allocation(stale.action.metadata["allocation_id"])
    assert pending["version"] == int(stale.action.metadata["canonical_version"]) + 1
    monkeypatch.setattr(auth, "get_gspread_client", original)
    ok, message = service.mutate_recent_action(**params)
    assert ok and "syncing" not in message
    current = setup.store.get_allocation(pending["id"])
    assert current["version"] == current["projectedVersion"] == pending["version"]
