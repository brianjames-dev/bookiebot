from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterator

from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import (
    BankAccount,
    BankStatus,
    BankTransaction,
    LinkedBankItem,
    ReconciliationClassification,
    ReconciliationItem,
    ReconciliationStatus,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class BankStore:
    def __init__(self, path: Path, cipher: TokenCipher):
        self.path = path
        self.cipher = cipher

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
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
                "INSERT OR IGNORE INTO bank_sync_state (item_id) VALUES (?)",
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
                        official_name, current_balance, available_balance, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        now,
                    ),
                )
        return len(accounts)

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
                        name, merchant_name, amount, pending, category, payment_channel,
                        raw_json, created_at, updated_at, removed_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
                    t.updated_at,
                    a.name AS account_name,
                    a.mask AS account_mask,
                    a.type AS account_type,
                    a.subtype AS account_subtype
                FROM bank_transactions t
                LEFT JOIN bank_accounts a ON a.id = t.account_id
                WHERE t.owner_key = ?
                  AND t.removed_at IS NULL
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
                SELECT COUNT(*)
                FROM bank_transactions
                WHERE owner_key = ?
                  AND removed_at IS NULL
                """,
                (owner_key,),
            ).fetchone()
        return int(row[0]) if row else 0

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
                    classification = excluded.classification,
                    status = CASE
                        WHEN bank_reconciliation_items.status IN ('confirmed', 'ignored', 'import_requested')
                        THEN bank_reconciliation_items.status
                        ELSE excluded.status
                    END,
                    matched_action_log_id = excluded.matched_action_log_id,
                    matched_sheet_ref = excluded.matched_sheet_ref,
                    confidence = excluded.confidence,
                    last_seen_at = excluded.last_seen_at,
                    notes = excluded.notes
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

    def unresolved_reconciliation_items(self, owner_key: str, limit: int = 25) -> list[ReconciliationItem]:
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
                  AND r.status IN ('needs_review', 'pending_user', 'conflict')
                ORDER BY COALESCE(t.date, t.authorized_date, '') DESC, r.id DESC
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

    def confirm_reconciliation_item(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        matched_sheet_ref: str | None = None,
    ) -> ReconciliationItem | None:
        now = utc_now_iso()
        self.initialize()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE bank_reconciliation_items
                SET status = 'confirmed',
                    resolved_at = ?,
                    last_seen_at = ?,
                    matched_sheet_ref = COALESCE(?, matched_sheet_ref),
                    notes = CASE
                        WHEN notes IS NULL OR notes = '' THEN 'logged from bank review'
                        ELSE notes || '; logged from bank review'
                    END
                WHERE id = ?
                  AND owner_key = ?
                """,
                (now, now, matched_sheet_ref, int(reconciliation_id), owner_key),
            )
        return self.get_reconciliation_item(owner_key, reconciliation_id)

    def status(self, configured: bool, plaid_env: str) -> BankStatus:
        self.initialize()
        with self.connect() as conn:
            item_count = int(conn.execute("SELECT COUNT(*) FROM bank_items WHERE status = 'active'").fetchone()[0])
            account_count = int(conn.execute("SELECT COUNT(*) FROM bank_accounts").fetchone()[0])
            transaction_count = int(
                conn.execute("SELECT COUNT(*) FROM bank_transactions WHERE removed_at IS NULL").fetchone()[0]
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
