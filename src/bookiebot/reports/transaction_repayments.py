"""Read-only repayment presentation; cash remains owned by canonical writers."""
from __future__ import annotations

import calendar
import hashlib
import json
from typing import Any


def repayment_details(allocation: dict[str, Any], events: list[dict[str, Any]], owner: str) -> dict[str, Any]:
    incoming = allocation["payerOwner"] == owner
    pending = sum(event["amountCents"] for event in events
                  if event["allocationId"] == allocation["id"] and event["status"] == "pending")
    reason = ("Only the original payer can edit this split." if not incoming else
              "This historical split is read-only." if allocation["accounting"] != "cash_v1" else
              "This split is no longer active." if allocation.get("lifecycle", "active") != "active" else
              "This balance was cleared. Its split history is retained." if allocation.get("clearedCents", 0) else
              "Confirm or dismiss the reported payment in Shared before editing this split." if pending else
              "Reverse confirmed repayments in Shared before editing this split." if allocation["settledCents"] else
              "This change is still syncing. Refresh before editing the split." if allocation["version"] != allocation["projectedVersion"] else "")
    return {"id": allocation["id"], "version": allocation["version"],
            "direction": "incoming" if incoming else "outgoing", "accounting": allocation["accounting"],
            "payerName": allocation["payerOwner"].title(), "partnerName": allocation["partnerOwner"].title(),
            "grossCents": allocation["grossCents"], "payerShareCents": allocation["payerShareCents"],
            "partnerShareCents": allocation["partnerShareCents"], "settledCents": allocation["settledCents"],
            "clearedCents": allocation.get("clearedCents", 0), "outstandingCents": allocation["outstandingCents"],
            "pendingCents": pending, "method": allocation["method"], "canEdit": not reason, "editReason": reason}


def attach_repayment(row: dict[str, Any], details: dict[str, Any]) -> None:
    row["repayment"] = details
    row["version"] = hashlib.sha256(json.dumps([row["version"], details], sort_keys=True).encode()).hexdigest()
    if not details["canEdit"]:
        for operation in ("split", "cancel_split"):
            row["capabilities"][operation] = False
            row["reasons"][operation] = details["editReason"]


def purchase_context(allocation: dict[str, Any], details: dict[str, Any]) -> dict[str, Any] | None:
    """Expose an unpaid fronted purchase without creating a second cash expense.

    Confirmed linked expenses/bill cells keep their real payment dates and are
    counted once. This context shows cumulative cash paid only on the row.
    """
    title = allocation.get("sourceSheetTitle", "")
    if title not in calendar.month_name or not title:
        return None
    month = f"{allocation['sourceYear']:04d}-{list(calendar.month_name).index(title):02d}"
    category = allocation["category"]
    return {"id": f"{month}:repayment-{allocation['id']}", "actionId": "", "month": month,
            "version": str(allocation["version"]), "date": allocation["expenseDate"],
            "title": allocation["item"], "location": allocation.get("location", ""),
            "person": details["partnerName"], "kind": "expense" if allocation["sourceWorksheet"] == "expense" else "payment",
            "category": category, "categoryLabel": category, "amountCents": allocation["grossCents"],
            "displayAmountCents": allocation["settledCents"], "contextOnly": True, "split": allocation["method"],
            "fields": {}, "editableFields": [],
            "capabilities": {operation: False for operation in ("update", "move", "delete", "split", "cancel_split", "undo")},
            "reasons": {operation: "This purchase was paid upfront by the other person."
                        for operation in ("update", "move", "delete", "split", "cancel_split", "undo")}}


def accounted_amount(row: dict[str, Any]) -> int:
    return 0 if row.get("contextOnly") else row.get("displayAmountCents", row["amountCents"])
