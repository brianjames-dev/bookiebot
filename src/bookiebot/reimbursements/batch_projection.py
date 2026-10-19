"""Plan receipt projections together, then write and verify per workbook.

Financial writes precede the generated ledger view. Absolute named targets and
durable receipt IDs make a lost response replayable without another payment.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date
import calendar
import json
from typing import Any

from gspread.utils import a1_to_rowcol, absolute_range_name

from bookiebot.reimbursements.projection import (
    ProjectionConflictError, SheetsProjection, _PERSONAL_BILL_LABELS, _cents,
    _identity_matches, _name, _projection_events, _source_targets, projection_lock, validate_named_anchors,
)
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.routing import get_budget_spreadsheet_id_for_user, get_shared_expenses_spreadsheet_id


class ReceiptBatch:
    def __init__(self, client: Any):
        self.http = client.http_client
        self.client = client
        self.books: dict[str, dict[str, Any]] = {}
        self.formulas: dict[Any, Any] = {}
        self.checks: dict[tuple[str, str], tuple[dict[str, int], dict[str, Any]]] = {}

    def book(self, key: str) -> dict[str, Any]:
        if not key:
            raise ProjectionConflictError("The linked workbook is missing.")
        if key not in self.books:
            meta = self.http.fetch_sheet_metadata(key, params={"fields": "sheets.properties,namedRanges"})
            self.books[key] = {"sheets": {s["properties"]["title"]: s["properties"] for s in meta["sheets"]},
                               "names": {n["name"]: n for n in meta.get("namedRanges", [])},
                               "rows": {}, "requests": [], "data": {}, "mirror": {}}
        return self.books[key]

    def load(self, requests: dict[str, set[str]]) -> None:
        for key, titles in requests.items():
            book = self.book(key)
            titles = sorted(titles)
            if any(title not in book["sheets"] for title in titles):
                raise ProjectionConflictError("A required expense or reimbursement sheet is missing.")
            response = self.http.values_batch_get(key, [absolute_range_name(t) for t in titles],
                                                  params={"valueRenderOption": "FORMATTED_VALUE"})["valueRanges"]
            if len(response) != len(titles):
                raise ProjectionConflictError("The sheet snapshot is incomplete.")
            book["rows"].update({title: result.get("values", []) for title, result in zip(titles, response)})

    def anchor(self, key: str, title: str, full: str, fields: dict[str, int], cells: dict[str, str]) -> int:
        book = self.book(key)
        sheet = book["sheets"][title]
        # Reuse the existing exact range-shape validator against this one fresh
        # metadata snapshot, rather than refetching it for every allocation.
        validate_named_anchors(book["names"], sheet["sheetId"], full, fields, cells)
        return book["names"][full]["range"]["startRowIndex"] + 1

    def values(self, key: str, title: str, row: int, fields: dict[str, int]) -> list[Any]:
        rows = self.book(key)["rows"][title]
        return rows[row - 1][min(fields.values()) - 1:max(fields.values())] if row <= len(rows) else []

    def reserve(self, key: str, title: str, full: str, amount: str, row: int, fields: dict[str, int]) -> None:
        book = self.book(key)
        for name, first, last in [(full, min(fields.values()), max(fields.values())),
                                  (amount, fields["amount"], fields["amount"])]:
            if name in book["names"]:
                raise ProjectionConflictError("An incomplete settlement anchor needs review.")
            request = SheetsProjection._range_request(name, book["sheets"][title]["sheetId"], row, first, last)
            book["requests"].append(request)
            book["names"][name] = request["addNamedRange"]["namedRange"]

    def target(self, key: str, name: str, values: list[Any], *, mirror: bool = False) -> None:
        book = self.book(key)
        data = book["mirror" if mirror else "data"]
        if any(other != name and book["names"][other]["range"] == book["names"][name]["range"] for other in data):
            raise ProjectionConflictError("Two reimbursements target the same expense cell.")
        if name in data and data[name] != values:
            raise ProjectionConflictError("Two reimbursements target the same expense cell.")
        data[name] = values

    def source(self, allocation: dict[str, Any]) -> None:
        key, title = allocation["sourceSpreadsheetId"], allocation["sourceSheetTitle"]
        fields = allocation["sourceColumnMap"]
        full = _name("source", allocation["id"])
        cells = SheetsProjection._source_anchors(allocation)
        row = self.anchor(key, title, full, fields, cells)
        current = self.values(key, title, row, fields)
        expected = dict(allocation["sourceValues"])
        desired = dict(expected)
        if "person" in fields:
            desired["person"] = allocation["payerPerson"]
        if allocation["sourceWorksheet"] == "expense":
            desired["item"] = allocation["item"]
        if not (_identity_matches(current, fields, expected) or _identity_matches(current, fields, desired)):
            raise ProjectionConflictError("The linked expense description or owner changed.")
        offset = fields["amount"] - min(fields.values())
        if _cents(current[offset]) not in _source_targets(allocation) | {_cents(expected["amount"]), allocation["grossCents"]}:
            raise ProjectionConflictError("The linked expense amount changed outside this settlement.")
        desired["amount"] = (allocation["grossCents"] - allocation["settledCents"]) / 100
        for field, name in cells.items():
            self.target(key, name, [desired[field]])
        self.checks[(key, full)] = fields, desired
        allocation["sourceRow"] = row

    def bill(self, allocation: dict[str, Any]) -> None:
        from bookiebot.sheets.collaboration import actor_key_for_owner
        label = _PERSONAL_BILL_LABELS.get(allocation["category"])
        if not label:
            raise ProjectionConflictError("This personal bill has no supported partner budget row.")
        key = get_budget_spreadsheet_id_for_user(actor_key_for_owner(allocation["partnerOwner"]), allocation["sourceYear"])
        title, fields = allocation["sourceSheetTitle"], {"item": 2, "amount": 3}
        book = self.book(key)
        full, amount = _name("partner_bill", allocation["id"]), _name("partner_bill_amount", allocation["id"])
        if full in book["names"]:
            row = self.anchor(key, title, full, fields, {"amount": amount})
        else:
            matches = [i for i, row in enumerate(book["rows"][title], 1) if len(row) > 1 and str(row[1]).strip() == label]
            if len(matches) != 1:
                raise ProjectionConflictError("The partner bill row does not match uniquely.")
            row = matches[0]
            if any(name.startswith("BB_partner_bill_") and region["range"]["sheetId"] == book["sheets"][title]["sheetId"]
                   and region["range"]["startRowIndex"] == row - 1 for name, region in book["names"].items()):
                raise ProjectionConflictError("Another reimbursement owns this partner bill row.")
            current = self.values(key, title, row, fields)
            if _cents(current[1] if len(current) > 1 and current[1] else 0):
                raise ProjectionConflictError("The partner bill already has an amount. Review it before syncing.")
            self.reserve(key, title, full, amount, row, fields)
        current = self.values(key, title, row, fields)
        valid = {allocation["grossCents"] - value for value in _source_targets(allocation)}
        if str(current[0]).strip() != label or _cents(current[1] if len(current) > 1 and current[1] else 0) not in valid:
            raise ProjectionConflictError("The partner bill was edited outside this settlement.")
        target = allocation["settledCents"] / 100
        self.target(key, amount, [target])
        self.checks[(key, full)] = fields, {"item": label, "amount": target}

    def receipt(self, allocation: dict[str, Any], event: dict[str, Any]) -> None:
        from bookiebot.sheets.collaboration import expense_person_for_owner
        paid = date.fromisoformat(event["date"])
        key, title = get_shared_expenses_spreadsheet_id(paid.year), paid.strftime("%B")
        category = allocation["category"] if allocation["category"] in get_category_columns else "need_expenses"
        config = get_category_columns[category]
        fields = {field: a1_to_rowcol(column + "1")[1] for field, column in config["columns"].items()}
        book = self.book(key)
        full, amount = _name("receipt", event["id"]), _name("receipt_amount", event["id"])
        label = "Offset" if event["kind"] == "offset" else "Reimbursement"
        expected = {"date": paid.isoformat(), "item": f"{label} · {allocation['item']}",
                    "amount": (event["amountCents"] if event["status"] == "confirmed" else 0) / 100,
                    "location": f"{label} to {allocation['payerOwner'].title()} · {allocation['location']}",
                    "person": expense_person_for_owner(allocation["partnerOwner"])}
        if full not in book["names"]:
            if not expected["amount"]:
                return
            first, last = min(fields.values()), max(fields.values())
            rows = book["rows"][title]
            row = max((i for i, values in enumerate(rows, 1) if i >= config["start_row"]
                       and any(str(v).strip() for v in values[first - 1:last])), default=config["start_row"] - 1) + 1
            sheet = book["sheets"][title]
            book["requests"].extend([
                {"appendDimension": {"sheetId": sheet["sheetId"], "dimension": "ROWS", "length": 1}},
                {"insertRange": {"range": {"sheetId": sheet["sheetId"], "startRowIndex": row - 1, "endRowIndex": row,
                                            "startColumnIndex": first - 1, "endColumnIndex": last}, "shiftDimension": "ROWS"}},
            ])
            self.reserve(key, title, full, amount, row, fields)
            values: list[Any] = [""] * (last - first + 1)
            for field, column in fields.items():
                values[column - first] = expected[field]
            # The inserted row and durable ID anchors commit atomically; a
            # concurrent ordinary append is shifted rather than overwritten.
            book["requests"].append({"updateCells": {"start": {"sheetId": sheet["sheetId"], "rowIndex": row - 1, "columnIndex": first - 1},
                "rows": [{"values": [{"userEnteredValue": {"numberValue": v} if isinstance(v, (int, float)) else {"stringValue": str(v)},
                                       "note": f"BookieBot settlement {event['id']} / expense {allocation['id']}"} for v in values]}],
                "fields": "userEnteredValue,note"}})
            while len(rows) < row:
                rows.append([])
            rows[row - 1].extend([""] * max(0, last - len(rows[row - 1])))
            rows[row - 1][first - 1:last] = values
        row = self.anchor(key, title, full, fields, {"amount": amount})
        current = self.values(key, title, row, fields)
        if not _identity_matches(current, fields, expected) or _cents(current[fields["amount"] - min(fields.values())]) not in {0, event["amountCents"]}:
            raise ProjectionConflictError("A linked reimbursement expense changed outside BookieBot.")
        self.target(key, amount, [expected["amount"]])
        self.checks[(key, full)] = fields, expected

    def mirror(self, allocation: dict[str, Any]) -> None:
        from bookiebot.reimbursements.service import allocation_as_legacy
        from bookiebot.sheets.collaboration import SHARED_REIMBURSEMENT_HEADERS, _allocation_row, actor_key_for_owner
        year = int(allocation.get("ledgerYear") or allocation["sourceYear"])
        key = allocation.get("ledgerSpreadsheetId") or get_budget_spreadsheet_id_for_user(actor_key_for_owner(allocation["payerOwner"]), year)
        book, title = self.book(key), "Shared Reimbursements"
        rows, width = book["rows"][title], len(SHARED_REIMBURSEMENT_HEADERS)
        if not rows or rows[0][:width] != SHARED_REIMBURSEMENT_HEADERS:
            raise ProjectionConflictError("The reimbursement worksheet headers need review.")
        name = _name("ledger", allocation["id"])
        if name not in book["names"]:
            raise ProjectionConflictError("The reimbursement mirror anchor is missing. Refresh Shared to recover it.")
        row = self.anchor(key, title, name, {"id": 1, "last": width}, {})
        current = self.values(key, title, row, {"id": 1, "last": width})
        if not current or current[0] != allocation["id"] or sum(bool(r) and r[0] == allocation["id"] for r in rows[1:]) != 1:
            raise ProjectionConflictError("The reimbursement mirror no longer has one matching ID.")
        confirmed = [e for e in allocation["events"] if e["status"] == "confirmed"]
        received = max((e["date"] for e in confirmed), default=allocation.get("legacyReceivedAt", "")) if allocation["settledCents"] else ""
        value = {**allocation, "outstandingCents": allocation["partnerShareCents"] - allocation["settledCents"] - allocation.get("clearedCents", 0)}
        legacy = replace(allocation_as_legacy(value), payer=allocation["payerPerson"], source_row=allocation["sourceRow"],
                         received_at=received, original_person=allocation["payerPerson"], responsible_person=allocation["payerPerson"])
        self.target(key, name, _allocation_row(legacy), mirror=True)

    def verify(self, *, mirror: bool = False) -> None:
        for key, book in self.books.items():
            names = list(book["mirror"]) if mirror else [name for candidate, name in self.checks if candidate == key]
            if not names:
                continue
            results = self.http.values_batch_get(key, names, params={"valueRenderOption": "FORMATTED_VALUE"})["valueRanges"]
            if len(results) != len(names):
                raise ProjectionConflictError("The settlement readback is incomplete.")
            metadata = self.http.fetch_sheet_metadata(key, params={"fields": "namedRanges"})
            actual = {n["name"]: n["range"] for n in metadata.get("namedRanges", [])}
            used = set(names) | (set(book["mirror"]) if mirror else set(book["data"]))
            for name in used:
                expected_range = book["names"][name]["range"]
                if tuple(actual.get(name, {}).get(field, 0) for field in (
                    "sheetId", "startRowIndex", "endRowIndex", "startColumnIndex", "endColumnIndex")) != tuple(
                        expected_range.get(field, 0) for field in (
                            "sheetId", "startRowIndex", "endRowIndex", "startColumnIndex", "endColumnIndex")):
                    raise ProjectionConflictError("A settlement anchor changed during the update.")
            for name, result in zip(names, results):
                values = result.get("values", [])
                if len(values) != 1:
                    raise ProjectionConflictError("The settlement readback is incomplete.")
                row = values[0]
                if mirror:
                    wanted = book["mirror"][name]
                    if (row + [""] * max(0, len(wanted) - len(row))) != wanted:
                        raise ProjectionConflictError("The reimbursement mirror update could not be verified.")
                else:
                    fields, expected = self.checks[(key, name)]
                    offset = fields["amount"] - min(fields.values())
                    if not _identity_matches(row, fields, expected) or _cents(row[offset]) != _cents(expected["amount"]):
                        raise ProjectionConflictError("The settlement update could not be verified.")

    def execute(self) -> None:
        # All destinations and mirrors have been preflighted before any write.
        if any(len(json.dumps({"requests": b["requests"], "data": b["data"], "mirror": b["mirror"]}).encode()) > 1_800_000
               for b in self.books.values()):
            raise ProjectionConflictError("The receipt batch needs a smaller sheet projection. Payments remain recorded.")
        for key, book in self.books.items():
            if book["requests"]:
                self.http.batch_update(key, {"requests": book["requests"]})
        for key, book in self.books.items():
            if book["data"]:
                self.http.values_batch_update(key, {"valueInputOption": "RAW", "data": [
                    {"range": name, "values": [values]} for name, values in book["data"].items()]})
        self.verify()
        for key, book in self.books.items():
            if book["mirror"]:
                self.http.values_batch_update(key, {"valueInputOption": "RAW", "data": [
                    {"range": name, "values": [values]} for name, values in book["mirror"].items()]})
        self.verify(mirror=True)


def sync_received(store: Any, allocation_ids: set[str]) -> bool:
    """Batch only already-anchored active cash allocations; failures stay pending."""
    import logging
    from bookiebot.sheets.auth import get_gspread_client
    from bookiebot.sheets.collaboration import actor_key_for_owner
    from bookiebot.reimbursements.migration import verify_budget_links
    try:
        with projection_lock(store):
            allocations = [a for a in store.pending_projections() if a["id"] in allocation_ids]
            if not allocations:
                return True
            batch = ReceiptBatch(get_gspread_client())
            requests: dict[str, set[str]] = {}
            def need(key: str, title: str) -> None:
                requests.setdefault(key, set()).add(title)
            for a in allocations:
                if (a["accounting"] != "cash_v1" or a.get("lifecycle", "active") != "active"
                        or a.get("mirrorOnlyVersion", 0) == a["version"]
                        or a.get("sourceRevision", {}).get("version", 0) > a["projectedVersion"]):
                    raise ProjectionConflictError("An expense correction must finish syncing before bulk receipt projection.")
                a["sourceSheetTitle"] = a.get("sourceSheetTitle") or date.fromisoformat(a["expenseDate"]).strftime("%B")
                need(a["sourceSpreadsheetId"], a["sourceSheetTitle"])
                year = int(a.get("ledgerYear") or a["sourceYear"])
                need(a.get("ledgerSpreadsheetId") or get_budget_spreadsheet_id_for_user(actor_key_for_owner(a["payerOwner"]), year), "Shared Reimbursements")
                if a["sourceWorksheet"] == "income":
                    need(get_budget_spreadsheet_id_for_user(actor_key_for_owner(a["partnerOwner"]), a["sourceYear"]), a["sourceSheetTitle"])
                else:
                    spent = date(a["sourceYear"], list(calendar.month_name).index(a["sourceSheetTitle"]), 1)
                    for owner in [a["payerOwner"], a["partnerOwner"]]:
                        verify_budget_links(batch.client, owner, spent, a["category"],
                                            person=a["payerPerson"] if owner == a["payerOwner"] else None, cache=batch.formulas)
                    for event in _projection_events(a):
                        if event["status"] == "pending" or not event.get("confirmedAt"):
                            continue
                        paid = date.fromisoformat(event["date"])
                        need(get_shared_expenses_spreadsheet_id(paid.year), paid.strftime("%B"))
                        category = a["category"] if a["category"] in get_category_columns else "need_expenses"
                        verify_budget_links(batch.client, a["partnerOwner"], paid, category, cache=batch.formulas)
            batch.load(requests)
            # Resolve sources before reserving new receipts at category ends.
            for a in allocations:
                batch.source(a)
            for a in allocations:
                if a["sourceWorksheet"] == "income":
                    batch.bill(a)
                else:
                    for event in _projection_events(a):
                        if event["status"] != "pending" and event.get("confirmedAt"):
                            batch.receipt(a, event)
                batch.mirror(a)
            batch.execute()
            return all([store.mark_projected(a["id"], a["version"], source_row=a["sourceRow"]) for a in allocations])
    except Exception:
        logging.getLogger(__name__).exception("Recorded bulk receipts await verified sheet projection")
        return False
