from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import re
from typing import Iterable

from bookiebot.banking.models import (
    BankTransaction,
    ReconciliationClassification,
    ReconciliationStatus,
)
from bookiebot.sheets.undo import LoggedAction


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


@dataclass(frozen=True)
class ActionLogMatch:
    action_id: str
    sheet_ref: str
    confidence: float
    notes: str


@dataclass(frozen=True)
class ActionLogCandidate:
    action_id: str
    sheet_ref: str
    action_type: str
    date: date
    amount: float
    label: str
    confidence: float
    notes: str


@dataclass(frozen=True)
class ActionLogCandidateGroup:
    group_id: str
    candidates: tuple[ActionLogCandidate, ...]
    total_amount: float
    confidence: float
    notes: str


@dataclass(frozen=True)
class ScheduledPullCandidate:
    source_type: str
    name: str
    amount: float
    pull_date: date
    source_ref: str
    account: str = ""


@dataclass(frozen=True)
class ReconciliationDecision:
    classification: ReconciliationClassification
    status: ReconciliationStatus
    confidence: float
    notes: str
    matched_action_log_id: str | None = None
    matched_sheet_ref: str | None = None


def classify_transaction(transaction: BankTransaction) -> tuple[ReconciliationClassification, ReconciliationStatus, float, str]:
    transaction_text = _normalized_transaction_text(transaction)

    if transaction.pending:
        return "needs_review", "needs_review", 0.40, "pending transaction"

    if _contains_any(transaction_text, TRANSFER_PATTERNS):
        # Keep the transfer/payment classification, but do not auto-clear from review.
        # Broad substrings like "payment" / "transfer" can appear on real expenses.
        return "transfer_or_payment", "needs_review", 0.85, "transfer/payment pattern"

    if transaction.amount > 0 and _contains_any(transaction_text, SUBSCRIPTION_PATTERNS):
        return "subscription_or_bill", "needs_review", 0.75, "possible subscription or bill"

    if transaction.amount < 0:
        if _contains_any(transaction_text, PAYROLL_PATTERNS):
            return "income", "needs_review", 0.80, "possible income deposit"
        if _contains_any(transaction_text, INTEREST_PATTERNS):
            return "income", "needs_review", 0.65, "interest income"
        return "refund_or_credit", "needs_review", 0.65, "inflow without payroll pattern"

    if transaction.amount > 0:
        return "expense", "needs_review", 0.60, "outflow transaction"

    return "needs_review", "needs_review", 0.20, "unclassified transaction"


def reconcile_transaction(
    transaction: BankTransaction,
    action_log: Iterable[LoggedAction] = (),
    scheduled_pulls: Iterable[ScheduledPullCandidate] = (),
    excluded_action_ids: set[str] | None = None,
    excluded_sheet_refs: set[str] | None = None,
) -> ReconciliationDecision:
    classification, status, confidence, notes = classify_transaction(transaction)
    match = match_action_log(
        transaction,
        action_log,
        classification,
        excluded_action_ids=excluded_action_ids,
    )
    if match:
        return ReconciliationDecision(
            classification=_matched_classification(classification, match.notes),
            status="matched",
            confidence=max(confidence, match.confidence),
            notes=match.notes,
            matched_action_log_id=match.action_id,
            matched_sheet_ref=match.sheet_ref,
        )
    scheduled_match = match_scheduled_pull(
        transaction,
        scheduled_pulls,
        excluded_sheet_refs=excluded_sheet_refs,
    )
    if scheduled_match:
        return ReconciliationDecision(
            classification="subscription_or_bill",
            status="matched",
            confidence=max(confidence, scheduled_match.confidence),
            notes=scheduled_match.notes,
            matched_sheet_ref=scheduled_match.sheet_ref,
        )
    return ReconciliationDecision(classification=classification, status=status, confidence=confidence, notes=notes)


