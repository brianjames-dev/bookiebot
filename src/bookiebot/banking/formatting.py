from __future__ import annotations

from collections import defaultdict

from bookiebot.banking.models import BankTransaction, ReconciliationItem, ReconciliationPreview
from bookiebot.banking.reconciliation import ActionLogCandidate, ActionLogCandidateGroup


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


def format_bank_transaction_table_chunks(
    transactions: list[BankTransaction],
    *,
    max_chars: int = 1700,
) -> list[str]:
    header = f"{'Date':<10}  {'Type':<7}  {'Amount':>10}  {'Name':<26}  Account"
    divider = "-" * len(header)
    chunks: list[str] = []
    rows: list[str] = []
    for transaction in transactions:
        row = format_bank_transaction_row(transaction, code_wrap=False)
        candidate = _code_table([header, divider, *rows, row])
        if rows and len(candidate) > max_chars:
            chunks.append(_code_table([header, divider, *rows]))
            rows = [row]
        else:
            rows.append(row)
    if rows or not chunks:
        chunks.append(_code_table([header, divider, *rows]))
    return chunks


def format_reconciliation_preview(preview: ReconciliationPreview, *, max_chars: int = 1800) -> str:
    summary = (
        "Bank reconciliation preview:\n"
        f"- Force: {'yes' if preview.force else 'no'}\n"
        f"- Cached transactions: {preview.cached_transaction_count}\n"
        f"- Candidate transactions: {preview.candidate_transaction_count}"
    )
    if not preview.items:
        if preview.force:
            return summary + "\n\nNo cached bank transactions were available to preview."
        return summary + "\n\nNo unreconciled cached bank transactions found."

    groups: dict[tuple[str, str], list[ReconciliationItem]] = defaultdict(list)
    for item in preview.items:
        groups[(item.classification, _status_group(item))].append(item)

    lines = [summary, ""]
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
        for status_group in ("matched", "needs_review"):
            items = groups.get((classification, status_group))
            if not items:
                continue
            section_lines, omitted = _format_reconciliation_section(
                _section_label(classification, status_group),
                items,
                max_chars=max_chars,
                current_chars=len("\n".join(lines)),
            )
            omitted_total += omitted
            if section_lines:
                lines.extend(section_lines)

    if omitted_total:
        if lines[-1] != "":
            lines.append("")
        lines.append(f"...and {omitted_total} more item(s). Use a lower limit or inspect transactions directly.")

    return "\n".join(lines)


def format_reconciliation_review(items: list[ReconciliationItem]) -> str:
    if not items:
        return "No unresolved bank reconciliation items."
    header = f"{'ID':>4}  {'Date':<5}  {'Amt':>8}  {'Type':<8}  Name"
    divider = "-" * len(header)
    rows = [_format_reconciliation_review_row(item) for item in items]
    return "Unresolved bank reconciliation items:\n```text\n" + "\n".join([header, divider, *rows]) + "\n```"


def format_resolved_reconciliation_review(items: list[ReconciliationItem]) -> str:
    if not items:
        return "No resolved bank reconciliation items."
    header = f"{'ID':>4}  {'Date':<5}  {'Amt':>8}  {'Status':<9}  {'Action':<10}  Name"
    divider = "-" * len(header)
    rows = [_format_resolved_reconciliation_review_row(item) for item in items]
    return "Resolved bank reconciliation items:\n```text\n" + "\n".join([header, divider, *rows]) + "\n```"


def format_reconciliation_detail(
    item: ReconciliationItem,
    candidates: list[ActionLogCandidate],
    groups: list[ActionLogCandidateGroup] | None = None,
    *,
    fallback: bool = False,
    include_commands: bool = True,
) -> str:
    transaction = item.transaction
    title = "Recent 30-day fallback matches" if fallback else "Possible matches"
    lines = [
        "Bank reconciliation item:",
        "```text",
        f"ID:      {item.id}",
        f"Date:    {transaction.date or transaction.authorized_date or 'unknown'}",
        f"Amount:  ${abs(transaction.amount):.2f}",
        f"Flow:    {_transaction_flow_label(transaction)}",
        f"Type:    {item.classification}",
        f"Name:    {transaction.merchant_name or transaction.name}",
        f"Account: {_format_account(transaction)}",
        "```",
        f"{title}:",
    ]
    if not candidates:
        lines.append("No candidate sheet/action-log rows found.")
    else:
        lines.append(_format_action_candidate_table(candidates))
    if groups:
        lines.extend(["", "Possible grouped matches:"])
        if not include_commands:
            lines.append("BookieBot found existing sheet rows that add up to this bank transaction.")
            lines.append(_format_guided_action_candidate_groups(groups))
        else:
            lines.append(_format_action_candidate_group_table(groups, show_action_ids=True))
    if include_commands:
        lines.extend(
            [
                "",
                "Resolve with:",
                f"`/debug_bank_match reconciliation_id:{item.id} action_id:<id>`",
                f"`/debug_bank_match_group reconciliation_id:{item.id} action_ids:<id1,id2>`",
                f"`/debug_bank_review_detail reconciliation_id:{item.id} fallback:true`",
                f"`/debug_bank_log_expense reconciliation_id:{item.id} ...`",
                f"`/debug_bank_ignore reconciliation_id:{item.id}`",
            ]
        )
    else:
        lines.extend(["", "Use the buttons below to resolve this item."])
    return "\n".join(lines)


