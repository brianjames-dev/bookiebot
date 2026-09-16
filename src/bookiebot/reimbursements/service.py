"""Application boundary for the durable, confirmed-payment reimbursement model."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import hashlib
import json
import logging
import os
import re
from typing import Any

from bookiebot.reimbursements.store import (
    MAX_CENTS, build_reimbursement_store, ReimbursementConflictError,
    ReimbursementNotFoundError, ReimbursementValidationError,
)
from bookiebot.sheets.routing import get_user_config, now_pacific

logger = logging.getLogger(__name__)


def enabled() -> bool:
    return os.getenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false").strip().lower() in {"1", "true", "yes"}


def money_cents(value: Any) -> int:
    """Parse an amount without rounding, coercing invalid text, or losing cents."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ReimbursementValidationError("Enter a nonnegative amount using whole cents.")
    raw = str(value).strip()
    if not re.fullmatch(r"\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?", raw):
        raise ReimbursementValidationError("Enter a nonnegative amount using whole cents.")
    number = Decimal(raw.replace("$", "").replace(",", "")) * 100
    if number > MAX_CENTS:
        raise ReimbursementValidationError("The amount is too large.")
    return int(number)


def is_managed(allocation_id: str) -> bool:
    if not enabled() or not allocation_id:
        return False
    try:
        build_reimbursement_store().get_allocation(allocation_id)
        return True
    except ReimbursementNotFoundError:
        return False
    # Storage unavailability propagates; it must never permit a legacy mutation.


def snapshot(owner: str, *, retry_projection: bool = False) -> dict[str, Any]:
    store = build_reimbursement_store()
    if retry_projection:
        from bookiebot.reimbursements.projection import sync_pending
        sync_pending(store)
    result = store.snapshot(owner)
    return {**result, "enabled": True, "ownerKey": owner,
            "projectionPending": any(row["version"] != row["projectedVersion"] for row in result["allocations"])}


def command(owner: str, body: dict[str, Any]) -> dict[str, Any]:
    store = build_reimbursement_store()
    result = store.command(owner, body)
    from bookiebot.reimbursements.projection import sync_pending
    synced = sync_pending(store)
    return {**result, **snapshot(owner), "projectionPending": not synced}


