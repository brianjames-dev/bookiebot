"""Recorded activity and reviewed app edits, using the Discord financial services."""
from __future__ import annotations

import calendar
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import logging
import re
import threading
import time
from typing import Any

from bookiebot.reports.app_access import PostgresAppAccessStore, build_app_access_store
from bookiebot.reports.phone_history import parse_phone_report_month
from bookiebot.reports.worksheet_reads import read_workbook_tabs
from bookiebot.reimbursements import service as shared
from bookiebot.sheets import undo
from bookiebot.sheets.auth import get_gspread_client
from bookiebot.sheets.config import get_category_columns, expense_category_label
from bookiebot.sheets.income import income_sheet_layout
from bookiebot.sheets.repo import GSpreadSheetsRepository, sheets_repository_context, sheet_command_context
from bookiebot.sheets.reimbursement_history import configured_reimbursement_workbooks
from bookiebot.sheets.routing import (
    actor_key_aliases, get_budget_spreadsheet_id_for_user, get_shared_expenses_spreadsheet_id,
    get_user_config, now_pacific, sheet_user_context,
)

logger = logging.getLogger(__name__)
_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
_CACHE_LOCK = threading.RLock()
_READ_LOCKS: dict[str, Any] = {}
_factory_lock = threading.Lock()


class TransactionValidation(ValueError):
    pass


class TransactionConflict(ValueError):
    pass


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def cell(rows: list[list[str]], row: int, column: int) -> str:
    return str(rows[row - 1][column - 1]) if 0 < row <= len(rows) and 0 < column <= len(rows[row - 1]) else ""


def cents(value: Any) -> int:
    try:
        return shared.money_cents(str(value))
    except ValueError:
        return 0


class MonthRepository(GSpreadSheetsRepository):
    """Existing tabs only; historical commands cannot fall into the current month."""
    def __init__(self, actor: str, month: str):
        self.actor, self.period = actor, parse_phone_report_month(month)
        self.books: dict[str, Any] = {}
        self.tabs: dict[tuple[str, str], Any] = {}

    def tab(self, personal: bool, title: str):
        key = (get_budget_spreadsheet_id_for_user(self.actor, self.period.year) if personal
               else get_shared_expenses_spreadsheet_id(self.period.year))
        if key not in self.books:
            self.books[key] = get_gspread_client().open_by_key(key)
        if (key, title) not in self.tabs:
            self.tabs[key, title] = self.books[key].worksheet(title)
        return self.tabs[key, title]

    def expense_sheet(self):
        return self.tab(False, calendar.month_name[self.period.month])

    def income_sheet(self):
        return self.tab(True, calendar.month_name[self.period.month])

    def action_log_sheet(self):
        # A missing log is created only after an explicit financial confirmation.
        title = f"_BookieBot Action Log - {self.period.year:04d}-{self.period.month:02d}"
        from gspread.exceptions import WorksheetNotFound
        try:
            return self.tab(False, title)
        except WorksheetNotFound:
            book = self.books[get_shared_expenses_spreadsheet_id(self.period.year)]
            ws = book.add_worksheet(title=title, rows=1000, cols=6)
            ws.update([undo._LOG_HEADERS], "A1:F1")
            book.batch_update({"requests": [{"updateSheetProperties": {"properties": {"sheetId": ws.id, "hidden": True}, "fields": "hidden"}}]})
            self.tabs[get_shared_expenses_spreadsheet_id(self.period.year), title] = ws
            return ws

    def shared_reimbursements_sheet(self):
        return self.tab(True, "Shared Reimbursements")

    find_shared_reimbursements_sheet = shared_reimbursements_sheet


@contextmanager
def transaction_context(actor: str, month: str):
    with sheet_user_context(actor), sheets_repository_context(MonthRepository(actor, month)):
        yield


def _date(value: str) -> str:
    from bookiebot.sheets.reimbursement_history import _expense_date
    parsed = _expense_date(value)
    return parsed.isoformat() if parsed else ""


