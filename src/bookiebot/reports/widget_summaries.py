"""Small read-only projections of canonical report, goal and shared balances."""
from __future__ import annotations

import calendar
from datetime import date, datetime, timezone
import math
import re
from typing import Any

from bookiebot.reports.goals_store import build_goals_store
from bookiebot.reimbursements import service as reimbursements
from bookiebot.sheets.routing import PACIFIC_TZ

WIDGET_TYPES = frozenset({"upcoming", "categories", "savings", "shared"})
GOAL_ID = re.compile(r"[0-9a-f]{32}")


def _number(value: Any, *, nonnegative: bool = False) -> float:
    if (type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 1e12
            or (nonnegative and value < 0)):
        raise ValueError("Invalid widget amount")
    return float(value)


def _cents(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 100_000_000_000_000:
        raise ValueError("Invalid widget cents")
    return value


def _name(value: Any, maximum: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise ValueError("Invalid widget label")
    return value


def report_content(report: dict[str, Any], kind: str, mode: str, day: str) -> dict[str, Any]:
    """No budget/projection formulas: use the same values as the report mode."""
    view = report["modeViews"][mode]
    if kind == "categories":
        return {key: {"remaining": _number(view["categoryBalances"]["remaining"][key]),
                      "budget": _number(view["categoryBudgets"][key], nonnegative=True)}
                for key in ("needs", "wants")}
    if kind != "upcoming":
        raise ValueError("Invalid report widget")
    today = date.fromisoformat(day)
    end = calendar.monthrange(today.year, today.month)[1]
    payments = []
    # Future scheduled events are present in both canonical mode views. They
    # describe the calendar, not proof that a bill is unpaid or a bank debit.
    for event in view["calendarEvents"]:
        if event["kind"] not in {"bill", "subscription"}:
            continue
        event_day = event["day"]
        if type(event_day) is not int or not 1 <= event_day <= end:
            raise ValueError("Invalid scheduled widget date")
        amount = _number(event["amount"], nonnegative=True)
        if event_day < today.day or amount == 0:
            continue
        payments.append({"label": _name(event["label"]), "amount": amount,
                         "date": today.replace(day=event_day).isoformat(), "kind": event["kind"]})
    payments.sort(key=lambda row: (row["date"], row["kind"], row["label"].casefold()))
    return {"payments": payments[:2], "totalCount": len(payments), "windowEnd": today.replace(day=end).isoformat()}


def _goals_content(owner: str) -> dict[str, Any]:
    result = build_goals_store().list_goals(owner)
    if result["scope"] != "personal" or result["currency"] != "USD" or len(result["goals"]) > 200:
        raise ValueError("Invalid widget goals")
    goals = []
    for row in result["goals"]:
        if type(row["archived"]) is not bool:
            raise ValueError("Invalid widget goal state")
        if row["archived"]:
            continue
        goal_id = row["id"]
        if not isinstance(goal_id, str) or not GOAL_ID.fullmatch(goal_id):
            raise ValueError("Invalid widget goal identifier")
        balance, target = _cents(row["balanceCents"]), _cents(row["targetCents"])
        if target == 0:
            raise ValueError("Invalid widget goal target")
        goals.append({"id": goal_id, "name": _name(row["name"], 80), "balance": balance / 100,
                      "target": target / 100, "remaining": max(0, target - balance) / 100,
                      "progress": min(1, balance / target)})
    if len({goal["id"] for goal in goals}) != len(goals):
        raise ValueError("Duplicate widget goal")
    return {"goals": goals}


def select_goal(content: dict[str, Any], goal_id: str | None) -> dict[str, Any]:
    goals = content["goals"]
    selected = next((goal for goal in goals if goal["id"] == goal_id), None) if goal_id else next(iter(goals), None)
    return {"goal": selected, "goals": [{"id": goal["id"], "name": goal["name"]} for goal in goals],
            "emptyReason": None if selected else "goal_unavailable" if goal_id else "no_goals"}


def _shared_content(owner: str) -> dict[str, Any]:
    if not reimbursements.enabled():
        raise ValueError("Shared widgets are unavailable")
    # In contrast to the interactive phone route, this may NEVER synchronize
    # sheet projections, acknowledge payments, or otherwise mutate finances.
    result = reimbursements.snapshot(owner, retry_projection=False)
    if result["ownerKey"] != owner or result["currency"] != "USD":
        raise ValueError("Invalid widget shared identity")
    owed_to, owe = 0, 0
    ids = set()
    partner = "hannah" if owner == "brian" else "brian"
    for row in result["allocations"]:
        if row["id"] in ids or {row["payerOwner"], row["partnerOwner"]} != {owner, partner}:
            raise ValueError("Invalid widget allocation scope")
        ids.add(row["id"])
        outstanding = _cents(row["outstandingCents"])
        if _cents(row["partnerShareCents"]) != _cents(row["settledCents"]) + outstanding:
            raise ValueError("Invalid widget shared amount")
        if row["payerOwner"] == owner:
            owed_to += outstanding
        else:
            owe += outstanding
    pending = 0
    for event in result["events"]:
        if event["allocationId"] not in ids:
            raise ValueError("Invalid widget payment scope")
        # Sender reports remain owed until their recipient confirms them.
        if event["status"] == "pending":
            pending += 1
    return {"owedToYou": _cents(owed_to) / 100, "youOwe": _cents(owe) / 100,
            "partnerName": partner.capitalize(), "pendingCount": pending,
            "projectionPending": bool(result["projectionPending"])}


def database_snapshot(kind: str, payload: dict[str, Any], day: str) -> dict[str, Any]:
    # Capture before reading, so slow work or cache hits never freshen old data.
    started = datetime.now(timezone.utc)
    if started.astimezone(PACIFIC_TZ).date().isoformat() != day:
        raise ValueError("Widget read crossed a budget day")
    owner = payload["owner_key"]
    if owner not in {"brian", "hannah"}:
        raise ValueError("Invalid widget owner")
    content = _goals_content(owner) if kind == "savings" else _shared_content(owner) if kind == "shared" else None
    if content is None:
        raise ValueError("Invalid database widget")
    return {"schemaVersion": 2, "type": kind, "ownerName": payload["owner_name"],
            "month": day[:7], "asOfDate": day, "timezone": "America/Los_Angeles",
            "updatedAt": started.isoformat(), "staleAfterSeconds": 1800,
            "refreshAfterSeconds": 900, "status": "fresh", "content": content}
