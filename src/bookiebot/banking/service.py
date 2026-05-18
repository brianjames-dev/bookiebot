from __future__ import annotations

import logging
from datetime import date as local_date
from typing import Any
from uuid import uuid4

from bookiebot.banking.config import BankingConfig, load_banking_config
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount, BankStatus, BankTransaction, LinkedBankItem, ReconciliationPreview, SyncResult
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.reconciliation import action_log_bank_transaction, reconcile_transaction
from bookiebot.banking.store import BankStore
from bookiebot.sheets.undo import read_active_logged_actions


logger = logging.getLogger(__name__)


def _clean_debug_text(value: str | None) -> str:
    text = (value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1].strip()
    return text


class BankingService:
    def __init__(self, config: BankingConfig, store: BankStore, plaid: PlaidClient):
        self.config = config
        self.store = store
        self.plaid = plaid

    async def link_sandbox_item(self, owner_key: str, institution_id: str = "ins_109508") -> LinkedBankItem:
        self.store.initialize()
        public_token = await self.plaid.create_sandbox_public_token(institution_id=institution_id)
        return await self.link_public_token(
            owner_key,
            public_token,
            institution_name=f"Plaid Sandbox {institution_id}",
        )

    async def create_link_token(self, owner_key: str) -> str:
        return await self.plaid.create_link_token(owner_key=owner_key)

    async def link_public_token(
        self,
        owner_key: str,
        public_token: str,
        *,
        institution_name: str | None = None,
    ) -> LinkedBankItem:
        self.store.initialize()
        access_token, item_id = await self.plaid.exchange_public_token(public_token)
        item = self.store.upsert_item(
            owner_key=owner_key,
            provider="plaid",
            item_id=item_id,
            access_token=access_token,
            institution_name=institution_name,
        )
        accounts = await self._fetch_accounts_for_item(item)
        self.store.upsert_accounts(accounts)
        return item

    async def seed_sandbox_owner(self, owner_key: str, institution_id: str = "ins_109508") -> tuple[LinkedBankItem, list[SyncResult]]:
        self.store.initialize()
        existing_items = self.store.list_active_items(owner_key=owner_key)
        if existing_items:
            item = existing_items[0]
        else:
            item = await self.link_sandbox_item(owner_key, institution_id=institution_id)
        results = await self.sync_owner(owner_key)
        if self.store.transaction_count(owner_key) == 0 and not any(
            result.added or result.modified for result in results
        ):
            reset_count = self.store.reset_sync_cursors(owner_key)
            if reset_count:
                logger.info(
                    "Reset empty Sandbox transaction cursor cache",
                    extra={"owner_key": owner_key, "items": reset_count},
                )
                results = await self.sync_owner(owner_key)
        return item, results

    async def sync_owner(self, owner_key: str) -> list[SyncResult]:
        self.store.initialize()
        results: list[SyncResult] = []
        for item in self.store.list_active_items(owner_key=owner_key):
            results.append(await self.sync_item(item))
        return results

    async def sync_item(self, item: LinkedBankItem) -> SyncResult:
        access_token = self.store.get_access_token(item.id)
        cursor = self.store.get_cursor(item.id)
        total_added = 0
        total_modified = 0
        total_removed = 0
        has_more = True
        latest_cursor = cursor

        try:
            accounts = await self._fetch_accounts_for_item(item, access_token=access_token)
            self.store.upsert_accounts(accounts)

            while has_more:
                response = await self.plaid.sync_transactions(access_token, cursor=latest_cursor)
                added = list(response.get("added") or [])
                modified = list(response.get("modified") or [])
                removed = list(response.get("removed") or [])
                latest_cursor = response.get("next_cursor") or latest_cursor
                has_more = bool(response.get("has_more"))

                self.store.upsert_transactions(added, item.owner_key)
                self.store.upsert_transactions(modified, item.owner_key)
                self.store.mark_transactions_removed(removed)

                total_added += len(added)
                total_modified += len(modified)
                total_removed += len(removed)

            self.store.mark_sync_success(item.id, latest_cursor)
            return SyncResult(
                item_id=item.id,
                institution_name=item.institution_name,
                added=total_added,
                modified=total_modified,
                removed=total_removed,
                accounts=len(accounts),
                has_more=False,
            )
        except Exception as exc:
            logger.warning("Bank sync failed", extra={"item_id": item.id, "exception": str(exc)})
            self.store.mark_sync_error(item.id, f"{type(exc).__name__}: {exc}")
            raise

    def status(self) -> BankStatus:
        return self.store.status(configured=self.config.configured, plaid_env=self.config.plaid_env)

    def linked_items(self, owner_key: str) -> list[LinkedBankItem]:
        return self.store.list_items(owner_key=owner_key)

    def disconnect_item(self, owner_key: str, item_db_id: int) -> LinkedBankItem | None:
        return self.store.disconnect_item(owner_key, item_db_id)

    def purge_disconnected_item(self, owner_key: str, item_db_id: int) -> dict[str, int] | None:
        return self.store.purge_disconnected_item(owner_key, item_db_id)

    def recent_transactions(self, owner_key: str, limit: int = 10) -> list[BankTransaction]:
        return self.store.recent_transactions(owner_key=owner_key, limit=limit)

    def seed_cached_transactions_from_action_log(
        self,
        owner_key: str,
        actor_key: str,
        *,
        limit: int = 25,
    ) -> tuple[int, int]:
        """Debug helper: seed bank cache from real BookieBot action-log rows."""
        self.store.initialize()
        actions = read_active_logged_actions(actor_key)
        rows = []
        for logged in reversed(actions):
            row = action_log_bank_transaction(logged)
            if row is not None:
                rows.append(row)
            if len(rows) >= max(1, min(limit, 100)):
                break
        if rows:
            self.store.upsert_transactions(rows, owner_key)
        return len(rows), len(actions)

    def seed_unmatched_debug_transaction(
        self,
        owner_key: str,
        *,
        name: str = "Unlogged Test Purchase",
        amount: float = 12.34,
        date: str | None = None,
        kind: str = "expense",
    ) -> BankTransaction:
        self.store.initialize()
        amount_value = abs(float(amount))
        if kind == "income":
            amount_value = -amount_value
        row = {
            "transaction_id": f"bookiebot-debug-unmatched-{uuid4().hex[:10]}",
            "account_id": "bookiebot-debug-unmatched",
            "date": date or local_date.today().isoformat(),
            "name": _clean_debug_text(name) or "Unlogged Test Purchase",
            "merchant_name": None,
            "amount": amount_value,
            "pending": False,
            "payment_channel": "bookiebot_debug",
        }
        self.store.upsert_transactions([row], owner_key)
        transactions = self.store.recent_transactions(owner_key, limit=1)
        if not transactions:
            raise RuntimeError("Failed to seed unmatched debug transaction")
        return transactions[0]

    def unresolved_reconciliation_items(self, owner_key: str, limit: int = 25) -> list:
        return self.store.unresolved_reconciliation_items(owner_key, limit=limit)

    def ignore_reconciliation_item(self, owner_key: str, reconciliation_id: int):
        return self.store.ignore_reconciliation_item(owner_key, reconciliation_id)

    def get_reconciliation_item(self, owner_key: str, reconciliation_id: int):
        return self.store.get_reconciliation_item(owner_key, reconciliation_id)

    def confirm_reconciliation_item(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        matched_sheet_ref: str | None = None,
    ):
        return self.store.confirm_reconciliation_item(
            owner_key,
            reconciliation_id,
            matched_sheet_ref=matched_sheet_ref,
        )

    def reconciliation_preview(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        force: bool = False,
        actor_key: str | None = None,
    ) -> ReconciliationPreview:
        self.store.initialize()
        cached_transaction_count = self.store.transaction_count(owner_key)
        transactions = self.store.bank_transactions_for_reconciliation(owner_key=owner_key, limit=limit, force=force)
        action_log = read_active_logged_actions(actor_key) if actor_key else []
        items = []
        for transaction in transactions:
            decision = reconcile_transaction(transaction, action_log)
            items.append(
                self.store.upsert_reconciliation_item(
                    owner_key=owner_key,
                    transaction=transaction,
                    classification=decision.classification,
                    status=decision.status,
                    confidence=decision.confidence,
                    notes=decision.notes,
                    matched_action_log_id=decision.matched_action_log_id,
                    matched_sheet_ref=decision.matched_sheet_ref,
                )
            )
        return ReconciliationPreview(
            owner_key=owner_key,
            items=items,
            force=force,
            cached_transaction_count=cached_transaction_count,
            candidate_transaction_count=len(transactions),
        )

    async def _fetch_accounts_for_item(
        self,
        item: LinkedBankItem,
        *,
        access_token: str | None = None,
    ) -> list[BankAccount]:
        token = access_token or self.store.get_access_token(item.id)
        raw_accounts = await self.plaid.get_accounts(token)
        return [_account_from_plaid(item, raw) for raw in raw_accounts]


def build_banking_service() -> BankingService:
    config = load_banking_config()
    cipher = TokenCipher(config.token_encryption_key or "missing-dev-key")
    if config.database_url:
        from bookiebot.banking.postgres_store import PostgresBankStore

        store = PostgresBankStore(config.database_url, cipher)
    else:
        store = BankStore(config.sqlite_path, cipher)
    plaid = PlaidClient(config)
    return BankingService(config=config, store=store, plaid=plaid)


def _account_from_plaid(item: LinkedBankItem, raw: dict[str, Any]) -> BankAccount:
    balances = raw.get("balances") or {}
    return BankAccount(
        item_id=item.id,
        provider_account_id=str(raw["account_id"]),
        owner_key=item.owner_key,
        name=str(raw.get("name") or raw.get("official_name") or "Account"),
        mask=raw.get("mask"),
        type=raw.get("type"),
        subtype=raw.get("subtype"),
        official_name=raw.get("official_name"),
        current_balance=_float_or_none(balances.get("current")),
        available_balance=_float_or_none(balances.get("available")),
    )


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
