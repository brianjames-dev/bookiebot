from __future__ import annotations

from collections import defaultdict

from bookiebot.banking.models import BankTransaction, ReconciliationItem, ReconciliationPreview


CLASSIFICATION_LABELS = {
    "expense": "Expense",
    "income": "Income",
    "subscription_or_bill": "Subscription/Bill",
    "transfer_or_payment": "Transfer/Payment",
    "refund_or_credit": "Refund/Credit",
    "ignore": "Ignored",
    "needs_review": "Needs review",
}


def format_bank_transaction(transaction: BankTransaction) -> str:
    return format_bank_transaction_row(transaction)


def format_bank_transaction_table(transactions: list[BankTransaction]) -> str:
    header = f"{'Date':<10}  {'Type':<7}  {'Amount':>10}  {'Name':<26}  Account"
    divider = "-" * len(header)
    rows = [format_bank_transaction_row(transaction, code_wrap=False) for transaction in transactions]
    return "```text\n" + "\n".join([header, divider, *rows]) + "\n```"


def format_reconciliation_preview(preview: ReconciliationPreview, *, max_chars: int = 1800) -> str:
    if not preview.items:
        return "No unreconciled cached bank transactions found."

    groups: dict[str, list[ReconciliationItem]] = defaultdict(list)
    for item in preview.items:
        groups[item.classification].append(item)

    lines = ["Bank reconciliation preview:"]
    omitted_total = 0
    for classification in (
        "expense",
        "income",
        "subscription_or_bill",
        "refund_or_credit",
        "transfer_or_payment",
        "needs_review",
        "ignore",
    ):
        items = groups.get(classification)
        if not items:
            continue
        section_lines, omitted = _format_reconciliation_section(
            CLASSIFICATION_LABELS[classification],
            items,
            max_chars=max_chars,
            current_chars=len("\n".join(lines)),
        )
        omitted_total += omitted
        if section_lines:
            lines.extend(section_lines)

    if omitted_total:
        lines.append("")
        lines.append(f"...and {omitted_total} more item(s). Use a lower limit or inspect transactions directly.")

    return "\n".join(lines)


def format_bank_transaction_row(transaction: BankTransaction, *, code_wrap: bool = True) -> str:
    date = transaction.date or transaction.authorized_date or "unknown date"
    name = transaction.merchant_name or transaction.name
    account = transaction.account_name or "Unknown account"
    if transaction.account_mask:
        account = f"{account} *{transaction.account_mask}"

    if transaction.amount < 0:
        direction = "in"
        amount = abs(transaction.amount)
    else:
        direction = "out"
        amount = transaction.amount

    if transaction.pending:
        direction = f"{direction}*"

    line = (
        f"{_clip(date, 10):<10}  "
        f"{direction:<7}  "
        f"{f'${amount:.2f}':>10}  "
        f"{_clip(name, 26):<26}  "
        f"{_clip(account, 22)}"
    )
    if code_wrap:
        return f"`{line}`"
    return line


def _format_reconciliation_section(
    label: str,
    items: list[ReconciliationItem],
    *,
    max_chars: int,
    current_chars: int,
) -> tuple[list[str], int]:
    kept: list[ReconciliationItem] = []
    omitted = 0
    for item in items:
        candidate = ["", f"{label}:", _format_reconciliation_table([*kept, item])]
        candidate_text = "\n".join(candidate)
        if current_chars + len(candidate_text) + 80 > max_chars:
            omitted += 1
            continue
        kept.append(item)
    if not kept:
        return [], omitted
    return ["", f"{label}:", _format_reconciliation_table(kept)], omitted


def _format_reconciliation_table(items: list[ReconciliationItem]) -> str:
    header = f"{'Date':<10}  {'Amount':>10}  {'Name':<26}  {'Status':<12}  Note"
    divider = "-" * len(header)
    rows = [_format_reconciliation_row(item) for item in items]
    return "```text\n" + "\n".join([header, divider, *rows]) + "\n```"


def _format_reconciliation_row(item: ReconciliationItem) -> str:
    transaction = item.transaction
    date = transaction.date or transaction.authorized_date or "unknown"
    amount = abs(transaction.amount)
    name = transaction.merchant_name or transaction.name
    return (
        f"{_clip(date, 10):<10}  "
        f"{f'${amount:.2f}':>10}  "
        f"{_clip(name, 26):<26}  "
        f"{_clip(item.status, 12):<12}  "
        f"{_clip(item.notes or '', 24)}"
    )


def _clip(value: str, width: int) -> str:
    text = str(value)
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "~"
