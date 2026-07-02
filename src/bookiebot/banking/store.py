from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterator, Protocol

from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import (
    BankAccount,
    BankStatus,
    BankTransaction,
    LinkedBankItem,
    PlaidWebhookEvent,
    ReconciliationCacheBuckets,
    ReconciliationClassification,
    ReconciliationItem,
    ReconciliationStatus,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

    def get_access_token(self, item_db_id: int, owner_key: str | None = None) -> str:
        with self.connect() as conn:
            if owner_key:
                row = conn.execute(
                    "SELECT encrypted_access_token FROM bank_items WHERE id = ? AND owner_key = ?",
                    (item_db_id, owner_key),
                ).fetchone()
            else:
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
                    webhook_pending = 0,
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
                account_row = conn.execute(
                    "SELECT id FROM bank_accounts WHERE provider_account_id = ?",
                    (txn.get("account_id"),),
                ).fetchone()
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
                  AND status IN ('pending', 'failed')
                ORDER BY received_at, id
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
        events: list[tuple[PlaidWebhookEvent, dict[str, Any]]] = []
        for row in rows:
            payload = json.loads(str(row["payload"]))
            events.append((_plaid_webhook_event_from_row(row), payload if isinstance(payload, dict) else {}))
        return events

    def mark_plaid_webhook_processing(self, event_id: int) -> None:
        self.initialize()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE bank_webhook_events
                SET status = 'processing',
                    error = NULL
                WHERE id = ?
                """,
                (int(event_id),),
            )

    def mark_plaid_webhook_processed(self, event_id: int, item_id: str | None = None) -> None:
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE bank_webhook_events
                SET status = 'processed',
                    processed_at = ?,
                    error = NULL
                WHERE id = ?
                """,
                (now, int(event_id)),
            )
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

    def mark_plaid_webhook_failed(self, event_id: int, error: str) -> None:
        self.initialize()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE bank_webhook_events
                SET status = 'failed',
                    error = ?
                WHERE id = ?
                """,
                (error[:1000], int(event_id)),
            )

    def recent_transactions(self, owner_key: str, limit: int = 10) -> list[BankTransaction]:
        safe_limit = max(1, min(int(limit), 25))
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
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
                  AND (t.account_id IS NULL OR COALESCE(a.watched, 1) = 1)
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, t.updated_at DESC, t.id DESC
                LIMIT ?
                """,
                (owner_key, safe_limit),
            ).fetchall()
        return [_bank_transaction_from_row(row) for row in rows]

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

    def reconciliation_cache_buckets(self, owner_key: str) -> ReconciliationCacheBuckets:
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
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    CASE
                        WHEN COALESCE(a.watched, 1) = 0 THEN 'unwatched'
                        WHEN t.pending = 1 THEN 'pending'
                        WHEN r.id IS NULL THEN 'not_reviewed'
                        WHEN r.status IN ('needs_review', 'pending_user', 'conflict') THEN 'needs_review'
                        WHEN r.status = 'matched' THEN 'matched'
                        WHEN r.status IN ('confirmed', 'import_requested') THEN 'confirmed'
                        WHEN r.status = 'ignored' THEN 'ignored'
                        ELSE 'other'
                    END AS bucket,
                    COUNT(*) AS count
                FROM bank_transactions t
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                LEFT JOIN bank_reconciliation_items r ON r.bank_transaction_id = t.id
                WHERE t.owner_key = ?
                  AND t.removed_at IS NULL
                GROUP BY bucket
                """,
                (owner_key,),
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
    ) -> list[BankTransaction]:
        if force:
            return self.recent_transactions(owner_key=owner_key, limit=min(max(1, int(limit)), 25))
        return self.unreconciled_transactions(owner_key=owner_key, limit=limit)

    def unreconciled_transactions(self, owner_key: str, limit: int = 50) -> list[BankTransaction]:
        safe_limit = max(1, min(int(limit), 100))
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
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
                  AND (t.account_id IS NULL OR COALESCE(a.watched, 1) = 1)
                  AND (
                    r.id IS NULL
                    OR r.status IN ('needs_review', 'pending_user', 'conflict')
                  )
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, t.updated_at DESC, t.id DESC
                LIMIT ?
                """,
                (owner_key, safe_limit),
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
            conn.execute(
                """
                INSERT INTO bank_reconciliation_items (
                    owner_key, bank_transaction_id, classification, status,
                    matched_action_log_id, matched_sheet_ref, confidence,
                    first_seen_at, last_seen_at, notes
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bank_transaction_id) DO UPDATE SET
                    classification = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.classification
                        ELSE excluded.classification
                    END,
                    status = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.status
                        ELSE excluded.status
                    END,
                    matched_action_log_id = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.matched_action_log_id
                        ELSE excluded.matched_action_log_id
                    END,
                    matched_sheet_ref = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.matched_sheet_ref
                        ELSE excluded.matched_sheet_ref
                    END,
                    confidence = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.confidence
                        ELSE excluded.confidence
                    END,
                    last_seen_at = excluded.last_seen_at,
                    notes = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.notes
                        ELSE excluded.notes
                    END
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

    def unresolved_reconciliation_items(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        max_age_days: int | None = None,
    ) -> list[ReconciliationItem]:
        safe_limit = max(1, min(int(limit), 100))
        cutoff_date = None
        if max_age_days is not None:
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
                  AND (t.account_id IS NULL OR COALESCE(a.watched, 1) = 1)
                  AND r.status IN ('needs_review', 'pending_user', 'conflict')
                  {date_filter}
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, r.id DESC
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
                  AND r.status IN ('confirmed', 'ignored', 'import_requested')
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

    def matched_action_log_ids(self, owner_key: str) -> set[str]:
        self.initialize()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT matched_action_log_id
                FROM bank_reconciliation_items
                WHERE owner_key = ?
                  AND matched_action_log_id IS NOT NULL
                  AND matched_action_log_id != ''
                  AND status IN ('matched', 'confirmed', 'import_requested')
                """,
                (owner_key,),
            ).fetchall()
        matched_ids: set[str] = set()
        for row in rows:
            raw_id = str(row["matched_action_log_id"])
            matched_ids.update(part.strip() for part in raw_id.split("+") if part.strip())
        return matched_ids

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
            row = conn.execute(
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
                  AND status IN ('needs_review', 'pending_user', 'conflict', 'matched')
                RETURNING id
                """,
                (now, now, matched_action_log_id, matched_sheet_ref, notes, notes, int(reconciliation_id), owner_key),
            ).fetchone()
        if row is None:
            return None
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
