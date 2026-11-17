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


def display_rows(rows: list[dict[str, Any]], snapshot: dict[str, Any], month: str) -> list[dict[str, Any]]:
    """Refresh canonical row cash from SQL without another Google Sheets read."""
    by_id = {row['id']: row for row in snapshot['allocations']}
    events = {event['id']: event for event in snapshot['events']}
    result = []
    for original in rows:
        identifier = original.get('canonicalAllocationId') or original.get('repayment', {}).get('id')
        allocation = by_id.get(identifier)
        if allocation is None or allocation['accounting'] != 'cash_v1':
            result.append(original)
            continue
        if original.get('contextOnly') and allocation['outstandingCents'] <= 0:
            continue
        row = {**original, 'canonicalAllocationVersion': allocation['version'], 'capabilities': dict(original['capabilities']), 'reasons': dict(original['reasons'])}
        event_id = row.get('canonicalEventId')
        if event_id:
            event = events.get(event_id)
            if event is None or event['status'] != 'confirmed':
                continue
            if event['amountCents'] != row['amountCents'] or 'displayAmountCents' in row:
                row['displayAmountCents'] = event['amountCents']
        elif row.get('canonicalBillCash') or row.get('contextOnly'):
            if allocation['settledCents'] != row['amountCents'] or 'displayAmountCents' in row:
                row['displayAmountCents'] = allocation['settledCents']
        elif allocation['payerOwner'] == snapshot['ownerKey']:
            row['displayAmountCents'] = allocation['grossCents'] - allocation['settledCents']
        details = repayment_details(allocation, snapshot['events'], snapshot['ownerKey'])
        if snapshot.get('displayPending'):
            details = {**details, 'canEdit': False, 'editReason': 'This entry is being updated.'}
            row['capabilities'] = {key: False for key in row['capabilities']}
        if not event_id and details != row.get('repayment'):
            attach_repayment(row, details)
        result.append(row)
    # A cached fully-paid purchase has no unpaid context row. Restore that
    # disclosure from canonical identity immediately when its receipt is undone.
    represented = {row.get('canonicalAllocationId') or row.get('repayment', {}).get('id') for row in result if not row.get('canonicalEventId')}
    for allocation in snapshot['allocations']:
        if (allocation['accounting'] != 'cash_v1' or allocation['id'] in represented or allocation['partnerOwner'] != snapshot['ownerKey']
                or allocation['outstandingCents'] <= 0 or allocation.get('lifecycle', 'active') != 'active'):
            continue
        details = repayment_details(allocation, snapshot['events'], snapshot['ownerKey'])
        context = purchase_context(allocation, details)
        if context is None or month not in ('all', context['month']):
            continue
        from bookiebot.sheets.config import expense_category_label
        context['categoryLabel'] = expense_category_label(context['category']) or context['category']
        attach_repayment(context, details)
        result.append(context)
    result.sort(key=lambda row: (row['month'], row['date'], getattr(row.get('_logged'), 'created_at', ''), row['id']), reverse=True)
    return result


def receipt_addresses(client: Any, spreadsheet_id: str, owner: str, year: int,
                      allocations: list[dict[str, Any]], events: list[dict[str, Any]]) -> dict[tuple[str, int, int], tuple[str, str]]:
    """Map canonical event IDs using existing named anchors, never merchant text."""
    from bookiebot.reimbursements.projection import _name
    by_id = {row['id']: row for row in allocations}
    relevant = [event for event in events if event['debtorOwner'] == owner and event['date'].startswith(str(year))
                and by_id.get(event['allocationId'], {}).get('sourceWorksheet') == 'expense']
    if not relevant or not hasattr(client, 'open_by_key'):
        return {}
    try:
        metadata = client.open_by_key(spreadsheet_id).fetch_sheet_metadata(params={'fields': 'namedRanges,sheets.properties'})
        titles = {sheet['properties']['sheetId']: sheet['properties']['title'] for sheet in metadata.get('sheets', [])}
        names = {item['name']: item['range'] for item in metadata.get('namedRanges', [])}
        result = {}
        for event in relevant:
            anchor = names.get(_name('receipt', event['id']))
            if anchor and anchor.get('sheetId') in titles and anchor.get('endRowIndex') == anchor.get('startRowIndex', 0) + 1:
                result[titles[anchor['sheetId']], anchor.get('startRowIndex', 0) + 1, anchor.get('startColumnIndex', 0)] = (event['allocationId'], event['id'])
        return result
    except Exception:
        # Optional identity hints must not guess when metadata is unavailable.
        # Existing verified sheet rows retain their ordinary read behavior.
        return {}
