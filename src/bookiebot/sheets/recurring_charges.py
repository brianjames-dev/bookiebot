"""Monthly bill source identities, not a second repayment or balance ledger."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import json
import re

from bookiebot.sheets.recurring import BillConflict, BillPlan, CATEGORIES, boolean, month_key, money_cents

CHARGES_TAB = "_BookieBot Bill Charges"
CHARGE_HEADERS = ("plan_id", "month", "charge_date", "source_label", "category", "worksheet_id",
                  "source_row", "amount_column", "anchor", "initial_amount", "recorded",
                  "source_action_id", "request_id", "created_at", "payer_owner")
OCCURRENCE_HEADERS = ("plan_snapshot", "virtual", "payment_date")


def following_month(period: str) -> str:
    year, month = map(int, month_key(period).split("-"))
    if year == 9999 and month == 12:
        raise BillConflict("The bill month is outside the supported calendar.")
    return f"{year + (month == 12):04d}-{month % 12 + 1:02d}"


def source_anchor(plan_id: str, period: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,96}", plan_id):
        raise BillConflict("The bill source identity is invalid.")
    return "bb_bill_" + plan_id.replace("-", "_") + "_" + month_key(period).replace("-", "")


@dataclass(frozen=True)
class BillCharge:
    plan_id: str
    month: str
    charge_date: str
    source_label: str
    category: str
    worksheet_id: int
    source_row: int
    amount_column: int
    anchor: str
    initial_amount_cents: int
    recorded: bool
    source_action_id: str = ""
    request_id: str = ""
    created_at: str = ""
    payer_owner: str = ""
    plan_snapshot: str = ""
    virtual: bool = False
    payment_date: str = ""


def occurrence_plan(charge: BillCharge, fallback: BillPlan | None = None) -> BillPlan:
    """Keep an existing occurrence independent of later recurring settings."""
    if not charge.plan_snapshot:
        if fallback is None:
            raise BillConflict("This bill occurrence has no saved configuration.")
        return fallback
    from bookiebot.sheets.recurring_rows import decode, encode
    try:
        value = json.loads(charge.plan_snapshot)
        if (not isinstance(value, dict) or any(type(value.get(k)) is not int for k in ("pull_day", "payer_basis_points"))
                or any(type(value.get(k)) is not bool for k in ("active", "monthly_source"))
                or value.get("amount_cents") is not None and (type(value["amount_cents"]) is not int or value["amount_cents"] < 0)):
            raise ValueError("occurrence settings")
        value["pull_months"] = tuple(value["pull_months"])
        plan = BillPlan(**value)
        # Reuse the schedule adapter's complete validation, including legacy
        # incomplete baselines, without accepting client-supplied authority.
        checked = decode(encode([plan], plan.source_tab, []), plan.source_tab)[0]
        if (checked.id != charge.plan_id or checked.source_label != charge.source_label
                or checked.category != charge.category or not checked.effective_from <= charge.month < checked.effective_until):
            raise ValueError("occurrence identity")
        if charge.virtual and (checked.kind != "subscription" or checked.monthly_source
                or checked.due_date(charge.month) != date.fromisoformat(charge.payment_date or charge.charge_date)
                or checked.amount_cents != charge.initial_amount_cents):
            raise ValueError("virtual occurrence")
        return checked
    except (KeyError, TypeError, ValueError) as exc:
        raise BillConflict("A recorded bill's original settings need review before changing it.") from exc


def decode_charges(rows: list[list[str]]) -> list[BillCharge]:
    if not rows:
        return []
    headers = [str(x).strip() for x in rows[0]]
    if not set(CHARGE_HEADERS) <= set(headers) or len(set(headers)) != len(headers):
        raise BillConflict("Bill charge history needs review before recording another amount.")
    result, seen = [], set()
    try:
        for raw in rows[1:]:
            if not any(str(x).strip() for x in raw):
                continue
            item = {name: str(raw[i]).strip() if i < len(raw) else "" for i, name in enumerate(headers)}
            period = month_key(item["month"])
            charged = date.fromisoformat(item["charge_date"])
            identity = (item["plan_id"], period)
            if identity in seen or charged.strftime("%Y-%m") != period:
                raise ValueError("charge identity")
            seen.add(identity)
            column, row, sheet_id = int(item["amount_column"]), int(item["source_row"]), int(item["worksheet_id"])
            virtual = boolean(item.get("virtual") or "false")
            payment_date = item.get("payment_date", "")
            if payment_date and date.fromisoformat(payment_date).strftime("%Y-%m") != period:
                raise ValueError("payment date")
            if (item["category"] not in CATEGORIES or row < (0 if virtual else 1) or virtual and row != 0 or sheet_id < 0
                    or column != (4 if item["category"] == "subscriptions_wants" else 3)
                    or item["anchor"] != source_anchor(item["plan_id"], period) or not item["source_label"]):
                raise ValueError("source")
            amount = money_cents(item["initial_amount"])
            assert amount is not None
            charge = BillCharge(item["plan_id"], period, charged.isoformat(), item["source_label"], item["category"],
                sheet_id, row, column, item["anchor"], amount, boolean(item["recorded"]), item["source_action_id"],
                item["request_id"], item["created_at"], item["payer_owner"], item.get("plan_snapshot", ""), virtual, payment_date)
            if virtual and not charge.plan_snapshot:
                raise ValueError("virtual occurrence settings")
            if charge.plan_snapshot:
                occurrence_plan(charge, None)
            result.append(charge)
    except (ValueError, KeyError, TypeError, AssertionError) as exc:
        raise BillConflict("A bill charge source changed. Check it before recording another amount.") from exc
    return result


def encode_charges(charges: list[BillCharge], original: list[list[str]]) -> list[list[str]]:
    names = [str(x) for x in original[0]] if original else []
    names += [name for name in (*CHARGE_HEADERS, *OCCURRENCE_HEADERS) if name not in names]
    old = {(str(row[names.index("plan_id")]), str(row[names.index("month")])): row
           for row in original[1:] if len(row) > max(names.index("plan_id"), names.index("month"))}
    result = [names]
    for charge in charges:
        values = {"plan_id": charge.plan_id, "month": charge.month, "charge_date": charge.charge_date,
            "source_label": charge.source_label, "category": charge.category, "worksheet_id": str(charge.worksheet_id),
            "source_row": str(charge.source_row), "amount_column": str(charge.amount_column), "anchor": charge.anchor,
            "initial_amount": f"{charge.initial_amount_cents / 100:.2f}", "recorded": str(charge.recorded).upper(),
            "source_action_id": charge.source_action_id, "request_id": charge.request_id,
            "created_at": charge.created_at, "payer_owner": charge.payer_owner,
            "plan_snapshot": charge.plan_snapshot, "virtual": str(charge.virtual).upper(), "payment_date": charge.payment_date}
        raw = old.get((charge.plan_id, charge.month), [])
        result.append([values[name] if name in values else str(raw[i]) if i < len(raw) else "" for i, name in enumerate(names)])
    return result
