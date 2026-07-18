from __future__ import annotations

import logging
import os
import time
from datetime import date as local_date, timedelta
from typing import Any
from uuid import uuid4

from bookiebot.banking.config import BankingConfig, load_banking_config
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import (
    BankAccount,
    BankStatus,
    BankTransaction,
    LinkedBankItem,
    ReconciliationItem,
    ReconciliationPreview,
    ReconciliationReportMatch,
    SyncResult,
)
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.reconciliation import (
    ActionLogCandidate,
    ActionLogCandidateGroup,
    ScheduledPullCandidate,
    _candidate_amount_tolerance,
    _scheduled_name_score,
    action_log_bank_transaction,
    action_log_candidate_by_id,
    find_action_log_candidates,
    find_action_log_candidate_groups,
    find_scheduled_pull_candidates,
    recent_action_log_candidates,
    reconcile_transaction,
)
from bookiebot.sheets.bills import bill_amount_for_source_label, list_bill_schedules, next_bill_pull_date
from bookiebot.sheets.routing import sheet_user_context
from bookiebot.sheets.subscriptions import (
    list_normalized_subscription_schedules,
    next_pull_date,
    parse_visible_subscription_schedules,
)
from bookiebot.banking.store import BankStore
from bookiebot.sheets.undo import delete_recent_action, read_active_logged_actions, undo_logged_action, update_recent_action


logger = logging.getLogger(__name__)
_SCHEDULE_SOURCE_CACHE: dict[str, tuple[float, list[Any], list[tuple[Any, bool, float]]]] = {}


def _schedule_cache_ttl_seconds() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_SCHEDULE_CACHE_SECONDS", "900").strip()
    try:
        return max(int(raw), 60)
    except ValueError:
        return 900


def _reconciliation_max_age_days() -> int:
    raw = os.getenv("BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS", "60").strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 60


def _current_month_start() -> str:
    return local_date.today().replace(day=1).isoformat()


def _schedule_sources_for_actor(actor_key: str) -> tuple[list[Any], list[tuple[Any, bool, float]]]:
    cached = _SCHEDULE_SOURCE_CACHE.get(actor_key)
    now = time.monotonic()
    if cached and now - cached[0] <= _schedule_cache_ttl_seconds():
        return list(cached[1]), list(cached[2])

    subscriptions: list[Any] = []
    bills_with_amounts: list[tuple[Any, bool, float]] = []
    with sheet_user_context(actor_key):
        subscription_load_failed = False
        try:
            subscriptions = list_normalized_subscription_schedules()
        except Exception:
            subscription_load_failed = True
            logger.warning(
                "Failed to load normalized subscription schedules for bank reconciliation",
                extra={"actor_key": actor_key},
                exc_info=True,
            )
        if not subscriptions and not subscription_load_failed:
            try:
                subscriptions = parse_visible_subscription_schedules()
            except Exception:
                logger.warning(
                    "Failed to load visible subscription schedules for bank reconciliation",
                    extra={"actor_key": actor_key},
                    exc_info=True,
                )
                subscriptions = []

        try:
            bills = list_bill_schedules()
        except Exception:
            logger.warning(
                "Failed to load bill schedules for bank reconciliation",
                extra={"actor_key": actor_key},
                exc_info=True,
            )
            bills = []

        for bill in bills:
            try:
                amount_entered, amount = bill_amount_for_source_label(bill.source_label)
            except Exception:
                logger.warning(
                    "Failed to load bill amount for bank reconciliation",
                    extra={"actor_key": actor_key, "bill_key": bill.bill_key},
                    exc_info=True,
                )
                amount_entered = False
                amount = 0.0
            bills_with_amounts.append((bill, amount_entered, amount))

    _SCHEDULE_SOURCE_CACHE[actor_key] = (now, list(subscriptions), list(bills_with_amounts))
    return subscriptions, bills_with_amounts


def clear_schedule_source_cache(actor_key: str | None = None) -> None:
    if actor_key is None:
        _SCHEDULE_SOURCE_CACHE.clear()
    else:
        _SCHEDULE_SOURCE_CACHE.pop(actor_key, None)


def _clean_debug_text(value: str | None) -> str:
    text = (value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1].strip()
    return text


def _find_action_for_sheet_ref(action_log: list, sheet_ref: str | None):
    if not sheet_ref or "!row " not in sheet_ref:
        return None
    worksheet, row_text = sheet_ref.split("!row ", 1)
    try:
        row = int(row_text.strip())
    except ValueError:
        return None
    for logged in reversed(action_log):
        if logged.action.worksheet == worksheet and logged.action.row == row:
            return logged
    return None


