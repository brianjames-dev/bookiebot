from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterator, Literal, Protocol
from uuid import uuid4

from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import (
    BankAccount,
    BankImportOperation,
    BankStatus,
    BankTransaction,
    LinkedBankItem,
    PlaidWebhookEvent,
    ReconciliationCacheBuckets,
    ReconciliationClassification,
    ReconciliationItem,
    ReconciliationStatus,
)


WEBHOOK_LEASE_SECONDS = 300


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sheet_reference_conflicts(left: str, right: str, left_month: str, right_month: str) -> bool:
    """Compare one row/occurrence, including older refs without period metadata."""
    def scoped(reference: str) -> tuple[str, str, str]:
        for marker in ('#month=', '#pull='):
            base, found, period = reference.partition(marker)
            if found:
                return base, marker, period
        return reference, '', ''

    left_base, left_kind, left_period = scoped(left)
    right_base, right_kind, right_period = scoped(right)
    if left_base != right_base:
        return False
    if left_kind and right_kind:
        return (left_period == right_period if left_kind == right_kind
                else left_period[:7] == right_period[:7])
    if left_kind:
        return not right_month or left_period[:7] == right_month
    if right_kind:
        return not left_month or right_period[:7] == left_month
    if '!row ' in left_base:
        # Old expense/income aliases repeat row numbers in every monthly tab.
        return not left_month or not right_month or left_month == right_month
    return True


class BankStoreConnection(Protocol):
    def execute(self, sql: str, params: tuple[Any, ...] = (), /) -> Any:
        ...

    def executemany(self, sql: str, params_seq: Any, /) -> Any:
        ...

    def executescript(self, sql_script: str, /) -> Any:
        ...


