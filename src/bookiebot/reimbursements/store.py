"""Household reimbursement accounting. Recording settlement never moves money.

All commands share one household transaction lock. The source sheet is a
projection; allocations and the audit trail remain authoritative in this store.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from functools import lru_cache
import hashlib
import json
import re
import threading
from typing import Any
from uuid import uuid4

from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore, build_app_access_store
from bookiebot.sheets.routing import get_discord_user_config, now_pacific

MAX_CENTS = 10_000_000_000
MAX_OFFSET_ENTRIES = 100
OWNERS = frozenset({"brian", "hannah"})


class ReimbursementValidationError(ValueError):
    pass


class ReimbursementNotFoundError(LookupError):
    pass


class ReimbursementConflictError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _text(value: Any, label: str, maximum: int = 200, *, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ReimbursementValidationError(f"{label} must be plain text of at most {maximum} characters.")
    result = value.strip()
    if required and not result:
        raise ReimbursementValidationError(f"{label} is required.")
    return result


def _owner(value: Any) -> str:
    if not isinstance(value, str) or value not in OWNERS:
        raise ReimbursementValidationError("Reimbursements require a mapped personal account.")
    return value


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ReimbursementValidationError(f"{label} must be an integer between {minimum} and {maximum}.")
    return value


def _cents(value: Any, label: str, *, zero: bool = False) -> int:
    return _integer(value, label, 0 if zero else 1, MAX_CENTS)


def _date(value: Any, label: str, *, past: bool = False) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ReimbursementValidationError(f"Enter a valid {label.lower()}.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ReimbursementValidationError(f"Enter a valid {label.lower()}.") from exc
    if not 1900 <= parsed.year <= 2200 or (past and parsed > now_pacific().date()):
        raise ReimbursementValidationError(f"{label} must be between 1900 and {'today' if past else '2200'}.")
    return value


def _json(value: Any, *, maximum: int = 100_000) -> str:
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ReimbursementValidationError("Reimbursement data must contain valid JSON values.") from exc
    if len(encoded) > maximum:
        raise ReimbursementValidationError("The reimbursement request is too large.")
    return encoded


def _allocation_details(payload: Any) -> dict[str, Any]:
    required = {"id", "payerOwner", "partnerOwner", "payerPerson", "item", "location", "expenseDate", "category",
                "sourceWorksheet", "sourceRow", "sourceActionId", "sourceYear", "grossCents", "payerShareCents",
                "partnerShareCents", "method", "accounting"}
    optional = {"splitActionId", "sourceSpreadsheetId", "settledCents", "sourceValues", "sourceColumnMap", "actorKey",
                "ledgerSpreadsheetId", "ledgerYear", "originalPerson", "legacyReceivedAt", "sourceSheetTitle", "baselineSettledCents"}
    if not isinstance(payload, dict) or set(payload) - required - optional or required - set(payload):
        raise ReimbursementValidationError("Allocation fields are missing or unexpected.")
    result: dict[str, Any] = {}
    for key, limit in {"id": 200, "payerPerson": 100, "item": 500, "location": 500, "category": 100,
                       "sourceWorksheet": 200, "sourceActionId": 200}.items():
        result[key] = _text(payload[key], key, limit, required=key != "location")
    result["payerOwner"], result["partnerOwner"] = _owner(payload["payerOwner"]), _owner(payload["partnerOwner"])
    if result["payerOwner"] == result["partnerOwner"]:
        raise ReimbursementValidationError("A reimbursement must connect two different people.")
    mapped = {config.budget_owner_key for config in get_discord_user_config().values()
              if result["payerPerson"].casefold() in {name.casefold() for name in
                  (config.name, *config.expense_persons, *config.expense_payment_methods)}}
    if mapped != {result["payerOwner"]}:
        raise ReimbursementValidationError("The payer person must belong to the payer's mapped account.")
    result["expenseDate"] = _date(payload["expenseDate"], "Expense date")
    result["sourceRow"] = _integer(payload["sourceRow"], "Source row", 1, 1_000_000)
    result["sourceYear"] = _integer(payload["sourceYear"], "Source year", 1900, 2200)
    result["sourceSpreadsheetId"] = _text(payload.get("sourceSpreadsheetId", ""), "Source spreadsheet", 200)
    result["splitActionId"] = _text(payload.get("splitActionId", ""), "Split action", 200)
    for key in ("grossCents", "payerShareCents", "partnerShareCents", "settledCents"):
        result[key] = _cents(payload.get(key, 0), key, zero=key != "grossCents")
    if result["payerShareCents"] + result["partnerShareCents"] != result["grossCents"]:
        raise ReimbursementValidationError("The two shares must equal the gross amount exactly.")
    if "baselineSettledCents" in payload and _cents(payload["baselineSettledCents"], "Baseline settled", zero=True) != result["settledCents"]:
        raise ReimbursementValidationError("The initial settlement baseline must match the registered settled amount.")
    result["baselineSettledCents"] = result["settledCents"]
    if result["settledCents"] > result["partnerShareCents"]:
        raise ReimbursementValidationError("Settlement cannot exceed the partner's share.")
    if payload["method"] not in ("income", "equal", "fronted") or payload["accounting"] not in ("cash_v1", "legacy_net"):
        raise ReimbursementValidationError("Unknown split or accounting method.")
    result["method"], result["accounting"] = payload["method"], payload["accounting"]
    if result["method"] == "fronted" and result["payerShareCents"] != 0:
        raise ReimbursementValidationError("A fronted expense belongs entirely to the partner.")
    if result["method"] == "equal" and abs(result["payerShareCents"] - result["partnerShareCents"]) > 1:
        raise ReimbursementValidationError("An equal split must divide the gross amount equally to the cent.")
    for key in ("actorKey", "ledgerSpreadsheetId", "originalPerson", "legacyReceivedAt", "sourceSheetTitle"):
        if key in payload:
            result[key] = _text(payload[key], key, 100 if key == "sourceSheetTitle" else 200)
    if "ledgerYear" in payload:
        result["ledgerYear"] = _integer(payload["ledgerYear"], "Ledger year", 1900, 2200)
    for key in ("sourceValues", "sourceColumnMap"):
        if key not in payload:
            continue
        mapping = payload[key]
        if not isinstance(mapping, dict) or len(mapping) > 50:
            raise ReimbursementValidationError(f"{key} must be a small field mapping.")
        result[key] = {}
        for field, value in mapping.items():
            field = _text(field, "Source field", 100, required=True)
            if field in result[key]:
                raise ReimbursementValidationError("Source field names must be distinct.")
            if key == "sourceValues":
                _text(value, "Source cell value", 2_000)
                result[key][field] = value  # Exact source identity includes surrounding whitespace.
            else:
                result[key][field] = _integer(value, "Source column", 1, 1_000)
    return result


class ReimbursementStore:
    def __init__(self, access: AppAccessStore):
        self.access = access

    def initialize(self) -> None:
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute("SELECT pg_advisory_xact_lock(84392516)")
            db.execute("CREATE TABLE IF NOT EXISTS app_reimbursement_household (id TEXT PRIMARY KEY)")
            db.execute("INSERT INTO app_reimbursement_household(id) VALUES ('household') ON CONFLICT(id) DO NOTHING")
            db.execute(f"""CREATE TABLE IF NOT EXISTS app_reimbursement_allocations (
                id TEXT PRIMARY KEY, payer_owner TEXT NOT NULL, partner_owner TEXT NOT NULL,
                source_action_id TEXT NOT NULL, source_year BIGINT NOT NULL, payload_json TEXT NOT NULL,
                registration_fingerprint TEXT NOT NULL, gross_cents BIGINT NOT NULL,
                payer_share_cents BIGINT NOT NULL, partner_share_cents BIGINT NOT NULL,
                settled_cents BIGINT NOT NULL, version BIGINT NOT NULL, projected_version BIGINT NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(source_action_id, source_year),
                CHECK(payer_owner IN ('brian','hannah') AND partner_owner IN ('brian','hannah') AND payer_owner <> partner_owner),
                CHECK(gross_cents > 0 AND gross_cents <= {MAX_CENTS}),
                CHECK(payer_share_cents >= 0 AND partner_share_cents >= 0 AND payer_share_cents + partner_share_cents = gross_cents),
                CHECK(settled_cents >= 0 AND settled_cents <= partner_share_cents),
                CHECK(version > 0 AND projected_version >= 0 AND projected_version <= version)
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS app_reimbursement_events (
                id TEXT PRIMARY KEY, allocation_id TEXT NOT NULL REFERENCES app_reimbursement_allocations(id),
                operation_id TEXT NOT NULL, kind TEXT NOT NULL, actor_owner TEXT NOT NULL,
                amount_cents BIGINT NOT NULL, event_date TEXT NOT NULL, note TEXT NOT NULL,
                status TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT NOT NULL DEFAULT '',
                confirmed_by TEXT NOT NULL DEFAULT '', confirmation_operation_id TEXT NOT NULL DEFAULT '',
                reversed_at TEXT NOT NULL DEFAULT '', reversed_by TEXT NOT NULL DEFAULT '',
                reversal_operation_id TEXT NOT NULL DEFAULT '',
                CHECK(kind IN ('receive','report_payment','offset')),
                CHECK(status IN ('pending','confirmed','reversed')),
                CHECK(amount_cents > 0), CHECK(actor_owner IN ('brian','hannah'))
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS app_reimbursement_events_allocation_idx ON app_reimbursement_events(allocation_id, created_at, id)")
            db.execute("CREATE INDEX IF NOT EXISTS app_reimbursement_events_operation_idx ON app_reimbursement_events(operation_id)")
            db.execute("""CREATE TABLE IF NOT EXISTS app_reimbursement_commands (
                request_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
                result_json TEXT NOT NULL, created_at TEXT NOT NULL
            )""")

    def _lock(self, db: Any) -> None:
        # Also take this lock for multi-query reads: PG's default READ COMMITTED
        # would otherwise mix an allocation from before a receipt with later events.
        db.execute("SELECT id FROM app_reimbursement_household WHERE id = 'household'" + self.access._pairing_lock).fetchone()

    @staticmethod
    def _row(db: Any, allocation_id: str) -> Any:
        row = db.execute("SELECT * FROM app_reimbursement_allocations WHERE id = ?", (allocation_id,)).fetchone()
        if row is None:
            raise ReimbursementNotFoundError("This reimbursement is unavailable.")
        return row

    @staticmethod
    def _payload(row: Any) -> dict[str, Any]:
        value = json.loads(row["payload_json"])
        outstanding = int(row["partner_share_cents"]) - int(row["settled_cents"])
        return {**value, "settledCents": int(row["settled_cents"]), "outstandingCents": outstanding,
                "status": "outstanding" if outstanding else "settled", "version": int(row["version"]),
                "projectedVersion": int(row["projected_version"]), "createdAt": row["created_at"], "updatedAt": row["updated_at"]}

    @staticmethod
    def _event_payload(row: Any, allocation: Any) -> dict[str, Any]:
        return {"id": row["id"], "allocationId": row["allocation_id"], "operationId": row["operation_id"],
                "kind": row["kind"], "actorOwner": row["actor_owner"], "payeeOwner": allocation["payer_owner"],
                "debtorOwner": allocation["partner_owner"], "amountCents": int(row["amount_cents"]),
                "date": row["event_date"], "note": row["note"], "status": row["status"], "createdAt": row["created_at"],
                "confirmedAt": row["confirmed_at"], "confirmedBy": row["confirmed_by"],
                "confirmationOperationId": row["confirmation_operation_id"], "reversedAt": row["reversed_at"],
                "reversedBy": row["reversed_by"], "reversalOperationId": row["reversal_operation_id"]}

    def register_allocation(self, payload: dict[str, Any]) -> dict[str, Any]:
        value = _allocation_details(payload)
        encoded = _json(value)
        fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
        with self.access.connect(write=True) as db:
            self._lock(db)
            existing = db.execute("SELECT * FROM app_reimbursement_allocations WHERE id = ?", (value["id"],)).fetchone()
            if existing is not None:
                if existing["registration_fingerprint"] != fingerprint:
                    raise ReimbursementConflictError("This allocation identifier belongs to different source or financial data.")
                return self._payload(existing)
            duplicate = db.execute("SELECT id FROM app_reimbursement_allocations WHERE source_action_id = ? AND source_year = ?",
                                   (value["sourceActionId"], value["sourceYear"])).fetchone()
            if duplicate is not None:
                raise ReimbursementConflictError("This source expense already has a reimbursement allocation.")
            now = _now()
            db.execute("""INSERT INTO app_reimbursement_allocations(id,payer_owner,partner_owner,source_action_id,source_year,
                         payload_json,registration_fingerprint,gross_cents,payer_share_cents,partner_share_cents,settled_cents,
                         version,projected_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)""",
                       (value["id"], value["payerOwner"], value["partnerOwner"], value["sourceActionId"], value["sourceYear"],
                        encoded, fingerprint, value["grossCents"], value["payerShareCents"], value["partnerShareCents"],
                        value["settledCents"], now, now))
            return self._payload(self._row(db, value["id"]))

    def find_by_source(self, source_action_id: str, source_year: int) -> dict[str, Any] | None:
        source_action_id = _text(source_action_id, "Source action", 200, required=True)
        source_year = _integer(source_year, "Source year", 1900, 2200)
        with self.access.connect(write=True) as db:
            self._lock(db)
            row = db.execute("SELECT * FROM app_reimbursement_allocations WHERE source_action_id = ? AND source_year = ?",
                             (source_action_id, source_year)).fetchone()
            return self._payload(row) if row is not None else None

    def get_allocation(self, allocation_id: str) -> dict[str, Any]:
        allocation_id = _text(allocation_id, "Allocation identifier", 200, required=True)
        with self.access.connect(write=True) as db:
            self._lock(db)
            return self._payload(self._row(db, allocation_id))

    def attach_source(self, allocation_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        allocation_id = _text(allocation_id, "Allocation identifier", 200, required=True)
        if not isinstance(updates, dict) or not updates or set(updates) - {"splitActionId", "sourceRow"}:
            raise ReimbursementValidationError("Only split-action or source-row metadata can be attached.")
        checked = {key: (_integer(value, "Source row", 1, 1_000_000) if key == "sourceRow"
                         else _text(value, "Split action", 200, required=True)) for key, value in updates.items()}
        with self.access.connect(write=True) as db:
            self._lock(db)
            row = self._row(db, allocation_id)
            value = json.loads(row["payload_json"])
            if all(value.get(key) == new for key, new in checked.items()):
                return self._payload(row)
            if "splitActionId" in checked and value.get("splitActionId") and value["splitActionId"] != checked["splitActionId"]:
                raise ReimbursementConflictError("The allocation is already attached to a different split action.")
            value.update(checked)
            db.execute("UPDATE app_reimbursement_allocations SET payload_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
                       (_json(value), _now(), allocation_id))
            return self._payload(self._row(db, allocation_id))

    def snapshot(self, owner: str) -> dict[str, Any]:
        owner = _owner(owner)
        with self.access.connect(write=True) as db:
            self._lock(db)
            rows = db.execute("SELECT * FROM app_reimbursement_allocations WHERE payer_owner = ? OR partner_owner = ? ORDER BY created_at, id", (owner, owner)).fetchall()
            allocations = {row["id"]: row for row in rows}
            events = db.execute("""SELECT e.* FROM app_reimbursement_events e JOIN app_reimbursement_allocations a ON a.id = e.allocation_id
                                WHERE a.payer_owner = ? OR a.partner_owner = ? ORDER BY e.created_at, e.id""", (owner, owner)).fetchall()
            return {"allocations": [self._payload(row) for row in rows],
                    "events": [self._event_payload(event, allocations[event["allocation_id"]]) for event in events], "currency": "USD"}

    def pending_projections(self) -> list[dict[str, Any]]:
        with self.access.connect(write=True) as db:
            self._lock(db)
            rows = db.execute("SELECT * FROM app_reimbursement_allocations WHERE projected_version < version ORDER BY created_at, id").fetchall()
            result = []
            for row in rows:
                events = db.execute("SELECT * FROM app_reimbursement_events WHERE allocation_id = ? ORDER BY created_at, id", (row["id"],)).fetchall()
                result.append({**self._payload(row), "events": [self._event_payload(event, row) for event in events]})
            return result

    def mark_projected(self, allocation_id: str, version: int) -> bool:
        allocation_id = _text(allocation_id, "Allocation identifier", 200, required=True)
        version = _integer(version, "Version", 1, 2**53 - 1)
        with self.access.connect(write=True) as db:
            self._lock(db)
            row = db.execute("SELECT version FROM app_reimbursement_allocations WHERE id = ?", (allocation_id,)).fetchone()
            if row is None or int(row["version"]) != version:
                return False
            db.execute("UPDATE app_reimbursement_allocations SET projected_version = ? WHERE id = ?", (version, allocation_id))
            return True

    @staticmethod
    def _writable(row: Any) -> None:
        if json.loads(row["payload_json"])["accounting"] != "cash_v1":
            raise ReimbursementConflictError("Historical net-accounting reimbursements are read-only.")

    @staticmethod
    def _version(row: Any, value: Any) -> None:
        if type(value) is not int or value != int(row["version"]):
            raise ReimbursementConflictError("This reimbursement changed. Refresh before continuing.")

    @staticmethod
    def _after_expense(row: Any, when: str) -> None:
        if when < json.loads(row["payload_json"])["expenseDate"]:
            raise ReimbursementValidationError("Payment cannot be recorded before the expense date.")

    @staticmethod
    def _no_pending(db: Any, allocation_id: str) -> None:
        pending = db.execute("SELECT id FROM app_reimbursement_events WHERE allocation_id = ? AND status = 'pending' LIMIT 1", (allocation_id,)).fetchone()
        if pending is not None:
            raise ReimbursementConflictError("Confirm or dismiss the pending reported payment before recording a receipt or offset.")

    @staticmethod
    def _available(row: Any, amount: int) -> None:
        if amount > int(row["partner_share_cents"]) - int(row["settled_cents"]):
            raise ReimbursementConflictError("The amount exceeds what is still owed on this reimbursement.")

    def _add_event(self, db: Any, row: Any, operation_id: str, kind: str, owner: str,
                   amount: int, when: str, note: str, now: str, *, confirmed: bool) -> str:
        event_id = uuid4().hex
        db.execute("""INSERT INTO app_reimbursement_events(id,allocation_id,operation_id,kind,actor_owner,amount_cents,
                     event_date,note,status,created_at,confirmed_at,confirmed_by,confirmation_operation_id)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (event_id, row["id"], operation_id, kind, owner, amount, when, note,
                    "confirmed" if confirmed else "pending", now, now if confirmed else "", owner if confirmed else "",
                    operation_id if confirmed else ""))
        return event_id

    @staticmethod
    def _settle(db: Any, allocation_id: str, amount: int, now: str) -> None:
        db.execute("UPDATE app_reimbursement_allocations SET settled_cents = settled_cents + ?, version = version + 1, updated_at = ? WHERE id = ?",
                   (amount, now, allocation_id))

    def get_command_result(self, owner: str, request_id: str) -> dict[str, Any] | None:
        """Recover a known transport request without rebuilding its old inputs."""
        owner = _owner(owner)
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise ReimbursementValidationError("A valid request identifier is required.")
        with self.access.connect(write=True) as db:
            self._lock(db)
            row = db.execute("SELECT owner_key,result_json FROM app_reimbursement_commands WHERE request_id = ?", (request_id,)).fetchone()
            if row is None:
                return None
            if row["owner_key"] != owner:
                raise ReimbursementConflictError("This request identifier belongs to another account.")
            return json.loads(row["result_json"])

    def command(self, owner: str, body: dict[str, Any]) -> dict[str, Any]:
        owner = _owner(owner)
        if not isinstance(body, dict):
            raise ReimbursementValidationError("A reimbursement request must be an object.")
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise ReimbursementValidationError("A request identifier is required. Reload and try again.")
        fingerprint = hashlib.sha256(_json(body).encode()).hexdigest()
        with self.access.connect(write=True) as db:
            self._lock(db)
            existing = db.execute("SELECT owner_key,fingerprint,result_json FROM app_reimbursement_commands WHERE request_id = ?", (request_id,)).fetchone()
            if existing is not None:
                if existing["owner_key"] != owner or existing["fingerprint"] != fingerprint:
                    raise ReimbursementConflictError("This request identifier was already used for another change.")
                return json.loads(existing["result_json"])
            now, operation_id = _now(), uuid4().hex
            # Claim before state-dependent work; failure rolls this claim back with
            # all changes, success caches the exact original result in the same tx.
            db.execute("INSERT INTO app_reimbursement_commands(request_id,owner_key,fingerprint,result_json,created_at) VALUES (?,?,?,'',?)",
                       (request_id, owner, fingerprint, now))
            operation = body.get("operation")
            common = {"operation", "requestId"}
            allowed = {"receive": {"allocationId", "version", "amountCents", "date", "note"},
                       "report_payment": {"allocationId", "version", "amountCents", "date", "note"},
                       "confirm_payment": {"allocationId", "version", "eventId"},
                       "offset": {"entries", "date", "note"}, "reverse": {"eventId"}}
            if not isinstance(operation, str) or operation not in allowed or set(body) - common - allowed[operation]:
                raise ReimbursementValidationError("Unknown action or unexpected reimbursement fields.")
            changed: list[str] = []
            event_ids: list[str] = []
            if operation in {"receive", "report_payment", "confirm_payment"}:
                allocation_id = _text(body.get("allocationId"), "Allocation identifier", 200, required=True)
                row = self._row(db, allocation_id)
                self._writable(row)
                self._version(row, body.get("version"))
                expected = row["partner_owner"] if operation == "report_payment" else row["payer_owner"]
                if owner != expected:
                    raise ReimbursementValidationError("Only the debtor can report a payment; only the payee can confirm receiving it.")
                if operation == "confirm_payment":
                    event_id = _text(body.get("eventId"), "Payment identifier", 200, required=True)
                    event = db.execute("SELECT * FROM app_reimbursement_events WHERE id = ? AND allocation_id = ?", (event_id, allocation_id)).fetchone()
                    if event is None:
                        raise ReimbursementNotFoundError("This reported payment is unavailable.")
                    if event["kind"] != "report_payment" or event["status"] != "pending":
                        raise ReimbursementConflictError("This payment is no longer awaiting confirmation.")
                    amount = int(event["amount_cents"])
                    self._available(row, amount)
                    db.execute("UPDATE app_reimbursement_events SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?, confirmation_operation_id = ? WHERE id = ?",
                               (now, owner, operation_id, event_id))
                else:
                    amount = _cents(body.get("amountCents"), "Payment amount")
                    when = _date(body.get("date"), "Payment date", past=True)
                    note = _text(body.get("note", ""), "Note", 500)
                    self._after_expense(row, when)
                    if operation == "receive":
                        self._no_pending(db, allocation_id)
                    self._available(row, amount)
                    if operation == "report_payment":
                        pending = db.execute("SELECT COALESCE(SUM(amount_cents),0) AS amount FROM app_reimbursement_events WHERE allocation_id = ? AND status = 'pending'", (allocation_id,)).fetchone()
                        if amount + int(pending["amount"]) > int(row["partner_share_cents"]) - int(row["settled_cents"]):
                            raise ReimbursementConflictError("Pending reported payments already cover this amount.")
                    event_id = self._add_event(db, row, operation_id, operation, owner, amount, when, note, now, confirmed=operation == "receive")
                event_ids.append(event_id)
                if operation != "report_payment":
                    self._settle(db, allocation_id, amount, now)
                    changed.append(allocation_id)
            elif operation == "offset":
                entries = body.get("entries")
                if not isinstance(entries, list) or not 2 <= len(entries) <= MAX_OFFSET_ENTRIES:
                    raise ReimbursementValidationError("Choose reimbursements in both directions for the offset.")
                when, note = _date(body.get("date"), "Offset date", past=True), _text(body.get("note", ""), "Note", 500)
                selected, totals = [], {"brian": 0, "hannah": 0}
                for entry in entries:
                    if not isinstance(entry, dict) or set(entry) != {"allocationId", "version", "amountCents"}:
                        raise ReimbursementValidationError("Each offset entry needs an allocation, version and amount.")
                    allocation_id = _text(entry["allocationId"], "Allocation identifier", 200, required=True)
                    if allocation_id in changed:
                        raise ReimbursementValidationError("A reimbursement can appear only once in an offset.")
                    row = self._row(db, allocation_id)
                    self._writable(row)
                    self._version(row, entry["version"])
                    amount = _cents(entry["amountCents"], "Offset amount")
                    self._after_expense(row, when)
                    self._no_pending(db, allocation_id)
                    self._available(row, amount)
                    totals[row["payer_owner"]] += amount
                    selected.append((row, amount))
                    changed.append(allocation_id)
                if not totals["brian"] or totals["brian"] != totals["hannah"]:
                    raise ReimbursementValidationError("An offset must clear equal amounts owed in both directions.")
                for row, amount in selected:
                    event_ids.append(self._add_event(db, row, operation_id, "offset", owner, amount, when, note, now, confirmed=True))
                    self._settle(db, row["id"], amount, now)
            else:
                event_id = _text(body.get("eventId"), "Payment identifier", 200, required=True)
                event = db.execute("SELECT * FROM app_reimbursement_events WHERE id = ?", (event_id,)).fetchone()
                if event is None:
                    raise ReimbursementNotFoundError("This payment is unavailable.")
                events = (db.execute("SELECT * FROM app_reimbursement_events WHERE operation_id = ? ORDER BY id", (event["operation_id"],)).fetchall()
                          if event["kind"] == "offset" else [event])
                rows = {item["allocation_id"]: self._row(db, item["allocation_id"]) for item in events}
                for row in rows.values():
                    self._writable(row)
                if not (owner == event["actor_owner"] or any(row["payer_owner"] == owner for row in rows.values())):
                    raise ReimbursementValidationError("Only the original actor or payee can reverse this event.")
                if any(item["status"] == "reversed" for item in events):
                    raise ReimbursementConflictError("This payment was already reversed.")
                for item in events:
                    if item["status"] == "confirmed":
                        row = rows[item["allocation_id"]]
                        if int(row["settled_cents"]) < int(item["amount_cents"]):
                            raise ReimbursementConflictError("This settlement cannot be reversed from the current balance.")
                        self._settle(db, row["id"], -int(item["amount_cents"]), now)
                        changed.append(row["id"])
                    db.execute("UPDATE app_reimbursement_events SET status = 'reversed', reversed_at = ?, reversed_by = ?, reversal_operation_id = ? WHERE id = ?",
                               (now, owner, operation_id, item["id"]))
                    event_ids.append(item["id"])
            result_events = []
            for event_id in event_ids:
                event = db.execute("SELECT * FROM app_reimbursement_events WHERE id = ?", (event_id,)).fetchone()
                result_events.append(self._event_payload(event, self._row(db, event["allocation_id"])))
            result = {"allocations": [self._payload(self._row(db, allocation_id)) for allocation_id in changed],
                      "events": result_events, "operationId": operation_id}
            db.execute("UPDATE app_reimbursement_commands SET result_json = ? WHERE request_id = ?", (_json(result, maximum=20_000_000), request_id))
            return result


@lru_cache(maxsize=8)
def _store_for_access(access: AppAccessStore) -> ReimbursementStore:
    store = ReimbursementStore(access)
    store.initialize()
    return store


_factory_lock = threading.Lock()


def build_reimbursement_store() -> ReimbursementStore:
    with _factory_lock:
        return _store_for_access(build_app_access_store())