def match_action_log(
    transaction: BankTransaction,
    action_log: Iterable[LoggedAction],
    classification: ReconciliationClassification | None = None,
    *,
    excluded_action_ids: set[str] | None = None,
) -> ActionLogMatch | None:
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return None

    compatible = _compatible_action_types(transaction, classification)
    excluded = excluded_action_ids or set()
    candidates = []
    for logged in action_log:
        if logged.id in excluded:
            continue
        candidate = _action_candidate(logged)
        if candidate is None or candidate["type"] not in compatible:
            continue
        if abs(candidate["amount"] - abs(transaction.amount)) > 0.01:
            continue
        day_delta = abs((candidate["date"] - transaction_date).days)
        if day_delta > 7:
            continue
        name_score = _name_score(transaction, candidate["text"])
        # Require some name evidence for automatic matches. Amount+date alone can attach
        # a bank txn to the wrong same-day same-amount sheet row (especially expenses).
        if name_score <= 0:
            continue
        score = 0.86 - (day_delta * 0.05) + (name_score * 0.10)
        candidates.append((score, day_delta, candidate, logged))

    if not candidates:
        return None

    score, day_delta, candidate, logged = sorted(candidates, key=lambda item: (-item[0], item[1]))[0]
    action_type = candidate["type"]
    notes = f"matched {action_type} action"
    if day_delta:
        notes = f"{notes} within {day_delta}d"
    return ActionLogMatch(
        action_id=logged.id,
        sheet_ref=f"{logged.action.worksheet}!row {logged.action.row}",
        confidence=min(score, 0.98),
        notes=notes,
    )


def match_scheduled_pull(
    transaction: BankTransaction,
    scheduled_pulls: Iterable[ScheduledPullCandidate],
    *,
    window_days: int = 3,
    excluded_sheet_refs: set[str] | None = None,
) -> ActionLogMatch | None:
    if transaction.pending or transaction.amount <= 0:
        return None
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return None

    excluded = excluded_sheet_refs or set()
    matches: list[tuple[float, int, ScheduledPullCandidate]] = []
    for pull in scheduled_pulls:
        if pull.source_ref in excluded:
            continue
        if abs(pull.amount - abs(transaction.amount)) > 0.01:
            continue
        day_delta = abs((pull.pull_date - transaction_date).days)
        if day_delta > window_days:
            continue
        name_score = _scheduled_name_score(transaction, pull.name)
        if name_score <= 0 and day_delta > 1:
            continue
        score = 0.78 - (day_delta * 0.06) + (name_score * 0.18)
        if name_score <= 0:
            score -= 0.08
        matches.append((min(score, 0.98), day_delta, pull))

    if not matches:
        return None

    score, day_delta, pull = sorted(matches, key=lambda item: (-item[0], item[1], item[2].name.lower()))[0]
    notes = f"matched {pull.source_type} schedule"
    if day_delta:
        notes = f"{notes} within {day_delta}d"
    return ActionLogMatch(
        action_id="",
        sheet_ref=pull.source_ref,
        confidence=score,
        notes=notes,
    )


def find_scheduled_pull_candidates(
    transaction: BankTransaction,
    scheduled_pulls: Iterable[ScheduledPullCandidate],
    *,
    window_days: int = 7,
    limit: int = 5,
) -> list[ActionLogCandidate]:
    if transaction.amount <= 0:
        return []
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return []

    candidates: list[ActionLogCandidate] = []
    for pull in scheduled_pulls:
        day_delta = abs((pull.pull_date - transaction_date).days)
        if day_delta > window_days:
            continue
        name_score = _scheduled_name_score(transaction, pull.name)
        candidate_amount = pull.amount if pull.amount > 0 else abs(transaction.amount)
        amount_delta = abs(candidate_amount - abs(transaction.amount))
        amount_tolerance = _candidate_amount_tolerance(abs(transaction.amount), name_score)
        if amount_delta > amount_tolerance:
            continue
        exact_or_wildcard_amount = pull.amount <= 0 or amount_delta <= 0.01
        if name_score <= 0 and not exact_or_wildcard_amount and day_delta > 3:
            continue
        amount_score = max(0.0, 1 - (amount_delta / amount_tolerance))
        date_score = max(0.0, 1 - (day_delta / max(window_days, 1)))
        score = (amount_score * 0.50) + (date_score * 0.30) + (name_score * 0.20)
        if exact_or_wildcard_amount:
            score += 0.10
        candidates.append(
            ActionLogCandidate(
                action_id=f"schedule:{pull.source_type}:{pull.source_ref}",
                sheet_ref=pull.source_ref,
                action_type="schedule",
                date=pull.pull_date,
                amount=candidate_amount,
                label=f"{pull.name} ({pull.source_type})",
                confidence=min(score, 0.98),
                notes=f"{pull.source_type} schedule, amount Δ ${amount_delta:.2f}, date Δ {day_delta}d",
            )
        )

    return sorted(candidates, key=lambda item: (-item.confidence, item.date))[: max(1, limit)]


