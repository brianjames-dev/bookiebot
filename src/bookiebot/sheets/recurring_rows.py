"""Lossless schedule metadata adapters; no Google Sheets I/O."""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import date
import re
from typing import Any
from openpyxl.utils import get_column_letter

from bookiebot.sheets.recurring import (
    BILL_TAB, SUBSCRIPTION_TAB, VERSION_HEADERS, FIRST_MONTH, LAST_MONTH,
    CADENCES, CATEGORIES, KINDS, SPLITS, BillConflict, BillPlan, BillValidation,
    boolean, fingerprint, month_key, money_cents, VIRTUAL_SUBSCRIPTION_CATEGORIES,
)

BILL_HEADERS = ("bill_key", "display_name", "recurrence", "pull_day", "pull_months", "source_label",
                "account", "notes", "updated_at", "expected_amount", "tracking_mode", "source_range")
SUB_HEADERS = ("cadence", "name", "amount", "pull_day", "pull_month", "source_range", "updated_at", "kind", "account", "source_label")


def header(rows: list[list[str]]) -> list[str]:
    result = [re.sub(r"[^a-z0-9]+", "_", str(x).strip().casefold()).strip("_") for x in (rows[0] if rows else [])]
    while result and not result[-1]:
        result.pop()
    nonempty = [x for x in result if x]
    if len(set(nonempty)) != len(nonempty):
        raise BillConflict("The bill schedule has duplicate headers. Check it before saving.")
    return result


def managed(rows: list[list[str]]) -> bool:
    headers = header(rows)
    if not {"plan_id", "effective_from", "effective_until"} & set(headers):
        return False
    present = set(VERSION_HEADERS) & set(headers)
    if present and present != set(VERSION_HEADERS):
        raise BillConflict("Bill history columns are incomplete. Check the schedule before saving.")
    return bool(present)


def fields(rows: list[list[str]]) -> list[dict[str, str]]:
    names = header(rows)
    return [{key: str(row[i]).strip() if i < len(row) else "" for i, key in enumerate(names) if key}
            for row in rows[1:] if any(str(x).strip() for x in row)]


def decode(rows: list[list[str]], tab: str) -> list[BillPlan]:
    if tab not in {BILL_TAB, SUBSCRIPTION_TAB} or not managed(rows):
        raise BillConflict("The managed bill schedule is unavailable.")
    result = []
    try:
        for item in fields(rows):
            identity = item["plan_id"]
            if not re.fullmatch(r"[A-Za-z0-9_-]{6,96}", identity):
                raise ValueError("identity")
            kind, cadence, category, split = item["bill_type"], item.get("cadence", item.get("recurrence", "")), item["category"], item["split_method"]
            if kind not in KINDS or cadence not in CADENCES or category not in CATEGORIES or split not in SPLITS:
                raise ValueError("type")
            start, end = month_key(item["effective_from"]), month_key(item["effective_until"])
            if start >= end:
                raise ValueError("interval")
            day = int(item.get("pull_day") or 0)
            months = tuple(int(x) for x in (item.get("pull_months") or item.get("pull_month") or "").split(",") if x)
            if not 0 <= day <= 31 or any(not 1 <= x <= 12 for x in months) or len(set(months)) != len(months):
                raise ValueError("date")
            incomplete_baseline = item["request_id"] == "baseline" and (day == 0 or cadence != "monthly" and not months)
            if not incomplete_baseline and (cadence == "yearly" and len(months) != 1 or cadence == "quarterly" and len(months) != 4):
                raise ValueError("months")
            if cadence == "quarterly" and months and any((sorted(months)[(i + 1) % 4] - sorted(months)[i]) % 12 != 3 for i in range(4)):
                raise ValueError("quarters")
            basis = int(item["payer_basis_points"])
            if not 0 <= basis <= 10000:
                raise ValueError("split")
            name = item.get("name") or item.get("display_name", "")
            source = item.get("source_label") or name
            if not name or not source or not item["version"]:
                raise ValueError("name")
            split_start = date.fromisoformat(item["split_starts_on"]).isoformat()
            result.append(BillPlan(identity, kind, name,
                money_cents(item.get("amount") if tab == SUBSCRIPTION_TAB else item.get("expected_amount"), optional=True),
                cadence, day, tuple(sorted(months)), category, item.get("account", ""), source, tab,
                item.get("source_range", ""), start, end, boolean(item["active"]), split, basis,
                item["version"], item["request_id"], boolean(item["monthly_source"])
                or kind != "subscription" or category not in VIRTUAL_SUBSCRIPTION_CATEGORIES, split_start))
    except (BillValidation, KeyError, TypeError, ValueError) as exc:
        raise BillConflict("A saved bill version is invalid. Check its schedule before changing it.") from exc
    grouped: dict[str, list[BillPlan]] = {}
    for plan in result:
        grouped.setdefault(plan.id, []).append(plan)
    for versions in grouped.values():
        ordered = sorted(versions, key=lambda x: x.effective_from)
        if any(a.effective_until > b.effective_from for a, b in zip(ordered, ordered[1:])):
            raise BillConflict("A bill has overlapping versions. Check its schedule before changing it.")
    return result


