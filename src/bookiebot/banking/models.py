from __future__ import annotations

from dataclasses import dataclass


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
