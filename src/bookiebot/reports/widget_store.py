"""Revocable, read-only widget grants, separate from phone sign-in tokens.

Only SHA-256 token digests reach durable storage. A short-lived pairing is
exchanged exactly once, atomically, for a narrowly scoped widget credential.
The report endpoint, not this store, enforces the credential's read-only scope.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import re
import secrets
import threading
import time
from typing import Any
import unicodedata
from uuid import uuid4

from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore, build_app_access_store


PAIRING_TTL_SECONDS = 10 * 60
GRANT_TTL_SECONDS = 365 * 86400
MAX_CONNECTIONS = 5
PAIRING_PREFIX = "bbw_pair_"
GRANT_PREFIX = "bbw_read_"
_PAIRING_RE = re.compile(r"bbw_pair_[A-Za-z0-9_-]{43}\Z")
_GRANT_RE = re.compile(r"bbw_read_[A-Za-z0-9_-]{43}\Z")
_ID_RE = re.compile(r"[a-f0-9]{32}\Z")


class WidgetValidationError(ValueError):
    pass


class WidgetLimitError(WidgetValidationError):
    pass


class WidgetNotFoundError(LookupError):
    pass


@dataclass(frozen=True)
class WidgetGrant:
    id: str
    actor_key: str
    owner_key: str
    label: str
    mode: str
    created_at: int
    expires_at: int
    last_used_at: int | None = None


def _now() -> int:
    return int(time.time())


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _iso(value: int) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")


def _grant(row: Any) -> WidgetGrant:
    return WidgetGrant(
        str(row["id"]), str(row["actor_key"]), str(row["owner_key"]), str(row["label"]),
        str(row["mode"]), int(row["created_at"]), int(row["expires_at"]),
        int(row["last_used_at"]) if row["last_used_at"] is not None else None,
    )


def _metadata(row: Any, status: str) -> dict[str, Any]:
    # Do not expose actor identifiers or digests to the Settings client.
    used = row["last_used_at"] if status == "active" else None
    return {"id": row["id"], "label": row["label"], "mode": row["mode"], "status": status,
            "createdAt": _iso(int(row["created_at"])), "expiresAt": _iso(int(row["expires_at"])),
            "lastUsedAt": _iso(int(used)) if used is not None else None}


class WidgetStore:
    def __init__(self, access: AppAccessStore):
        self.access = access

    def initialize(self) -> None:
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute("SELECT pg_advisory_xact_lock(84392508)")
            db.execute("CREATE TABLE IF NOT EXISTS app_widget_owners (owner_key TEXT PRIMARY KEY)")
            for table in ("app_widget_pairings", "app_widget_grants"):
                db.execute(f"""CREATE TABLE IF NOT EXISTS {table} (
                    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
                    actor_key TEXT NOT NULL, owner_key TEXT NOT NULL,
                    label TEXT NOT NULL, mode TEXT NOT NULL,
                    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
                    last_used_at BIGINT
                )""")
                db.execute(f"CREATE INDEX IF NOT EXISTS {table}_owner_idx ON {table}(owner_key, expires_at)")

    @staticmethod
    def _owner(owner: str) -> None:
        if not isinstance(owner, str) or owner not in {"brian", "hannah"}:
            raise WidgetValidationError("Widgets require a mapped personal account.")

    @staticmethod
    def _mode(mode: str) -> None:
        if not isinstance(mode, str) or mode not in {"current", "projected"}:
            raise WidgetValidationError("Choose Current or Projected for this widget.")

    @staticmethod
    def _id(connection_id: str) -> None:
        if not isinstance(connection_id, str) or not _ID_RE.fullmatch(connection_id):
            raise WidgetValidationError("Choose a widget connection.")

    def _lock_owner(self, db: Any, owner: str) -> None:
        # One lock order for issuance, redemption, settings, and revocation.
        # SQLite has already reserved its writer; PostgreSQL locks this row.
        db.execute("INSERT INTO app_widget_owners(owner_key) VALUES (?) ON CONFLICT(owner_key) DO NOTHING", (owner,))
        db.execute("SELECT owner_key FROM app_widget_owners WHERE owner_key = ?" + self.access._pairing_lock, (owner,)).fetchone()

    def issue_pairing(self, actor_key: str, owner_key: str, label: str, mode: str) -> dict[str, Any]:
        self._owner(owner_key)
        self._mode(mode)
        if (not isinstance(actor_key, str) or not actor_key.strip() or len(actor_key) > 128
                or any(unicodedata.category(char).startswith("C") for char in actor_key)):
            raise WidgetValidationError("Widgets require a mapped personal account.")
        if (not isinstance(label, str) or not label.strip() or len(label.strip()) > 80
                or any(unicodedata.category(char).startswith("C") for char in label)):
            raise WidgetValidationError("Enter a widget name of at most 80 characters.")
        label = label.strip()
        with self.access.connect(write=True) as db:
            self._lock_owner(db, owner_key)
            now = _now()
            count = 0
            for table in ("app_widget_pairings", "app_widget_grants"):
                db.execute(f"DELETE FROM {table} WHERE owner_key = ? AND expires_at <= ?", (owner_key, now))
                count += int(db.execute(f"SELECT COUNT(*) AS count FROM {table} WHERE owner_key = ?", (owner_key,)).fetchone()["count"])
            if count >= MAX_CONNECTIONS:
                raise WidgetLimitError("Remove an existing widget connection before adding another (maximum 5).")
            token = PAIRING_PREFIX + secrets.token_urlsafe(32)
            connection_id = uuid4().hex
            expires = now + PAIRING_TTL_SECONDS
            db.execute("""INSERT INTO app_widget_pairings
                (id, token_hash, actor_key, owner_key, label, mode, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (connection_id, _token_hash(token), actor_key, owner_key, label, mode, now, expires))
        return {"id": connection_id, "label": label, "mode": mode, "status": "pending",
                "createdAt": _iso(now), "expiresAt": _iso(expires), "lastUsedAt": None,
                "pairingToken": token}

    def consume_pairing(self, token: str) -> tuple[str, WidgetGrant] | None:
        if not isinstance(token, str) or not _PAIRING_RE.fullmatch(token):
            return None
        digest = _token_hash(token)
        with self.access.connect(write=True) as db:
            owner_row = db.execute("SELECT owner_key FROM app_widget_pairings WHERE token_hash = ?", (digest,)).fetchone()
            if owner_row is None:
                return None
            self._lock_owner(db, str(owner_row["owner_key"]))
            # Re-read after the owner lock: revoke/another redeem may have won.
            row = db.execute("SELECT * FROM app_widget_pairings WHERE token_hash = ?", (digest,)).fetchone()
            now = _now()
            if row is None or int(row["expires_at"]) <= now:
                return None
            grant = WidgetGrant(str(row["id"]), str(row["actor_key"]), str(row["owner_key"]),
                                str(row["label"]), str(row["mode"]), now, now + GRANT_TTL_SECONDS)
            grant_token = GRANT_PREFIX + secrets.token_urlsafe(32)
            db.execute("DELETE FROM app_widget_pairings WHERE token_hash = ?", (digest,))
            db.execute("""INSERT INTO app_widget_grants
                (id, token_hash, actor_key, owner_key, label, mode, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (grant.id, _token_hash(grant_token), grant.actor_key, grant.owner_key, grant.label,
                 grant.mode, grant.created_at, grant.expires_at))
            # Both commit together. A failed insert restores the pairing.
        return grant_token, grant

    def get_grant(self, token: str) -> WidgetGrant | None:
        if not isinstance(token, str) or not _GRANT_RE.fullmatch(token):
            return None
        with self.access.connect() as db:
            row = db.execute("SELECT * FROM app_widget_grants WHERE token_hash = ?", (_token_hash(token),)).fetchone()
            return _grant(row) if row is not None and int(row["expires_at"]) > _now() else None

    def touch_grant(self, token: str) -> bool:
        """Record a successful authorized read; never resurrect a revoked grant."""
        if not isinstance(token, str) or not _GRANT_RE.fullmatch(token):
            return False
        digest = _token_hash(token)
        with self.access.connect(write=True) as db:
            row = db.execute("SELECT owner_key FROM app_widget_grants WHERE token_hash = ?", (digest,)).fetchone()
            if row is None:
                return False
            self._lock_owner(db, str(row["owner_key"]))
            now = _now()
            result = db.execute("UPDATE app_widget_grants SET last_used_at = ? WHERE token_hash = ? AND expires_at > ?", (now, digest, now))
            return result.rowcount == 1

    def list_connections(self, owner_key: str) -> dict[str, Any]:
        self._owner(owner_key)
        with self.access.connect() as db:
            now = _now()
            # A single statement sees one snapshot even under PostgreSQL's
            # READ COMMITTED isolation. Separate selects could show a pairing
            # twice (or miss it) if it is redeemed between the two queries.
            rows = db.execute("""SELECT *, 'pending' AS status FROM app_widget_pairings
                WHERE owner_key = ? AND expires_at > ?
                UNION ALL SELECT *, 'active' AS status FROM app_widget_grants
                WHERE owner_key = ? AND expires_at > ?""", (owner_key, now, owner_key, now)).fetchall()
            connections = [_metadata(row, str(row["status"])) for row in rows]
            connections.sort(key=lambda row: (row["createdAt"], row["id"]), reverse=True)
            return {"connections": connections}

    def revoke(self, owner_key: str, connection_id: str) -> None:
        self._owner(owner_key)
        self._id(connection_id)
        with self.access.connect(write=True) as db:
            self._lock_owner(db, owner_key)
            for table in ("app_widget_pairings", "app_widget_grants"):
                db.execute(f"DELETE FROM {table} WHERE owner_key = ? AND id = ?", (owner_key, connection_id))

    def revoke_owner(self, owner_key: str) -> None:
        self._owner(owner_key)
        with self.access.connect(write=True) as db:
            self._lock_owner(db, owner_key)
            for table in ("app_widget_pairings", "app_widget_grants"):
                db.execute(f"DELETE FROM {table} WHERE owner_key = ?", (owner_key,))

    def set_mode(self, owner_key: str, connection_id: str, mode: str) -> dict[str, Any]:
        self._owner(owner_key)
        self._id(connection_id)
        self._mode(mode)
        with self.access.connect(write=True) as db:
            self._lock_owner(db, owner_key)
            now = _now()
            for table, status in (("app_widget_pairings", "pending"), ("app_widget_grants", "active")):
                result = db.execute(f"UPDATE {table} SET mode = ? WHERE owner_key = ? AND id = ? AND expires_at > ?",
                                    (mode, owner_key, connection_id, now))
                if result.rowcount == 1:
                    row = db.execute(f"SELECT * FROM {table} WHERE owner_key = ? AND id = ?", (owner_key, connection_id)).fetchone()
                    return _metadata(row, status)
            raise WidgetNotFoundError("This widget connection is unavailable. Refresh and try again.")


@lru_cache(maxsize=8)
def _widgets_for_access(access: AppAccessStore) -> WidgetStore:
    store = WidgetStore(access)
    store.initialize()
    return store


_factory_lock = threading.Lock()


def build_widget_store() -> WidgetStore:
    with _factory_lock:
        return _widgets_for_access(build_app_access_store())
