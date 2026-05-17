from __future__ import annotations

from bookiebot.banking.models import BankTransaction


def format_bank_transaction(transaction: BankTransaction) -> str:
    date = transaction.date or transaction.authorized_date or "unknown date"
    name = transaction.merchant_name or transaction.name
    status = " pending" if transaction.pending else ""
    account = transaction.account_name or "Unknown account"
    if transaction.account_mask:
        account = f"{account} *{transaction.account_mask}"

    if transaction.amount < 0:
        direction = "inflow"
        amount = abs(transaction.amount)
        verb = "from"
    else:
        direction = "outflow"
        amount = transaction.amount
        verb = "to"

    return f"`{date} | {direction}{status} | ${amount:.2f} {verb} {name} | {account}`"

