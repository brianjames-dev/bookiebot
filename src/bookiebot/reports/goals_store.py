"""Personal savings plans, separate from bank balances and monthly sheet savings."""
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
from bookiebot.sheets.routing import now_pacific

MAX_CENTS = 10_000_000_000


class GoalValidationError(ValueError):
    pass


class GoalNotFoundError(LookupError):
    pass


class GoalConflictError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _text(value: Any, label: str, maximum: int, *, required: bool = False) -> str:
    if not isinstance(value, str) or len(value.strip()) > maximum or any(ord(char) < 32 for char in value):
        raise GoalValidationError(f"{label} must be plain text of at most {maximum} characters.")
    result = value.strip()
    if required and not result:
        raise GoalValidationError(f"Enter {label.lower()}.")
    return result


def _cents(value: Any, label: str, *, allow_zero: bool = False) -> int:
    if type(value) is not int or not (0 if allow_zero else 1) <= value <= MAX_CENTS:
        raise GoalValidationError(f"{label} must be a valid {'nonnegative' if allow_zero else 'positive'} amount.")
    return value


def _date(value: Any, label: str, *, optional: bool = False) -> str:
    if optional and value in (None, ""):
        return ""
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise GoalValidationError(f"Enter a valid {label.lower()}.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise GoalValidationError(f"Enter a valid {label.lower()}.") from exc
    if not 1900 <= parsed.year <= 2200:
        raise GoalValidationError(f"Enter a {label.lower()} between 1900 and 2200.")
    return value


class GoalsStore:
    def __init__(self, access: AppAccessStore):
        self.access = access

    def initialize(self) -> None:
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                # Separate app processes may initialize goals together during
                # a deploy; IF NOT EXISTS alone does not serialize PG DDL.
                db.execute("SELECT pg_advisory_xact_lock(84392505)")
            db.execute("CREATE TABLE IF NOT EXISTS app_goal_owners (owner_key TEXT PRIMARY KEY)")
            db.execute("""CREATE TABLE IF NOT EXISTS app_savings_goals (
                id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, name TEXT NOT NULL,
                target_cents BIGINT NOT NULL, starting_cents BIGINT NOT NULL,
                target_date TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
                version BIGINT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS app_savings_goals_owner_idx ON app_savings_goals(owner_key, archived)")
            db.execute("""CREATE TABLE IF NOT EXISTS app_goal_contributions (
                id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, owner_key TEXT NOT NULL,
                amount_cents BIGINT NOT NULL, contribution_date TEXT NOT NULL,
                note TEXT NOT NULL, created_at TEXT NOT NULL, reversed_at TEXT NOT NULL DEFAULT ''
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS app_goal_contributions_goal_idx ON app_goal_contributions(owner_key, goal_id, created_at)")
            db.execute("""CREATE TABLE IF NOT EXISTS app_goal_commands (
                owner_key TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                result_json TEXT NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(owner_key, request_id)
            )""")

    @staticmethod
    def _owner(owner: str) -> None:
        if owner not in {"brian", "hannah"}:
            raise GoalValidationError("Savings goals require a mapped personal account.")

    @staticmethod
    def _goal(db: Any, owner: str, goal_id: str) -> Any:
        row = db.execute("SELECT * FROM app_savings_goals WHERE owner_key = ? AND id = ?", (owner, goal_id)).fetchone()
        if row is None:
            raise GoalNotFoundError("This savings goal is unavailable.")
        return row

    @staticmethod
    def _payload(db: Any, row: Any) -> dict[str, Any]:
        totals = db.execute("""SELECT COALESCE(SUM(CASE WHEN reversed_at = '' THEN amount_cents ELSE 0 END), 0) AS amount,
                            COUNT(*) AS count FROM app_goal_contributions WHERE owner_key = ? AND goal_id = ?""",
                            (row["owner_key"], row["id"])).fetchone()
        balance = int(row["starting_cents"]) + int(totals["amount"])
        return {"id": row["id"], "name": row["name"], "targetCents": int(row["target_cents"]),
                "startingCents": int(row["starting_cents"]), "balanceCents": balance,
                "contributionCents": int(totals["amount"]), "contributionCount": int(totals["count"]),
                "targetDate": row["target_date"], "archived": bool(row["archived"]),
                "version": int(row["version"]), "createdAt": row["created_at"], "updatedAt": row["updated_at"]}

    def list_goals(self, owner: str) -> dict[str, Any]:
        self._owner(owner)
        with self.access.connect() as db:
            rows = db.execute("SELECT * FROM app_savings_goals WHERE owner_key = ? ORDER BY archived, created_at DESC, id", (owner,)).fetchall()
            return {"goals": [self._payload(db, row) for row in rows], "scope": "personal", "currency": "USD"}

    def history(self, owner: str, goal_id: str, *, offset: int = 0) -> dict[str, Any]:
        self._owner(owner)
        if type(offset) is not int or not 0 <= offset <= 100_000:
            raise GoalValidationError("Invalid contribution history page.")
        with self.access.connect() as db:
            self._goal(db, owner, goal_id)
            rows = db.execute("""SELECT * FROM app_goal_contributions WHERE owner_key = ? AND goal_id = ?
                              ORDER BY created_at DESC, id DESC LIMIT 26 OFFSET ?""", (owner, goal_id, offset)).fetchall()
            return {"contributions": [{"id": row["id"], "amountCents": int(row["amount_cents"]),
                                       "date": row["contribution_date"], "note": row["note"],
                                       "createdAt": row["created_at"], "reversedAt": row["reversed_at"]} for row in rows[:25]],
                    "nextOffset": offset + 25 if len(rows) > 25 else None}

    def command(self, owner: str, body: dict[str, Any]) -> dict[str, Any]:
        self._owner(owner)
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise GoalValidationError("A request identifier is required. Reload and try again.")
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        with self.access.connect(write=True) as db:
            # Serialize all commands for one owner, including first-goal creation
            # and repeated requests. SQLite already reserves its writer above.
            db.execute("INSERT INTO app_goal_owners(owner_key) VALUES (?) ON CONFLICT(owner_key) DO NOTHING", (owner,))
            db.execute("SELECT owner_key FROM app_goal_owners WHERE owner_key = ?" + self.access._pairing_lock, (owner,)).fetchone()
            existing = db.execute("SELECT fingerprint, result_json FROM app_goal_commands WHERE owner_key = ? AND request_id = ?", (owner, request_id)).fetchone()
            if existing is not None:
                if existing["fingerprint"] != fingerprint:
                    raise GoalConflictError("This request was already used for another change. Reload and try again.")
                return json.loads(existing["result_json"])
            operation = body.get("operation")
            if operation == "create":
                allowed = {"operation", "requestId", "name", "targetCents", "startingCents", "targetDate"}
            elif operation == "edit":
                allowed = {"operation", "requestId", "goalId", "version", "name", "targetCents", "startingCents", "targetDate"}
            elif operation in {"archive", "restore"}:
                allowed = {"operation", "requestId", "goalId", "version"}
            elif operation == "contribute":
                allowed = {"operation", "requestId", "goalId", "version", "amountCents", "date", "note"}
            elif operation == "reverse":
                allowed = {"operation", "requestId", "goalId", "version", "contributionId"}
            else:
                raise GoalValidationError("Unknown savings goal action.")
            if set(body) - allowed:
                raise GoalValidationError("Unexpected fields in the savings goal request.")
            now = _now()
            if operation == "create":
                count = db.execute("SELECT COUNT(*) AS count FROM app_savings_goals WHERE owner_key = ?", (owner,)).fetchone()
                if int(count["count"]) >= 200:
                    raise GoalValidationError("This account already has 200 savings goals.")
                goal_id = uuid4().hex
                name, target, starting, target_date = self._details(body)
                db.execute("""INSERT INTO app_savings_goals(id, owner_key, name, target_cents, starting_cents, target_date,
                             archived, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)""",
                           (goal_id, owner, name, target, starting, target_date, now, now))
            else:
                goal_id = body.get("goalId")
                if not isinstance(goal_id, str):
                    raise GoalValidationError("Choose a savings goal.")
                goal = self._goal(db, owner, goal_id)
                if type(body.get("version")) is not int or body["version"] != int(goal["version"]):
                    raise GoalConflictError("This goal changed on another screen. Refresh and try again.")
                if goal["archived"] and operation != "restore":
                    raise GoalConflictError("Restore this archived goal before changing it.")
                if operation == "edit":
                    name, target, starting, target_date = self._details(body)
                    if starting + self._payload(db, goal)["contributionCents"] > MAX_CENTS:
                        raise GoalValidationError("This starting balance exceeds the supported goal balance.")
                    db.execute("UPDATE app_savings_goals SET name = ?, target_cents = ?, starting_cents = ?, target_date = ? WHERE owner_key = ? AND id = ?",
                               (name, target, starting, target_date, owner, goal_id))
                elif operation in {"archive", "restore"}:
                    db.execute("UPDATE app_savings_goals SET archived = ? WHERE owner_key = ? AND id = ?", (int(operation == "archive"), owner, goal_id))
                elif operation == "contribute":
                    amount = _cents(body.get("amountCents"), "Contribution")
                    contribution_date = _date(body.get("date"), "Contribution date")
                    if date.fromisoformat(contribution_date) > now_pacific().date():
                        raise GoalValidationError("Contributions record money already allocated; choose today or an earlier date.")
                    note = _text(body.get("note", ""), "Note", 200)
                    balance = self._payload(db, goal)["balanceCents"]
                    if balance + amount > MAX_CENTS:
                        raise GoalValidationError("This contribution exceeds the supported goal balance.")
                    db.execute("""INSERT INTO app_goal_contributions(id, goal_id, owner_key, amount_cents, contribution_date, note, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)""", (uuid4().hex, goal_id, owner, amount, contribution_date, note, now))
                elif operation == "reverse":
                    contribution_id = body.get("contributionId")
                    if not isinstance(contribution_id, str):
                        raise GoalValidationError("Choose a contribution to reverse.")
                    contribution = db.execute("SELECT * FROM app_goal_contributions WHERE owner_key = ? AND goal_id = ? AND id = ?",
                                              (owner, goal_id, contribution_id)).fetchone()
                    if contribution is None:
                        raise GoalNotFoundError("This contribution is unavailable.")
                    if contribution["reversed_at"]:
                        raise GoalConflictError("This contribution was already reversed.")
                    db.execute("UPDATE app_goal_contributions SET reversed_at = ? WHERE owner_key = ? AND goal_id = ? AND id = ?", (now, owner, goal_id, contribution_id))
                db.execute("UPDATE app_savings_goals SET version = version + 1, updated_at = ? WHERE owner_key = ? AND id = ?", (now, owner, goal_id))
            result = {"goal": self._payload(db, self._goal(db, owner, goal_id))}
            db.execute("INSERT INTO app_goal_commands(owner_key, request_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
                       (owner, request_id, fingerprint, json.dumps(result, separators=(",", ":")), now))
            return result

    @staticmethod
    def _details(body: dict[str, Any]) -> tuple[str, int, int, str]:
        return (_text(body.get("name"), "Goal name", 80, required=True),
                _cents(body.get("targetCents"), "Target"),
                _cents(body.get("startingCents", 0), "Starting balance", allow_zero=True),
                _date(body.get("targetDate"), "Target date", optional=True))


@lru_cache(maxsize=8)
def _goals_for_access(access: AppAccessStore) -> GoalsStore:
    store = GoalsStore(access)
    store.initialize()
    return store


_factory_lock = threading.Lock()


def build_goals_store() -> GoalsStore:
    with _factory_lock:
        return _goals_for_access(build_app_access_store())