def record_split(user_key: str, logged: Any, ws: Any, fields: dict[str, int], values: dict[str, str],
                 payer: str, method: str, gross: float, payer_share: float, partner_share: float) -> tuple[bool, str]:
    """Create one durable allocation before any projection changes sheet values."""
    from bookiebot.sheets.collaboration import partner_owner_key
    from bookiebot.sheets.routing import get_shared_expenses_spreadsheet_id, get_budget_spreadsheet_id_for_user
    from bookiebot.sheets.reimbursement_history import _expense_date
    from bookiebot.sheets.undo import UndoAction, record_undo_action
    owner = get_user_config(user_key).budget_owner_key
    fields, values = dict(fields), dict(values)
    if values.get("person") and values["person"] != payer:
        raise ReimbursementValidationError("The source expense payer must match the person recording this split.")
    if logged.action.worksheet != "expense" and "item" not in fields:
        # Fixed bills previously retained only their amount cell. A stable label
        # is also needed to locate the same bill safely after rows move.
        label = str(ws.cell(logged.action.row, 2).value or "")
        if not label.strip():
            raise ReimbursementValidationError("The source bill label could not be verified.")
        fields["item"], values["item"] = 2, label
    today = now_pacific().date()
    spent_on = _expense_date(values.get("date", "")) or today
    year = today.year  # Recent actions belong to the active source workbook.
    identity = hashlib.sha256(f"{owner}:{year}:{logged.id}".encode()).hexdigest()[:24]
    store = build_reimbursement_store()
    try:
        allocation = store.get_allocation(identity)
    except ReimbursementNotFoundError:
        allocation = None
    amounts = {"grossCents": money_cents(gross), "payerShareCents": money_cents(payer_share),
               "partnerShareCents": money_cents(partner_share)}
    if allocation is not None and any(allocation.get(key) != value for key, value in {
        **amounts, "payerOwner": owner, "payerPerson": payer, "method": method,
        "sourceActionId": logged.id, "sourceWorksheet": logged.action.worksheet,
    }.items()):
        raise ReimbursementConflictError("This source expense already has a different recorded split.")
    if allocation is None:
        if money_cents(values.get("amount")) != amounts["grossCents"]:
            raise ReimbursementValidationError("The source expense amount changed. Review it before splitting.")
        source_id = (get_shared_expenses_spreadsheet_id(year) if logged.action.worksheet == "expense"
                     else get_budget_spreadsheet_id_for_user(user_key, year))
        payload = {
            "id": identity, "payerOwner": owner, "partnerOwner": partner_owner_key(owner), "payerPerson": payer,
            "item": values.get("item") or logged.action.metadata.get("category") or "Shared expense",
            "location": values.get("location", ""), "expenseDate": spent_on.isoformat(),
            "category": logged.action.metadata.get("category", ""), "sourceWorksheet": logged.action.worksheet,
            "sourceRow": logged.action.row, "sourceActionId": logged.id, "splitActionId": "", "sourceYear": year,
            "sourceSpreadsheetId": source_id, "sourceSheetTitle": ws.title,
            "sourceColumnMap": fields, "sourceValues": values, "actorKey": user_key,
            **amounts, "settledCents": 0, "method": method, "accounting": "cash_v1",
        }
        allocation = store.register_allocation(payload)
    if not allocation["splitActionId"]:
        split_id = record_undo_action(user_key, UndoAction(
            worksheet=logged.action.worksheet, kind="restore_cells", row=logged.action.row,
            columns=[fields["amount"]], previous_values=[values["amount"]], new_values=list(values.values()),
            metadata={**logged.action.metadata, "type": "split", "source_action_id": logged.id,
                      "allocation_id": identity, "accounting": "cash_v1", "split_method": method,
                      "gross_amount": f"{gross:.2f}", "payer_share": f"{payer_share:.2f}",
                      "partner_share": f"{partner_share:.2f}", "original_person": payer,
                      "responsible_person": payer, "responsible_owner_key": owner,
                      "display_fields": json.dumps(list(fields)), "split_operation": "apply"},
            description=f"split {logged.action.description}"))
        if split_id is None:
            return True, "The split is recorded. Action history still needs syncing; no payment has been marked received."
        store.attach_source(identity, {"splitActionId": split_id})
    from bookiebot.reimbursements.projection import sync_pending
    synced = sync_pending(store)
    partner = partner_owner_key(owner).title()
    message = (f"{owner.title()} paid ${gross:.2f}. {partner} owes {owner.title()} ${partner_share:.2f}. "
               "The full purchase stays in the payer's expenses until repayment is confirmed.")
    if not synced:
        message += " The split is saved; expense sheets are still syncing."
    return True, message


def _current_source_values(value: dict[str, Any]) -> dict[str, str]:
    result = dict(value.get("sourceValues", {}))
    result["amount"] = f"{(value['grossCents'] - value['settledCents']) / 100:.2f}"
    for field, key in (("item", "item"), ("location", "location"), ("person", "payerPerson")):
        if field in value.get("sourceColumnMap", {}) and (field != "item" or value["sourceWorksheet"] == "expense"):
            result[field] = value[key]
    return result


