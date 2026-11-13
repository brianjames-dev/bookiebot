"""Pure reviewed bill configuration intent, separate from payment mutations."""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import date, timedelta
import re
from typing import Any

from bookiebot.sheets.recurring import (
    LAST_MONTH, BillConflict, BillPlan, BillValidation, fingerprint, month_key, normalize_plan, selected, versioned,
)


@dataclass(frozen=True)
class BillSnapshot:
    owner: str
    plans: tuple[BillPlan, ...]
    version: str
    period: str
    earliest_months: dict[str, str]

    def records(self) -> list[BillPlan]:
        current = {p.id: p for p in selected(list(self.plans), self.period, include_inactive=True)}
        for plan in sorted(self.plans, key=lambda p: p.effective_from):
            if plan.id not in current and plan.effective_from > self.period:
                current[plan.id] = plan
        return sorted(current.values(), key=lambda p: (p.kind, p.name.casefold(), p.id))


@dataclass(frozen=True)
class BillChange:
    snapshot: BillSnapshot
    operation: str
    before: BillPlan | None
    after: BillPlan
    review_version: str

    def rows(self, request_id: str) -> list[BillPlan]:
        return versioned(list(self.snapshot.plans), self.after, request_id)

    def public(self) -> dict[str, Any]:
        return {"operation": self.operation, "before": self.before.public(self.snapshot.period) if self.before else None,
                "after": self.after.public(self.snapshot.period), "effectiveFrom": self.after.effective_from,
                "splitStartsOn": self.after.split_starts_on,
                "replacesScheduledChanges": any(p.id == self.after.id and p.effective_from >= self.after.effective_from
                                                 for p in self.snapshot.plans if p.effective_from > self.snapshot.period),
                "reviewVersion": self.review_version}


def prepare_change(snapshot: BillSnapshot, body: dict[str, Any], *, today: date) -> BillChange:
    common = {"operation", "id", "draftId", "version", "settingsVersion", "reviewVersion", "requestId"}
    if not isinstance(body, dict):
        raise BillValidation("Choose a bill action.")
    operation = body.get("operation")
    if not isinstance(operation, str) or operation not in {"create", "update", "delete"} or set(body) - (common | ({"effectiveFrom"} if operation == "delete" else {"bill"})):
        raise BillValidation("Choose a valid bill action.")
    if body.get("settingsVersion") != snapshot.version:
        raise BillConflict("Bill settings changed. Refresh before reviewing your changes.")
    current = None
    if operation == "create":
        nonce = body.get("draftId")
        if not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", nonce):
            raise BillValidation("Start a fresh bill form.")
        identity = "bill_" + fingerprint([snapshot.owner, nonce])[:24]
        if any(p.id == identity for p in snapshot.plans):
            raise BillConflict("This bill is already saved. Refresh the bill list.")
    else:
        identity = body.get("id")
        current = next((p for p in snapshot.records() if p.id == identity), None)
        if current is None:
            raise BillConflict("This bill is unavailable in your settings. Refresh the bill list.")
        identity = current.id
        if body.get("version") != current.version:
            raise BillConflict("This bill changed. Refresh before reviewing your changes.")
    if operation == "delete":
        assert current is not None
        effective = month_key(body.get("effectiveFrom"))
        if effective >= LAST_MONTH:
            raise BillValidation("Choose an earlier starting month.")
        if effective < today.strftime("%Y-%m"):
            raise BillValidation("Choose this month or a later month. Earlier months stay unchanged.")
        after = replace(current, active=False, effective_from=effective, version="", request_id="")
    else:
        raw = body.get("bill")
        if not isinstance(raw, dict):
            raise BillValidation("Enter the bill settings.")
        after = normalize_plan(raw, current=current, today=today, plan_id=identity)
        for other in snapshot.records():
            if other.id != after.id and other.source_label.casefold() == after.source_label.casefold():
                raise BillValidation("A bill with that name already exists. Edit it instead.")
        if after.split_method != "none":
            changed = (current is None or current.split_method != after.split_method
                       or after.split_method == "custom" and current.payer_basis_points != after.payer_basis_points)
            start = max(date.fromisoformat(after.effective_from + "-01"), today if current is None else today + timedelta(days=1))
            after = replace(after, split_starts_on=start.isoformat() if changed or current is None else current.split_starts_on)
    minimum = snapshot.earliest_months.get(after.id, today.strftime("%Y-%m"))
    timing_repair = bool(current and not current.pull_day and operation == "update" and replace(after,
        pull_day=current.pull_day, pull_months=current.pull_months, effective_from=current.effective_from,
        effective_until=current.effective_until, version=current.version, request_id=current.request_id,
        split_starts_on=current.split_starts_on, monthly_source=current.monthly_source) == current)
    if after.effective_from < minimum and not timing_repair:
        raise BillValidation(f"This charge is already recorded. Start changes in {minimum} or later.")
    # The review binds the exact owner/source snapshot, before/after values and
    # internal split start. Clients never supply row addresses or authority.
    review = fingerprint([snapshot.owner, snapshot.version, operation, asdict(current) if current else None, asdict(after)])
    return BillChange(snapshot, operation, current, after, review)
