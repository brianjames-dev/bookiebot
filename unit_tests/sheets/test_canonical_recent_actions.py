import copy
from types import SimpleNamespace

import pytest

from bookiebot.reimbursements import service, store as store_module
from bookiebot.reimbursements.store import ReimbursementConflictError
from bookiebot.sheets import undo


ACTOR = "676638528590970917"


@pytest.fixture
def canonical(monkeypatch):
    value = {
        "id": "allocation", "payerOwner": "brian", "partnerOwner": "hannah",
        "payerPerson": "Brian (BofA)", "version": 3, "accounting": "cash_v1",
        "sourceActionId": "source", "splitActionId": "split", "sourceWorksheet": "expense",
        "sourceRow": 3, "category": "grocery", "method": "income", "lifecycle": "active",
        "grossCents": 9234, "payerShareCents": 5977, "partnerShareCents": 3257,
        "item": "Grocery", "location": "Costco Wholesale",
        "sourceColumnMap": {"date": 1, "amount": 2, "location": 3, "person": 4},
        "sourceValues": {"date": "9/16/2026", "amount": "92.34", "location": "Costco Wholesale", "person": "Brian (BofA)"},
    }
    action = undo.UndoAction(worksheet="expense", kind="restore_cells", row=3, columns=[2], previous_values=["92.34"],
        new_values=list(value["sourceValues"].values()), description="split grocery",
        metadata={"type": "split", "category": "grocery", "allocation_id": "allocation", "accounting": "cash_v1",
                  "source_action_id": "source"})
    logged = undo.LoggedAction("split", "2026-09-16", ACTOR, action)
    store = SimpleNamespace(get_allocation=lambda _id: value, find_by_source=lambda *_args: value,
                           snapshot=lambda _owner, **_kwargs: {"allocations": [value]})
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    monkeypatch.setattr(store_module, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(undo, "active_logged_action_by_id", lambda *_args: logged)
    monkeypatch.setattr(undo, "_active_lineage_ids", lambda logged: {logged.id})
    monkeypatch.setattr(undo, "_worksheet", lambda *_args: pytest.fail("Canonical corrections must use the ledger projection"))
    synced = []
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", lambda actor, ids, **kw: synced.append((actor, ids, kw)))
    return SimpleNamespace(value=value, logged=logged, synced=synced)


def test_split_capabilities_preserve_transaction_fields_and_all_actions(canonical):
    current = undo.select_recent_action(ACTOR, action_id="split")
    assert current is not None
    capabilities = undo.action_capabilities(current.action)
    assert capabilities.can_update and capabilities.can_move and capabilities.can_delete
    assert capabilities.can_change_split and capabilities.can_cancel_split
    assert not capabilities.can_split and not capabilities.can_undo
    assert capabilities.editable_fields == ["amount", "location", "person"]


def test_canonical_bill_keeps_amount_only_updates_and_cannot_move_or_delete(canonical):
    canonical.value.update(sourceWorksheet="income", category="rent", sourceColumnMap={"amount": 3, "item": 2})
    current = undo.select_recent_action(ACTOR, action_id="split")
    assert current is not None
    capabilities = undo.action_capabilities(current.action)
    assert capabilities.can_update and capabilities.can_change_split
    assert capabilities.editable_fields == ["amount"]
    assert not capabilities.can_move and not capabilities.can_delete


@pytest.mark.parametrize("operation", ["update", "move", "split", "cancel", "delete"])
def test_selected_split_routes_every_operation_through_canonical_service(canonical, monkeypatch, operation):
    calls = []
    monkeypatch.setattr(service, "mutate_recent_action", lambda actor, logged, op, **kw: (calls.append((actor, logged, op, kw)) or (True, "Saved")), raising=False)
    functions = {
        "update": lambda: undo.update_recent_action(ACTOR, action_id="split", updates={"amount": "100.00", "location": "Costco"}),
        "move": lambda: undo.move_recent_action(ACTOR, action_id="split", destination_category="food", updates={"item": "Groceries"}),
        "split": lambda: undo.change_split_recent_action(ACTOR, action_id="split", split_method="equal"),
        "cancel": lambda: undo.cancel_split_recent_action(ACTOR, action_id="split"),
        "delete": lambda: undo.delete_recent_action(ACTOR, action_id="split"),
    }
    assert functions[operation]() == (True, "Saved")
    assert len(calls) == 1 and calls[0][0] == ACTOR and calls[0][2] == operation
    assert calls[0][1].action.metadata["canonical_version"] == "3"
    if operation in {"update", "move", "delete"}:
        assert canonical.synced[0][1] == {"source", "split"}
    else:
        assert canonical.synced == []


def test_canonical_move_still_prompts_for_missing_item(canonical, monkeypatch):
    monkeypatch.setattr(service, "mutate_recent_action", lambda *_a, **_kw: pytest.fail("Must collect required item"), raising=False)
    ok, detail = undo.move_recent_action(ACTOR, action_id="split", destination_category="food")
    assert not ok and "item" in detail.lower()
    undo.clear_pending_action_selection(ACTOR)


def test_saved_canonical_move_retry_reaches_projection_recovery(canonical, monkeypatch):
    calls = []
    monkeypatch.setattr(service, "mutate_recent_action", lambda *args, **kw: (calls.append((args, kw)) or (True, "Synced")))
    assert undo.move_recent_action(ACTOR, action_id="split", destination_category="grocery") == (True, "Synced")
    assert calls[0][0][2] == "move"


def test_ordinary_selection_ignores_unmapped_history_during_canonical_lookup(canonical, monkeypatch):
    from dataclasses import replace
    selected = replace(canonical.logged, id="unlinked", action=replace(canonical.logged.action,
        metadata={"type": "expense", "category": "grocery"}))
    unrelated = replace(selected, id="legacy", user_key="unmapped-legacy-user")
    monkeypatch.setattr(undo, "_read_log", lambda: [unrelated, selected])
    monkeypatch.setattr(store_module, "build_reimbursement_store", lambda: SimpleNamespace(
        find_by_source=lambda *_args: None, snapshot=lambda _owner, **_kwargs: {"allocations": []}))
    assert undo._canonical_action(selected) == selected


def test_canceled_split_can_be_resplit_using_same_managed_source(canonical, monkeypatch):
    canonical.value["lifecycle"] = "void"
    current = undo.select_recent_action(ACTOR, action_id="split")
    assert current is not None
    capabilities = undo.action_capabilities(current.action)
    assert capabilities.can_split and not capabilities.can_change_split
    assert capabilities.can_update and capabilities.can_move and capabilities.can_delete
    calls = []
    monkeypatch.setattr(service, "mutate_recent_action", lambda *args, **kw: (calls.append((args, kw)) or (True, "Split saved")), raising=False)
    assert undo.split_recent_action(ACTOR, action_id="split", split_method="equal")[0]
    assert calls[0][0][2] == "split"


def test_canonical_conflict_does_not_touch_sheet_or_reopen_reconciliation(canonical, monkeypatch):
    def conflict(*_args, **_kwargs):
        raise ReimbursementConflictError("Reverse the confirmed repayment first.")
    monkeypatch.setattr(service, "mutate_recent_action", conflict, raising=False)
    ok, detail = undo.update_recent_action(ACTOR, action_id="split", updates={"amount": "100"})
    assert not ok and "Reverse" in detail
    assert canonical.synced == []


def test_live_overlay_keeps_audit_immutable_and_bank_candidate_at_corrected_gross(canonical):
    from dataclasses import replace
    from bookiebot.banking.reconciliation import _action_candidate
    source = replace(canonical.logged, id="source", action=replace(canonical.logged.action,
        metadata={"type": "expense", "category": "grocery"}, description="grocery $92.34 at Costco Wholesale"))
    originals = copy.deepcopy([source, canonical.logged])
    canonical.value.update(grossCents=10000, payerShareCents=6473, partnerShareCents=3527, sourceRow=7, location="Safeway")
    result = undo.canonical_logged_actions([source, canonical.logged], for_reconciliation=True)
    assert len(result) == 2
    candidate = _action_candidate(result[0])
    assert candidate is not None and candidate["amount"] == 100
    assert "Costco" not in candidate["text"]
    assert _action_candidate(result[1]) is None
    assert result[0].action.row == 7 and "Safeway" in result[0].action.new_values
    assert [source, canonical.logged] == originals
    canonical.value["lifecycle"] = "deleted"
    assert undo.canonical_logged_actions([source, canonical.logged], for_reconciliation=True) == []
    assert undo.select_recent_action(ACTOR, action_id="split") is None


def test_wrong_owner_allocation_cannot_be_selected(canonical):
    canonical.value["payerOwner"] = "hannah"
    assert undo.select_recent_action(ACTOR, action_id="split") is None


def test_split_after_update_manages_ancestors_and_retains_one_corrected_bank_candidate(canonical, monkeypatch):
    from dataclasses import replace
    from bookiebot.banking.reconciliation import _action_candidate
    original = replace(canonical.logged, id="original", action=replace(canonical.logged.action,
        metadata={"type": "expense", "category": "grocery"}))
    source = replace(canonical.logged, id="source", action=replace(canonical.logged.action,
        metadata={"type": "update", "category": "grocery", "updated_action_id": "original"}))
    history = [original, source, canonical.logged]
    actions = undo.canonical_logged_actions(history, for_reconciliation=True)
    candidates = [entry.id for entry in actions if _action_candidate(entry)]
    assert candidates == ["source"]
    monkeypatch.setattr(undo, "_read_log", lambda: history)
    monkeypatch.setattr(store_module, "build_reimbursement_store", lambda: SimpleNamespace(
        find_by_source=lambda *_args: None, snapshot=lambda _owner, **_kwargs: {"allocations": [canonical.value]}))
    selected = undo._canonical_action(original)
    assert selected is not None and selected.action.metadata["canonical_reimbursement"] == "true"
    canonical.value["lifecycle"] = "deleted"
    assert undo._canonical_action(original) is None


def test_bank_overlay_traces_through_inactive_update_before_move_and_split(canonical):
    from dataclasses import replace
    from bookiebot.banking.reconciliation import _action_candidate
    original = replace(canonical.logged, id="original", action=replace(canonical.logged.action,
        metadata={"type": "expense", "category": "grocery"}))
    updated = replace(original, id="updated", status="undone", action=replace(original.action,
        metadata={"type": "update", "updated_action_id": "original"}))
    moved = replace(original, id="source", action=replace(original.action,
        metadata={"type": "move", "source_action_id": "updated"}))
    active = [original, moved, canonical.logged]
    actions = undo.canonical_logged_actions(active, for_reconciliation=True, history=[original, updated, moved, canonical.logged])
    assert [entry.id for entry in actions if _action_candidate(entry)] == ["source"]