def mutate_recent_action(user_key: str, logged: Any, operation: str, *,
                         updates: dict[str, Any] | None = None, destination_category: str | None = None,
                         split_method: str | None = None) -> tuple[bool, str]:
    """Correct one canonical expense and replay its desired sheet state.

    Recent-action records keep their stable IDs. The ledger's durable revisions
    are the correction audit trail; recent-action readers overlay the current
    source details instead of introducing a second independently written log.
    """
    from gspread.utils import a1_to_rowcol
    from bookiebot.sheets.collaboration import normalize_split_method, split_amounts, split_method_label
    from bookiebot.sheets.config import expense_category_label, get_category_columns, normalize_expense_category
    from bookiebot.sheets import undo
    from bookiebot.reimbursements.projection import sync_pending

    try:
        owner = get_user_config(user_key).budget_owner_key
        store = build_reimbursement_store()
        allocation_id = logged.action.metadata.get("allocation_id", "")
        value = (store.get_allocation(allocation_id) if allocation_id
                 else store.find_by_source(logged.id, now_pacific().year))
        if value is None:
            return False, "I could not find the linked reimbursement for that expense."
        if value["payerOwner"] != owner:
            raise ReimbursementValidationError("Only the original payer can edit this expense.")
        if value["accounting"] != "cash_v1":
            raise ReimbursementConflictError("Historical net-accounting reimbursements are read-only.")

        def finish(message: str) -> tuple[bool, str]:
            try:
                synced = sync_pending(store)
            except Exception:
                logger.exception("Saved expense correction awaits projection", extra={"allocation_id": value["id"]})
                synced = False
            return True, message + ("" if synced else
                " The change is saved; expense sheets are still syncing. Open Shared in the app and refresh to retry syncing.")

        if value.get("lifecycle") == "deleted":
            if operation == "delete":
                return finish("Deleted the expense and canceled its split.")
            raise ReimbursementConflictError("This expense has already been deleted.")
        original_version = logged.action.metadata.get("canonical_version")
        expected_version = int(original_version) if original_version else value["version"]
        changes: dict[str, Any] = {}
        category = value["category"]
        updates = {str(key).strip().lower(): item for key, item in (updates or {}).items() if item not in (None, "")}
        fields = value.get("sourceColumnMap", {})
        source_values = _current_source_values(value)
        if operation == "split":
            method = normalize_split_method(split_method)
            if method is None:
                raise ReimbursementValidationError("Choose By income, 50/50, or Fronted for this split.")
            if method == "fronted" and value["sourceWorksheet"] != "expense":
                raise ReimbursementValidationError("Fronted is currently available only for shared expense rows.")
            payer, partner = split_amounts(value["grossCents"] / 100, method, owner)
            changes = {"method": method, "payerShareCents": money_cents(payer),
                       "partnerShareCents": money_cents(partner), "lifecycle": "active"}
            message = f"Updated split to {split_method_label(method)}. {value['partnerOwner'].title()} owes ${partner:.2f}."
        elif operation in {"update", "move"}:
            allowed = set(fields) - {"date"}
            if value["sourceWorksheet"] != "expense":
                allowed = {"amount"}
            if operation == "move":
                if value["sourceWorksheet"] != "expense":
                    raise ReimbursementValidationError("Only shared expense rows can be moved to another category.")
                category = normalize_expense_category(destination_category)
                if category not in get_category_columns:
                    raise ReimbursementValidationError("Choose a valid expense category.")
                if category == value["category"] and value.get("sourceRevision", {}).get("operation") != "move":
                    return False, f"That expense is already in {expense_category_label(category)}."
                fields = {field: a1_to_rowcol(column + "1")[1]
                          for field, column in get_category_columns[category]["columns"].items()}
                allowed = set(fields) - {"date"}
            if set(updates) - allowed:
                raise ReimbursementValidationError("I can update " + ", ".join(sorted(allowed)) + " for this expense.")
            if operation == "update" and not updates:
                raise ReimbursementValidationError("Choose the transaction detail and its new value.")
            if "amount" in updates:
                gross = money_cents(updates["amount"])
                if not gross:
                    raise ReimbursementValidationError("The expense amount must be greater than zero.")
                payer, partner = split_amounts(gross / 100, value["method"], owner)
                changes.update(grossCents=gross, payerShareCents=money_cents(payer), partnerShareCents=money_cents(partner))
                updates["amount"] = f"{gross / 100:.2f}"
            source_values.update({key: str(item).strip() for key, item in updates.items()})
            if operation == "move":
                source_values = {field: source_values.get(field, "") for field in fields}
                missing = undo._missing_required_move_fields(source_values, category)
                if missing:
                    if missing == ["item"]:
                        undo.set_pending_move_item(user_key, logged.id, category)
                        return False, undo._move_item_prompt(value["category"], category)
                    return False, undo._missing_move_fields_message(missing, value["category"], category)
                changes.update(category=category, sourceColumnMap=fields)
            changes["sourceValues"] = source_values
            for field, key in (("item", "item"), ("location", "location"), ("person", "payerPerson")):
                if field in source_values and (field != "item" or value["sourceWorksheet"] == "expense"):
                    changes[key] = source_values[field]
            message = (f"Moved expense to {expense_category_label(category)}. The split is preserved."
                       if operation == "move" else "Updated the transaction details. The split method is preserved.")
        elif operation in {"cancel", "delete"}:
            if operation == "delete" and value["sourceWorksheet"] != "expense":
                raise ReimbursementValidationError("Fixed bill rows cannot be deleted.")
            changes = {"lifecycle": "void" if operation == "cancel" else "deleted"}
            message = "Canceled the split. The full expense remains recorded." if operation == "cancel" else "Deleted the expense and canceled its split."
        else:
            raise ReimbursementValidationError("Unknown expense correction.")

        if all(value.get(key, "active" if key == "lifecycle" else None) == target for key, target in changes.items()):
            # Lost responses and repeated confirmations can only replay the same
            # canonical target; they do not add another financial revision.
            if value["projectedVersion"] != value["version"]:
                return finish(message)
            return True, message
        if operation == "move" and category == value["category"]:
            return False, f"That expense is already in {expense_category_label(category)}."
        store.revise_allocation(owner, value["id"], expected_version, changes, operation=operation)
        return finish(message)
    except (ReimbursementValidationError, ReimbursementConflictError, ReimbursementNotFoundError) as exc:
        return False, str(exc)