def _public(actor: str, month: str, logged: undo.LoggedAction, rows: list[list[str]], *, manual: bool = False) -> dict[str, Any]:
    action = logged.action
    fields = undo._field_columns_for_action(action)
    current = {key: cell(rows, action.row, col) for key, col in fields.items()}
    values = undo._field_values_for_action(action)
    canonical = undo._is_canonical_reimbursement(action)
    values = values if canonical else current
    capabilities = undo.action_capabilities(action)
    kind = undo._transaction_type(action)
    if kind == "split":
        kind = action.metadata.get("source_type", "expense")
    kind = kind if kind in {"expense", "income", "payment", "savings"} else "expense"
    uid = f"{month}:{logged.id}"
    version = digest([asdict(logged), current])
    category = action.metadata.get("category", "")
    description = values.get("item") or values.get("source") or expense_category_label(category) or action.description
    generated = (action.metadata.get("linked_repayment") == "true") or manual and (values.get("item", "").startswith(("Reimbursement ·", "Offset ·"))
                            or values.get("location", "").startswith(("Reimbursement to ", "Offset to ")))
    return {"id": uid, "actionId": logged.id, "month": month, "version": version,
            "date": _date(values.get("date", "")), "title": description, "location": values.get("location", ""),
            "person": values.get("person") or action.metadata.get("person") or get_user_config(actor).name,
            "kind": kind, "category": category, "categoryLabel": expense_category_label(category) if category else kind.title(),
            "amountCents": cents(values.get("amount", "")), "fields": values,
            "split": action.metadata.get("split_method", "") if capabilities.can_change_split else "",
            "capabilities": {"update": capabilities.can_update and not generated, "move": capabilities.can_move and not generated,
                "delete": capabilities.can_delete and not generated, "split": (capabilities.can_split or capabilities.can_change_split) and not generated,
                "cancel_split": capabilities.can_cancel_split and not generated, "undo": capabilities.can_undo and not manual and not generated},
            "editableFields": capabilities.editable_fields,
            "reasons": {"update": capabilities.update_reason, "move": capabilities.move_reason,
                "delete": capabilities.delete_reason, "split": capabilities.split_reason,
                "undo": "Shared corrections retain their audit history. Manage repayments separately in Shared." if canonical else ""},
            "notice": "This is a linked repayment. Manage or reverse it in Shared." if generated else "",
            "_logged": logged, "_manual": manual, "_current": current}


def _manual_actions(actor: str, month: str, expenses: list[list[str]], personal: list[list[str]]):
    persons = set(get_user_config(actor).expense_persons)
    for category, config in get_category_columns.items():
        columns = undo._category_columns(category)
        for row in range(int(config["start_row"]), len(expenses) + 1):
            values = {key: cell(expenses, row, col) for key, col in columns.items()}
            if cents(values.get("amount")) <= 0 or values.get("person") not in persons:
                continue
            action = undo.UndoAction(worksheet="expense", kind="clear_cells", row=row,
                columns=list(columns.values()), previous_values=[""] * len(columns), new_values=list(values.values()),
                metadata={"type": "expense", "category": category}, description=values.get("item") or category)
            yield undo.LoggedAction(id=f"sheet-expense-{category}-{row}", created_at=month + "-01", user_key=actor, action=action)
    summary = next((i for i, row in enumerate(personal, 1) if "Monthly Income:" in row), None)
    if summary:
        layout = income_sheet_layout(None, summary, rows=personal)
        for row in range(layout["header_row"] + 1, summary):
            amount = cell(personal, row, layout["amount"])
            source = cell(personal, row, layout["source"])
            if cents(amount) <= 0 or not source or source.startswith("<") or source.strip().casefold() == "spacex espp this month":
                continue
            metadata = {"type": "income", "source": source, **{f"income_{key}_column": str(layout[key]) for key in ("date", "source", "amount") if key in layout}}
            yield undo.LoggedAction(id=f"sheet-income-{row}", created_at=month + "-01", user_key=actor,
                action=undo.UndoAction(worksheet="income", kind="delete_row", row=row, columns=[], previous_values=[],
                    new_values=list(personal[row - 1]), metadata=metadata, description=f"income from {source}"))
    from bookiebot.reports.expense_breakdown import _payment_group_for_label
    for row, values in enumerate(personal, 1):
        label = cell(personal, row, 2)
        if label and _payment_group_for_label(label) and cents(cell(personal, row, 3)):
            yield undo.LoggedAction(id=f"sheet-payment-{row}", created_at=month + "-01", user_key=actor,
                action=undo.UndoAction(worksheet="income", kind="restore_cells", row=row, columns=[3], previous_values=[""],
                    new_values=[cell(personal, row, 3)], metadata={"type": "payment", "category": label, "exact_source_label": label}, description=label))
    savings_labels = {"enter monthly savings contribution", "enter 1st paycheck deposit", "enter 2nd paycheck deposit"}
    for row, values in enumerate(personal, 1):
        for col, label in enumerate(values, 1):
            if label.strip().casefold() in savings_labels and cents(cell(personal, row, col + 3)):
                yield undo.LoggedAction(id=f"sheet-savings-{row}-{col+3}", created_at=month + "-01", user_key=actor,
                    action=undo.UndoAction(worksheet="income", kind="restore_cells", row=row, columns=[col+3], previous_values=[""],
                        new_values=[cell(personal,row,col+3)], metadata={"type":"savings", "category":"monthly savings"}, description="Cash savings"))


