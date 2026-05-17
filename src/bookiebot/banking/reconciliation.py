from __future__ import annotations

import re

from bookiebot.banking.models import (
    BankTransaction,
    ReconciliationClassification,
    ReconciliationStatus,
)


TRANSFER_PATTERNS = (
    "ach electronic credit",
    "credit card",
    "payment",
    "transfer",
    "xfer",
    "cd deposit",
    "deposit .initial",
    "savings",
    "money market",
)

PAYROLL_PATTERNS = (
    "payroll",
    "paycheck",
    "direct dep",
    "direct deposit",
    "salary",
    "sonic",
    "insurity",
)

INTEREST_PATTERNS = (
    "intrst",
    "interest",
)

SUBSCRIPTION_PATTERNS = (
    "netflix",
    "spotify",
    "apple",
    "icloud",
    "chatgpt",
    "openai",
    "xfinity",
    "recology",
    "pge",
    "pg&e",
    "utility",
)


def classify_transaction(transaction: BankTransaction) -> tuple[ReconciliationClassification, ReconciliationStatus, float, str]:
    text = _normalized_text(transaction)

    if transaction.pending:
        return "needs_review", "needs_review", 0.40, "pending transaction"

    if _contains_any(text, TRANSFER_PATTERNS):
        return "transfer_or_payment", "matched", 0.95, "transfer/payment pattern"

    if transaction.amount > 0 and _contains_any(text, SUBSCRIPTION_PATTERNS):
        return "subscription_or_bill", "needs_review", 0.75, "possible subscription or bill"

    if transaction.amount < 0:
        if _contains_any(text, PAYROLL_PATTERNS):
            return "income", "needs_review", 0.80, "possible income deposit"
        if _contains_any(text, INTEREST_PATTERNS):
            return "income", "needs_review", 0.65, "interest income"
        return "refund_or_credit", "needs_review", 0.65, "inflow without payroll pattern"

    if transaction.amount > 0:
        return "expense", "needs_review", 0.60, "outflow transaction"

    return "needs_review", "needs_review", 0.20, "unclassified transaction"


def _normalized_text(transaction: BankTransaction) -> str:
    parts = [
        transaction.name,
        transaction.merchant_name or "",
        transaction.account_name or "",
        transaction.account_type or "",
        transaction.account_subtype or "",
    ]
    text = " ".join(parts).lower()
    return re.sub(r"\s+", " ", text).strip()


def _contains_any(text: str, patterns: tuple[str, ...]) -> bool:
    return any(pattern in text for pattern in patterns)