def _bill_name_matches_transaction(bill_name: str, transaction: BankTransaction) -> bool:
    bill_text = " ".join(token for token in _simple_match_tokens(bill_name) if len(token) >= 3)
    transaction_text = " ".join(
        token
        for token in _simple_match_tokens(" ".join(filter(None, [transaction.name, transaction.merchant_name])))
        if len(token) >= 3
    )
    if not bill_text or not transaction_text:
        return False
    return bill_text in transaction_text or any(token in bill_text for token in transaction_text.split())


def _simple_match_tokens(value: str | None) -> list[str]:
    import re

    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).split()


def _scheduled_pull_debug_rows(transaction: BankTransaction, pulls: list[ScheduledPullCandidate], window_days: int) -> list[str]:
    transaction_date = _transaction_local_date(transaction)
    if transaction.amount <= 0:
        return ["Transaction is money-in, so schedule candidates are skipped."]
    if transaction_date is None:
        return ["Transaction date is missing or invalid."]

    rows = []
    if transaction.pending:
        rows.append("Transaction is pending; candidates are shown for review only.")
        rows.append("")
    header = f"{'Name':<18} {'Pull':<5} {'Amt':>8} {'d':>2} {'Name':>4} {'Delta':>7} {'Result'}"
    rows.append(header)
    rows.append("-" * len(header))
    for pull in pulls[:25]:
        day_delta = abs((pull.pull_date - transaction_date).days)
        name_score = _scheduled_name_score(transaction, pull.name)
        candidate_amount = pull.amount if pull.amount > 0 else abs(transaction.amount)
        amount_delta = abs(candidate_amount - abs(transaction.amount))
        amount_tolerance = _candidate_amount_tolerance(abs(transaction.amount), name_score)
        exact_or_wildcard_amount = pull.amount <= 0 or amount_delta <= 0.01
        result = "ok"
        if day_delta > window_days:
            result = "date"
        elif amount_delta > amount_tolerance:
            result = "amount"
        elif name_score <= 0 and not exact_or_wildcard_amount and day_delta > 3:
            result = "name/date"
        rows.append(
            f"{pull.name[:18]:<18} {pull.pull_date:%m-%d} "
            f"{('$' + format(candidate_amount, '.2f')):>8} {day_delta:>2} "
            f"{name_score:>4.2f} {('$' + format(amount_delta, '.2f')):>7} {result}"
        )
    return rows


def _scheduled_pulls_for_transactions(
    transactions: list[BankTransaction],
    *,
    actor_key: str | None,
    window_days: int = 7,
) -> list[ScheduledPullCandidate]:
    if not actor_key or not transactions:
        return []

    transaction_dates = [_transaction_local_date(transaction) for transaction in transactions]
    transaction_dates = [value for value in transaction_dates if value is not None]
    if not transaction_dates:
        return []

    transactions_by_date: dict[local_date, list[BankTransaction]] = {}
    for transaction in transactions:
        transaction_date = _transaction_local_date(transaction)
        if transaction_date is not None:
            transactions_by_date.setdefault(transaction_date, []).append(transaction)
    unique_transaction_dates = tuple(sorted(transactions_by_date))
    start_date = min(transaction_dates) - timedelta(days=window_days)
    end_date = max(transaction_dates) + timedelta(days=window_days)
    subscriptions, bills_with_amounts = _schedule_sources_for_actor(actor_key)
    candidates: list[ScheduledPullCandidate] = []
    for subscription in subscriptions:
        if subscription.amount <= 0:
            continue
        expected = next_pull_date(subscription, start_date)
        while expected is not None and expected <= end_date:
            candidates.append(
                ScheduledPullCandidate(
                    source_type="subscription",
                    name=subscription.name,
                    amount=subscription.amount,
                    pull_date=expected,
                    source_ref=subscription.source_range or f"subscription:{subscription.id or subscription.name}",
                    account=subscription.account,
                )
            )
            expected = next_pull_date(subscription, expected + timedelta(days=1))

    for bill, amount_entered, amount in bills_with_amounts:
        seen_pull_dates: set[local_date] = set()
        expected = next_bill_pull_date(bill, start_date)
        while expected is not None and expected <= end_date:
            seen_pull_dates.add(expected)
            candidates.append(
                ScheduledPullCandidate(
                    source_type="bill",
                    name=bill.display_name,
                    amount=amount if amount_entered and amount > 0 else 0.0,
                    pull_date=expected,
                    source_ref=bill.source_range or f"bill:{bill.bill_key}",
                    account=bill.account,
                )
            )
            expected = next_bill_pull_date(bill, expected + timedelta(days=1))
        for transaction_date in unique_transaction_dates:
            if transaction_date in seen_pull_dates:
                continue
            date_transactions = transactions_by_date.get(transaction_date, [])
            name_matches = any(_bill_name_matches_transaction(bill.display_name, transaction) for transaction in date_transactions)
            if not ((amount_entered and amount > 0) or name_matches):
                continue
            candidates.append(
                ScheduledPullCandidate(
                    source_type="bill",
                    name=bill.display_name,
                    amount=amount if amount_entered and amount > 0 else 0.0,
                    pull_date=transaction_date,
                    source_ref=bill.source_range or f"bill:{bill.bill_key}",
                    account=bill.account,
                )
            )
    return candidates