def _identity(owner: str, tab: str, value: str) -> str:
    return "bill_" + fingerprint([owner, tab, value])[:24]


def legacy_plans(owner: str, bill_rows: list[list[str]], subscription_rows: list[list[str]]) -> list[BillPlan]:
    """Prepare baselines from the existing authoritative sources without writes."""
    from bookiebot.sheets.bills import RETIRED_BILL_KEYS, _parse_day, _parse_pull_months, _parse_recurrence, _slug
    from bookiebot.sheets.subscriptions import _parse_visible_subscription_schedule_drafts

    result = []
    names = header(bill_rows)
    for row_number, raw in enumerate(bill_rows[1:], 2):
        if not any(str(value).strip() for value in raw):
            continue
        item = {key: str(raw[i]).strip() if i < len(raw) else "" for i, key in enumerate(names) if key}
        name = item.get("display_name", "")
        if not name:
            raise BillConflict("A bill is missing its name. Check the bill schedule.")
        source = item.get("source_label") or name
        amount = money_cents(item.get("expected_amount"), optional=True)
        mode = item.get("tracking_mode") or "manual"
        if mode not in {"automatic", "manual"}:
            raise BillConflict("A bill has an invalid tracking mode.")
        if ({_slug(item.get("bill_key", "")), _slug(source)} & RETIRED_BILL_KEYS and amount is None and mode == "manual"):
            continue
        cadence = _parse_recurrence(item.get("recurrence", ""))
        if cadence is None:
            raise BillConflict("A bill has an invalid frequency. Check its schedule.")
        normalized = re.sub(r"[^a-z0-9]", "", source.casefold())
        # Rent's missing legacy tracking flag does not make its price variable.
        # Classification alone does not enroll a schedule or invent an amount.
        kind = "fixed" if mode == "automatic" or normalized == "rent" else "variable"
        category = "rent" if normalized == "rent" else "static_bills_subscriptions_needs" if kind == "fixed" else "bills_utilities"
        result.append(BillPlan(_identity(owner, BILL_TAB, item.get("bill_key") or source), kind, name, amount,
            cadence, _parse_day(item.get("pull_day", "")) or 0, _parse_pull_months(item.get("pull_months", "")),
            category, item.get("account", ""), source, BILL_TAB,
            item.get("source_range") or f"{BILL_TAB}!A{row_number}:{get_column_letter(len(names))}{row_number}",
            split_method="none", monthly_source=True))
    for sub in _parse_visible_subscription_schedule_drafts(subscription_rows):
        result.append(BillPlan(_identity(owner, SUBSCRIPTION_TAB, sub.source_range or sub.id), "subscription",
            sub.name, money_cents(f"{sub.amount:.2f}"), sub.cadence, sub.pull_day or 0,
            (sub.pull_month,) if sub.pull_month else (),
            "subscriptions_wants" if sub.kind.casefold() in {"want", "wants"} else "static_bills_subscriptions_needs",
            sub.account, sub.name, SUBSCRIPTION_TAB, sub.source_range))
    for plan in result:
        if sum(p.source_label.casefold() == plan.source_label.casefold() for p in result) > 1:
            raise BillConflict("Two bills share the same source name. Resolve the duplicate before saving.")
    return [replace(p, version=fingerprint(asdict(p)), request_id="baseline") for p in result]