class BankStore:
    def __init__(self, path: Path, cipher: TokenCipher):
        self.path = path
        self.cipher = cipher

    @contextmanager
    def connect(self) -> Iterator[BankStoreConnection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            yield conn
            conn.commit()
        finally:
            conn.close()

    def initialize(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS bank_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_key TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    item_id TEXT NOT NULL UNIQUE,
                    encrypted_access_token TEXT NOT NULL,
                    institution_name TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    disconnected_at TEXT
                );

                CREATE TABLE IF NOT EXISTS bank_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_id INTEGER NOT NULL REFERENCES bank_items(id) ON DELETE CASCADE,
                    provider_account_id TEXT NOT NULL UNIQUE,
                    owner_key TEXT NOT NULL,
                    name TEXT NOT NULL,
                    mask TEXT,
                    type TEXT,
                    subtype TEXT,
                    official_name TEXT,
                    current_balance REAL,
                    available_balance REAL,
                    watched INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS bank_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider_transaction_id TEXT NOT NULL UNIQUE,
                    account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
                    owner_key TEXT NOT NULL,
                    date TEXT,
                    authorized_date TEXT,
                    name TEXT NOT NULL,
                    merchant_name TEXT,
                    amount REAL NOT NULL,
                    pending INTEGER NOT NULL,
                    category TEXT,
                    payment_channel TEXT,
                    pending_transaction_id TEXT,
                    raw_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    removed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS bank_sync_state (
                    item_id INTEGER PRIMARY KEY REFERENCES bank_items(id) ON DELETE CASCADE,
                    transactions_cursor TEXT,
                    last_sync_at TEXT,
                    last_success_at TEXT,
                    last_error TEXT,
                    webhook_pending INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS bank_webhook_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    item_id TEXT,
                    webhook_type TEXT,
                    webhook_code TEXT,
                    payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    received_at TEXT NOT NULL,
                    processed_at TEXT,
                    error TEXT
                );

                CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_key TEXT NOT NULL,
                    bank_transaction_id INTEGER NOT NULL UNIQUE REFERENCES bank_transactions(id) ON DELETE CASCADE,
                    classification TEXT NOT NULL,
                    status TEXT NOT NULL,
                    matched_action_log_id TEXT,
                    matched_sheet_ref TEXT,
                    confidence REAL NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    resolved_at TEXT,
                    ignored_at TEXT,
                    notes TEXT
                );

                """
            )
            self._ensure_account_watch_column(conn)
            self._ensure_transaction_pending_link_column(conn)
            self._ensure_import_operations_table(conn)
            self._ensure_reconciliation_events_table(conn)
            self._ensure_webhook_claim_columns(conn)

    def _ensure_webhook_claim_columns(self, conn: BankStoreConnection) -> None:
        for column in ('claim_token TEXT', 'lease_expires_at TEXT', 'attempt_count INTEGER NOT NULL DEFAULT 0', 'next_attempt_at TEXT'):
            try:
                conn.execute(f'ALTER TABLE bank_webhook_events ADD COLUMN {column}')
            except sqlite3.OperationalError as exc:
                if 'duplicate column name' not in str(exc).lower():
                    raise

    def _ensure_reconciliation_events_table(self, conn: BankStoreConnection) -> None:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS bank_reconciliation_events (
                event_id TEXT PRIMARY KEY,
                reconciliation_id INTEGER NOT NULL
                    REFERENCES bank_reconciliation_items(id) ON DELETE CASCADE,
                owner_key TEXT NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )"""
        )

    def reconciliation_events(self, owner_key: str, reconciliation_id: int, limit: int = 25) -> list[dict[str, Any]]:
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT * FROM bank_reconciliation_events
                   WHERE owner_key = ? AND reconciliation_id = ?
                   ORDER BY occurred_at DESC, event_id DESC LIMIT ?""",
                (owner_key, int(reconciliation_id), max(1, min(int(limit), 100))),
            ).fetchall()
        return [{**dict(row), 'payload': json.loads(row['payload_json'])} for row in rows]

    def _ensure_import_operations_table(self, conn: BankStoreConnection) -> None:
        # Identical schema and transitions on SQLite and Postgres.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bank_import_operations (
                operation_id TEXT PRIMARY KEY,
                reconciliation_id INTEGER NOT NULL UNIQUE
                    REFERENCES bank_reconciliation_items(id) ON DELETE CASCADE,
                owner_key TEXT NOT NULL,
                actor_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                request_json TEXT NOT NULL,
                matched_action_log_id TEXT,
                matched_sheet_ref TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                error TEXT
            )
            """
        )

    def get_import_operation(self, owner_key: str, reconciliation_id: int) -> BankImportOperation | None:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM bank_import_operations WHERE owner_key = ? AND reconciliation_id = ?",
                (owner_key, int(reconciliation_id)),
            ).fetchone()
        return BankImportOperation(**dict(row)) if row else None

    def claim_reconciliation_import(
        self, owner_key: str, reconciliation_id: int, *, operation_id: str,
        actor_key: str, kind: str, request: dict[str, Any],
    ) -> tuple[BankImportOperation | None, bool]:
        """Atomically claim an eligible, unchanged transaction before touching Sheets."""
        self.initialize()
        now = utc_now_iso()
        with self.connect() as conn:
            claimed = conn.execute(
                """
                UPDATE bank_reconciliation_items
                SET status = 'import_requested', last_seen_at = ?
                WHERE id = ? AND owner_key = ?
                  AND status IN ('needs_review', 'pending_user', 'conflict')
                  AND NOT EXISTS (
                    SELECT 1 FROM bank_import_operations o
                    WHERE o.reconciliation_id = bank_reconciliation_items.id
                  )
                  AND EXISTS (
                    SELECT 1 FROM bank_transactions t
                    LEFT JOIN bank_accounts a ON a.id = t.account_id
                    WHERE t.id = bank_reconciliation_items.bank_transaction_id
                      AND t.owner_key = ? AND t.removed_at IS NULL AND t.pending = 0
                      AND COALESCE(a.watched, 1) = 1
                      AND t.amount = ? AND COALESCE(t.date, t.authorized_date, '') = ?
                  )
                """,
                (now, int(reconciliation_id), owner_key, owner_key, request['bank_amount'], request['bank_date']),
            ).rowcount == 1
            if claimed:
                conn.execute(
                    """
                    INSERT INTO bank_import_operations (
                        operation_id, reconciliation_id, owner_key, actor_key, kind,
                        status, request_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
                    """,
                    (operation_id, int(reconciliation_id), owner_key, actor_key, kind,
                     json.dumps(request, sort_keys=True), now, now),
                )
            row = conn.execute(
                "SELECT * FROM bank_import_operations WHERE owner_key = ? AND reconciliation_id = ?",
                (owner_key, int(reconciliation_id)),
            ).fetchone()
        return (BankImportOperation(**dict(row)) if row else None), claimed

    def mark_import_writing(self, owner_key: str, operation_id: str) -> bool:
        with self.connect() as conn:
            return conn.execute(
                """UPDATE bank_import_operations SET status = 'writing', updated_at = ?
                   WHERE operation_id = ? AND owner_key = ? AND status = 'claimed'""",
                (utc_now_iso(), operation_id, owner_key),
            ).rowcount == 1

    def mark_import_needs_recovery(self, owner_key: str, operation_id: str, error: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """UPDATE bank_import_operations
                   SET status = 'needs_recovery', updated_at = ?, error = ?
                   WHERE operation_id = ? AND owner_key = ? AND status != 'completed'""",
                (utc_now_iso(), error[:1000], operation_id, owner_key),
            )

    def complete_reconciliation_import(
        self, operation: BankImportOperation, *, action_id: str, sheet_ref: str,
    ) -> BankImportOperation:
        """Persist the written action and confirmation together; never overwrite another resolution."""
        request = json.loads(operation.request_json)
        now = utc_now_iso()
        with self.connect() as conn:
            # This update also serializes two recovery/completion attempts on Postgres.
            updated = conn.execute(
                """UPDATE bank_import_operations
                   SET matched_action_log_id = ?, matched_sheet_ref = ?, updated_at = ?
                   WHERE operation_id = ? AND owner_key = ? AND status != 'completed'
                     AND (matched_action_log_id IS NULL OR matched_action_log_id = ?)""",
                (action_id, sheet_ref, now, operation.operation_id, operation.owner_key, action_id),
            ).rowcount
            if updated:
                confirmed = conn.execute(
                    """
                    UPDATE bank_reconciliation_items
                    SET status = 'confirmed', resolved_at = ?, last_seen_at = ?,
                        matched_action_log_id = ?, matched_sheet_ref = ?,
                        notes = 'logged from bank reconciliation import'
                    WHERE id = ? AND owner_key = ? AND status = 'import_requested'
                      AND EXISTS (
                        SELECT 1 FROM bank_transactions t
                        WHERE t.id = bank_reconciliation_items.bank_transaction_id
                          AND t.removed_at IS NULL AND t.pending = 0
                          AND t.amount = ? AND COALESCE(t.date, t.authorized_date, '') = ?
                      )
                    """,
                    (now, now, action_id, sheet_ref, operation.reconciliation_id, operation.owner_key,
                     request['bank_amount'], request['bank_date']),
                ).rowcount == 1
                conn.execute(
                    """UPDATE bank_import_operations SET status = ?, error = ?
                       WHERE operation_id = ? AND owner_key = ?""",
                    ('completed' if confirmed else 'needs_recovery',
                     None if confirmed else 'Bank item changed after the sheet write; review the recorded action.',
                     operation.operation_id, operation.owner_key),
                )
            row = conn.execute(
                "SELECT * FROM bank_import_operations WHERE operation_id = ? AND owner_key = ?",
                (operation.operation_id, operation.owner_key),
            ).fetchone()
        if row is None:
            raise RuntimeError('Import operation disappeared during completion')
        return BankImportOperation(**dict(row))

    def _ensure_account_watch_column(self, conn: BankStoreConnection) -> None:
        try:
            conn.execute("ALTER TABLE bank_accounts ADD COLUMN watched INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise

    def _ensure_transaction_pending_link_column(self, conn: BankStoreConnection) -> None:
        try:
            conn.execute("ALTER TABLE bank_transactions ADD COLUMN pending_transaction_id TEXT")
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise

    def upsert_item(
        self,
        *,
        owner_key: str,
        provider: str,
        item_id: str,
        access_token: str,
        institution_name: str | None,
    ) -> LinkedBankItem:
        now = utc_now_iso()
        encrypted_access_token = self.cipher.encrypt(access_token)
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO bank_items (
                    owner_key, provider, item_id, encrypted_access_token,
                    institution_name, status, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
                ON CONFLICT(item_id) DO UPDATE SET
                    owner_key = excluded.owner_key,
                    encrypted_access_token = excluded.encrypted_access_token,
                    institution_name = excluded.institution_name,
                    status = 'active',
                    updated_at = excluded.updated_at,
                    disconnected_at = NULL
                """,
                (owner_key, provider, item_id, encrypted_access_token, institution_name, now, now),
            )
            row = conn.execute("SELECT * FROM bank_items WHERE item_id = ?", (item_id,)).fetchone()
            conn.execute(
                "INSERT INTO bank_sync_state (item_id) VALUES (?) ON CONFLICT(item_id) DO NOTHING",
                (int(row["id"]),),
            )
            return _linked_item_from_row(row)

    def list_active_items(self, owner_key: str | None = None) -> list[LinkedBankItem]:
        query = "SELECT * FROM bank_items WHERE status = 'active'"
        params: tuple[Any, ...] = ()
        if owner_key:
            query += " AND owner_key = ?"
            params = (owner_key,)
        query += " ORDER BY created_at"
        with self.connect() as conn:
            return [_linked_item_from_row(row) for row in conn.execute(query, params).fetchall()]

    def list_items(self, owner_key: str | None = None) -> list[LinkedBankItem]:
        query = "SELECT * FROM bank_items"
        params: tuple[Any, ...] = ()
        if owner_key:
            query += " WHERE owner_key = ?"
            params = (owner_key,)
        query += " ORDER BY created_at"
        self.initialize()
        with self.connect() as conn:
            return [_linked_item_from_row(row) for row in conn.execute(query, params).fetchall()]

    def get_item(self, owner_key: str, item_db_id: int) -> LinkedBankItem | None:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM bank_items WHERE id = ? AND owner_key = ?",
                (int(item_db_id), owner_key),
            ).fetchone()
        return _linked_item_from_row(row) if row else None

    def get_item_by_provider_item_id(self, item_id: str) -> LinkedBankItem | None:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM bank_items WHERE item_id = ? AND status = 'active'",
                (item_id,),
            ).fetchone()
        return _linked_item_from_row(row) if row else None

    def disconnect_item(self, owner_key: str, item_db_id: int) -> LinkedBankItem | None:
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM bank_items WHERE id = ? AND owner_key = ?",
                (int(item_db_id), owner_key),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE bank_items
                SET status = 'disconnected',
                    disconnected_at = ?,
                    updated_at = ?
                WHERE id = ?
                  AND owner_key = ?
                """,
                (now, now, int(item_db_id), owner_key),
            )
            updated = conn.execute("SELECT * FROM bank_items WHERE id = ?", (int(item_db_id),)).fetchone()
        return _linked_item_from_row(updated) if updated else None

    def purge_disconnected_item(self, owner_key: str, item_db_id: int) -> dict[str, int] | None:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM bank_items WHERE id = ? AND owner_key = ?",
                (int(item_db_id), owner_key),
            ).fetchone()
            if row is None:
                return None
            if str(row["status"]) != "disconnected":
                return {
                    "item_id": int(item_db_id),
                    "status": 0,
                    "accounts": 0,
                    "transactions": 0,
                    "reconciliation_items": 0,
                }

            transaction_rows = conn.execute(
                """
                SELECT t.id
                FROM bank_transactions t
                JOIN bank_accounts a ON a.id = t.account_id
                WHERE a.item_id = ?
                  AND t.owner_key = ?
                """,
                (int(item_db_id), owner_key),
            ).fetchall()
            transaction_ids = [int(transaction["id"]) for transaction in transaction_rows]
            reconciliation_count = 0
            transaction_count = len(transaction_ids)
            if transaction_ids:
                placeholders = ",".join("?" for _ in transaction_ids)
                reconciliation_count = int(
                    conn.execute(
                        f"""
                        SELECT COUNT(*) AS count
                        FROM bank_reconciliation_items
                        WHERE bank_transaction_id IN ({placeholders})
                        """,
                        tuple(transaction_ids),
                    ).fetchone()["count"]
                )
                conn.execute(
                    f"DELETE FROM bank_reconciliation_items WHERE bank_transaction_id IN ({placeholders})",
                    tuple(transaction_ids),
                )
                conn.execute(
                    f"DELETE FROM bank_transactions WHERE id IN ({placeholders})",
                    tuple(transaction_ids),
                )

            account_count = int(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM bank_accounts WHERE item_id = ? AND owner_key = ?",
                    (int(item_db_id), owner_key),
                ).fetchone()["count"]
            )
            conn.execute(
                "DELETE FROM bank_accounts WHERE item_id = ? AND owner_key = ?",
                (int(item_db_id), owner_key),
            )
            conn.execute("DELETE FROM bank_sync_state WHERE item_id = ?", (int(item_db_id),))
            conn.execute(
                "DELETE FROM bank_items WHERE id = ? AND owner_key = ?",
                (int(item_db_id), owner_key),
            )
        return {
            "item_id": int(item_db_id),
            "status": 1,
            "accounts": account_count,
            "transactions": transaction_count,
            "reconciliation_items": reconciliation_count,
        }

    def purge_transactions_before(self, owner_key: str, cutoff_date: str) -> dict[str, int | str]:
        self.initialize()
        with self.connect() as conn:
            transaction_rows = conn.execute(
                """
                SELECT id
                FROM bank_transactions
                WHERE owner_key = ?
                  AND COALESCE(date, authorized_date, '') != ''
                  AND COALESCE(date, authorized_date, '') < ?
                """,
                (owner_key, cutoff_date),
            ).fetchall()
            transaction_ids = [int(transaction["id"]) for transaction in transaction_rows]
            reconciliation_count = 0
            transaction_count = len(transaction_ids)
            if transaction_ids:
                placeholders = ",".join("?" for _ in transaction_ids)
                reconciliation_count = int(
                    conn.execute(
                        f"""
                        SELECT COUNT(*) AS count
                        FROM bank_reconciliation_items
                        WHERE bank_transaction_id IN ({placeholders})
                        """,
                        tuple(transaction_ids),
                    ).fetchone()["count"]
                )
                conn.execute(
                    f"DELETE FROM bank_reconciliation_items WHERE bank_transaction_id IN ({placeholders})",
                    tuple(transaction_ids),
                )
                conn.execute(
                    f"DELETE FROM bank_transactions WHERE id IN ({placeholders})",
                    tuple(transaction_ids),
                )

        return {
            "cutoff_date": cutoff_date,
            "transactions": transaction_count,
            "reconciliation_items": reconciliation_count,
        }

    def get_access_token(self, item_db_id: int) -> str:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT encrypted_access_token FROM bank_items WHERE id = ?",
                (item_db_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"Unknown bank item id {item_db_id}")
        return self.cipher.decrypt(str(row["encrypted_access_token"]))

    def get_cursor(self, item_db_id: int) -> str | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT transactions_cursor FROM bank_sync_state WHERE item_id = ?",
                (item_db_id,),
            ).fetchone()
        if row is None:
            return None
        return row["transactions_cursor"]

    def mark_sync_success(self, item_db_id: int, cursor: str | None) -> None:
        now = utc_now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO bank_sync_state (item_id, transactions_cursor, last_sync_at, last_success_at, last_error)
                VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT(item_id) DO UPDATE SET
                    transactions_cursor = excluded.transactions_cursor,
                    last_sync_at = excluded.last_sync_at,
                    last_success_at = excluded.last_success_at,
                    last_error = NULL
                """,
                (item_db_id, cursor, now, now),
            )

    def mark_sync_error(self, item_db_id: int, error: str) -> None:
        now = utc_now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO bank_sync_state (item_id, last_sync_at, last_error)
                VALUES (?, ?, ?)
                ON CONFLICT(item_id) DO UPDATE SET
                    last_sync_at = excluded.last_sync_at,
                    last_error = excluded.last_error
                """,
                (item_db_id, now, error[:1000]),
            )

    def reset_sync_cursors(self, owner_key: str) -> int:
        """Clear Plaid transaction cursors for an owner so the next sync backfills cached rows."""
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT s.item_id
                FROM bank_sync_state s
                JOIN bank_items i ON i.id = s.item_id
                WHERE i.owner_key = ?
                  AND i.status = 'active'
                  AND s.transactions_cursor IS NOT NULL
                """,
                (owner_key,),
            ).fetchall()
            conn.execute(
                """
                UPDATE bank_sync_state
                SET transactions_cursor = NULL,
                    last_sync_at = ?,
                    last_error = NULL
                WHERE item_id IN (
                    SELECT id FROM bank_items WHERE owner_key = ? AND status = 'active'
                )
                """,
                (now, owner_key),
            )
        return len(rows)

    def upsert_accounts(self, accounts: list[BankAccount]) -> int:
        now = utc_now_iso()
        with self.connect() as conn:
            for account in accounts:
                conn.execute(
                    """
                    INSERT INTO bank_accounts (
                        item_id, provider_account_id, owner_key, name, mask, type, subtype,
                        official_name, current_balance, available_balance, watched, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(provider_account_id) DO UPDATE SET
                        owner_key = excluded.owner_key,
                        name = excluded.name,
                        mask = excluded.mask,
                        type = excluded.type,
                        subtype = excluded.subtype,
                        official_name = excluded.official_name,
                        current_balance = excluded.current_balance,
                        available_balance = excluded.available_balance,
                        updated_at = excluded.updated_at
                    """,
                    (
                        account.item_id,
                        account.provider_account_id,
                        account.owner_key,
                        account.name,
                        account.mask,
                        account.type,
                        account.subtype,
                        account.official_name,
                        account.current_balance,
                        account.available_balance,
                        1 if account.watched else 0,
                        now,
                    ),
                )
        return len(accounts)

    def list_accounts(self, owner_key: str) -> list[BankAccount]:
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM bank_accounts
                WHERE owner_key = ?
                ORDER BY item_id, name, mask
                """,
                (owner_key,),
            ).fetchall()
        return [_bank_account_from_row(row) for row in rows]

    def set_account_watched(self, owner_key: str, account_db_id: int, watched: bool) -> BankAccount | None:
        self.initialize()
        with self.connect() as conn:
            self._lock_reconciliation_owner(conn, owner_key)
            row = conn.execute(
                "SELECT * FROM bank_accounts WHERE id = ? AND owner_key = ?",
                (int(account_db_id), owner_key),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE bank_accounts
                SET watched = ?,
                    updated_at = ?
                WHERE id = ?
                  AND owner_key = ?
                """,
                (1 if watched else 0, utc_now_iso(), int(account_db_id), owner_key),
            )
            updated = conn.execute("SELECT * FROM bank_accounts WHERE id = ?", (int(account_db_id),)).fetchone()
        return _bank_account_from_row(updated) if updated else None

    def upsert_transactions(self, transactions: list[dict[str, Any]], owner_key: str) -> int:
        now = utc_now_iso()
        with self.connect() as conn:
            for txn in transactions:
                # Lock an existing transaction before inspecting its old value;
                # the same UPDATE serializes writers on both database backends.
                conn.execute(
                    'UPDATE bank_transactions SET id = id WHERE provider_transaction_id = ?',
                    (txn['transaction_id'],),
                )
                previous = conn.execute(
                    'SELECT * FROM bank_transactions WHERE provider_transaction_id = ?',
                    (txn['transaction_id'],),
                ).fetchone()
                if previous is not None and previous['owner_key'] != owner_key:
                    raise ValueError('Bank transaction does not belong to this person.')
                account_row = conn.execute(
                    "SELECT id, owner_key FROM bank_accounts WHERE provider_account_id = ?",
                    (txn.get("account_id"),),
                ).fetchone()
                if account_row is not None and account_row['owner_key'] != owner_key:
                    raise ValueError('Bank account does not belong to this person.')
                account_id = int(account_row["id"]) if account_row else None
                category = txn.get("personal_finance_category") or txn.get("category")
                conn.execute(
                    """
                    INSERT INTO bank_transactions (
                        provider_transaction_id, account_id, owner_key, date, authorized_date,
                        name, merchant_name, amount, pending, category, payment_channel, pending_transaction_id,
                        raw_json, created_at, updated_at, removed_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT(provider_transaction_id) DO UPDATE SET
                        account_id = excluded.account_id,
                        owner_key = excluded.owner_key,
                        date = excluded.date,
                        authorized_date = excluded.authorized_date,
                        name = excluded.name,
                        merchant_name = excluded.merchant_name,
                        amount = excluded.amount,
                        pending = excluded.pending,
                        category = excluded.category,
                        payment_channel = excluded.payment_channel,
                        pending_transaction_id = excluded.pending_transaction_id,
                        raw_json = excluded.raw_json,
                        updated_at = excluded.updated_at,
                        removed_at = NULL
                    """,
                    (
                        txn["transaction_id"],
                        account_id,
                        owner_key,
                        txn.get("date"),
                        txn.get("authorized_date"),
                        txn.get("name") or txn.get("merchant_name") or "Unknown transaction",
                        txn.get("merchant_name"),
                        float(txn.get("amount") or 0),
                        1 if txn.get("pending") else 0,
                        json.dumps(category, sort_keys=True) if category is not None else None,
                        txn.get("payment_channel"),
                        txn.get("pending_transaction_id"),
                        json.dumps(txn, sort_keys=True),
                        now,
                        now,
                    ),
                )
                if previous is not None:
                    current_values = {
                        'amount': float(txn.get('amount') or 0), 'date': txn.get('date'),
                        'authorized_date': txn.get('authorized_date'), 'account_id': account_id,
                        'pending': 1 if txn.get('pending') else 0,
                    }
                    previous_values = {key: previous[key] for key in current_values}
                    changed = [key for key in current_values if current_values[key] != previous_values[key]]
                    if changed:
                        # Serialize against confirmations too, so the event and
                        # reopening describe the exact match being invalidated.
                        conn.execute(
                            'UPDATE bank_reconciliation_items SET id = id WHERE bank_transaction_id = ?',
                            (previous['id'],),
                        )
                        matched = conn.execute(
                            """SELECT * FROM bank_reconciliation_items
                               WHERE bank_transaction_id = ? AND status IN ('matched', 'confirmed')""",
                            (previous['id'],),
                        ).fetchone()
                        if matched is not None:
                            payload = {
                                'changed_fields': changed, 'before': previous_values, 'after': current_values,
                                'previous_match': {
                                    key: matched[key] for key in (
                                        'status', 'classification', 'confidence', 'matched_action_log_id',
                                        'matched_sheet_ref', 'resolved_at', 'notes',
                                    )
                                },
                            }
                            conn.execute(
                                """INSERT INTO bank_reconciliation_events (
                                    event_id, reconciliation_id, owner_key, event_type, occurred_at, payload_json
                                ) VALUES (?, ?, ?, 'bank_transaction_modified', ?, ?)""",
                                (uuid4().hex, matched['id'], matched['owner_key'], now, json.dumps(payload, sort_keys=True)),
                            )
                            conn.execute(
                                """UPDATE bank_reconciliation_items
                                   SET status = 'needs_review', matched_action_log_id = NULL, matched_sheet_ref = NULL,
                                       resolved_at = NULL, ignored_at = NULL, confidence = 0, last_seen_at = ?,
                                       notes = 'Bank transaction changed; previous match retained in reconciliation events.'
                                   WHERE id = ?""",
                                (now, matched['id']),
                            )
        return len(transactions)

    def mark_transactions_removed(self, removed: list[dict[str, Any] | str]) -> int:
        now = utc_now_iso()
        ids = [
            item if isinstance(item, str) else str(item.get("transaction_id") or "")
            for item in removed
        ]
        ids = [provider_id for provider_id in ids if provider_id]
        if not ids:
            return 0
        with self.connect() as conn:
            conn.executemany(
                "UPDATE bank_transactions SET removed_at = ?, updated_at = ? WHERE provider_transaction_id = ?",
                [(now, now, provider_id) for provider_id in ids],
            )
        return len(ids)

    def enqueue_plaid_webhook(self, payload: dict[str, Any]) -> PlaidWebhookEvent:
        now = utc_now_iso()
        item_id = str(payload.get("item_id") or "").strip() or None
        webhook_type = str(payload.get("webhook_type") or "").strip() or None
        webhook_code = str(payload.get("webhook_code") or "").strip() or None
        self.initialize()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO bank_webhook_events (
                    provider, item_id, webhook_type, webhook_code, payload, status, received_at
                )
                VALUES ('plaid', ?, ?, ?, ?, 'pending', ?)
                """,
                (item_id, webhook_type, webhook_code, json.dumps(payload, sort_keys=True), now),
            )
            if item_id:
                conn.execute(
                    """
                    UPDATE bank_sync_state
                    SET webhook_pending = 1,
                        last_sync_at = ?
                    WHERE item_id IN (
                        SELECT id FROM bank_items WHERE item_id = ?
                    )
                    """,
                    (now, item_id),
                )
            row = conn.execute(
                """
                SELECT *
                FROM bank_webhook_events
                WHERE provider = 'plaid'
                  AND received_at = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (now,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Failed to load stored Plaid webhook event")
        return _plaid_webhook_event_from_row(row)

    def pending_plaid_webhook_events(self, limit: int = 25) -> list[tuple[PlaidWebhookEvent, dict[str, Any]]]:
        safe_limit = max(1, min(int(limit), 100))
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM bank_webhook_events
                WHERE provider = 'plaid'
                  AND (
                    status = 'pending'
                    OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
                    OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                  )
                ORDER BY received_at, id
                LIMIT ?
                """,
                (utc_now_iso(), utc_now_iso(), safe_limit),
            ).fetchall()
        events: list[tuple[PlaidWebhookEvent, dict[str, Any]]] = []
        for row in rows:
            payload = json.loads(str(row["payload"]))
            events.append((_plaid_webhook_event_from_row(row), payload if isinstance(payload, dict) else {}))
        return events

    def claim_plaid_webhook_event(self, event_id: int) -> str | None:
        self.initialize()
        now = utc_now_iso()
        expires = (datetime.fromisoformat(now) + timedelta(seconds=WEBHOOK_LEASE_SECONDS)).isoformat()
        claim_token = uuid4().hex
        with self.connect() as conn:
            # Serialize claims for different events on the same linked item.
            conn.execute(
                """UPDATE bank_sync_state SET item_id = item_id WHERE item_id IN (
                    SELECT i.id FROM bank_items i JOIN bank_webhook_events e ON e.item_id = i.item_id
                    WHERE e.id = ?
                )""",
                (int(event_id),),
            )
            claimed = conn.execute(
                """
                UPDATE bank_webhook_events
                SET status = 'processing', error = NULL, claim_token = ?,
                    lease_expires_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL
                WHERE id = ?
                  AND (
                    status = 'pending'
                    OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
                    OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM bank_webhook_events other
                    WHERE other.item_id = bank_webhook_events.item_id AND other.id != bank_webhook_events.id
                      AND other.status = 'processing' AND other.lease_expires_at > ?
                  )
                """,
                (claim_token, expires, int(event_id), now, now, now),
            ).rowcount == 1
        return claim_token if claimed else None

    def mark_plaid_webhook_processing(self, event_id: int) -> str | None:
        return self.claim_plaid_webhook_event(event_id)

    def mark_plaid_webhook_processed(
        self, event_id: int, item_id: str | None = None, *, claim_token: str | None = None,
    ) -> bool:
        now = utc_now_iso()
        self.initialize()
        claim_filter = "status = 'processing' AND claim_token = ?" if claim_token else "claim_token IS NULL"
        params = (now, int(event_id), claim_token) if claim_token else (now, int(event_id))
        with self.connect() as conn:
            updated = conn.execute(
                f"""
                UPDATE bank_webhook_events
                SET status = 'processed',
                    processed_at = ?,
                    error = NULL, lease_expires_at = NULL, next_attempt_at = NULL
                WHERE id = ? AND {claim_filter}
                """,
                params,
            ).rowcount == 1
            if not updated:
                return False
            if item_id:
                remaining = conn.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM bank_webhook_events
                    WHERE provider = 'plaid'
                      AND item_id = ?
                      AND status IN ('pending', 'failed', 'processing')
                    """,
                    (item_id,),
                ).fetchone()
                if remaining is not None and int(remaining["count"]) == 0:
                    conn.execute(
                        """
                        UPDATE bank_sync_state
                        SET webhook_pending = 0
                        WHERE item_id IN (
                            SELECT id FROM bank_items WHERE item_id = ?
                        )
                        """,
                        (item_id,),
                    )
        return True

    def mark_plaid_webhook_failed(self, event_id: int, error: str, *, claim_token: str | None = None) -> bool:
        self.initialize()
        claim_filter = "status = 'processing' AND claim_token = ?" if claim_token else "claim_token IS NULL"
        claim_params = (int(event_id), claim_token) if claim_token else (int(event_id),)
        with self.connect() as conn:
            row = conn.execute(
                f'SELECT attempt_count FROM bank_webhook_events WHERE id = ? AND {claim_filter}',
                claim_params,
            ).fetchone()
            if row is None:
                return False
            delay = min(3600, 60 * 2 ** min(max(int(row['attempt_count']) - 1, 0), 6))
            next_attempt = (datetime.fromisoformat(utc_now_iso()) + timedelta(seconds=delay)).isoformat()
            return conn.execute(
                f"""
                UPDATE bank_webhook_events
                SET status = 'failed', error = ?, next_attempt_at = ?, lease_expires_at = NULL
                WHERE id = ? AND {claim_filter}
                """,
                (error[:1000], next_attempt, *claim_params),
            ).rowcount == 1

    def recent_transactions(
        self,
        owner_key: str,
        limit: int = 10,
        *,
        start_date: str | None = None,
    ) -> list[BankTransaction]:
        safe_limit = max(1, min(int(limit), 200))
        date_filter = ""
        params: tuple[Any, ...]
        if start_date:
            date_filter = " AND COALESCE(t.date, t.authorized_date, '') >= ?"
            params = (owner_key, start_date, safe_limit)
        else:
            params = (owner_key, safe_limit)
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    t.id,
                    t.provider_transaction_id,
                    t.owner_key,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_transactions t
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE t.owner_key = ?
                  AND t.removed_at IS NULL
                  {date_filter}
                  AND (t.pending = 0 OR NOT EXISTS (
                      SELECT 1 FROM bank_transactions posted
                      WHERE posted.owner_key = t.owner_key AND posted.pending = 0
                        AND posted.removed_at IS NULL
                        AND posted.pending_transaction_id = t.provider_transaction_id
                  ))
                  AND (t.account_id IS NULL OR (a.watched = 1 AND a.owner_key = t.owner_key
                      AND EXISTS (SELECT 1 FROM bank_items i WHERE i.id = a.item_id
                                  AND i.owner_key = t.owner_key AND i.status = 'active')))
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, t.updated_at DESC, t.id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_bank_transaction_from_row(row) for row in rows]

    def _review_rows(
        self, owner_key: str, *, start_date: str, limit: int, reconciled: bool,
    ) -> list[Any]:
        """Phone review uses only a person's connected, watched, recent accounts.

        A posted replacement supersedes its authorization immediately, even if
        Plaid delivers the authorization's removal on a later sync page.
        """
        self.initialize()
        reconciliation_join = (
            "JOIN bank_reconciliation_items r ON r.bank_transaction_id = t.id AND r.owner_key = t.owner_key"
            if reconciled else ""
        )
        with self.connect() as conn:
            return conn.execute(
                f"""SELECT {'r.*' if reconciled else 't.*'},
                        t.provider_transaction_id, t.date, t.authorized_date,
                        t.name, t.merchant_name, t.amount, t.pending,
                        t.payment_channel, t.pending_transaction_id, t.updated_at,
                        a.name AS account_name, a.mask AS account_mask,
                        a.type AS account_type, a.subtype AS account_subtype
                    FROM bank_transactions t
                    JOIN bank_accounts a ON a.id = t.account_id AND a.owner_key = t.owner_key
                    JOIN bank_items i ON i.id = a.item_id AND i.owner_key = t.owner_key
                    {reconciliation_join}
                    WHERE t.owner_key = ? AND t.removed_at IS NULL
                      AND a.watched = 1 AND i.status = 'active'
                      AND COALESCE(t.date, t.authorized_date, '') >= ?
                      AND (t.pending = 0 OR NOT EXISTS (
                          SELECT 1 FROM bank_transactions posted
                          WHERE posted.owner_key = t.owner_key AND posted.pending = 0
                            AND posted.removed_at IS NULL
                            AND posted.pending_transaction_id = t.provider_transaction_id
                      ))
                    ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, t.id DESC
                    LIMIT ?""",
                (owner_key, start_date, max(1, min(int(limit), 200))),
            ).fetchall()

    def review_transactions(
        self, owner_key: str, *, start_date: str, limit: int = 100,
    ) -> list[BankTransaction]:
        return [_bank_transaction_from_row(row) for row in self._review_rows(
            owner_key, start_date=start_date, limit=limit, reconciled=False,
        )]

    def review_reconciliation_items(
        self, owner_key: str, *, start_date: str, limit: int = 100,
    ) -> list[ReconciliationItem]:
        return [_reconciliation_item_from_row(row) for row in self._review_rows(
            owner_key, start_date=start_date, limit=limit, reconciled=True,
        )]

    def review_sync_status(self, owner_key: str) -> dict[str, Any]:
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT s.last_success_at, s.last_error
                   FROM bank_items i LEFT JOIN bank_sync_state s ON s.item_id = i.id
                   WHERE i.owner_key = ? AND i.status = 'active'
                     AND EXISTS (SELECT 1 FROM bank_accounts a
                                 WHERE a.item_id = i.id AND a.owner_key = i.owner_key AND a.watched = 1)""",
                (owner_key,),
            ).fetchall()
        successful = [str(row['last_success_at']) for row in rows if row['last_success_at']]
        return {
            'checkedAt': min(successful) if rows and len(successful) == len(rows) else None,
            'syncFailed': any(bool(row['last_error']) for row in rows),
        }

    def transaction_count(self, owner_key: str) -> int:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM bank_transactions
                WHERE owner_key = ?
                  AND removed_at IS NULL
                """,
                (owner_key,),
            ).fetchone()
        return int(row["count"]) if row else 0

    def reconciliation_cache_buckets(self, owner_key: str, *, start_date: str | None = None) -> ReconciliationCacheBuckets:
        self.initialize()
        buckets = {
            "stored": 0,
            "needs_review": 0,
            "matched": 0,
            "confirmed": 0,
            "ignored": 0,
            "pending": 0,
            "not_reviewed": 0,
            "unwatched": 0,
            "other": 0,
        }
        date_filter = ""
        params: tuple[Any, ...]
        if start_date:
            date_filter = " AND COALESCE(t.date, t.authorized_date, '') >= ?"
            params = (owner_key, start_date)
        else:
            params = (owner_key,)
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    CASE
                        WHEN COALESCE(a.watched, 1) = 0 THEN 'unwatched'
                        WHEN t.pending = 1 THEN 'pending'
                        WHEN r.id IS NULL THEN 'not_reviewed'
                        WHEN r.status IN ('needs_review', 'pending_user', 'conflict', 'import_requested') THEN 'needs_review'
                        WHEN r.status = 'matched' THEN 'matched'
                        WHEN r.status = 'confirmed' THEN 'confirmed'
                        WHEN r.status = 'ignored' THEN 'ignored'
                        ELSE 'other'
                    END AS bucket,
                    COUNT(*) AS count
                FROM bank_transactions t
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                LEFT JOIN bank_reconciliation_items r ON r.bank_transaction_id = t.id
                WHERE t.owner_key = ?
                  AND t.removed_at IS NULL
                  {date_filter}
                GROUP BY bucket
                """,
                params,
            ).fetchall()
        for row in rows:
            bucket = str(row["bucket"])
            if bucket in buckets:
                buckets[bucket] = int(row["count"])
        buckets["stored"] = sum(value for key, value in buckets.items() if key != "stored")
        return ReconciliationCacheBuckets(**buckets)

    def bank_transactions_for_reconciliation(
        self,
        owner_key: str,
        *,
        limit: int = 50,
        force: bool = False,
        start_date: str | None = None,
    ) -> list[BankTransaction]:
        if force:
            return self.recent_transactions(owner_key=owner_key, limit=min(max(1, int(limit)), 200), start_date=start_date)
        return self.unreconciled_transactions(owner_key=owner_key, limit=limit, start_date=start_date)

    def unreconciled_transactions(
        self,
        owner_key: str,
        limit: int = 50,
        *,
        start_date: str | None = None,
    ) -> list[BankTransaction]:
        safe_limit = max(1, min(int(limit), 100))
        date_filter = ""
        params: tuple[Any, ...]
        if start_date:
            date_filter = " AND COALESCE(t.date, t.authorized_date, '') >= ?"
            params = (owner_key, start_date, safe_limit)
        else:
            params = (owner_key, safe_limit)
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    t.id,
                    t.provider_transaction_id,
                    t.owner_key,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_transactions t
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                LEFT JOIN bank_reconciliation_items r ON r.bank_transaction_id = t.id
                WHERE t.owner_key = ?
                  AND t.removed_at IS NULL
                  AND t.pending = 0
                  {date_filter}
                  AND (t.account_id IS NULL OR (a.watched = 1 AND a.owner_key = t.owner_key
                      AND EXISTS (SELECT 1 FROM bank_items i WHERE i.id = a.item_id
                                  AND i.owner_key = t.owner_key AND i.status = 'active')))
                  AND (
                    r.id IS NULL
                    OR r.status IN ('needs_review', 'pending_user', 'conflict')
                  )
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, t.updated_at DESC, t.id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_bank_transaction_from_row(row) for row in rows]

    def upsert_reconciliation_item(
        self,
        *,
        owner_key: str,
        transaction: BankTransaction,
        classification: ReconciliationClassification,
        status: ReconciliationStatus,
        confidence: float,
        notes: str | None = None,
        matched_action_log_id: str | None = None,
        matched_sheet_ref: str | None = None,
    ) -> ReconciliationItem:
        now = utc_now_iso()
        with self.connect() as conn:
            self._lock_reconciliation_owner(conn, owner_key)
            conn.execute('UPDATE bank_transactions SET id = id WHERE id = ?', (transaction.id,))
            current = conn.execute(
                """SELECT t.*, a.watched, a.owner_key AS account_owner, i.status AS item_status
                   FROM bank_transactions t LEFT JOIN bank_accounts a ON a.id = t.account_id
                   LEFT JOIN bank_items i ON i.id = a.item_id
                   WHERE t.id = ? AND t.owner_key = ?""",
                (transaction.id, owner_key),
            ).fetchone()
            if current is None or transaction.owner_key != owner_key:
                raise ValueError('Bank transaction does not belong to this person.')
            if status == 'matched' and (
                current['removed_at'] is not None or current['pending']
                or current['updated_at'] != transaction.updated_at
                or (current['account_id'] is not None and (
                    not current['watched'] or current['item_status'] != 'active'
                    or current['account_owner'] != owner_key
                ))
                or self._reconciliation_match_taken(
                    conn, owner_key, transaction.id, matched_action_log_id, matched_sheet_ref,
                )
            ):
                status = 'needs_review'
                confidence = 0
                matched_action_log_id = matched_sheet_ref = None
                notes = 'Match changed or is already used; review again.'
            conn.execute(
                """
                INSERT INTO bank_reconciliation_items (
                    owner_key, bank_transaction_id, classification, status,
                    matched_action_log_id, matched_sheet_ref, confidence,
                    first_seen_at, last_seen_at, notes
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bank_transaction_id) DO UPDATE SET
                    classification = excluded.classification,
                    status = excluded.status,
                    matched_action_log_id = excluded.matched_action_log_id,
                    matched_sheet_ref = excluded.matched_sheet_ref,
                    confidence = excluded.confidence,
                    last_seen_at = excluded.last_seen_at,
                    notes = excluded.notes
                WHERE bank_reconciliation_items.status NOT IN ('confirmed', 'ignored', 'import_requested')
                """,
                (
                    owner_key,
                    transaction.id,
                    classification,
                    status,
                    matched_action_log_id,
                    matched_sheet_ref,
                    confidence,
                    now,
                    now,
                    notes,
                ),
            )
            row = conn.execute(
                """
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.bank_transaction_id = ?
                """,
                (transaction.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Failed to load stored reconciliation item")
        return _reconciliation_item_from_row(row)

    @staticmethod
    def _lock_reconciliation_owner(conn: BankStoreConnection, owner_key: str) -> None:
        # A stable owner lock serializes competing claims for the same sheet
        # entry on SQLite and Postgres without another persistence table.
        rows = conn.execute(
            'SELECT id FROM bank_items WHERE owner_key = ? ORDER BY id', (owner_key,),
        ).fetchall()
        for row in rows:
            conn.execute('UPDATE bank_items SET id = id WHERE id = ?', (row['id'],))

    @staticmethod
    def _reconciliation_match_taken(
        conn: BankStoreConnection, owner_key: str, bank_transaction_id: int,
        action_ids: str | None, sheet_refs: str | None,
    ) -> bool:
        wanted_ids = {part.strip() for part in (action_ids or '').split('+') if part.strip()}
        wanted_refs = {part.strip() for part in (sheet_refs or '').split(' + ') if part.strip()}
        if not wanted_ids and not wanted_refs:
            return False
        rows = conn.execute(
            """SELECT r.matched_action_log_id, r.matched_sheet_ref,
                      COALESCE(t.date, t.authorized_date, '') AS bank_date
               FROM bank_reconciliation_items r
               JOIN bank_transactions t ON t.id = r.bank_transaction_id AND t.owner_key = r.owner_key
               WHERE r.owner_key = ? AND r.bank_transaction_id != ?
                 AND r.status IN ('matched', 'confirmed', 'import_requested')
                 AND t.removed_at IS NULL AND t.pending = 0""",
            (owner_key, bank_transaction_id),
        ).fetchall()
        transaction = conn.execute(
            "SELECT COALESCE(date, authorized_date, '') AS bank_date FROM bank_transactions WHERE id = ? AND owner_key = ?",
            (bank_transaction_id, owner_key),
        ).fetchone()
        month = str(transaction['bank_date'])[:7] if transaction else ''
        for row in rows:
            if wanted_ids.intersection(part.strip() for part in (row['matched_action_log_id'] or '').split('+')):
                return True
            existing_refs = {part.strip() for part in (row['matched_sheet_ref'] or '').split(' + ') if part.strip()}
            if any(_sheet_reference_conflicts(wanted, existing, month, str(row['bank_date'])[:7])
                   for wanted in wanted_refs for existing in existing_refs):
                return True
        return False

    def unresolved_reconciliation_items(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        max_age_days: int | None = None,
        start_date: str | None = None,
    ) -> list[ReconciliationItem]:
        safe_limit = max(1, min(int(limit), 100))
        cutoff_date = None
        if start_date:
            cutoff_date = start_date
        elif max_age_days is not None:
            cutoff_date = (date.today() - timedelta(days=max(1, int(max_age_days)))).isoformat()
        date_filter = ""
        params: tuple[Any, ...]
        if cutoff_date:
            date_filter = " AND COALESCE(t.date, t.authorized_date, '') >= ?"
            params = (owner_key, cutoff_date, safe_limit)
        else:
            params = (owner_key, safe_limit)
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.owner_key = ?
                  AND t.removed_at IS NULL
                  AND t.pending = 0
                  AND (t.account_id IS NULL OR (a.watched = 1 AND a.owner_key = t.owner_key
                      AND EXISTS (SELECT 1 FROM bank_items i WHERE i.id = a.item_id
                                  AND i.owner_key = t.owner_key AND i.status = 'active')))
                  AND r.status IN ('needs_review', 'pending_user', 'conflict', 'import_requested')
                  {date_filter}
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, r.id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_reconciliation_item_from_row(row) for row in rows]

    def matched_reconciliation_items(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        max_age_days: int | None = None,
        start_date: str | None = None,
    ) -> list[ReconciliationItem]:
        safe_limit = max(1, min(int(limit), 100))
        cutoff_date = None
        if start_date:
            cutoff_date = start_date
        elif max_age_days is not None:
            cutoff_date = (date.today() - timedelta(days=max(1, int(max_age_days)))).isoformat()
        date_filter = ""
        params: tuple[Any, ...]
        if cutoff_date:
            date_filter = " AND COALESCE(t.date, t.authorized_date, '') >= ?"
            params = (owner_key, cutoff_date, safe_limit)
        else:
            params = (owner_key, safe_limit)
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.owner_key = ?
                  AND t.removed_at IS NULL
                  AND t.pending = 0
                  AND (t.account_id IS NULL OR (a.watched = 1 AND a.owner_key = t.owner_key
                      AND EXISTS (SELECT 1 FROM bank_items i WHERE i.id = a.item_id
                                  AND i.owner_key = t.owner_key AND i.status = 'active')))
                  AND r.status = 'matched'
                  {date_filter}
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, r.last_seen_at DESC, r.id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_reconciliation_item_from_row(row) for row in rows]

    def resolved_reconciliation_items(self, owner_key: str, limit: int = 25) -> list[ReconciliationItem]:
        safe_limit = max(1, min(int(limit), 100))
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.owner_key = ?
                  AND t.removed_at IS NULL
                  AND r.status IN ('confirmed', 'ignored')
                ORDER BY COALESCE(r.resolved_at, r.ignored_at, r.last_seen_at) DESC, r.id DESC
                LIMIT ?
                """,
                (owner_key, safe_limit),
            ).fetchall()
        return [_reconciliation_item_from_row(row) for row in rows]

    def ignore_reconciliation_item(self, owner_key: str, reconciliation_id: int) -> ReconciliationItem | None:
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            self._lock_reconciliation_owner(conn, owner_key)
            row = conn.execute(
                """
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.id = ?
                  AND r.owner_key = ?
                  AND t.removed_at IS NULL
                """,
                (int(reconciliation_id), owner_key),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE bank_reconciliation_items
                SET status = 'ignored',
                    ignored_at = ?,
                    last_seen_at = ?,
                    notes = CASE
                        WHEN notes IS NULL OR notes = '' THEN 'ignored by user'
                        ELSE notes || '; ignored by user'
                    END
                WHERE id = ?
                  AND owner_key = ?
                """,
                (now, now, int(reconciliation_id), owner_key),
            )
            updated = conn.execute(
                """
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.id = ?
                """,
                (int(reconciliation_id),),
            ).fetchone()
        return _reconciliation_item_from_row(updated) if updated else None

    def get_reconciliation_item(self, owner_key: str, reconciliation_id: int) -> ReconciliationItem | None:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT
                    r.*,
                    t.provider_transaction_id,
                    t.date,
                    t.authorized_date,
                    t.name,
                    t.merchant_name,
                    t.amount,
                    t.pending,
                    t.payment_channel,
                    t.pending_transaction_id,
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE r.id = ?
                  AND r.owner_key = ?
                  AND t.removed_at IS NULL
                """,
                (int(reconciliation_id), owner_key),
            ).fetchone()
        return _reconciliation_item_from_row(row) if row else None

    def get_reconciliation_item_for_transaction(
        self, owner_key: str, bank_transaction_id: int,
    ) -> ReconciliationItem | None:
        self.initialize()
        with self.connect() as conn:
            row = conn.execute(
                'SELECT id FROM bank_reconciliation_items WHERE owner_key = ? AND bank_transaction_id = ?',
                (owner_key, int(bank_transaction_id)),
            ).fetchone()
        return self.get_reconciliation_item(owner_key, int(row['id'])) if row is not None else None

    def matched_action_log_ids(self, owner_key: str) -> set[str]:
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT r.matched_action_log_id
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id AND t.owner_key = r.owner_key
                WHERE r.owner_key = ? AND t.removed_at IS NULL AND t.pending = 0
                  AND matched_action_log_id IS NOT NULL
                  AND matched_action_log_id != ''
                  AND r.status IN ('matched', 'confirmed', 'import_requested')
                """,
                (owner_key,),
            ).fetchall()
        matched_ids: set[str] = set()
        for row in rows:
            raw_id = str(row["matched_action_log_id"])
            matched_ids.update(part.strip() for part in raw_id.split("+") if part.strip())
        return matched_ids

    def matched_sheet_refs(self, owner_key: str) -> set[str]:
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT r.matched_sheet_ref
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id AND t.owner_key = r.owner_key
                WHERE r.owner_key = ? AND t.removed_at IS NULL AND t.pending = 0
                  AND matched_sheet_ref IS NOT NULL
                  AND matched_sheet_ref != ''
                  AND r.status IN ('matched', 'confirmed', 'import_requested')
                """,
                (owner_key,),
            ).fetchall()
        matched_refs: set[str] = set()
        for row in rows:
            raw_ref = str(row["matched_sheet_ref"])
            matched_refs.update(part.strip() for part in raw_ref.split(" + ") if part.strip())
        return matched_refs

    def apply_reconciliation_review(
        self, owner_key: str, reconciliation_id: int, *,
        action: Literal['confirm', 'ignore', 'reopen'],
        expected_status: str, expected_updated_at: str, expected_last_seen_at: str,
        matched_action_log_id: str | None = None, matched_sheet_ref: str | None = None,
    ) -> ReconciliationItem | None:
        """Apply a reviewed metadata decision, or return None for a stale view.

        This never logs an expense or changes a sheet amount. Pending charges
        and imports in progress cannot be decided from the phone review screen.
        """
        allowed = {
            'confirm': {'needs_review', 'pending_user', 'conflict', 'matched'},
            'ignore': {'needs_review', 'pending_user', 'conflict', 'matched'},
            'reopen': {'matched', 'confirmed', 'ignored'},
        }
        if action not in allowed or expected_status not in allowed[action]:
            return None
        if action == 'confirm' and not (matched_action_log_id or matched_sheet_ref):
            return None
        self.initialize()
        now = utc_now_iso()
        with self.connect() as conn:
            self._lock_reconciliation_owner(conn, owner_key)
            identity = conn.execute(
                'SELECT bank_transaction_id FROM bank_reconciliation_items WHERE id = ? AND owner_key = ?',
                (int(reconciliation_id), owner_key),
            ).fetchone()
            if identity is None:
                return None
            conn.execute('UPDATE bank_transactions SET id = id WHERE id = ?', (identity['bank_transaction_id'],))
            conn.execute('UPDATE bank_reconciliation_items SET id = id WHERE id = ?', (int(reconciliation_id),))
            row = conn.execute(
                """SELECT r.*, t.updated_at AS bank_updated_at
                   FROM bank_reconciliation_items r
                   JOIN bank_transactions t ON t.id = r.bank_transaction_id AND t.owner_key = r.owner_key
                   JOIN bank_accounts a ON a.id = t.account_id AND a.owner_key = r.owner_key
                   JOIN bank_items i ON i.id = a.item_id AND i.owner_key = r.owner_key
                   WHERE r.id = ? AND r.owner_key = ? AND t.removed_at IS NULL AND t.pending = 0
                     AND a.watched = 1 AND i.status = 'active'""",
                (int(reconciliation_id), owner_key),
            ).fetchone()
            if row is None or (
                row['status'] != expected_status or row['bank_updated_at'] != expected_updated_at
                or row['last_seen_at'] != expected_last_seen_at
            ):
                return None
            if action == 'confirm' and self._reconciliation_match_taken(
                conn, owner_key, row['bank_transaction_id'], matched_action_log_id, matched_sheet_ref,
            ):
                return None
            status = {'confirm': 'confirmed', 'ignore': 'ignored', 'reopen': 'needs_review'}[action]
            conn.execute(
                """UPDATE bank_reconciliation_items
                   SET status = ?, matched_action_log_id = ?, matched_sheet_ref = ?,
                       resolved_at = ?, ignored_at = ?, last_seen_at = ?, notes = ?
                   WHERE id = ? AND owner_key = ?""",
                (status, matched_action_log_id if action == 'confirm' else None,
                 matched_sheet_ref if action == 'confirm' else None,
                 now if action == 'confirm' else None, now if action == 'ignore' else None,
                 now, f'{action} from phone review', int(reconciliation_id), owner_key),
            )
            payload = {
                'previous_status': row['status'], 'status': status,
                'previous_action_log_id': row['matched_action_log_id'],
                'previous_sheet_ref': row['matched_sheet_ref'],
                'matched_action_log_id': matched_action_log_id if action == 'confirm' else None,
                'matched_sheet_ref': matched_sheet_ref if action == 'confirm' else None,
                'bank_updated_at': expected_updated_at,
            }
            conn.execute(
                """INSERT INTO bank_reconciliation_events (
                       event_id, reconciliation_id, owner_key, event_type, occurred_at, payload_json
                   ) VALUES (?, ?, ?, ?, ?, ?)""",
                (uuid4().hex, int(reconciliation_id), owner_key, f'phone_review_{action}',
                 now, json.dumps(payload, sort_keys=True)),
            )
        return self.get_reconciliation_item(owner_key, reconciliation_id)

    def confirm_reconciliation_item(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        matched_action_log_id: str | None = None,
        matched_sheet_ref: str | None = None,
        notes: str = "logged from bank review",
    ) -> ReconciliationItem | None:
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            self._lock_reconciliation_owner(conn, owner_key)
            identity = conn.execute(
                'SELECT bank_transaction_id FROM bank_reconciliation_items WHERE id = ? AND owner_key = ?',
                (int(reconciliation_id), owner_key),
            ).fetchone()
            if identity is None:
                return None
            conn.execute('UPDATE bank_transactions SET id = id WHERE id = ?', (identity['bank_transaction_id'],))
            row = conn.execute(
                """SELECT r.bank_transaction_id, r.matched_action_log_id, r.matched_sheet_ref
                   FROM bank_reconciliation_items r JOIN bank_transactions t ON t.id = r.bank_transaction_id
                   LEFT JOIN bank_accounts a ON a.id = t.account_id
                   LEFT JOIN bank_items i ON i.id = a.item_id
                   WHERE r.id = ? AND r.owner_key = ? AND t.owner_key = ?
                     AND t.removed_at IS NULL AND t.pending = 0
                     AND (t.account_id IS NULL OR (a.watched = 1 AND a.owner_key = t.owner_key
                         AND i.status = 'active' AND i.owner_key = t.owner_key))""",
                (int(reconciliation_id), owner_key, owner_key),
            ).fetchone()
            if row is None or self._reconciliation_match_taken(
                conn, owner_key, row['bank_transaction_id'],
                matched_action_log_id or row['matched_action_log_id'],
                matched_sheet_ref or row['matched_sheet_ref'],
            ):
                return None
            conn.execute(
                """
                UPDATE bank_reconciliation_items
                SET status = 'confirmed',
                    resolved_at = ?,
                    last_seen_at = ?,
                    matched_action_log_id = COALESCE(?, matched_action_log_id),
                    matched_sheet_ref = COALESCE(?, matched_sheet_ref),
                    notes = CASE
                        WHEN notes IS NULL OR notes = '' THEN ?
                        ELSE notes || '; ' || ?
                    END
                WHERE id = ?
                  AND owner_key = ?
                """,
                (now, now, matched_action_log_id, matched_sheet_ref, notes, notes, int(reconciliation_id), owner_key),
            )
        return self.get_reconciliation_item(owner_key, reconciliation_id)

    def reopen_reconciliation_item(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        notes: str = "reopened for review",
    ) -> ReconciliationItem | None:
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            self._lock_reconciliation_owner(conn, owner_key)
            row = conn.execute(
                """
                SELECT r.id
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                WHERE r.id = ?
                  AND r.owner_key = ?
                  AND t.removed_at IS NULL
                """,
                (int(reconciliation_id), owner_key),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE bank_reconciliation_items
                SET status = 'needs_review',
                    matched_action_log_id = NULL,
                    matched_sheet_ref = NULL,
                    resolved_at = NULL,
                    ignored_at = NULL,
                    last_seen_at = ?,
                    notes = CASE
                        WHEN notes IS NULL OR notes = '' THEN ?
                        ELSE notes || '; ' || ?
                    END
                WHERE id = ?
                  AND owner_key = ?
                """,
                (now, notes, notes, int(reconciliation_id), owner_key),
            )
        return self.get_reconciliation_item(owner_key, reconciliation_id)

    def reopen_reconciliation_items_for_action_ids(
        self,
        owner_key: str,
        action_ids: set[str],
        *,
        notes: str = "reopened because matched action changed",
    ) -> list[ReconciliationItem]:
        ids = {str(action_id).strip() for action_id in action_ids if str(action_id).strip()}
        if not ids:
            return []
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT r.id, r.matched_action_log_id
                FROM bank_reconciliation_items r
                JOIN bank_transactions t ON t.id = r.bank_transaction_id
                WHERE r.owner_key = ?
                  AND t.removed_at IS NULL
                  AND r.matched_action_log_id IS NOT NULL
                  AND r.matched_action_log_id != ''
                  AND r.status IN ('matched', 'confirmed', 'import_requested')
                """,
                (owner_key,),
            ).fetchall()

        reopened: list[ReconciliationItem] = []
        for row in rows:
            matched_ids = {
                part.strip()
                for part in str(row["matched_action_log_id"]).split("+")
                if part.strip()
            }
            if matched_ids & ids:
                item = self.reopen_reconciliation_item(owner_key, int(row["id"]), notes=notes)
                if item is not None:
                    reopened.append(item)
        return reopened

    def status(self, configured: bool, plaid_env: str) -> BankStatus:
        self.initialize()
        with self.connect() as conn:
            item_count = int(
                conn.execute("SELECT COUNT(*) AS count FROM bank_items WHERE status = 'active'").fetchone()["count"]
            )
            account_count = int(conn.execute("SELECT COUNT(*) AS count FROM bank_accounts").fetchone()["count"])
            transaction_count = int(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM bank_transactions WHERE removed_at IS NULL"
                ).fetchone()["count"]
            )
            sync_row = conn.execute(
                """
                SELECT last_success_at, last_error
                FROM bank_sync_state
                ORDER BY COALESCE(last_sync_at, '') DESC
                LIMIT 1
                """
            ).fetchone()
        return BankStatus(
            configured=configured,
            plaid_env=plaid_env,
            sqlite_path=str(self.path),
            item_count=item_count,
            account_count=account_count,
            transaction_count=transaction_count,
            last_success_at=sync_row["last_success_at"] if sync_row else None,
            last_error=sync_row["last_error"] if sync_row else None,
        )


def _linked_item_from_row(row: sqlite3.Row) -> LinkedBankItem:
    return LinkedBankItem(
        id=int(row["id"]),
        owner_key=str(row["owner_key"]),
        provider=str(row["provider"]),
        item_id=str(row["item_id"]),
        institution_name=row["institution_name"],
        status=str(row["status"]),
    )


def _bank_account_from_row(row: sqlite3.Row) -> BankAccount:
    return BankAccount(
        id=int(row["id"]),
        item_id=int(row["item_id"]),
        provider_account_id=str(row["provider_account_id"]),
        owner_key=str(row["owner_key"]),
        name=str(row["name"]),
        mask=row["mask"],
        type=row["type"],
        subtype=row["subtype"],
        official_name=row["official_name"],
        current_balance=float(row["current_balance"]) if row["current_balance"] is not None else None,
        available_balance=float(row["available_balance"]) if row["available_balance"] is not None else None,
        watched=bool(row["watched"]),
    )


def _bank_transaction_from_row(row: sqlite3.Row) -> BankTransaction:
    return BankTransaction(
        id=int(row["id"]),
        provider_transaction_id=str(row["provider_transaction_id"]),
        owner_key=str(row["owner_key"]),
        account_name=row["account_name"],
        account_mask=row["account_mask"],
        account_type=row["account_type"],
        account_subtype=row["account_subtype"],
        date=row["date"],
        authorized_date=row["authorized_date"],
        name=str(row["name"]),
        merchant_name=row["merchant_name"],
        amount=float(row["amount"]),
        pending=bool(row["pending"]),
        payment_channel=row["payment_channel"],
        updated_at=str(row["updated_at"]),
        pending_transaction_id=row["pending_transaction_id"],
    )


def _reconciliation_item_from_row(row: sqlite3.Row) -> ReconciliationItem:
    transaction = BankTransaction(
        id=int(row["bank_transaction_id"]),
        provider_transaction_id=str(row["provider_transaction_id"]),
        owner_key=str(row["owner_key"]),
        account_name=row["account_name"],
        account_mask=row["account_mask"],
        account_type=row["account_type"],
        account_subtype=row["account_subtype"],
        date=row["date"],
        authorized_date=row["authorized_date"],
        name=str(row["name"]),
        merchant_name=row["merchant_name"],
        amount=float(row["amount"]),
        pending=bool(row["pending"]),
        payment_channel=row["payment_channel"],
        updated_at=str(row["updated_at"]),
        pending_transaction_id=row["pending_transaction_id"],
    )
    return ReconciliationItem(
        id=int(row["id"]),
        owner_key=str(row["owner_key"]),
        bank_transaction_id=int(row["bank_transaction_id"]),
        provider_transaction_id=str(row["provider_transaction_id"]),
        classification=row["classification"],
        status=row["status"],
        confidence=float(row["confidence"]),
        matched_action_log_id=row["matched_action_log_id"],
        matched_sheet_ref=row["matched_sheet_ref"],
        first_seen_at=str(row["first_seen_at"]),
        last_seen_at=str(row["last_seen_at"]),
        resolved_at=row["resolved_at"],
        ignored_at=row["ignored_at"],
        notes=row["notes"],
        transaction=transaction,
    )


def _plaid_webhook_event_from_row(row: sqlite3.Row) -> PlaidWebhookEvent:
    return PlaidWebhookEvent(
        id=int(row["id"]),
        item_id=row["item_id"],
        webhook_type=row["webhook_type"],
        webhook_code=row["webhook_code"],
        status=str(row["status"]),
        received_at=str(row["received_at"]),
        processed_at=row["processed_at"],
        error=row["error"],
    )