def load_transactions(actor: str, month: str, *, fresh: bool = False) -> list[dict[str, Any]]:
    key = (actor, month)
    with _READ_LOCKS.setdefault(actor, threading.RLock()):
        with _CACHE_LOCK:
            if not fresh and key in _CACHE and time.monotonic() - _CACHE[key][0] < 30:
                return _CACHE[key][1]
        periods = [parse_phone_report_month(month)] if month != "all" else []
        years = sorted({p.year for p in periods}) if periods else sorted(configured_reimbursement_workbooks(actor, now_pacific().year), reverse=True)
        client, result = get_gspread_client(), []
        owner = get_user_config(actor).budget_owner_key
        allocations = []
        if shared.enabled():
            allocations = shared.build_reimbursement_store().snapshot(owner, include_inactive=True)["allocations"]
        aliases = actor_key_aliases(actor)
        for year in years:
            numbers = [p.month for p in periods] if periods else list(range(1, (now_pacific().month if year == now_pacific().year else 12) + 1))
            titles = [calendar.month_name[number] for number in numbers]
            logs = [f"_BookieBot Action Log - {year:04d}-{number:02d}" for number in numbers]
            personal = read_workbook_tabs(client, get_budget_spreadsheet_id_for_user(actor, year), titles)
            shared_rows = read_workbook_tabs(client, get_shared_expenses_spreadsheet_id(year), [*titles, *logs])
            for number, title, log in zip(numbers, titles, logs):
                if title not in shared_rows or title not in personal:
                    if periods:
                        raise TransactionValidation("That month's transaction sheets are not available.")
                    continue
                period = f"{year:04d}-{number:02d}"
                history = []
                if log in shared_rows and any(shared_rows[log]):
                    if shared_rows[log][0][:6] != undo._LOG_HEADERS:
                        raise RuntimeError("Transaction history is incomplete.")
                    history = [undo._logged_action_from_row(row) for row in shared_rows[log][1:] if row and row[0]]
                history = [entry for entry in history if entry.user_key in aliases]
                for entry in history:
                    entry.action.metadata["source_year"] = str(year)
                active = undo._dedupe_actions_by_lineage(undo.canonical_logged_actions([
                    entry for entry in history if entry.status == "active" and entry.action.metadata.get("type") not in {"system_state", "delete"}
                ], history=history), history)
                occupied = set()
                for logged, manual in [(entry, False) for entry in active] + [(entry, True) for entry in _manual_actions(actor, period, shared_rows[title], personal[title])]:
                    a = logged.action
                    if manual:
                        managed = [value for value in allocations if value["payerOwner"] == owner and value["sourceYear"] == year
                                   and value["sourceSheetTitle"] == title and value["sourceWorksheet"] == a.worksheet
                                   and value["sourceRow"] == a.row and (a.worksheet != "expense" or value["category"] == a.metadata.get("category"))]
                        if len(managed) > 1:
                            raise RuntimeError("Ambiguous managed transaction source")
                        if managed:
                            logged.id = managed[0]["sourceActionId"]
                            overlaid = undo._allocation_action(logged, managed[0])
                            if overlaid is None:
                                continue
                            logged, a = overlaid, overlaid.action
                        elif a.worksheet == "income" and a.metadata.get("type") == "payment":
                            _normalized_label = lambda value: re.sub(r"[^a-z0-9]", "", str(value).casefold())
                            if any(value["partnerOwner"] == owner and value["sourceYear"] == year
                                   and value["sourceSheetTitle"] == title and value["sourceWorksheet"] == "income"
                                   and _normalized_label(value["category"]) == _normalized_label(a.metadata.get("category", "")) for value in allocations):
                                a.metadata["linked_repayment"] = "true"
                    address = (a.worksheet, a.row, a.metadata.get("category", "") if a.worksheet == "expense" else "")
                    if address in occupied:
                        continue
                    rows = shared_rows[title] if a.worksheet == "expense" else personal[title]
                    if not manual and not undo._is_canonical_reimbursement(a):
                        columns = undo._field_columns_for_action(a)
                        expected = undo._field_values_for_action(a)
                        if any((undo._money_display_value(cell(rows, a.row, columns[field])) != undo._money_display_value(value)
                                if field == "amount" else cell(rows, a.row, columns[field]).strip() != value.strip())
                               for field, value in expected.items() if field in columns):
                            continue
                    occupied.add(address)
                    row = _public(actor, period, logged, rows, manual=manual)
                    if row["amountCents"] > 0:
                        result.append(row)
        result.sort(key=lambda row: (row["month"], row["date"], row["_logged"].created_at, row["id"]), reverse=True)
        with _CACHE_LOCK:
            if len(_CACHE) >= 32:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[key] = time.monotonic(), result
        return result