def _transaction_local_date(transaction: BankTransaction) -> local_date | None:
    raw = transaction.date or transaction.authorized_date
    if not raw:
        return None
    try:
        return local_date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _report_source_type(item: ReconciliationItem, matched: ActionLogCandidate | None) -> str:
    if matched is None:
        return "automatic rule"
    if matched.action_type == "schedule" or matched.action_id.startswith("schedule:"):
        return "schedule"
    if matched.action_type == "group":
        return "spreadsheet group"
    return "spreadsheet row"


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
        access_token = self.store.get_access_token(item.id, owner_key=item.owner_key)
        cursor = self.store.get_cursor(item.id)
        total_added = 0
        total_modified = 0
        total_removed = 0
        has_more = True
        latest_cursor = cursor

        try:
            if self.config.plaid_webhook_url:
                try:
                    await self.plaid.update_item_webhook(access_token, self.config.plaid_webhook_url)
                except Exception:
                    logger.warning(
                        "Failed to update Plaid item webhook; continuing transaction sync",
                        extra={"item_id": item.id},
                        exc_info=True,
                    )
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

    def receive_plaid_webhook(self, payload: dict[str, Any]):
        return self.store.enqueue_plaid_webhook(payload)

    async def process_plaid_webhook_inbox(self, limit: int = 25) -> dict[str, int]:
        self.store.initialize()
        processed = 0
        failed = 0
        skipped = 0
        for event, payload in self.store.pending_plaid_webhook_events(limit=limit):
            self.store.mark_plaid_webhook_processing(event.id)
            item_id = event.item_id or str(payload.get("item_id") or "").strip() or None
            try:
                webhook_type = (event.webhook_type or "").upper()
                webhook_code = (event.webhook_code or "").upper()
                if webhook_type != "TRANSACTIONS":
                    skipped += 1
                    self.store.mark_plaid_webhook_processed(event.id, item_id)
                    continue
                if webhook_code not in {
                    "SYNC_UPDATES_AVAILABLE",
                    "DEFAULT_UPDATE",
                    "HISTORICAL_UPDATE",
                    "INITIAL_UPDATE",
                }:
                    skipped += 1
                    self.store.mark_plaid_webhook_processed(event.id, item_id)
                    continue
                if not item_id:
                    skipped += 1
                    self.store.mark_plaid_webhook_processed(event.id, item_id)
                    continue
                item = self.store.get_item_by_provider_item_id(item_id)
                if item is None:
                    raise RuntimeError(f"Unknown Plaid item_id {item_id}")
                await self.sync_item(item)
                self.store.mark_plaid_webhook_processed(event.id, item_id)
                processed += 1
            except Exception as exc:
                failed += 1
                self.store.mark_plaid_webhook_failed(event.id, f"{type(exc).__name__}: {exc}")
                logger.warning(
                    "Failed to process Plaid webhook event",
                    extra={"event_id": event.id, "item_id": item_id, "exception": str(exc)},
                    exc_info=True,
                )
        return {"processed": processed, "failed": failed, "skipped": skipped}

    def status(self) -> BankStatus:
        return self.store.status(configured=self.config.configured, plaid_env=self.config.plaid_env)

    def linked_items(self, owner_key: str) -> list[LinkedBankItem]:
        return self.store.list_items(owner_key=owner_key)

    def accounts(self, owner_key: str) -> list[BankAccount]:
        return self.store.list_accounts(owner_key)

    def set_account_watched(self, owner_key: str, account_db_id: int, watched: bool) -> BankAccount | None:
        return self.store.set_account_watched(owner_key, account_db_id, watched)

    def disconnect_item(self, owner_key: str, item_db_id: int) -> LinkedBankItem | None:
        return self.store.disconnect_item(owner_key, item_db_id)

    async def remove_item_from_plaid(self, owner_key: str, item_db_id: int) -> LinkedBankItem | None:
        item = self.store.get_item(owner_key, item_db_id)
        if item is None:
            return None
        if item.status == "active":
            access_token = self.store.get_access_token(item.id, owner_key=item.owner_key)
            await self.plaid.remove_item(access_token)
        return self.store.disconnect_item(owner_key, item_db_id)

    def purge_disconnected_item(self, owner_key: str, item_db_id: int) -> dict[str, int] | None:
        return self.store.purge_disconnected_item(owner_key, item_db_id)

    def purge_transactions_before(self, owner_key: str, cutoff_date: str) -> dict[str, int | str]:
        return self.store.purge_transactions_before(owner_key, cutoff_date)

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

    def unresolved_reconciliation_items(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        max_age_days: int | None = None,
        start_date: str | None = None,
    ) -> list:
        if max_age_days is None and start_date is None:
            max_age_days = _reconciliation_max_age_days()
        return self.store.unresolved_reconciliation_items(
            owner_key,
            limit=limit,
            max_age_days=max_age_days,
            start_date=start_date,
        )

    def matched_reconciliation_items(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        max_age_days: int | None = None,
        start_date: str | None = None,
    ) -> list:
        if max_age_days is None and start_date is None:
            max_age_days = _reconciliation_max_age_days()
        return self.store.matched_reconciliation_items(
            owner_key,
            limit=limit,
            max_age_days=max_age_days,
            start_date=start_date,
        )

    def resolved_reconciliation_items(self, owner_key: str, limit: int = 25) -> list:
        return self.store.resolved_reconciliation_items(owner_key, limit=limit)

    def ignore_reconciliation_item(self, owner_key: str, reconciliation_id: int):
        return self.store.ignore_reconciliation_item(owner_key, reconciliation_id)

    def reopen_reconciliation_item(self, owner_key: str, reconciliation_id: int, *, notes: str = "reopened for review"):
        return self.store.reopen_reconciliation_item(owner_key, reconciliation_id, notes=notes)

    def reopen_reconciliation_items_for_action_ids(
        self,
        owner_key: str,
        action_ids: set[str],
        *,
        notes: str = "reopened because matched action changed",
    ):
        return self.store.reopen_reconciliation_items_for_action_ids(owner_key, action_ids, notes=notes)

    def get_reconciliation_item(self, owner_key: str, reconciliation_id: int):
        return self.store.get_reconciliation_item(owner_key, reconciliation_id)

    def confirm_reconciliation_item(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        matched_action_log_id: str | None = None,
        matched_sheet_ref: str | None = None,
        notes: str = "logged from bank review",
    ):
        return self.store.confirm_reconciliation_item(
            owner_key,
            reconciliation_id,
            matched_action_log_id=matched_action_log_id,
            matched_sheet_ref=matched_sheet_ref,
            notes=notes,
        )

    def reconciliation_match_candidates(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        actor_key: str,
        fallback: bool = False,
        limit: int = 10,
    ) -> tuple[ReconciliationItem | None, list[ActionLogCandidate], list[ActionLogCandidateGroup]]:
        item = self.get_reconciliation_item(owner_key, reconciliation_id)
        if item is None:
            return None, [], []
        action_log = read_active_logged_actions(actor_key)
        excluded = self.store.matched_action_log_ids(owner_key)
        schedule_candidates = find_scheduled_pull_candidates(
            item.transaction,
            _scheduled_pulls_for_transactions([item.transaction], actor_key=actor_key),
            window_days=14 if fallback else 7,
            limit=limit,
        )
        if fallback:
            action_candidates = recent_action_log_candidates(
                item.transaction,
                action_log,
                excluded_action_ids=excluded,
                days_back=30,
                limit=limit,
            )
            candidates = [*schedule_candidates, *action_candidates][: max(1, limit)]
            groups: list[ActionLogCandidateGroup] = []
        else:
            action_candidates = find_action_log_candidates(
                item.transaction,
                action_log,
                classification=item.classification,
                excluded_action_ids=excluded,
                window_days=7,
                limit=limit,
            )
            candidates = [*schedule_candidates, *action_candidates][: max(1, limit)]
            groups = find_action_log_candidate_groups(
                item.transaction,
                action_log,
                classification=item.classification,
                excluded_action_ids=excluded,
                window_days=7,
                max_group_size=4,
                limit=5,
            )
        return item, candidates, groups

    def reconciliation_schedule_debug(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        actor_key: str,
    ) -> str:
        clear_schedule_source_cache(actor_key)
        item = self.get_reconciliation_item(owner_key, reconciliation_id)
        if item is None:
            return f"No bank reconciliation item `{reconciliation_id}` was found."

        transaction = item.transaction
        transaction_date = _transaction_local_date(transaction)
        subscriptions, bills_with_amounts = _schedule_sources_for_actor(actor_key)
        pulls = _scheduled_pulls_for_transactions([transaction], actor_key=actor_key)
        candidates = find_scheduled_pull_candidates(transaction, pulls, window_days=14, limit=25)

        lines = [
            "Bank schedule candidate debug:",
            "```text",
            f"ID:     {item.id}",
            f"Date:   {transaction.date or transaction.authorized_date or 'unknown'}",
            f"Amount: ${abs(transaction.amount):.2f}",
            f"Name:   {transaction.merchant_name or transaction.name}",
            "```",
            f"Loaded schedules: `{len(subscriptions)}` subscription(s), `{len(bills_with_amounts)}` bill(s).",
        ]
        if bills_with_amounts:
            lines.extend(["", "Bills loaded:", "```text"])
            lines.append(f"{'Bill':<18} {'Amt':>9} {'Day':>3} {'Months':<9} {'Name':<4} {'Next'}")
            lines.append("-" * 58)
            for bill, amount_entered, amount in bills_with_amounts[:20]:
                amount_text = f"${amount:.2f}" if amount_entered else "missing"
                name_match = "yes" if _bill_name_matches_transaction(bill.display_name, transaction) else "no"
                next_from_tx = next_bill_pull_date(bill, transaction_date) if transaction_date is not None else None
                months = ",".join(str(month) for month in bill.pull_months) if bill.pull_months else "-"
                lines.append(
                    f"{bill.display_name[:18]:<18} {amount_text:>9} {bill.pull_day:>3} "
                    f"{months:<9} {name_match:<4} {next_from_tx or 'none'}"
                )
            lines.append("```")
        if pulls:
            lines.extend(["", "Scheduled pulls generated for this bank item:", "```text"])
            for pull in pulls[:25]:
                lines.append(
                    f"{pull.source_type[:4]:<4} {pull.pull_date.isoformat()} "
                    f"${pull.amount:.2f} {pull.name[:28]}"
                )
            lines.append("```")
        else:
            lines.extend(["", "Scheduled pulls generated for this bank item: `0`"])
        if pulls:
            lines.extend(["", "Schedule scoring:", "```text"])
            lines.extend(_scheduled_pull_debug_rows(transaction, pulls, 14))
            lines.append("```")
        if candidates:
            lines.extend(["", "Final schedule candidates:", "```text"])
            for candidate in candidates[:25]:
                lines.append(
                    f"{candidate.date.isoformat()} ${candidate.amount:.2f} "
                    f"{candidate.confidence:.2f} {candidate.label[:30]}"
                )
            lines.append("```")
        else:
            lines.extend(["", "Final schedule candidates: `0`"])
        return "\n".join(lines)[:1900]

    def reconciliation_report_matches(
        self,
        owner_key: str,
        items: list[ReconciliationItem],
        *,
        actor_key: str | None,
        limit: int = 100,
    ) -> list[ReconciliationReportMatch]:
        del owner_key
        matched_items = [
            item for item in items if item.status in {"matched", "confirmed", "import_requested"}
        ][: max(1, limit)]
        if not matched_items:
            return []

        action_candidates: dict[str, ActionLogCandidate] = {}
        if actor_key:
            for logged in read_active_logged_actions(actor_key):
                candidate = action_log_candidate_by_id(logged)
                if candidate is not None:
                    action_candidates[logged.id] = candidate

        scheduled_pulls = _scheduled_pulls_for_transactions(
            [item.transaction for item in matched_items],
            actor_key=actor_key,
            window_days=14,
        )

        report: list[ReconciliationReportMatch] = []
        for item in matched_items:
            matched = self._matched_report_candidate(item, action_candidates, scheduled_pulls)
            transaction = item.transaction
            report.append(
                ReconciliationReportMatch(
                    reconciliation_id=item.id,
                    bank_date=transaction.date or transaction.authorized_date or "unknown",
                    bank_name=transaction.merchant_name or transaction.name,
                    bank_amount=abs(transaction.amount),
                    matched_date=matched.date.isoformat() if matched else None,
                    matched_name=matched.label if matched else None,
                    matched_amount=matched.amount if matched else None,
                    source_type=_report_source_type(item, matched),
                    reason=item.notes or "automatic reconciliation rule",
                    confidence=item.confidence,
                )
            )
        return report

    def _matched_report_candidate(
        self,
        item: ReconciliationItem,
        action_candidates: dict[str, ActionLogCandidate],
        scheduled_pulls: list[ScheduledPullCandidate],
    ) -> ActionLogCandidate | None:
        if item.matched_action_log_id:
            action_ids = [part.strip() for part in item.matched_action_log_id.split("+") if part.strip()]
            candidates = [action_candidates[action_id] for action_id in action_ids if action_id in action_candidates]
            if len(candidates) == 1:
                return candidates[0]
            if len(candidates) > 1:
                return ActionLogCandidate(
                    action_id="+".join(candidate.action_id for candidate in candidates),
                    sheet_ref=" + ".join(candidate.sheet_ref for candidate in candidates),
                    action_type="group",
                    date=min(candidate.date for candidate in candidates),
                    amount=sum(candidate.amount for candidate in candidates),
                    label=" + ".join(candidate.label for candidate in candidates),
                    confidence=sum(candidate.confidence for candidate in candidates) / len(candidates),
                    notes="grouped spreadsheet rows",
                )

        if item.matched_sheet_ref:
            candidates = find_scheduled_pull_candidates(
                item.transaction,
                scheduled_pulls,
                window_days=14,
                limit=25,
            )
            return next(
                (candidate for candidate in candidates if candidate.sheet_ref == item.matched_sheet_ref),
                None,
            )
        return None

    def confirm_reconciliation_schedule_match(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        actor_key: str,
        schedule_ref: str,
    ) -> tuple[ReconciliationItem | None, ActionLogCandidate | None, str]:
        item = self.get_reconciliation_item(owner_key, reconciliation_id)
        if item is None:
            return None, None, "not_found"
        if item.status not in {"needs_review", "pending_user", "conflict", "matched"}:
            return item, None, "not_unresolved"
        if item.transaction.pending:
            return item, None, "pending_transaction"

        candidates = find_scheduled_pull_candidates(
            item.transaction,
            _scheduled_pulls_for_transactions([item.transaction], actor_key=actor_key),
            window_days=14,
            limit=25,
        )
        candidate = next((candidate for candidate in candidates if candidate.sheet_ref == schedule_ref), None)
        if candidate is None:
            return item, None, "schedule_not_found"
        if round(candidate.amount * 100) != round(abs(item.transaction.amount) * 100):
            return item, candidate, "amount_mismatch"

        confirmed = self.confirm_reconciliation_item(
            owner_key,
            reconciliation_id,
            matched_sheet_ref=candidate.sheet_ref,
            notes=f"matched {candidate.label}",
        )
        return confirmed, candidate, "matched"

    def confirm_reconciliation_action_match(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        actor_key: str,
        action_id: str,
    ) -> tuple[ReconciliationItem | None, ActionLogCandidate | None, str]:
        item = self.get_reconciliation_item(owner_key, reconciliation_id)
        if item is None:
            return None, None, "not_found"
        if item.status not in {"needs_review", "pending_user", "conflict", "matched"}:
            return item, None, "not_unresolved"
        if item.transaction.pending:
            return item, None, "pending_transaction"

        excluded = self.store.matched_action_log_ids(owner_key)
        if action_id in excluded and item.matched_action_log_id != action_id:
            return item, None, "already_matched"

        action_by_id = {logged.id: logged for logged in read_active_logged_actions(actor_key)}
        logged = action_by_id.get(action_id)
        if logged is None:
            return item, None, "action_not_found"
        candidate = action_log_candidate_by_id(logged)
        if candidate is None:
            return item, None, "action_not_reconcilable"

        bank_amount = abs(item.transaction.amount)
        if round(candidate.amount * 100) != round(bank_amount * 100):
            success, detail = update_recent_action(
                actor_key,
                updates={"amount": f"{bank_amount:.2f}"},
                action_id=candidate.action_id,
                metadata_extra={
                    "origin": "bank_reconciliation",
                    "bank_reconciliation_id": str(reconciliation_id),
                },
            )
            if not success:
                return item, candidate, f"amount_update_failed: {detail}"
            updated_logged = {entry.id: entry for entry in read_active_logged_actions(actor_key)}.get(action_id)
            updated_candidate = action_log_candidate_by_id(updated_logged) if updated_logged else None
            if updated_candidate is not None:
                candidate = updated_candidate
            update_status = "matched_updated"
        else:
            update_status = "matched"

        confirmed = self.confirm_reconciliation_item(
            owner_key,
            reconciliation_id,
            matched_action_log_id=candidate.action_id,
            matched_sheet_ref=candidate.sheet_ref,
            notes="matched existing sheet/action-log row",
        )
        return confirmed, candidate, update_status

    def revert_reconciliation_item(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        actor_key: str,
        undo_sheet_action: bool = False,
    ) -> tuple[ReconciliationItem | None, list[str], str]:
        item = self.get_reconciliation_item(owner_key, reconciliation_id)
        if item is None:
            return None, [], "not_found"

        details: list[str] = []
        if undo_sheet_action:
            details.extend(self._undo_reconciliation_sheet_actions(item, actor_key=actor_key))

        reopened = self.reopen_reconciliation_item(owner_key, reconciliation_id)
        return reopened, details, "reopened"

    def _undo_reconciliation_sheet_actions(self, item: ReconciliationItem, *, actor_key: str) -> list[str]:
        action_log = read_active_logged_actions(actor_key)
        action_by_id = {logged.id: logged for logged in action_log}
        details: list[str] = []

        matched_ids = [
            part.strip()
            for part in (item.matched_action_log_id or "").split("+")
            if part.strip()
        ]
        update_ids = [
            logged.id
            for logged in reversed(action_log)
            if logged.action.metadata.get("origin") == "bank_reconciliation"
            and logged.action.metadata.get("bank_reconciliation_id") == str(item.id)
            and logged.action.metadata.get("type") == "update"
        ]
        if not update_ids and matched_ids:
            update_ids = [
                logged.id
                for logged in reversed(action_log)
                if logged.action.metadata.get("type") == "update"
                and logged.action.metadata.get("updated_action_id") in matched_ids
            ][:1]
        for action_id in update_ids:
            success, detail = undo_logged_action(actor_key, action_id)
            details.append(("Undid amount update: " if success else "Could not undo amount update: ") + detail)

        logged_match_ids = [
            action_id
            for action_id in matched_ids
            if action_id in action_by_id
            and action_by_id[action_id].action.metadata.get("origin") == "bank_reconciliation"
        ]
        if not logged_match_ids and "logged as " in (item.notes or "").lower():
            sheet_action = _find_action_for_sheet_ref(action_log, item.matched_sheet_ref)
            if sheet_action is not None:
                logged_match_ids = [sheet_action.id]

        for action_id in logged_match_ids:
            success, detail = delete_recent_action(actor_key, action_id=action_id)
            details.append(("Deleted logged sheet row: " if success else "Could not delete logged sheet row: ") + detail)

        if not details:
            details.append("No BookieBot-created sheet action was found to undo.")
        return details

    def confirm_reconciliation_action_group_match(
        self,
        owner_key: str,
        reconciliation_id: int,
        *,
        actor_key: str,
        action_ids: list[str],
        adjust_action_id: str | None = None,
    ) -> tuple[ReconciliationItem | None, list[ActionLogCandidate], str]:
        item = self.get_reconciliation_item(owner_key, reconciliation_id)
        if item is None:
            return None, [], "not_found"
        if item.status not in {"needs_review", "pending_user", "conflict", "matched"}:
            return item, [], "not_unresolved"
        if item.transaction.pending:
            return item, [], "pending_transaction"

        cleaned_ids = [action_id.strip() for action_id in action_ids if action_id.strip()]
        if len(cleaned_ids) < 2:
            return item, [], "too_few"
        if len(set(cleaned_ids)) != len(cleaned_ids):
            return item, [], "duplicate"

        excluded = self.store.matched_action_log_ids(owner_key)
        already_matched = [action_id for action_id in cleaned_ids if action_id in excluded]
        if already_matched:
            return item, [], "already_matched"

        action_by_id = {logged.id: logged for logged in read_active_logged_actions(actor_key)}
        candidates: list[ActionLogCandidate] = []
        for action_id in cleaned_ids:
            logged = action_by_id.get(action_id)
            if logged is None:
                return item, candidates, "action_not_found"
            candidate = action_log_candidate_by_id(logged)
            if candidate is None:
                return item, candidates, "action_not_reconcilable"
            candidates.append(candidate)

        total_cents = sum(round(candidate.amount * 100) for candidate in candidates)
        bank_cents = round(abs(item.transaction.amount) * 100)
        if abs(total_cents - bank_cents) > 1:
            adjust_id = (adjust_action_id or "").strip()
            if not adjust_id:
                return item, candidates, "amount_mismatch"
            adjust_candidate = next((candidate for candidate in candidates if candidate.action_id == adjust_id), None)
            if adjust_candidate is None:
                return item, candidates, "adjust_action_not_in_group"
            suggested_cents = round(adjust_candidate.amount * 100) + (bank_cents - total_cents)
            if suggested_cents < 0:
                return item, candidates, "adjustment_negative"
            suggested_amount = suggested_cents / 100
            success, detail = update_recent_action(
                actor_key,
                updates={"amount": f"{suggested_amount:.2f}"},
                action_id=adjust_candidate.action_id,
                metadata_extra={
                    "origin": "bank_reconciliation",
                    "bank_reconciliation_id": str(reconciliation_id),
                    "bank_reconciliation_group_adjustment": "true",
                },
            )
            if not success:
                return item, candidates, f"amount_update_failed: {detail}"

            action_by_id = {logged.id: logged for logged in read_active_logged_actions(actor_key)}
            adjusted_candidates: list[ActionLogCandidate] = []
            for action_id in cleaned_ids:
                logged = action_by_id.get(action_id)
                if logged is None:
                    return item, candidates, "action_not_found_after_adjustment"
                candidate = action_log_candidate_by_id(logged)
                if candidate is None:
                    return item, candidates, "action_not_reconcilable_after_adjustment"
                adjusted_candidates.append(candidate)
            candidates = adjusted_candidates
            total_cents = sum(round(candidate.amount * 100) for candidate in candidates)
            if abs(total_cents - bank_cents) > 1:
                return item, candidates, "amount_mismatch_after_adjustment"
            status = "matched_adjusted"
        else:
            status = "matched"

        match_id = "+".join(candidate.action_id for candidate in candidates)
        sheet_ref = " + ".join(candidate.sheet_ref for candidate in candidates)
        confirmed = self.confirm_reconciliation_item(
            owner_key,
            reconciliation_id,
            matched_action_log_id=match_id,
            matched_sheet_ref=sheet_ref,
            notes=f"matched existing grouped rows totaling ${total_cents / 100:.2f}",
        )
        return confirmed, candidates, status

    def reconciliation_preview(
        self,
        owner_key: str,
        limit: int = 25,
        *,
        force: bool = False,
        actor_key: str | None = None,
        start_date: str | None = None,
    ) -> ReconciliationPreview:
        self.store.initialize()
        cache_buckets = self.store.reconciliation_cache_buckets(owner_key, start_date=start_date)
        cached_transaction_count = cache_buckets.stored
        transactions = self.store.bank_transactions_for_reconciliation(
            owner_key=owner_key,
            limit=limit,
            force=force,
            start_date=start_date,
        )
        action_log = read_active_logged_actions(actor_key) if actor_key else []
        scheduled_pulls = _scheduled_pulls_for_transactions(transactions, actor_key=actor_key)
        used_action_ids = set() if force else set(self.store.matched_action_log_ids(owner_key))
        used_sheet_refs = set() if force else set(self.store.matched_sheet_refs(owner_key))
        items = []
        for transaction in transactions:
            decision = reconcile_transaction(
                transaction,
                action_log,
                scheduled_pulls,
                excluded_action_ids=used_action_ids,
                excluded_sheet_refs=used_sheet_refs,
            )
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
            if decision.matched_action_log_id:
                used_action_ids.update(
                    part.strip()
                    for part in decision.matched_action_log_id.split("+")
                    if part.strip()
                )
            if decision.matched_sheet_ref:
                used_sheet_refs.update(
                    part.strip()
                    for part in decision.matched_sheet_ref.split(" + ")
                    if part.strip()
                )
        return ReconciliationPreview(
            owner_key=owner_key,
            items=items,
            force=force,
            cached_transaction_count=cached_transaction_count,
            candidate_transaction_count=len(transactions),
            cache_buckets=cache_buckets,
        )

    async def _fetch_accounts_for_item(
        self,
        item: LinkedBankItem,
        *,
        access_token: str | None = None,
    ) -> list[BankAccount]:
        token = access_token or self.store.get_access_token(item.id, owner_key=item.owner_key)
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