def find_action_log_candidates(
    transaction: BankTransaction,
    action_log: Iterable[LoggedAction],
    *,
    classification: ReconciliationClassification | None = None,
    excluded_action_ids: set[str] | None = None,
    window_days: int = 7,
    limit: int = 5,
) -> list[ActionLogCandidate]:
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return []

    excluded = excluded_action_ids or set()
    compatible = _compatible_action_types(transaction, classification)
    candidates: list[ActionLogCandidate] = []
    for logged in action_log:
        if logged.id in excluded:
            continue
        candidate = _action_candidate(logged)
        if candidate is None or candidate["type"] not in compatible:
            continue
        day_delta = abs((candidate["date"] - transaction_date).days)
        if day_delta > window_days:
            continue

        name_score = _name_score(transaction, candidate["text"])
        amount_delta = abs(candidate["amount"] - abs(transaction.amount))
        amount_tolerance = _candidate_amount_tolerance(abs(transaction.amount), name_score)
        if amount_delta > amount_tolerance:
            continue

        amount_score = max(0.0, 1 - (amount_delta / amount_tolerance))
        date_score = max(0.0, 1 - (day_delta / max(window_days, 1)))
        score = (amount_score * 0.55) + (date_score * 0.30) + (name_score * 0.15)
        if candidate["type"] == "income" and name_score <= 0 and amount_delta > 0.01:
            continue
        candidates.append(
            _action_log_candidate(
                logged,
                candidate,
                confidence=min(score, 0.98),
                notes=f"amount Δ ${amount_delta:.2f}, date Δ {day_delta}d",
            )
        )

    return sorted(candidates, key=lambda item: (-item.confidence, item.date), reverse=False)[: max(1, limit)]


def recent_action_log_candidates(
    transaction: BankTransaction,
    action_log: Iterable[LoggedAction],
    *,
    excluded_action_ids: set[str] | None = None,
    days_back: int = 30,
    limit: int = 25,
) -> list[ActionLogCandidate]:
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return []

    excluded = excluded_action_ids or set()
    compatible = _compatible_action_types(transaction, None)
    earliest = transaction_date.toordinal() - max(1, days_back)
    latest = transaction_date.toordinal() + 1
    candidates: list[ActionLogCandidate] = []
    for logged in action_log:
        if logged.id in excluded:
            continue
        candidate = _action_candidate(logged)
        if candidate is None or candidate["type"] not in compatible:
            continue
        ordinal = candidate["date"].toordinal()
        if ordinal < earliest or ordinal > latest:
            continue
        amount_delta = abs(candidate["amount"] - abs(transaction.amount))
        day_delta = abs((candidate["date"] - transaction_date).days)
        name_score = _name_score(transaction, candidate["text"])
        rough_score = max(0.0, 1 - min(amount_delta / max(abs(transaction.amount), 1), 1)) * 0.65
        rough_score += max(0.0, 1 - min(day_delta / max(days_back, 1), 1)) * 0.25
        rough_score += name_score * 0.10
        candidates.append(
            _action_log_candidate(
                logged,
                candidate,
                confidence=min(rough_score, 0.95),
                notes=f"recent fallback, amount Δ ${amount_delta:.2f}, date Δ {day_delta}d",
            )
        )

    return sorted(candidates, key=lambda item: (-item.confidence, item.date), reverse=False)[: max(1, limit)]