def public_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if not key.startswith("_")}


def listing(actor: str, query: Any) -> dict[str, Any]:
    month = query.get("month") or now_pacific().strftime("%Y-%m")
    if len(str(query.get("search", ""))) > 200:
        raise TransactionValidation("Use a search of up to 200 characters.")
    rows = load_transactions(actor, month, fresh=query.get("fresh") == "1")
    search = str(query.get("search", "")).casefold().split()
    kind, category, person, split = (query.get(key, "") for key in ("kind", "category", "person", "split"))
    try:
        offset = int(query.get("offset", 0))
        if not 0 <= offset <= 100_000:
            raise ValueError()
    except ValueError as exc:
        raise TransactionValidation("Choose a valid transactions page.") from exc
    selected = [row for row in rows if (not kind or row["kind"] == kind) and (not category or row["category"] == category)
        and (not person or row["person"] == person) and (not split or bool(row["split"]) == (split == "shared"))
        and all(word in " ".join(str(row[k]) for k in ("title", "location", "person", "categoryLabel", "amountCents", "date")).casefold()
                or word == f"{row['amountCents'] / 100:.2f}" for word in search)]
    return {"items": [public_row(row) for row in selected[offset:offset + 40]], "total": len(selected),
            "nextOffset": offset + 40 if len(selected) > offset + 40 else None,
            "categories": sorted({row["category"] for row in rows if row["category"]}),
            "persons": sorted({row["person"] for row in rows}), "month": month}


