from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


ReconciliationClassification = Literal[
    "expense",
    "income",
    "subscription_or_bill",
    "transfer_or_payment",
    "refund_or_credit",
    "ignore",
    "needs_review",
]

ReconciliationStatus = Literal[
    "matched",
    "needs_review",
    "pending_user",
    "confirmed",
    "import_requested",
    "ignored",
    "conflict",
]


@dataclass(frozen=True)
class LinkedBankItem:
    id: int
    owner_key: str
    provider: str
    item_id: str
    institution_name: str | None
    status: str


@dataclass(frozen=True)
class BankAccount:
    item_id: int
    provider_account_id: str
    owner_key: str
    name: str
    mask: str | None
    type: str | None
    subtype: str | None
    official_name: str | None
    current_balance: float | None
    available_balance: float | None
    id: int | None = None
    watched: bool = True


@dataclass(frozen=True)
class BankTransaction:
    id: int
    provider_transaction_id: str
    owner_key: str
    account_name: str | None
    account_mask: str | None
    account_type: str | None
    account_subtype: str | None
    date: str | None
    authorized_date: str | None
    name: str
    merchant_name: str | None
    amount: float
    pending: bool
    payment_channel: str | None
    updated_at: str
    pending_transaction_id: str | None = None


@dataclass(frozen=True)
class SyncResult:
    item_id: int
    institution_name: str | None
    added: int = 0
    modified: int = 0
    removed: int = 0
    accounts: int = 0
    has_more: bool = False


@dataclass(frozen=True)
class BankStatus:
    configured: bool
    plaid_env: str
    sqlite_path: str
    item_count: int
    account_count: int
    transaction_count: int
    last_success_at: str | None
    last_error: str | None


@dataclass(frozen=True)
class ReconciliationItem:
    id: int
    owner_key: str
    bank_transaction_id: int
    provider_transaction_id: str
    classification: ReconciliationClassification
    status: ReconciliationStatus
    confidence: float
    matched_action_log_id: str | None
    matched_sheet_ref: str | None
    first_seen_at: str
    last_seen_at: str
    resolved_at: str | None
    ignored_at: str | None
    notes: str | None
    transaction: BankTransaction


@dataclass(frozen=True)
class ReconciliationCacheBuckets:
    stored: int = 0
    needs_review: int = 0
    matched: int = 0
    confirmed: int = 0
    ignored: int = 0
    pending: int = 0
    not_reviewed: int = 0
    unwatched: int = 0
    other: int = 0


@dataclass(frozen=True)
class ReconciliationPreview:
    owner_key: str
    items: list[ReconciliationItem]
    force: bool = False
    cached_transaction_count: int = 0
    candidate_transaction_count: int = 0
    cache_buckets: ReconciliationCacheBuckets = ReconciliationCacheBuckets()


@dataclass(frozen=True)
class PlaidWebhookEvent:
    id: int
    item_id: str | None
    webhook_type: str | None
    webhook_code: str | None
    status: str
    received_at: str
    processed_at: str | None
    error: str | None