def format_group_match_amount_mismatch(
    item: ReconciliationItem,
    candidates: list[ActionLogCandidate],
) -> str:
    bank_amount = abs(item.transaction.amount)
    selected_total = sum(candidate.amount for candidate in candidates)
    difference = bank_amount - selected_total
    lines = [
        "Group total does not exactly match the bank transaction.",
        f"Bank: `${bank_amount:.2f}`",
        f"Selected rows: `${selected_total:.2f}`",
        f"Difference: `${difference:+.2f}`",
        "",
        "Selected sheet rows:",
        _format_group_mismatch_table(candidates),
        "",
        "Update one row, then run the group match again:",
    ]
    for candidate in candidates:
        suggested_amount = candidate.amount + difference
        if suggested_amount < 0:
            continue
        lines.append(
            f"`/debug_bank_update_action_amount action_id:{candidate.action_id} amount:{suggested_amount:.2f}`"
        )
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


def _format_action_candidate_table(candidates: list[ActionLogCandidate]) -> str:
    header = f"{'Action ID':<9}  {'Date':<5}  {'Amt':>8}  {'Type':<7}  {'Conf':>4}  Label"
    divider = "-" * len(header)
    rows = []
    for candidate in candidates:
        rows.append(
            f"{candidate.action_id:<9}  "
            f"{_short_date(candidate.date.isoformat()):<5}  "
            f"{_short_money(candidate.amount):>8}  "
            f"{_clip(candidate.action_type, 7):<7}  "
            f"{candidate.confidence:.2f}  "
            f"{_clip(candidate.label, 28)}"
        )
    return _code_table([header, divider, *rows])


def _format_action_candidate_group_table(
    groups: list[ActionLogCandidateGroup],
    *,
    show_action_ids: bool = True,
) -> str:
    if show_action_ids:
        header = f"{'Action IDs':<21}  {'Total':>8}  {'Conf':>4}  Rows"
    else:
        header = f"{'Choice':<6}  {'Total':>8}  {'Conf':>4}  Rows"
    divider = "-" * len(header)
    rows = []
    for index, group in enumerate(groups, start=1):
        ids = ",".join(candidate.action_id for candidate in group.candidates)
        labels = " + ".join(_clip(candidate.label, 14) for candidate in group.candidates)
        if show_action_ids:
            rows.append(
                f"{_clip(ids, 21):<21}  "
                f"{_short_money(group.total_amount):>8}  "
                f"{group.confidence:.2f}  "
                f"{_clip(labels, 30)}"
            )
        else:
            rows.append(
                f"{index:<6}  "
                f"{_short_money(group.total_amount):>8}  "
                f"{group.confidence:.2f}  "
                f"{_clip(labels, 30)}"
            )
    return _code_table([header, divider, *rows])


def _format_guided_action_candidate_groups(groups: list[ActionLogCandidateGroup]) -> str:
    lines: list[str] = []
    for index, group in enumerate(groups[:5], start=1):
        lines.append(f"Choice {index}: {_short_money(group.total_amount)} total, {group.confidence:.2f} confidence")
        for candidate in group.candidates:
            lines.append(
                f"  - {_short_date(candidate.date.isoformat())}  "
                f"{_short_money(candidate.amount):>8}  "
                f"{_clip(candidate.label, 46)}"
            )
        if index != min(len(groups), 5):
            lines.append("")
    return _code_table(lines)


