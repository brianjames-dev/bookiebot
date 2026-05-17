from __future__ import annotations

import logging
from typing import Any

from bookiebot.banking.config import BankingConfig, load_banking_config
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount, BankStatus, BankTransaction, LinkedBankItem, ReconciliationPreview, SyncResult
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.reconciliation import classify_transaction
from bookiebot.banking.store import BankStore


logger = logging.getLogger(__name__)


class BankingService:
    def __init__(self, config: BankingConfig, store: BankStore, plaid: PlaidClient):
        self.config = config
        self.store = store
        self.plaid = plaid

    async def link_sandbox_item(self, owner_key: str, institution_id: str = "ins_109508") -> LinkedBankItem:
        self.store.initialize()
        public_token = await self.plaid.create_sandbox_public_token(institution_id=institution_id)
        access_token, item_id = await self.plaid.exchange_public_token(public_token)
        item = self.store.upsert_item(
            owner_key=owner_key,
            provider="plaid",
            item_id=item_id,
            access_token=access_token,
            institution_name=f"Plaid Sandbox {institution_id}",
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

    def recent_transactions(self, owner_key: str, limit: int = 10) -> list[BankTransaction]:
        return self.store.recent_transactions(owner_key=owner_key, limit=limit)

    def reconciliation_preview(self, owner_key: str, limit: int = 25, *, force: bool = False) -> ReconciliationPreview:
        self.store.initialize()
        cached_transaction_count = self.store.transaction_count(owner_key)
        transactions = self.store.bank_transactions_for_reconciliation(owner_key=owner_key, limit=limit, force=force)
        items = []
        for transaction in transactions:
            classification, status, confidence, notes = classify_transaction(transaction)
            items.append(
                self.store.upsert_reconciliation_item(
                    owner_key=owner_key,
                    transaction=transaction,
                    classification=classification,
                    status=status,
                    confidence=confidence,
                    notes=notes,
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