def find_action_log_candidate_groups(
    transaction: BankTransaction,
    action_log: Iterable[LoggedAction],
    *,
    classification: ReconciliationClassification | None = None,
    excluded_action_ids: set[str] | None = None,
    window_days: int = 7,
    max_group_size: int = 4,
    limit: int = 5,
) -> list[ActionLogCandidateGroup]:
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return []

    excluded = excluded_action_ids or set()
    compatible = _compatible_action_types(transaction, classification)
    candidates: list[ActionLogCandidate] = []
    for logged in action_log:
        if logged.id in excluded:
            continue
        candidate = _action_candidate(logged)
        if candidate is None or candidate["type"] not in compatible:
            continue
        day_delta = abs((candidate["date"] - transaction_date).days)
        if day_delta > window_days:
            continue
        amount = float(candidate["amount"])
        if amount <= 0 or amount >= abs(transaction.amount):
            continue
        name_score = _name_score(transaction, candidate["text"])
        candidates.append(
            _action_log_candidate(
                logged,
                candidate,
                confidence=max(0.2, min(0.95, 0.70 - (day_delta * 0.03) + (name_score * 0.10))),
                notes=f"group candidate, date Δ {day_delta}d",
            )
        )

    candidates = sorted(candidates, key=lambda item: (-item.confidence, item.date))[:24]
    target_cents = round(abs(transaction.amount) * 100)
    groups: list[ActionLogCandidateGroup] = []

    def search(start: int, picked: list[ActionLogCandidate], total_cents: int) -> None:
        if len(groups) >= limit:
            return
        if picked and abs(total_cents - target_cents) <= 1:
            avg_confidence = sum(candidate.confidence for candidate in picked) / len(picked)
            groups.append(
                ActionLogCandidateGroup(
                    group_id="+".join(candidate.action_id for candidate in picked),
                    candidates=tuple(picked),
                    total_amount=total_cents / 100,
                    confidence=min(avg_confidence + 0.10, 0.99),
                    notes=f"exact aggregate match across {len(picked)} rows",
                )
            )
            return
        if total_cents > target_cents + 1 or len(picked) >= max_group_size:
            return
        for index in range(start, len(candidates)):
            candidate = candidates[index]
            search(index + 1, [*picked, candidate], total_cents + round(candidate.amount * 100))

    search(0, [], 0)
    return sorted(groups, key=lambda group: (-group.confidence, len(group.candidates)))[:limit]


def action_log_candidate_by_id(logged: LoggedAction) -> ActionLogCandidate | None:
    candidate = _action_candidate(logged)
    if candidate is None:
        return None
    return _action_log_candidate(logged, candidate, confidence=1.0, notes="manually selected")


def action_log_bank_transaction(logged: LoggedAction) -> dict | None:
    """Build a deterministic debug bank transaction from a real BookieBot action-log row."""
    candidate = _action_candidate(logged)
    if candidate is None:
        return None
    action_type = candidate["type"]
    amount = -candidate["amount"] if action_type == "income" else candidate["amount"]
    return {
        "transaction_id": f"bookiebot-action-log-{logged.id}",
        "account_id": "bookiebot-action-log",
        "date": candidate["date"].isoformat(),
        "name": _action_transaction_name(logged),
        "merchant_name": None,
        "amount": amount,
        "pending": False,
        "payment_channel": "bookiebot_debug",
    }


def _action_log_candidate(
    logged: LoggedAction,
    candidate: dict,
    *,
    confidence: float,
    notes: str,
) -> ActionLogCandidate:
    return ActionLogCandidate(
        action_id=logged.id,
        sheet_ref=f"{logged.action.worksheet}!row {logged.action.row}",
        action_type=str(candidate["type"]),
        date=candidate["date"],
        amount=float(candidate["amount"]),
        label=_action_transaction_name(logged),
        confidence=confidence,
        notes=notes,
    )


def _normalized_transaction_text(transaction: BankTransaction) -> str:
    parts = [
        transaction.name,
        transaction.merchant_name or "",
    ]
    text = " ".join(parts).lower()
    return re.sub(r"\s+", " ", text).strip()


def _contains_any(text: str, patterns: tuple[str, ...]) -> bool:
    return any(pattern in text for pattern in patterns)


def _transaction_date(transaction: BankTransaction) -> date | None:
    raw = transaction.date or transaction.authorized_date
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _compatible_action_types(
    transaction: BankTransaction,
    classification: ReconciliationClassification | None,
) -> set[str]:
    if transaction.amount < 0:
        return {"income"}
    if classification == "subscription_or_bill":
        return {"payment", "expense"}
    if classification == "transfer_or_payment":
        return {"payment"}
    return {"expense", "payment"}


def _matched_classification(
    classification: ReconciliationClassification,
    notes: str,
) -> ReconciliationClassification:
    if "income action" in notes:
        return "income"
    if "payment action" in notes:
        return "subscription_or_bill"
    return classification


def _action_candidate(logged: LoggedAction) -> dict | None:
    action = logged.action
    action_type = action.metadata.get("type", "")
    if action_type not in {"expense", "income", "payment"}:
        return None

    amount = _action_amount(action_type, action.new_values, action.description)
    action_date = _action_date(action.new_values, logged.created_at)
    if amount is None or action_date is None or amount <= 0:
        return None

    text_parts = [
        action.description,
        action.metadata.get("category", ""),
        action.metadata.get("source", ""),
        *action.new_values,
    ]
    return {
        "type": action_type,
        "amount": amount,
        "date": action_date,
        "text": " ".join(str(part) for part in text_parts if part),
    }