def _normalized(body: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    operation = body.get("operation")
    if operation not in {"update", "move", "delete", "split", "cancel_split", "undo"}:
        raise TransactionValidation("Choose an available transaction action.")
    if not row["capabilities"].get(operation):
        raise TransactionValidation(row["reasons"].get(operation) or "This action is unavailable for this transaction.")
    result: dict[str, Any] = {"operation": operation}
    updates = body.get("updates", {})
    if not isinstance(updates, dict) or set(updates) - (set(row["editableFields"]) | ({"item"} if operation == "move" else set())):
        raise TransactionValidation("Choose an editable transaction field.")
    if updates and operation not in {"update", "move"}:
        raise TransactionValidation("Only Update and Move can change transaction fields.")
    clean = {}
    for key, value in updates.items():
        if key == "amount":
            if type(value) is not int or not 0 < value <= shared.MAX_CENTS:
                raise TransactionValidation("Enter a positive amount in whole cents.")
            clean[key] = f"{value / 100:.2f}"
        elif not isinstance(value, str) or not value.strip() or len(value) > 200 or any(ord(ch) < 32 for ch in value) or value.lstrip().startswith("="):
            raise TransactionValidation("Enter plain transaction text, up to 200 characters.")
        else:
            clean[key] = value.strip()
    if "person" in clean and clean["person"] not in {"Hannah", "Brian (BofA)", "Brian (AL)"}:
        raise TransactionValidation("Choose a configured person/card.")
    if operation == "update" and not clean:
        raise TransactionValidation("Enter the details to update.")
    if clean:
        result["updates"] = clean
    if operation == "move":
        destination = body.get("destination")
        if destination not in get_category_columns or destination == row["category"]:
            raise TransactionValidation("Choose a different expense category.")
        needed = undo._values_for_category(row["fields"], destination, clean)
        missing = undo._missing_required_move_fields(needed, destination)
        if missing:
            raise TransactionValidation("Enter an item name before moving this transaction." if missing == ["item"] else "The source is missing required transaction details.")
        result["destination_category"] = destination
    if operation == "split":
        method = body.get("method")
        if method not in {"income", "equal", "fronted"} or (method == "fronted" and row["kind"] != "expense"):
            raise TransactionValidation("Choose By income or 50/50 for a payment, or a supported expense split.")
        result["split_method"] = method
    return result


def _undo_review_row(actor: str, month: str, action_id: str) -> dict[str, Any]:
    period = parse_phone_report_month(month)
    title = f"_BookieBot Action Log - {month}"
    source = read_workbook_tabs(get_gspread_client(), get_shared_expenses_spreadsheet_id(period.year), [title, calendar.month_name[period.month]])
    rows = source.get(title, [])
    if not rows or rows[0][:6] != undo._LOG_HEADERS:
        raise TransactionConflict("The saved Undo history is unavailable.")
    logged = next((undo._logged_action_from_row(row) for row in rows[1:] if row and row[0] == action_id and len(row) > 2 and row[2] in actor_key_aliases(actor)), None)
    if not logged or logged.status != "active" or logged.action.metadata.get("type") not in {"update", "move", "delete", "split"}:
        raise TransactionConflict("This change has already been undone or is unavailable.")
    cells = source.get(calendar.month_name[period.month], [])
    if logged.action.worksheet == "income":
        cells = read_workbook_tabs(get_gspread_client(), get_budget_spreadsheet_id_for_user(actor, period.year), [calendar.month_name[period.month]]).get(calendar.month_name[period.month], [])
    row = _public(actor, month, logged, cells)
    action = logged.action
    restored = dict(row["fields"])
    if action.kind == "compact_category_cells":
        snapshot = json.loads(action.metadata["category_snapshot"])[0]
        restored = dict(zip(undo._category_columns(action.metadata["category"]), snapshot))
    elif action.kind == "move_expense":
        restored = dict(zip(undo._category_columns(action.metadata["source_category"]), json.loads(action.metadata["source_values"])))
    elif action.kind == "restore_row":
        columns = undo._field_columns_for_action(action)
        restored = {field: str(action.previous_values[col - 1]) if col <= len(action.previous_values) else "" for field, col in columns.items()}
    else:
        columns = undo._field_columns_for_action(action)
        for col, value in zip(action.columns, action.previous_values):
            for field, column in columns.items():
                if col == column:
                    restored[field] = value
    row["fields"], row["amountCents"] = restored, cents(restored.get("amount", ""))
    row.update(person=restored.get("person") or get_user_config(actor).name, location=restored.get("location", ""), date=_date(restored.get("date", "")))
    row["title"] = logged.action.description
    # Restore/delete checks use fresh full source evidence as well as saved history.
    row["version"] = digest([asdict(logged), cells])
    return row


def review(actor: str, body: dict[str, Any]) -> dict[str, Any]:
    month = body.get("month")
    if not isinstance(month, str) or month == "all":
        raise TransactionValidation("Choose the transaction's recorded month.")
    row = (_undo_review_row(actor, month, str(body.get("id", "")).removeprefix(month + ":")) if body.get("operation") == "undo" else
           next((row for row in load_transactions(actor, month, fresh=True) if row["id"] == body.get("id")), None))
    if row is None:
        raise TransactionConflict("This transaction is no longer available. Reload Transactions.")
    if body.get("version") != row["version"] and not (body.get("operation") == "undo" and body.get("version") is None):
        raise TransactionConflict("This transaction changed. Reload it before reviewing a change.")
    normalized = _normalized(body, row)
    after = {**row["fields"], **normalized.get("updates", {})}
    payload: dict[str, Any] = {"item": public_row(row), "after": after,
        "operation": normalized["operation"], "destination": normalized.get("destination_category"),
        "reviewVersion": digest([row["version"], normalized])}
    if normalized["operation"] == "split" or (row["split"] and normalized["operation"] == "update" and "amount" in normalized.get("updates", {})):
        from bookiebot.sheets.collaboration import split_amounts
        method = normalized.get("split_method") or row["split"]
        payer, partner = split_amounts(cents(after.get("amount")) / 100, method, get_user_config(actor).budget_owner_key)
        payload["share"] = {"method": method, "payerCents": round(payer * 100), "partnerCents": round(partner * 100)}
    return {"review": payload, "_row": row, "_normalized": normalized}


class TransactionCommands:
    def __init__(self, access):
        self.access = access

    def initialize(self):
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute("SELECT pg_advisory_xact_lock(84392509)")
            db.execute("CREATE TABLE IF NOT EXISTS app_transaction_owners (owner_key TEXT PRIMARY KEY)")
            db.execute("""CREATE TABLE IF NOT EXISTS app_transaction_commands (
                owner_key TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                state TEXT NOT NULL, result_json TEXT NOT NULL, command_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_key, request_id))""")

    def saved(self, owner: str, request_id: str):
        with self.access.connect() as db:
            row = db.execute("SELECT state,result_json FROM app_transaction_commands WHERE owner_key=? AND request_id=?", (owner, request_id)).fetchone()
            return {"state": row["state"], **json.loads(row["result_json"])} if row else None

    def overview(self, owner: str, month: str) -> dict[str, Any]:
        """Owner-scoped recovery/Undo affordances survive another browser session."""
        with self.access.connect() as db:
            records = db.execute("SELECT state,result_json,command_json FROM app_transaction_commands WHERE owner_key=? ORDER BY created_at DESC", (owner,)).fetchall()
        undone: set[str] = set()
        result: dict[str, Any] = {}
        for record in records:
            body = json.loads(record["command_json"])
            saved = json.loads(record["result_json"])
            if record["state"] != "done":
                result["pendingCommand"] = body
            elif saved.get("success"):
                if body.get("operation") == "undo":
                    undone.add(body["id"])
                candidate = saved.get("undo")
                if (candidate and candidate["id"] not in undone and "undo" not in result
                        and (month == "all" or candidate["month"] == month)):
                    result["undo"] = candidate
        return result

    def command(self, actor: str, body: dict[str, Any]) -> dict[str, Any]:
        owner = get_user_config(actor).budget_owner_key
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise TransactionValidation("Start a fresh transaction review.")
        fingerprint = digest(body)
        # Persist a single claim before any sheet mutation. A lost response or
        # process restart can check this record but can never repeat the writer.
        with self.access.connect(write=True) as db:
            db.execute("INSERT INTO app_transaction_owners(owner_key) VALUES (?) ON CONFLICT(owner_key) DO NOTHING", (owner,))
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute("SELECT owner_key FROM app_transaction_owners WHERE owner_key=? FOR UPDATE", (owner,))
            old = db.execute("SELECT fingerprint,state,result_json FROM app_transaction_commands WHERE owner_key=? AND request_id=?", (owner, request_id)).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    raise TransactionConflict("This confirmation belongs to different transaction details.")
                return {"state": old["state"], **json.loads(old["result_json"])}
            pending = db.execute("SELECT request_id FROM app_transaction_commands WHERE owner_key=? AND state!='done'", (owner,)).fetchone()
            if pending:
                raise TransactionConflict("A prior change still needs verification. Check its saved status before another change.")
            db.execute("INSERT INTO app_transaction_commands VALUES (?,?,?,'running','{}',?,?)", (owner, request_id, fingerprint, json.dumps(body,sort_keys=True),datetime.now(timezone.utc).isoformat()))
        state, result = "done", {}
        writer_started = False
        try:
            with undo._RECENT_MUTATION_LOCK:
                checked = review(actor, body)
                if body.get("reviewVersion") != checked["review"]["reviewVersion"]:
                    raise TransactionConflict("The review changed. Review the transaction again.")
                row, data = checked["_row"], dict(checked["_normalized"])
                operation = data.pop("operation")
                with transaction_context(actor, row["month"]), sheet_command_context(request_id):
                    logged = row["_logged"]
                    if row["_manual"]:
                        writer_started = True
                        # Explicit confirmation adopts the existing source as
                        # audit lineage; it never copies/imports another row.
                        logged.id = undo.record_undo_action(actor, logged.action) or ""
                        if not logged.id:
                            raise RuntimeError("Could not save source history")
                    before_log = undo._read_log_data(raise_on_error=True)
                    if before_log is None:
                        raise RuntimeError("Could not read action history before the change")
                    before = {entry.logged.id for entry in before_log.records}
                    writer = {"update": undo.update_recent_action, "move": undo.move_recent_action,
                        "delete": undo.delete_recent_action, "split": undo.change_split_recent_action if row["split"] else undo.split_recent_action,
                        "cancel_split": undo.cancel_split_recent_action, "undo": undo.undo_logged_action}[operation]
                    writer_started = True
                    success, detail = writer(actor, action_id=logged.id, **data)
                    result = {"success": success, "detail": detail}
                    if not success and any(marker in detail.lower() for marker in (
                        "could not verify", "undo record", "something went wrong", "could not safely", "may already")):
                        state = "uncertain"
                        result["detail"] = "I could not verify the change. Check Transactions and saved history before another change. This request will not be submitted again."
                    elif success:
                        history = undo._read_log_data(raise_on_error=True)
                        new = [record.logged for record in history.records if record.logged.id not in before and record.logged.user_key in actor_key_aliases(actor)] if history else []
                        if new and operation != "undo" and undo.action_capabilities(new[-1].action).can_undo:
                            result["undo"] = {"month": row["month"], "id": row["month"] + ":" + new[-1].id}
        except (TransactionValidation, TransactionConflict) as exc:
            result = {"success": False, "detail": str(exc)}
        except Exception:
            logger.exception("App transaction outcome needs inspection", extra={"request_id": request_id})
            state = "uncertain" if writer_started else "done"
            result = {"success": False, "detail": ("The change may already be saved. Check Transactions and saved history before another change. This request will not be submitted again."
                      if writer_started else "Could not prepare the change. Nothing was changed. Reload Transactions and try again shortly.")}
        finally:
            with _CACHE_LOCK:
                for key in list(_CACHE):
                    if key[0] == actor:
                        _CACHE.pop(key)
        with self.access.connect(write=True) as db:
            db.execute("UPDATE app_transaction_commands SET state=?,result_json=? WHERE owner_key=? AND request_id=?", (state, json.dumps(result), owner, request_id))
        return {"state": state, **result}


@lru_cache(maxsize=8)
def _commands(access):
    store = TransactionCommands(access)
    store.initialize()
    return store


def build_transaction_commands():
    with _factory_lock:
        return _commands(build_app_access_store())