def encode(plans: list[BillPlan], tab: str, original: list[list[str]]) -> list[list[str]]:
    """Retain unknown columns and row metadata while adding versioned records."""
    base = BILL_HEADERS if tab == BILL_TAB else SUB_HEADERS
    names = header(original)
    width = max([len(names), *(max((i + 1 for i, value in enumerate(row) if str(value).strip()), default=0) for row in original)])
    names += [""] * (width - len(names))
    display_headers = [(original[0][i] if original and i < len(original[0]) else "") for i in range(width)]
    missing = [name for name in (*base, *VERSION_HEADERS) if name not in names]
    display_headers += missing
    names += [name for name in (*base, *VERSION_HEADERS) if name not in names]
    old_names = header(original)
    existing = [({key: str(row[i]).strip() if i < len(row) else "" for i, key in enumerate(old_names) if key}, row)
                for row in original[1:] if any(str(x).strip() for x in row)]
    result = [display_headers]
    for plan in plans:
        if plan.source_tab != tab:
            continue
        prior = next(((item, raw) for item, raw in existing if item.get("plan_id") == plan.id and item.get("version") == plan.version), None)
        if prior is None:
            prior = next(((item, raw) for item, raw in existing if item.get("plan_id") == plan.id), None)
        if prior is None:
            matches = [(item, raw) for item, raw in existing if not item.get("plan_id") and
                       ((tab == BILL_TAB and (item.get("source_label") or item.get("display_name")) == plan.source_label)
                        or (tab == SUBSCRIPTION_TAB and plan.source_range and item.get("source_range") == plan.source_range))]
            if len(matches) > 1:
                raise BillConflict("The original bill row is ambiguous. Refresh before saving.")
            prior = matches[0] if matches else ({}, [])
        old, raw = prior
        item: dict[str, Any] = {"name": plan.name, "display_name": plan.name,
            "cadence": plan.cadence, "recurrence": plan.cadence, "pull_day": str(plan.pull_day or ""),
            "pull_month": str(plan.pull_months[0]) if plan.cadence == "yearly" else "",
            "pull_months": ",".join(map(str, plan.pull_months)), "source_label": plan.source_label,
            "amount": "" if plan.amount_cents is None else f"{plan.amount_cents / 100:.2f}",
            "expected_amount": "" if plan.amount_cents is None else f"{plan.amount_cents / 100:.2f}",
            "source_range": plan.source_range, "account": plan.account,
            "kind": "Wants" if plan.category == "subscriptions_wants" else "Needs",
            "tracking_mode": "manual" if plan.kind == "variable" else "automatic",
            "bill_key": old.get("bill_key") or re.sub(r"[^a-z0-9]+", "_", plan.source_label.casefold()).strip("_"),
            "plan_id": plan.id, "bill_type": plan.kind, "effective_from": plan.effective_from,
            "effective_until": plan.effective_until, "active": str(plan.active).upper(),
            "category": plan.category, "split_method": plan.split_method,
            "payer_basis_points": str(plan.payer_basis_points), "version": plan.version,
            "request_id": plan.request_id, "monthly_source": str(plan.monthly_source).upper(),
            "split_starts_on": plan.split_starts_on}
        result.append([str(item[name]) if name in item else str(raw[i]) if i < len(raw) else ""
                       for i, name in enumerate(names)])
    return result


