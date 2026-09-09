"""Generated, ID-anchored legacy worksheet view of the canonical ledger.

Call under the reimbursement projection lock. The database owns every A:Y
value; named ranges and atomic insertion make lost responses safe to replay.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from gspread import WorksheetNotFound

from bookiebot.reimbursements.projection import ProjectionConflictError, SheetsProjection, _name
from bookiebot.sheets.collaboration import (
    LEGACY_SHARED_REIMBURSEMENT_HEADERS,
    SHARED_REIMBURSEMENT_HEADERS,
    _allocation_row,
    actor_key_for_owner,
)
from bookiebot.sheets.routing import get_budget_spreadsheet_id_for_user


_TITLE = "Shared Reimbursements"
_WIDTH = len(SHARED_REIMBURSEMENT_HEADERS)


def _write_cells(sheet_id: int, row: int, values: list[str]) -> dict[str, Any]:
    return {"updateCells": {
        "start": {"sheetId": sheet_id, "rowIndex": row - 1, "columnIndex": 0},
        "rows": [{"values": [{"userEnteredValue": {"stringValue": str(value)}} for value in values]}],
        "fields": "userEnteredValue",
    }}


def _headers(book: Any, sheet: Any, rows: list[list[Any]]) -> None:
    current = list(rows[0]) if rows else []
    padded = current + [""] * max(0, _WIDTH - len(current))
    if padded[:_WIDTH] == SHARED_REIMBURSEMENT_HEADERS:
        return
    legacy_width = len(LEGACY_SHARED_REIMBURSEMENT_HEADERS)
    legacy = padded[:legacy_width] == LEGACY_SHARED_REIMBURSEMENT_HEADERS
    if legacy:
        if any(value and value != expected for value, expected in zip(
                padded[legacy_width:_WIDTH], SHARED_REIMBURSEMENT_HEADERS[legacy_width:])):
            raise ProjectionConflictError("The reimbursement worksheet has conflicting custom headers.")
    elif any(str(value).strip() for row in rows for value in row):
        raise ProjectionConflictError("The reimbursement worksheet has an unexpected header row.")
    requests: list[dict[str, Any]] = []
    missing = _WIDTH - int(getattr(sheet, "col_count", _WIDTH))
    if missing > 0:
        requests.append({"appendDimension": {"sheetId": sheet.id, "dimension": "COLUMNS", "length": missing}})
    requests.append(_write_cells(sheet.id, 1, SHARED_REIMBURSEMENT_HEADERS))
    book.batch_update({"requests": requests})
    actual = sheet.get_all_values()
    if not actual or actual[0][:_WIDTH] != SHARED_REIMBURSEMENT_HEADERS:
        raise ProjectionConflictError("The reimbursement worksheet headers could not be verified.")


def _source_row(client: Any, allocation: dict[str, Any], ledger_book: Any, ledger_key: str) -> int:
    if allocation["accounting"] == "legacy_net":
        return int(allocation["sourceRow"])  # Historical source access is not required to mirror its record.
    key = str(allocation.get("sourceSpreadsheetId", ""))
    if not key:
        return int(allocation["sourceRow"])
    book = ledger_book if key == ledger_key else client.open_by_key(key)
    linked = SheetsProjection._ranges(book).get(_name("source", allocation["id"]))
    if linked is None:
        return int(allocation["sourceRow"])
    region = linked.get("range", {})
    start = region.get("startRowIndex", 0)
    if not isinstance(start, int) or start < 0 or region.get("endRowIndex") != start + 1:
        raise ProjectionConflictError("The original expense anchor no longer identifies one row.")
    return start + 1


def _values(client: Any, allocation: dict[str, Any], book: Any, key: str) -> list[str]:
    from bookiebot.reimbursements.service import allocation_as_legacy

    confirmed = [event for event in allocation.get("events", []) if event["status"] == "confirmed"]
    received_at = ""
    if allocation["settledCents"]:
        received_at = (max(confirmed, key=lambda event: (event["date"], event.get("confirmedAt", ""), event["id"]))["date"]
                       if confirmed else str(allocation.get("legacyReceivedAt", "")))
    value = {**allocation, "outstandingCents": allocation["partnerShareCents"] - allocation["settledCents"]}
    legacy = replace(allocation_as_legacy(value), payer=allocation["payerPerson"],
                     source_row=_source_row(client, allocation, book, key), received_at=received_at,
                     original_person=allocation["payerPerson"], responsible_person=allocation["payerPerson"])
    return _allocation_row(legacy)


def _validate_anchor(book: Any, sheet: Any, name: str, allocation_id: str) -> list[Any]:
    region = SheetsProjection._ranges(book).get(name, {}).get("range", {})
    start = region.get("startRowIndex", 0)
    if (region.get("sheetId") != sheet.id or start < 1 or region.get("endRowIndex") != start + 1
            or region.get("startColumnIndex", 0) != 0 or region.get("endColumnIndex") != _WIDTH):
        raise ProjectionConflictError("The reimbursement row anchor was moved or resized.")
    values = SheetsProjection._read(book, name)
    if not values or str(values[0]) != allocation_id:
        raise ProjectionConflictError("The linked reimbursement row no longer has its allocation ID.")
    return values


def mirror_allocation(client: Any, allocation: dict[str, Any]) -> None:
    """Mirror one allocation without deleting unrelated records or history."""
    year = int(allocation.get("ledgerYear") or allocation["sourceYear"])
    key = str(allocation.get("ledgerSpreadsheetId") or get_budget_spreadsheet_id_for_user(
        actor_key_for_owner(allocation["payerOwner"]) or "shortcut:" + allocation["payerOwner"], year))
    book = client.open_by_key(key)
    try:
        sheet = book.worksheet(_TITLE)
    except WorksheetNotFound:
        # A lost creation response is safe: retry finds the existing title.
        sheet = book.add_worksheet(title=_TITLE, rows=1000, cols=_WIDTH)
    rows = sheet.get_all_values()
    _headers(book, sheet, rows)
    values = _values(client, allocation, book, key)
    matches = [index for index, row in enumerate(rows, 1) if index > 1 and row and str(row[0]) == allocation["id"]]
    if len(matches) > 1:
        raise ProjectionConflictError("The reimbursement worksheet contains duplicate allocation IDs.")
    name = _name("ledger", allocation["id"])
    if name not in SheetsProjection._ranges(book):
        if matches:
            book.batch_update({"requests": [SheetsProjection._range_request(name, sheet.id, matches[0], 1, _WIDTH)]})
        else:
            row = max((index for index, cells in enumerate(rows, 1) if any(str(cell).strip() for cell in cells)), default=1) + 1
            # Insert the complete row width so custom columns remain attached
            # to their original records even when another writer appends first.
            width = max(_WIDTH, int(getattr(sheet, "col_count", _WIDTH)))
            book.batch_update({"requests": [
                {"appendDimension": {"sheetId": sheet.id, "dimension": "ROWS", "length": max(1, row - sheet.row_count)}},
                {"insertRange": {"range": {"sheetId": sheet.id, "startRowIndex": row - 1, "endRowIndex": row,
                                             "startColumnIndex": 0, "endColumnIndex": width}, "shiftDimension": "ROWS"}},
                SheetsProjection._range_request(name, sheet.id, row, 1, _WIDTH),
                _write_cells(sheet.id, row, values),
            ]})
    current = _validate_anchor(book, sheet, name, allocation["id"])
    if (current + [""] * max(0, _WIDTH - len(current)))[:_WIDTH] != values:
        book.values_batch_update({"valueInputOption": "RAW", "data": [{"range": name, "values": [values]}]})
    verified = _validate_anchor(book, sheet, name, allocation["id"])
    if (verified + [""] * max(0, _WIDTH - len(verified)))[:_WIDTH] != values:
        raise ProjectionConflictError("The reimbursement worksheet update could not be verified.")
