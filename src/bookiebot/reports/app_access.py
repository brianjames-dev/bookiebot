"""Durable, revocable phone access independent of banking service setup.

Raw bearer tokens exist only at the API boundary. Storage contains SHA-256
digests, and each operation uses its own connection so stores can be shared
between report worker threads.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import importlib
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from typing import Any, Iterator, Protocol


PAIRING_TTL_SECONDS = 900
SESSION_TTL_SECONDS = 180 * 86400
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")


@dataclass(frozen=True)
class AppSession:
    actor_key: str
    owner_key: str
    expires_at: int


class _Connection(Protocol):
    def execute(self, sql: str, params: tuple[Any, ...] = (), /) -> Any:
        ...


def _now() -> int:
    return int(time.time())


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _session(row: Any) -> AppSession:
    return AppSession(str(row["actor_key"]), str(row["owner_key"]), int(row["expires_at"]))


class AppAccessStore:
    """SQLite access store; initialize once before use, or use the factory."""

    _pairing_lock = ""

    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def connect(self, *, write: bool = False) -> Iterator[_Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            # Reserve the writer before reading a pairing. A second connection
            # cannot redeem it, revoke it, or upgrade a stale read concurrently.
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _create_schema(connection: _Connection) -> None:
        for table in ("app_phone_pairings", "app_phone_sessions"):
            connection.execute(
                f"""CREATE TABLE IF NOT EXISTS {table} (
                    token_hash TEXT PRIMARY KEY,
                    actor_key TEXT NOT NULL,
                    owner_key TEXT NOT NULL,
                    expires_at BIGINT NOT NULL
                )"""
            )
            connection.execute(f"CREATE INDEX IF NOT EXISTS {table}_owner_idx ON {table}(owner_key)")

    def initialize(self) -> None:
        with self.connect(write=True) as connection:
            self._create_schema(connection)

    def issue_pairing(self, actor_key: str, owner_key: str) -> str:
        token = secrets.token_urlsafe(32)
        with self.connect(write=True) as connection:
            connection.execute(
                "INSERT INTO app_phone_pairings (token_hash, actor_key, owner_key, expires_at) VALUES (?, ?, ?, ?)",
                (_token_hash(token), actor_key, owner_key, _now() + PAIRING_TTL_SECONDS),
            )
        return token

    def peek_pairing(self, token: str) -> AppSession | None:
        if not _TOKEN_RE.fullmatch(token):
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT actor_key, owner_key, expires_at FROM app_phone_pairings WHERE token_hash = ?",
                (_token_hash(token),),
            ).fetchone()
            return _session(row) if row is not None and int(row["expires_at"]) > _now() else None

    def consume_pairing(self, token: str) -> tuple[str, AppSession] | None:
        if not _TOKEN_RE.fullmatch(token):
            return None
        with self.connect(write=True) as connection:
            row = connection.execute(
                "SELECT actor_key, owner_key, expires_at FROM app_phone_pairings WHERE token_hash = ?"
                + self._pairing_lock,
                (_token_hash(token),),
            ).fetchone()
            # Check the clock after acquiring the lock: waiting for another
            # transaction must not allow a pairing that has since expired.
            now = _now()
            if row is None or int(row["expires_at"]) <= now:
                return None
            session = AppSession(str(row["actor_key"]), str(row["owner_key"]), now + SESSION_TTL_SECONDS)
            session_token = secrets.token_urlsafe(32)
            connection.execute("DELETE FROM app_phone_pairings WHERE token_hash = ?", (_token_hash(token),))
            connection.execute(
                "INSERT INTO app_phone_sessions (token_hash, actor_key, owner_key, expires_at) VALUES (?, ?, ?, ?)",
                (_token_hash(session_token), session.actor_key, session.owner_key, session.expires_at),
            )
            # Deletion and session creation commit together. An insert failure
            # rolls back redemption and keeps the original pairing usable.
        return session_token, session

    def get_session(self, token: str) -> AppSession | None:
        if not _TOKEN_RE.fullmatch(token):
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT actor_key, owner_key, expires_at FROM app_phone_sessions WHERE token_hash = ?",
                (_token_hash(token),),
            ).fetchone()
            return _session(row) if row is not None and int(row["expires_at"]) > _now() else None

    def revoke_session(self, token: str) -> None:
        if not _TOKEN_RE.fullmatch(token):
            return
        with self.connect(write=True) as connection:
            connection.execute("DELETE FROM app_phone_sessions WHERE token_hash = ?", (_token_hash(token),))

    def revoke_owner(self, owner_key: str) -> None:
        with self.connect(write=True) as connection:
            # Pairing locks come first, matching redemption's lock order. Any
            # redemption already in progress finishes before session deletion.
            connection.execute("DELETE FROM app_phone_pairings WHERE owner_key = ?", (owner_key,))
            connection.execute("DELETE FROM app_phone_sessions WHERE owner_key = ?", (owner_key,))


class _PostgresConnection:
    def __init__(self, connection: Any):
        self.connection = connection

    def execute(self, sql: str, params: tuple[Any, ...] = (), /) -> Any:
        return self.connection.execute(sql.replace("?", "%s"), params)


class PostgresAppAccessStore(AppAccessStore):
    _pairing_lock = " FOR UPDATE"

    def __init__(self, database_url: str):
        self.database_url = database_url

    @contextmanager
    def connect(self, *, write: bool = False) -> Iterator[_Connection]:
        try:
            psycopg = importlib.import_module("psycopg")
            dict_row = importlib.import_module("psycopg.rows").dict_row
        except ModuleNotFoundError as exc:
            raise RuntimeError("Install requirements.txt to use Postgres phone access storage.") from exc
        connection = psycopg.connect(self.database_url, row_factory=dict_row)
        try:
            with connection.transaction():
                yield _PostgresConnection(connection)
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect(write=True) as connection:
            # Serialize idempotent schema setup across application processes;
            # concurrent PostgreSQL CREATE TABLE IF NOT EXISTS can still race.
            connection.execute("SELECT pg_advisory_xact_lock(84392503)")
            self._create_schema(connection)


_factory_lock = threading.Lock()


@lru_cache(maxsize=8)
def _build_store(database_url: str, sqlite_path: str) -> AppAccessStore:
    store = PostgresAppAccessStore(database_url) if database_url else AppAccessStore(Path(sqlite_path))
    store.initialize()
    return store


def build_app_access_store() -> AppAccessStore:
    """Lazily initialize a store for the current config; call in a worker thread."""
    database_url = next(
        (value for name in ("BOOKIEBOT_APP_DATABASE_URL", "BANK_DATABASE_URL", "DATABASE_URL")
         if (value := os.getenv(name, "").strip())),
        "",
    )
    sqlite_path = ""
    if not database_url:
        explicit_path = os.getenv("BOOKIEBOT_APP_SQLITE_PATH", "").strip()
        railway = bool(os.getenv("RAILWAY_ENVIRONMENT_ID") or os.getenv("RAILWAY_PROJECT_ID"))
        if railway:
            mount_path = os.getenv("RAILWAY_VOLUME_MOUNT_PATH", "").strip()
            if not mount_path:
                raise RuntimeError("Configure BOOKIEBOT_APP_DATABASE_URL or mount a Railway volume for phone access.")
            volume = Path(mount_path).resolve()
            path = Path(explicit_path).resolve() if explicit_path else volume / "app-access.sqlite3"
            if path == volume or not path.is_relative_to(volume):
                raise RuntimeError(
                    "BOOKIEBOT_APP_SQLITE_PATH must be inside the mounted Railway volume. "
                    "Configure BOOKIEBOT_APP_DATABASE_URL or mount a Railway volume for phone access."
                )
        else:
            path = Path(explicit_path or "data/app-access.sqlite3").resolve()
        sqlite_path = str(path)
    # functools' cache alone permits duplicate concurrent first calls.
    with _factory_lock:
        return _build_store(database_url, sqlite_path)
