"""Recoverable, ID-anchored projections of confirmed settlements into budget sheets.

The database is authoritative. Named ranges bind individual source/receipt cells
so inserting another spreadsheet row cannot redirect a later receipt write.
Amounts are absolute targets; replay never adds another payment or expense.
"""
from __future__ import annotations

from contextlib import contextmanager
import calendar
from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import threading
from typing import Any, Iterator

from gspread.utils import a1_to_rowcol

from bookiebot.reports.app_access import PostgresAppAccessStore
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.routing import get_shared_expenses_spreadsheet_id


class ProjectionConflictError(RuntimeError):
    pass


_LOCK = threading.Lock()


@contextmanager
def projection_lock(store: Any) -> Iterator[None]:
    # Separate lock from ledger commands: payments remain durably recordable
    # while a slow Sheets request is pending. PG locks serialize app processes.
    with _LOCK:
        if isinstance(store.access, PostgresAppAccessStore):
            with store.access.connect(write=True) as db:
                db.execute("SELECT pg_advisory_xact_lock(84392517)")
                yield
        else:
            # SQLite is for local/single-process use; production uses Postgres.
            yield


def _name(kind: str, identity: str) -> str:
    return "BB_" + kind + "_" + hashlib.sha256(identity.encode()).hexdigest()[:32]


def _cents(value: Any) -> int:
    try:
        raw = str(value).strip().replace("$", "").replace(",", "")
        number = Decimal(raw)
        if not number.is_finite() or number * 100 != (number * 100).to_integral_value():
            raise ValueError
        return int(number * 100)
    except (ValueError, InvalidOperation) as exc:
        raise ProjectionConflictError("The linked expense amount is not a valid currency value.") from exc


def _date_key(value: Any) -> str:
    from bookiebot.sheets.reimbursement_history import _expense_date
    parsed = _expense_date(str(value))
    return parsed.isoformat() if parsed else str(value).strip()


def _identity_matches(values: list[Any], fields: dict[str, int], expected: dict[str, Any], *, skip_person: bool = False) -> bool:
    first = min(fields.values())
    for field, column in fields.items():
        if field == "amount" or (skip_person and field == "person"):
            continue
        actual = str(values[column - first] if column - first < len(values) else "").strip()
        wanted = str(expected.get(field, "")).strip()
        if field == "date":
            if _date_key(actual) != _date_key(wanted):
                return False
        elif actual != wanted:
            return False
    return True


def _source_targets(allocation: dict[str, Any]) -> set[int]:
    """Allow only actual confirmed history, in settlement rather than report order."""
    gross = allocation["grossCents"]
    total = int(allocation.get("baselineSettledCents", 0))
    targets = {gross - total}
    changes = []
    for event in allocation.get("events", []):
        confirmed = event.get("confirmedAt")
        if not confirmed:
            if event["status"] == "confirmed":
                raise ProjectionConflictError("A confirmed payment is missing its confirmation history.")
            continue  # Pending reports, including their reversals, never settled.
        changes.append((confirmed, event["id"], 0, event["amountCents"]))
        if event["status"] == "reversed":
            if not event.get("reversedAt") or event["reversedAt"] < confirmed:
                raise ProjectionConflictError("A reversed payment is missing its settlement history.")
            changes.append((event["reversedAt"], event["id"], 1, -event["amountCents"]))
    for _when, _identity, _kind, change in sorted(changes):
        total += change
        if not 0 <= total <= allocation["partnerShareCents"]:
            raise ProjectionConflictError("The recorded settlement history does not balance.")
        targets.add(gross - total)
    if total != allocation["settledCents"]:
        raise ProjectionConflictError("The recorded settlements do not match this expense's balance.")
    return targets