def _action_transaction_name(logged: LoggedAction) -> str:
    action = logged.action
    action_type = action.metadata.get("type", "")
    if action_type == "income":
        return action.metadata.get("source") or action.description or "BookieBot Income"
    if action_type == "payment":
        return action.metadata.get("category") or action.description or "BookieBot Payment"
    if action_type == "expense":
        values = [value for value in action.new_values if value]
        for value in values[1:]:
            if _money_value(value) is None and not _parse_date(value):
                return value
        return action.metadata.get("category") or action.description or "BookieBot Expense"
    return action.description or "BookieBot Action"


def _action_amount(action_type: str, values: list[str], description: str) -> float | None:
    if action_type == "income":
        for value in reversed(values):
            amount = _money_value(value)
            if amount is not None:
                return amount
    if action_type == "payment" and values:
        return _money_value(values[-1])
    for value in values:
        amount = _money_value(value)
        if amount is not None and amount > 0:
            return amount
    return _money_from_text(description)


def _action_date(values: list[str], created_at: str) -> date | None:
    for value in values:
        parsed = _parse_date(value)
        if parsed:
            return parsed
    return _parse_date(created_at)


def _money_value(value: str) -> float | None:
    text = str(value).strip()
    if not text:
        return None
    try:
        return abs(float(text.replace("$", "").replace(",", "")))
    except ValueError:
        return None


def _money_from_text(text: str) -> float | None:
    match = re.search(r"\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)", text)
    if not match:
        return None
    return _money_value(match.group(1))


def _parse_date(value: str) -> date | None:
    text = str(value).strip()
    if not text:
        return None
    for fmt, width in (("%Y-%m-%d", 10), ("%Y-%m-%dT%H:%M:%S", 19), ("%m/%d/%Y", 10)):
        try:
            return datetime.strptime(text[:width], fmt).date()
        except ValueError:
            continue
    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if match:
        month, day, year = (int(part) for part in match.groups())
        return date(year, month, day)
    return None


def _name_score(transaction: BankTransaction, action_text: str) -> float:
    # Normalize the same way as schedule matching so "PG&E" / "pg&e" share tokens.
    bank_text = _normalize_schedule_text(_normalized_transaction_text(transaction))
    action_normalized = _normalize_schedule_text(action_text)
    if not bank_text or not action_normalized:
        return 0.0
    bank_tokens = {token for token in re.split(r"\s+", bank_text) if len(token) >= 3}
    action_tokens = {token for token in re.split(r"\s+", action_normalized) if len(token) >= 3}
    return _token_overlap_score(bank_tokens, action_tokens)


def _scheduled_name_score(transaction: BankTransaction, schedule_name: str) -> float:
    bank_text = _normalize_schedule_text(_normalized_transaction_text(transaction))
    schedule_text = _normalize_schedule_text(schedule_name)
    if not bank_text or not schedule_text:
        return 0.0
    bank_tokens = {token for token in re.split(r"\s+", bank_text) if len(token) >= 3}
    schedule_tokens = {token for token in re.split(r"\s+", schedule_text) if len(token) >= 3}
    token_score = _token_overlap_score(bank_tokens, schedule_tokens)
    if token_score > 0:
        return token_score
    if any(token in schedule_text or schedule_text in token for token in bank_tokens):
        return 0.35
    return 0.0


def _normalize_schedule_text(value: str) -> str:
    text = value.lower()
    replacements = {
        "pg&e": "pge",
        "p g e": "pge",
        "apple.com/bill": "apple",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _token_overlap_score(left_tokens: set[str], right_tokens: set[str]) -> float:
    if not left_tokens or not right_tokens:
        return 0.0
    overlap = left_tokens & right_tokens
    if not overlap:
        return 0.0
    bank_coverage = len(overlap) / len(left_tokens)
    candidate_coverage = len(overlap) / len(right_tokens)
    return max(bank_coverage, candidate_coverage)


def _candidate_amount_tolerance(transaction_amount: float, name_score: float) -> float:
    base = max(2.0, transaction_amount * 0.05)
    if name_score >= 0.80:
        return max(base, 15.0, transaction_amount * 0.35)
    if name_score >= 0.50:
        return max(base, 10.0, transaction_amount * 0.25)
    return base