def runtime_tables(owner: str, bill_rows: list[list[str]], subscription_schedule: list[list[str]],
                   visible_subscriptions: list[list[str]], charge_rows: list[list[str]] | None = None,
                   ) -> tuple[list[list[str]], list[list[str]], bool]:
    """Read-only compatibility views; retain every version for period selectors.

    Each hidden tab can be enrolled independently. Legacy subscription mirrors
    remain caches until that subscription source is explicitly migrated.
    Monthly-source subscriptions appear in the bill view exactly once.
    """
    from bookiebot.sheets.recurring_charges import decode_charges, following_month
    charges = decode_charges(charge_rows or [])
    bill_managed, sub_managed = managed(bill_rows), managed(subscription_schedule)
    if not bill_managed and not sub_managed and not charges:
        return bill_rows, visible_subscriptions, False
    bills = decode(bill_rows, BILL_TAB) if bill_managed else legacy_plans(owner, bill_rows, [])
    subs = decode(subscription_schedule, SUBSCRIPTION_TAB) if sub_managed else legacy_plans(owner, [], visible_subscriptions)
    if {p.id for p in bills} & {p.id for p in subs}:
        raise BillConflict("The bill schedules contain a duplicated identity. Refresh before making changes.")
    monthly, virtual = [], []
    for plan in [*bills, *subs]:
        enrolled = bill_managed if plan.source_tab == BILL_TAB else sub_managed
        view = replace(plan, source_range="billplan:" + plan.id) if enrolled else plan
        if plan.monthly_source:
            adopted = [c for c in charges if c.plan_id == plan.id and plan.effective_from <= c.month < plan.effective_until]
            portions = [replace(view, source_tab=BILL_TAB)]
            for charge in sorted(adopted, key=lambda c: c.month):
                end = following_month(charge.month)
                remaining = []
                for part in portions:
                    if charge.month >= part.effective_until or end <= part.effective_from:
                        remaining.append(part)
                        continue
                    if part.effective_from < charge.month:
                        remaining.append(replace(part, effective_until=charge.month))
                    if end < part.effective_until:
                        remaining.append(replace(part, effective_from=end))
                portions = remaining
                monthly.append(replace(view, source_tab=BILL_TAB, effective_from=charge.month, effective_until=end,
                    pull_day=date.fromisoformat(charge.charge_date).day, cadence="monthly", pull_months=()))
            monthly.extend(portions)
        else:
            portions = [view]
            for charge in sorted((c for c in charges if c.plan_id == plan.id and
                                  plan.effective_from <= c.month < plan.effective_until), key=lambda c: c.month):
                end = following_month(charge.month)
                remaining = []
                for part in portions:
                    if charge.month >= part.effective_until or end <= part.effective_from:
                        remaining.append(part)
                        continue
                    if part.effective_from < charge.month:
                        remaining.append(replace(part, effective_until=charge.month))
                    if end < part.effective_until:
                        remaining.append(replace(part, effective_from=end))
                portions = remaining
                monthly.append(replace(view, source_tab=BILL_TAB, monthly_source=True,
                    effective_from=charge.month, effective_until=end, pull_day=date.fromisoformat(charge.charge_date).day,
                    cadence="monthly", pull_months=(), source_label=charge.source_label, category=charge.category))
            virtual.extend(replace(p, source_tab=SUBSCRIPTION_TAB) for p in portions)
    for charge in charges:
        if any(p.id == charge.plan_id for p in [*bills, *subs]):
            continue
        # A generated recipient source has no owner-editable recurring plan.
        # It can count confirmed cash but must never project a new charge.
        monthly.append(BillPlan(charge.plan_id, "variable", charge.source_label, None, "monthly",
            date.fromisoformat(charge.charge_date).day, (), charge.category, "", charge.source_label, BILL_TAB,
            "billplan-receipt:" + charge.plan_id, charge.month, following_month(charge.month), active=False,
            version=fingerprint(charge.__dict__), monthly_source=True))
    return encode(monthly, BILL_TAB, bill_rows), encode(virtual, SUBSCRIPTION_TAB, subscription_schedule), True


def period_rows(rows: list[list[str]], period: str) -> list[list[str]]:
    """Keep inactive versions for recorded cash, but never mix price versions."""
    if not managed(rows):
        return rows
    period = month_key(period)
    names = header(rows)
    start, end = names.index("effective_from"), names.index("effective_until")
    return [rows[0], *(row for row in rows[1:] if len(row) > max(start, end)
                      and row[start] <= period < row[end])]


def with_recorded_months(rows: list[list[str]], charges: list[list[str]], allocations: list[dict[str, Any]],
                         *, owner: str, year: int) -> list[list[str]]:
    """Zero confirmed cash is still a recorded charge, never a new estimate."""
    if not rows:
        return rows
    from bookiebot.sheets.recurring_charges import decode_charges
    from bookiebot.sheets.bills import bill_label_key
    names = header(rows)
    index = names.index("recorded_months") if "recorded_months" in names else len(names)
    result = [list(rows[0]) + (["recorded_months"] if index == len(names) else [])]
    recorded = decode_charges(charges)
    for item, raw in zip(fields(rows), (r for r in rows[1:] if any(str(v).strip() for v in r))):
        months = {c.month for c in recorded if c.recorded and c.plan_id == item.get("plan_id")}
        for value in allocations:
            if (value["payerOwner"] == owner and value.get("lifecycle", "active") == "active"
                    and value["sourceYear"] == year and value["sourceWorksheet"] == "income"
                    and (value["billPlanId"] == item.get("plan_id") if value.get("billPlanId") else
                         bill_label_key(value.get("sourceValues", {}).get("item") or value.get("item") or value["category"]) == bill_label_key(item.get("source_label", "")))):
                months.add(value["expenseDate"][:7])
        line = list(raw) + [""] * max(0, index + 1 - len(raw))
        line[index] = ",".join(sorted(months))
        result.append(line)
    return result
