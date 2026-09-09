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
from unit_tests.reimbursements.test_store import access, command, payment  # noqa: F401

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


def test_canonical_lookup_outage_fails_closed_and_undo_never_touches_sheet(setup, monkeypatch):
    split(setup)
    allocation = setup.store.snapshot("brian")["allocations"][0]
    assert service.is_managed(allocation["id"])
    logged = undo.LoggedAction(id=setup.logged.id, created_at="2026-01-03", user_key=BRIAN, action=setup.logged.action)
    guarded = undo._canonical_action(logged)
    assert guarded is not None and guarded.action.metadata["allocation_id"] == allocation["id"]
    capabilities = undo.action_capabilities(guarded.action)
    assert not any((capabilities.can_update, capabilities.can_move, capabilities.can_split, capabilities.can_change_split,
                    capabilities.can_cancel_split, capabilities.can_delete, capabilities.can_undo))
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
