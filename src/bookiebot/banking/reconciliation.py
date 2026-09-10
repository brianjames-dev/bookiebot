from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime
import re
from math import isfinite
from typing import Iterable

from bookiebot.banking.models import (
    BankTransaction,
    ReconciliationClassification,
    ReconciliationStatus,
)
from bookiebot.sheets.undo import LoggedAction


TRANSFER_PATTERNS = (
    r"\bcredit card\b.*\bpayment\b",
    r"\bpayment\b.*\bcredit card\b",
    r"\b(?:transfer|xfer)\b",
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
    amount_recorded: bool = True


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
    amount_recorded: bool = False

    @property
    def occurrence_ref(self) -> str:
        # A recurring row is evidence for one pull, never all future months.
        pull_key = self.pull_date.strftime("%Y-%m") if self.source_type == "bill" else self.pull_date.isoformat()
        return f"{self.source_ref}#pull={pull_key}"


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

    if any(re.search(pattern, transaction_text) for pattern in TRANSFER_PATTERNS):
        return "transfer_or_payment", "matched", 0.95, "transfer/payment pattern"

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
    action_log = tuple(action_log)
    scheduled_pulls = tuple(scheduled_pulls)
    classification, status, confidence, notes = classify_transaction(transaction)
    if transaction.pending:
        return ReconciliationDecision(classification=classification, status=status, confidence=confidence, notes=notes)
    match = match_action_log(
        transaction,
        action_log,
        classification,
        excluded_action_ids=(excluded_action_ids or set()) | claimed_schedule_action_ids(
            scheduled_pulls, action_log, excluded_sheet_refs or set(),
        ),
    )
    if match:
        logged = next(logged for logged in action_log if logged.id == match.action_id)
        return ReconciliationDecision(
            classification=_matched_classification(classification, match.notes),
            status="matched",
            confidence=max(confidence, match.confidence),
            notes=match.notes,
            matched_action_log_id=match.action_id,
            matched_sheet_ref=action_sheet_ref(logged, scheduled_pulls),
        )
    scheduled_match = match_scheduled_pull(
        transaction,
        distinct_scheduled_pulls(scheduled_pulls, action_log),
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
    if transaction.pending or transaction_date is None:
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
        if round(candidate["amount"] * 100) != round(abs(transaction.amount) * 100):
            continue
        day_delta = _transaction_day_delta(transaction, candidate["date"])
        if day_delta > 7:
            continue
        score = 0.88 - (day_delta * 0.015)
        name_score = _name_score(transaction, candidate["text"])
        if name_score < 0.5:
            continue
        score += name_score * 0.10
        candidates.append((score, day_delta, candidate, logged))

    if not candidates:
        return None

    ranked = sorted(candidates, key=lambda item: (-item[0], item[1]))
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.08:
        return None
    score, day_delta, candidate, logged = ranked[0]
    action_type = candidate["type"]
    notes = f"matched {action_type} action"
    if day_delta:
        notes = f"{notes} within {day_delta}d"
    return ActionLogMatch(
        action_id=logged.id,
        sheet_ref=action_sheet_ref(logged),
        confidence=min(score, 0.98),
        notes=notes,
    )


def match_scheduled_pull(
    transaction: BankTransaction,
    scheduled_pulls: Iterable[ScheduledPullCandidate],
    *,
    window_days: int = 7,
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
        if pull.occurrence_ref in excluded:
            continue
        if pull.source_type == "bill" and not pull.amount_recorded:
            continue
        if pull.amount <= 0 or round(pull.amount * 100) != round(abs(transaction.amount) * 100):
            continue
        day_delta = _transaction_day_delta(transaction, pull.pull_date)
        if day_delta > window_days:
            continue
        name_score = _scheduled_name_score(transaction, pull.name)
        if name_score < 0.5:
            continue
        score = 0.88 - (day_delta * 0.015) + (name_score * 0.10)
        matches.append((min(score, 0.98), day_delta, pull))

    if not matches:
        return None

    # The same monthly bill may have a due-date and an off-cycle review hint.
    unique = {}
    for entry in matches:
        key = entry[2].occurrence_ref
        if key not in unique or entry[0] > unique[key][0]:
            unique[key] = entry
    ranked = sorted(unique.values(), key=lambda item: (-item[0], item[1], item[2].name.lower()))
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.08:
        return None
    score, day_delta, pull = ranked[0]
    notes = f"matched {pull.source_type} schedule"
    if day_delta:
        notes = f"{notes} within {day_delta}d"
    return ActionLogMatch(
        action_id="",
        sheet_ref=pull.occurrence_ref,
        confidence=score,
        notes=notes,
    )


def _schedule_represents_action(pull: ScheduledPullCandidate, candidate: dict) -> bool:
    if candidate["type"] not in {"expense", "payment"}:
        return False
    if round(candidate["amount"] * 100) != round(pull.amount * 100):
        return False
    same_period = (
        candidate["date"].strftime("%Y-%m") == pull.pull_date.strftime("%Y-%m")
        if pull.source_type == "bill" else abs((candidate["date"] - pull.pull_date).days) <= 7
    )
    return same_period and _token_overlap_score(_name_tokens(pull.name), _name_tokens(candidate["text"])) >= 0.5


def action_sheet_ref(logged: LoggedAction, scheduled_pulls: Iterable[ScheduledPullCandidate] = ()) -> str:
    """Reserve physical row and equivalent recurring occurrence in one store CAS."""
    candidate = _action_candidate(logged)
    month_suffix = f"#month={candidate['date']:%Y-%m}" if candidate is not None else ""
    refs = [f"{logged.action.worksheet}!row {logged.action.row}{month_suffix}"]
    if candidate is not None:
        refs.extend(pull.occurrence_ref for pull in scheduled_pulls if _schedule_represents_action(pull, candidate))
    return " + ".join(dict.fromkeys(refs))


def claimed_schedule_action_ids(
    scheduled_pulls: Iterable[ScheduledPullCandidate], action_log: Iterable[LoggedAction],
    claimed_refs: set[str],
) -> set[str]:
    """A newly logged action cannot reuse an already checked schedule occurrence."""
    claimed = [pull for pull in scheduled_pulls if pull.occurrence_ref in claimed_refs]
    return {
        logged.id for logged in action_log
        if (candidate := _action_candidate(logged)) is not None
        and any(_schedule_represents_action(pull, candidate) for pull in claimed)
    }


def distinct_scheduled_pulls(
    scheduled_pulls: Iterable[ScheduledPullCandidate], action_log: Iterable[LoggedAction],
) -> list[ScheduledPullCandidate]:
    """Prefer a logged purchase when a schedule describes the same expense.

    Include reserved actions so a duplicate charge cannot consume the action
    first and then consume its schedule as an independent payment.
    """
    actions = [candidate for logged in action_log if (candidate := _action_candidate(logged))]
    return [pull for pull in scheduled_pulls
            if not any(_schedule_represents_action(pull, candidate) for candidate in actions)]


def find_scheduled_pull_candidates(
    transaction: BankTransaction,
    scheduled_pulls: Iterable[ScheduledPullCandidate],
    *,
    action_log: Iterable[LoggedAction] = (),
    window_days: int = 7,
    limit: int = 5,
) -> list[ActionLogCandidate]:
    if transaction.amount <= 0:
        return []
    transaction_date = _transaction_date(transaction)
    if transaction_date is None:
        return []

    candidates: list[ActionLogCandidate] = []
    for pull in distinct_scheduled_pulls(scheduled_pulls, action_log):
        day_delta = _transaction_day_delta(transaction, pull.pull_date)
        if day_delta > window_days:
            continue
        name_score = _scheduled_name_score(transaction, pull.name)
        candidate_amount = pull.amount if pull.amount > 0 else abs(transaction.amount)
        amount_delta = abs(candidate_amount - abs(transaction.amount))
        amount_tolerance = _candidate_amount_tolerance(abs(transaction.amount), name_score)
        if amount_delta > amount_tolerance:
            continue
        exact_or_wildcard_amount = pull.amount <= 0 or amount_delta <= 0.01
        if pull.amount <= 0 and name_score < 0.5:
            continue
        if name_score <= 0 and not exact_or_wildcard_amount and day_delta > 3:
            continue
        amount_score = max(0.0, 1 - (amount_delta / amount_tolerance))
        date_score = max(0.0, 1 - (day_delta / max(window_days, 1)))
        score = (amount_score * 0.50) + (date_score * 0.30) + (name_score * 0.20)
        if exact_or_wildcard_amount:
            score += 0.10
        candidates.append(
            ActionLogCandidate(
                action_id=f"schedule:{pull.source_type}:{pull.occurrence_ref}",
                sheet_ref=pull.occurrence_ref,
                action_type="schedule",
                date=pull.pull_date,
                amount=candidate_amount,
                label=f"{pull.name} ({pull.source_type})",
                confidence=min(score, 0.98),
                notes=f"{pull.source_type} schedule{' (not logged)' if pull.source_type == 'bill' and not pull.amount_recorded else ''}, amount Δ ${amount_delta:.2f}, date Δ {day_delta}d",
                amount_recorded=pull.source_type == "subscription" or pull.amount_recorded,
            )
        )

    unique = {}
    for candidate in candidates:
        if candidate.sheet_ref not in unique or candidate.confidence > unique[candidate.sheet_ref].confidence:
            unique[candidate.sheet_ref] = candidate
    return sorted(unique.values(), key=lambda item: (-item.confidence, item.date))[: max(1, limit)]


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
        day_delta = _transaction_day_delta(transaction, candidate["date"])
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
        day_delta = _transaction_day_delta(transaction, candidate["date"])
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
        day_delta = _transaction_day_delta(transaction, candidate["date"])
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


def action_log_candidate_by_id(
    logged: LoggedAction, *, scheduled_pulls: Iterable[ScheduledPullCandidate] = (),
) -> ActionLogCandidate | None:
    candidate = _action_candidate(logged)
    if candidate is None:
        return None
    return replace(
        _action_log_candidate(logged, candidate, confidence=1.0, notes="manually selected"),
        sheet_ref=action_sheet_ref(logged, scheduled_pulls),
    )


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
        sheet_ref=action_sheet_ref(logged),
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
    if action_type == "expense" and len(values) >= 3 and (not values[0] or _parse_date(values[0])):
        return _money_value(values[2])
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
        amount = abs(float(text.replace("$", "").replace(",", "")))
        return amount if isfinite(amount) else None
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
        try:
            return date(year, month, day)
        except ValueError:
            return None
    return None


# Provider boilerplate is not merchant identity. Keep the vocabulary deliberately
# small; fuzzy amounts/names remain review suggestions instead of automatic links.
_NAME_NOISE = frozenset({
    "payment", "payments", "purchase", "recurring", "debit", "credit", "card",
    "online", "web", "pos", "ach", "bill", "expense", "income", "for", "from",
    "inc", "llc", "com", "www", "need", "needs", "want", "wants", "food",
    "grocery", "shopping", "brian", "hannah", "bofa", "checking", "bank",
    "the", "and", "with", "at", "by", "on", "to",
})


def _name_tokens(value: str) -> set[str]:
    return {token for token in _normalize_schedule_text(value).split()
            if len(token) >= 3 and not token.isdigit() and token not in _NAME_NOISE}


def _name_score(transaction: BankTransaction, action_text: str) -> float:
    return _token_overlap_score(
        _name_tokens(_normalized_transaction_text(transaction)), _name_tokens(action_text),
    )


def _scheduled_name_score(transaction: BankTransaction, schedule_name: str) -> float:
    return _name_score(transaction, schedule_name)


def _normalize_schedule_text(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    # Exact, known merchant aliases only; arbitrary substring overlap can turn
    # different merchants into confident matches (e.g. Apple / Pineapple).
    for pattern, replacement in (
        (r"\bp\s*g\s*e\b", "pge"),
        (r"\bpg e\b", "pge"),
        (r"\bpacific gas (?:and )?electric\b", "pge"),
        (r"\bcomcast\b", "xfinity"),
        (r"\bapple com bill\b", "apple"),
    ):
        text = re.sub(pattern, replacement, text)
    return re.sub(r"\s+", " ", text).strip()


def transaction_match_dates(transaction: BankTransaction) -> tuple[date, ...]:
    # Authorization carries the purchase day when posting crosses a weekend or
    # month boundary. Only use it if it is a plausible predecessor of posting.
    posted = _transaction_date(transaction)
    authorized = _parse_date(transaction.authorized_date or "")
    dates = [posted] if posted else []
    if authorized and (posted is None or 0 <= (posted - authorized).days <= 14):
        dates.append(authorized)
    return tuple(dict.fromkeys(dates))


def _transaction_day_delta(transaction: BankTransaction, candidate_date: date) -> int:
    return min((abs((candidate_date - value).days) for value in transaction_match_dates(transaction)), default=10**6)


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