def _format_group_mismatch_table(candidates: list[ActionLogCandidate]) -> str:
    header = f"{'Action ID':<9}  {'Date':<5}  {'Amt':>8}  {'Row':<14}  Label"
    divider = "-" * len(header)
    rows = []
    for candidate in candidates:
        rows.append(
            f"{candidate.action_id:<9}  "
            f"{_short_date(candidate.date.isoformat()):<5}  "
            f"{_short_money(candidate.amount):>8}  "
            f"{_clip(candidate.sheet_ref, 14):<14}  "
            f"{_clip(candidate.label, 24)}"
        )
    return _code_table([header, divider, *rows])


def _format_account(transaction: BankTransaction) -> str:
    account = transaction.account_name or "Unknown account"
    if transaction.account_mask:
        account = f"{account} *{transaction.account_mask}"
    return account


def _transaction_flow_label(transaction: BankTransaction) -> str:
    if transaction.amount < 0:
        return "Money in / refund"
    return "Money out / charge"


def _code_table(lines: list[str]) -> str:
    return "```text\n" + "\n".join(lines) + "\n```"


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
        candidate = [f"{label}:", _format_reconciliation_table([*kept, item])]
        candidate_text = "\n".join(candidate)
        if current_chars + len(candidate_text) + 80 > max_chars:
            omitted += 1
            continue
        kept.append(item)
    if not kept:
        return [], omitted
    return [f"{label}:", _format_reconciliation_table(kept)], omitted


def _format_reconciliation_table(items: list[ReconciliationItem]) -> str:
    header = f"{'Date':<5}  {'Amt':>8}  Name"
    divider = "-" * len(header)
    rows = [_format_reconciliation_row(item) for item in items]
    return "```text\n" + "\n".join([header, divider, *rows]) + "\n```"


def _format_reconciliation_row(item: ReconciliationItem) -> str:
    transaction = item.transaction
    date = transaction.date or transaction.authorized_date or "unknown"
    amount = abs(transaction.amount)
    name = transaction.merchant_name or transaction.name
    return (
        f"{_short_date(date):<5}  "
        f"{_short_money(amount):>8}  "
        f"{_clip(name, 26)}"
    )


def _format_reconciliation_review_row(item: ReconciliationItem) -> str:
    transaction = item.transaction
    date = transaction.date or transaction.authorized_date or "unknown"
    amount = abs(transaction.amount)
    name = transaction.merchant_name or transaction.name
    return (
        f"{item.id:>4}  "
        f"{_short_date(date):<5}  "
        f"{_short_money(amount):>8}  "
        f"{_clip(item.classification, 8):<8}  "
        f"{_clip(name, 24)}"
    )


def _format_resolved_reconciliation_review_row(item: ReconciliationItem) -> str:
    transaction = item.transaction
    date = transaction.date or transaction.authorized_date or "unknown"
    amount = abs(transaction.amount)
    name = transaction.merchant_name or transaction.name
    action = item.matched_action_log_id or item.matched_sheet_ref or ""
    return (
        f"{item.id:>4}  "
        f"{_short_date(date):<5}  "
        f"{_short_money(amount):>8}  "
        f"{_clip(item.status, 9):<9}  "
        f"{_clip(action, 10):<10}  "
        f"{_clip(name, 24)}"
    )


def _status_group(item: ReconciliationItem) -> str:
    return "matched" if item.status == "matched" and item.matched_action_log_id else "needs_review"


def _section_label(classification: str, status_group: str) -> str:
    label = CLASSIFICATION_LABELS[classification]
    if status_group == "matched":
        return f"Matched {label}"
    return f"Unmatched {label}"


def _short_date(value: str) -> str:
    if len(value) >= 10 and value[4] == "-" and value[7] == "-":
        return value[5:10]
    return _clip(value, 5)


def _short_money(amount: float) -> str:
    text = f"${amount:.2f}"
    if len(text) <= 8:
        return text
    if amount >= 1000:
        compact = f"${amount / 1000:.1f}k"
        if len(compact) <= 8:
            return compact
    return _clip(text, 8)


def _compact_note(value: str) -> str:
    normalized = value.replace("_", " ").strip().lower()
    if "outflow transaction" in normalized:
        return "expense"
    if "inflow without payroll" in normalized:
        return "credit"
    if "transfer/payment" in normalized:
        return "transfer"
    if "interest income" in normalized:
        return "interest"
    if "possible income" in normalized:
        return "income?"
    if "subscription" in normalized or "bill" in normalized:
        return "bill/sub"
    if "pending" in normalized:
        return "pending"
    return _clip(normalized, 10)


def _clip(value: str, width: int) -> str:
    text = str(value)
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "~"
