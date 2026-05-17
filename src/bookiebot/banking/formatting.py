from __future__ import annotations

from bookiebot.banking.models import BankTransaction


def format_bank_transaction(transaction: BankTransaction) -> str:
    return format_bank_transaction_row(transaction)


def format_bank_transaction_table(transactions: list[BankTransaction]) -> str:
    header = f"{'Date':<10}  {'Type':<7}  {'Amount':>10}  {'Name':<26}  Account"
    divider = "-" * len(header)
    rows = [format_bank_transaction_row(transaction, code_wrap=False) for transaction in transactions]
    return "```text\n" + "\n".join([header, divider, *rows]) + "\n```"


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


def _clip(value: str, width: int) -> str:
    text = str(value)
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "~"