def allocation_as_legacy(value: dict[str, Any]) -> Any:
    from bookiebot.sheets.collaboration import SharedAllocation
    return SharedAllocation(
        allocation_id=value["id"], created_at=value.get("createdAt", ""), updated_at=value.get("updatedAt", ""),
        actor_key=value.get("actorKey", ""), owner_key=value["payerOwner"], payer=value["payerOwner"].title(),
        partner=value["partnerOwner"].title(), source_action_id=value["sourceActionId"], split_action_id=value["splitActionId"],
        source_worksheet=value["sourceWorksheet"], source_category=value["category"], source_row=value["sourceRow"],
        expense_date=value["expenseDate"], item=value["item"], location=value["location"],
        gross_amount=value["grossCents"] / 100, split_method=value["method"], payer_share=value["payerShareCents"] / 100,
        partner_share=value["partnerShareCents"] / 100,
        status="void" if value.get("lifecycle", "active") != "active" else "reimbursed" if not value["outstandingCents"] else "outstanding",
        received_amount=value["settledCents"] / 100, responsible_owner_key=value["payerOwner"],
        original_person=value["payerPerson"], responsible_person=value["payerPerson"])


def matching(owner: str, text: str = "", *, owed_by: bool = False) -> list[Any]:
    words = text.lower().split()
    key = "partnerOwner" if owed_by else "payerOwner"
    result = []
    for value in build_reimbursement_store().snapshot(owner)["allocations"]:
        haystack = " ".join(str(value.get(field, "")) for field in ("id", "item", "location", "category", "payerOwner", "partnerOwner")).lower()
        if value[key] == owner and value["outstandingCents"] > 0 and all(word in haystack for word in words):
            result.append(allocation_as_legacy(value))
    return result