class SheetsProjection:
    def __init__(self, client: Any):
        self.client = client
        self.books: dict[str, Any] = {}
        self.budget_formula_cache: dict[Any, Any] = {}

    def _book(self, key: str) -> Any:
        if not key:
            raise ProjectionConflictError("The linked workbook is missing; the payment remains recorded.")
        if key not in self.books:
            self.books[key] = self.client.open_by_key(key)
        return self.books[key]

    @staticmethod
    def _ranges(book: Any) -> dict[str, Any]:
        metadata = book.fetch_sheet_metadata(params={"fields": "namedRanges"})
        return {row["name"]: row for row in metadata.get("namedRanges", [])}

    @staticmethod
    def _read(book: Any, name: str) -> list[Any]:
        values = book.values_get(name).get("values", [])
        if len(values) != 1:
            raise ProjectionConflictError("A linked expense range was removed or changed. Review it before syncing.")
        return list(values[0])

    @staticmethod
    def _range_request(name: str, sheet_id: int, row: int, first: int, last: int) -> dict[str, Any]:
        return {"addNamedRange": {"namedRange": {"name": name, "range": {
            "sheetId": sheet_id, "startRowIndex": row - 1, "endRowIndex": row,
            "startColumnIndex": first - 1, "endColumnIndex": last,
        }}}}

    def _validate_anchors(self, book: Any, sheet_id: int, full: str, fields: dict[str, int], anchors: dict[str, str]) -> None:
        names = self._ranges(book)
        linked = names.get(full, {}).get("range", {})
        first, last = min(fields.values()), max(fields.values())
        start = linked.get("startRowIndex", 0)
        if (linked.get("sheetId") != sheet_id or linked.get("endRowIndex") != start + 1
                or linked.get("startColumnIndex", 0) != first - 1 or linked.get("endColumnIndex") != last):
            raise ProjectionConflictError("A linked expense range was moved or resized. Review it before syncing.")
        for field, name in anchors.items():
            cell = names.get(name, {}).get("range", {})
            if (cell.get("sheetId") != sheet_id or cell.get("startRowIndex", 0) != start
                    or cell.get("endRowIndex") != start + 1
                    or cell.get("startColumnIndex", 0) != fields[field] - 1
                    or cell.get("endColumnIndex") != fields[field]):
                raise ProjectionConflictError("An expense cell is no longer attached to its linked row. Review it before syncing.")

    def source(self, allocation: dict[str, Any]) -> None:
        fields = allocation.get("sourceColumnMap", {})
        expected = allocation.get("sourceValues", {})
        if not fields or "amount" not in fields or not (set(fields) - {"amount"}) or not expected:
            raise ProjectionConflictError("This expense needs a verified source row before settlement can sync.")
        book = self._book(allocation["sourceSpreadsheetId"])
        sheet = book.worksheet(allocation.get("sourceSheetTitle") or date.fromisoformat(allocation["expenseDate"]).strftime("%B"))
        full = _name("source", allocation["id"])
        amount = _name("amount", allocation["id"])
        person = _name("person", allocation["id"])
        item = _name("item", allocation["id"])
        write_item = "item" in fields and allocation.get("sourceWorksheet") == "expense"
        anchors = {"amount": amount}
        if "person" in fields:
            anchors["person"] = person
        if write_item:
            anchors["item"] = item
        names = self._ranges(book)
        first, last = min(fields.values()), max(fields.values())
        target = allocation["grossCents"] - allocation["settledCents"]
        if full not in names:
            # Resolve a moved original by all saved non-amount fields; ambiguous
            # duplicates stop before any financial write.
            matches = []
            for row_number, row in enumerate(sheet.get_all_values(), start=1):
                values = row[first - 1:last]
                if _identity_matches(values, fields, expected):
                    if fields["amount"] - first < len(values) and _cents(values[fields["amount"] - first]) == _cents(expected["amount"]):
                        matches.append(row_number)
            if len(matches) != 1:
                raise ProjectionConflictError("The original expense no longer matches uniquely. Review its linked row.")
            row = matches[0]
            requests = [self._range_request(full, sheet.id, row, first, last),
                        self._range_request(amount, sheet.id, row, fields["amount"], fields["amount"])]
            if "person" in fields:
                requests.append(self._range_request(person, sheet.id, row, fields["person"], fields["person"]))
            if write_item:
                requests.append(self._range_request(item, sheet.id, row, fields["item"], fields["item"]))
            book.batch_update({"requests": requests})
        # A timeout after creating anchors is recoverable by finding their names.
        self._validate_anchors(book, sheet.id, full, fields, anchors)
        current = self._read(book, full)
        expected_now = dict(expected)
        if "person" in fields:
            expected_now["person"] = allocation["payerPerson"]
        if write_item:
            expected_now["item"] = allocation["item"]
        if not (_identity_matches(current, fields, expected) or _identity_matches(current, fields, expected_now)):
            raise ProjectionConflictError("The linked expense description or owner changed. No amount was overwritten.")
        amount_offset = fields["amount"] - first
        current_amount = _cents(current[amount_offset] if len(current) > amount_offset else "")
        # Any previous confirmed state is a valid restart point; arbitrary edits
        # are not silently overwritten. Reversals also retain their old totals.
        valid_amounts = _source_targets(allocation) | {_cents(expected["amount"]), allocation["grossCents"]}
        if current_amount not in valid_amounts:
            raise ProjectionConflictError("The linked expense amount was edited outside this settlement. Review it before syncing.")
        data = [{"range": amount, "values": [[target / 100]]}]
        if "person" in fields:
            data.append({"range": person, "values": [[allocation["payerPerson"]]]})
        if write_item:
            data.append({"range": item, "values": [[allocation["item"]]]})
        book.values_batch_update({"valueInputOption": "RAW", "data": data})
        verified = self._read(book, full)
        if (_cents(verified[amount_offset] if len(verified) > amount_offset else "") != target
                or not _identity_matches(verified, fields, expected_now)):
            raise ProjectionConflictError("The expense update could not be verified; syncing will retry safely.")

    def receipt(self, allocation: dict[str, Any], event: dict[str, Any]) -> None:
        if event["status"] == "pending" or (event["status"] == "reversed" and not event.get("confirmedAt")):
            return
        paid_on = date.fromisoformat(event["date"])
        book = self._book(get_shared_expenses_spreadsheet_id(paid_on.year))
        sheet = book.worksheet(paid_on.strftime("%B"))
        category = allocation["category"] if allocation["category"] in get_category_columns else "need_expenses"
        config = get_category_columns[category]
        fields = {field: a1_to_rowcol(column + "1")[1] for field, column in config["columns"].items()}
        full = _name("receipt", event["id"])
        amount = _name("receipt_amount", event["id"])
        names = self._ranges(book)
        target = event["amountCents"] if event["status"] == "confirmed" else 0
        label = "Offset" if event["kind"] == "offset" else "Reimbursement"
        from bookiebot.sheets.collaboration import expense_person_for_owner
        expected = {"date": paid_on.isoformat(), "item": f"{label} · {allocation['item']}",
                    "amount": target / 100, "location": f"{label} to {allocation['payerOwner'].title()} · {allocation['location']}",
                    "person": expense_person_for_owner(allocation["partnerOwner"])}
        first, last = min(fields.values()), max(fields.values())
        if full not in names:
            if not target:  # Reversed before the first projection: nothing to add.
                return
            rows = sheet.get_all_values()
            occupied = [index for index, values in enumerate(rows, start=1)
                        if index >= config["start_row"] and any(str(v).strip() for v in values[first - 1:last])]
            row = max(occupied, default=config["start_row"] - 1) + 1
            values: list[Any] = [""] * (last - first + 1)
            for field, column in fields.items():
                values[column - first] = expected[field]
            # Reserve capacity and insert fresh category cells in the same batch
            # as the anchor/write. An expense appended after our read is shifted,
            # never overwritten. Other side-by-side categories stay in place.
            requests: list[dict[str, Any]] = [
                {"appendDimension": {"sheetId": sheet.id, "dimension": "ROWS", "length": max(1, row - sheet.row_count)}},
                {"insertRange": {"range": {"sheetId": sheet.id, "startRowIndex": row - 1, "endRowIndex": row,
                                             "startColumnIndex": first - 1, "endColumnIndex": last}, "shiftDimension": "ROWS"}},
            ]
            requests += [self._range_request(full, sheet.id, row, first, last),
                         self._range_request(amount, sheet.id, row, fields["amount"], fields["amount"]),
                         {"updateCells": {"start": {"sheetId": sheet.id, "rowIndex": row - 1, "columnIndex": first - 1},
                          "rows": [{"values": [{"userEnteredValue": {"numberValue": value} if isinstance(value, (int, float))
                                                else {"stringValue": str(value)},
                                                "note": f"BookieBot settlement {event['id']} / expense {allocation['id']}"} for value in values]}],
                          "fields": "userEnteredValue,note"}}]
            # Name reservation and the new row are one Sheets transaction. If the
            # response is lost, retry finds this exact row instead of appending.
            book.batch_update({"requests": requests})
        self._validate_anchors(book, sheet.id, full, fields, {"amount": amount})
        current_values = self._read(book, full)
        if not _identity_matches(current_values, fields, expected):
            raise ProjectionConflictError("A linked reimbursement expense was edited. Review it before syncing.")
        amount_offset = fields["amount"] - first
        current = _cents(current_values[amount_offset] if len(current_values) > amount_offset else "")
        if current not in {0, event["amountCents"]}:
            raise ProjectionConflictError("A reimbursement expense amount was edited outside BookieBot.")
        book.values_batch_update({"valueInputOption": "RAW", "data": [{"range": amount, "values": [[target / 100]]}]})
        verified = self._read(book, full)
        if (_cents(verified[amount_offset] if len(verified) > amount_offset else "") != target
                or not _identity_matches(verified, fields, expected)):
            raise ProjectionConflictError("The reimbursement expense could not be verified.")

    def project(self, allocation: dict[str, Any]) -> None:
        if allocation["accounting"] == "legacy_net":
            return  # Preserved history; no invented historical cash entries.
        from bookiebot.reimbursements.migration import verify_budget_links
        if allocation.get("sourceWorksheet") == "expense":
            spent_on = date.fromisoformat(allocation["expenseDate"])
            source_month = allocation.get("sourceSheetTitle") or spent_on.strftime("%B")
            when = date(allocation.get("sourceYear", spent_on.year), list(calendar.month_name).index(source_month), 1)
            verify_budget_links(self.client, allocation["payerOwner"], when, allocation["category"],
                                person=allocation["payerPerson"], cache=self.budget_formula_cache)
            verify_budget_links(self.client, allocation["partnerOwner"], when, allocation["category"], cache=self.budget_formula_cache)
        # Validate every destination before the first sheet write, including
        # reversals and backdated receipts into a potentially frozen month.
        category = allocation["category"] if allocation["category"] in get_category_columns else "need_expenses"
        for event in allocation.get("events", []):
            if event["status"] == "pending" or (event["status"] == "reversed" and not event.get("confirmedAt")):
                continue
            verify_budget_links(self.client, allocation["partnerOwner"], date.fromisoformat(event["date"]), category,
                                cache=self.budget_formula_cache)
        # Recipient entries first keep a failed cross-workbook write visible as
        # pending; the operation is never represented as an atomic Sheets write.
        for event in allocation.get("events", []):
            self.receipt(allocation, event)
        self.source(allocation)


def sync_pending(store: Any, projector: Any | None = None) -> bool:
    """Return True only when every current canonical version is verified."""
    import logging
    if projector is None:
        from bookiebot.sheets.auth import get_gspread_client
        projector = SheetsProjection(get_gspread_client())
    success = True
    with projection_lock(store):
        if isinstance(projector, SheetsProjection):
            projector.budget_formula_cache.clear()
        for allocation in store.pending_projections():
            try:
                projector.project(allocation)
                if isinstance(projector, SheetsProjection):
                    from bookiebot.reimbursements.mirror import mirror_allocation
                    mirror_allocation(projector.client, allocation)
                if not store.mark_projected(allocation["id"], allocation["version"]):
                    success = False
            except Exception:
                logging.getLogger(__name__).exception("Reimbursement sheet projection remains pending", extra={"allocation_id": allocation["id"]})
                success = False
    return success
