from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
import logging
from typing import Any, Literal
from uuid import uuid4

from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import actor_key_aliases, get_user_config, now_pacific
from bookiebot.sheets.utils import clean_money


logger = logging.getLogger(__name__)

SplitMethod = Literal["income", "equal"]
AllocationStatus = Literal["outstanding", "reimbursed", "void"]

BRIAN_ANNUAL_INCOME = Decimal("156000")
HANNAH_ANNUAL_INCOME = Decimal("85000")
HOUSEHOLD_ANNUAL_INCOME = BRIAN_ANNUAL_INCOME + HANNAH_ANNUAL_INCOME

SHARED_REIMBURSEMENT_HEADERS = [
    "allocation_id",
    "created_at",
    "updated_at",
    "actor_key",
    "owner_key",
    "payer",
    "partner",
    "source_action_id",
    "split_action_id",
    "source_worksheet",
    "source_category",
    "source_row",
    "expense_date",
    "item",
    "location",
    "gross_amount",
    "split_method",
    "payer_share",
    "partner_share",
    "status",
    "received_amount",
    "received_at",
]


@dataclass(frozen=True)
class SharedAllocation:
    allocation_id: str
    created_at: str
    updated_at: str
    actor_key: str
    owner_key: str
    payer: str
    partner: str
    source_action_id: str
    split_action_id: str
    source_worksheet: str
    source_category: str
    source_row: int
    expense_date: str
    item: str
    location: str
    gross_amount: float
    split_method: SplitMethod
    payer_share: float
    partner_share: float
    status: AllocationStatus = "outstanding"
    received_amount: float = 0.0
    received_at: str = ""

    @property
    def outstanding_amount(self) -> float:
        if self.status == "void":
            return 0.0
        return round(max(self.partner_share - self.received_amount, 0.0), 2)


def normalize_split_method(value: Any) -> SplitMethod | None:
    normalized = str(value or "").strip().lower().replace("_", " ")
    if normalized in {"income", "by income", "income based", "income-based", "proportional"}:
        return "income"
    if normalized in {"equal", "even", "evenly", "50/50", "50 50", "half"}:
        return "equal"
    return None


def split_method_label(method: SplitMethod) -> str:
    return "By income" if method == "income" else "50/50"


def payer_owner_from_person(person: Any, actor_key: str | None) -> str:
    normalized = str(person or "").strip().lower()
    if normalized.startswith("hannah"):
        return "hannah"
    if normalized.startswith("brian"):
        return "brian"
    return get_user_config(actor_key).budget_owner_key


def split_amounts(gross_amount: Any, method: SplitMethod, payer_owner: str) -> tuple[float, float]:
    gross = Decimal(str(clean_money(str(gross_amount)))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if gross <= 0:
        raise ValueError("Split expenses must have an amount greater than zero.")
    if method == "equal":
        ratio = Decimal("0.5")
    elif payer_owner == "hannah":
        ratio = HANNAH_ANNUAL_INCOME / HOUSEHOLD_ANNUAL_INCOME
    else:
        ratio = BRIAN_ANNUAL_INCOME / HOUSEHOLD_ANNUAL_INCOME
    payer_share = (gross * ratio).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    partner_share = gross - payer_share
    return float(payer_share), float(partner_share)


def new_allocation(
    *,
    actor_key: str | None,
    payer: str,
    source_action_id: str,
    source_worksheet: str,
    source_category: str,
    source_row: int,
    expense_date: str,
    item: str,
    location: str,
    gross_amount: float,
    split_method: SplitMethod,
    payer_share: float,
    partner_share: float,
) -> SharedAllocation:
    owner_key = payer_owner_from_person(payer, actor_key)
    timestamp = now_pacific().isoformat(timespec="seconds")
    return SharedAllocation(
        allocation_id=uuid4().hex[:12],
        created_at=timestamp,
        updated_at=timestamp,
        actor_key=str(actor_key or ""),
        owner_key=owner_key,
        payer=payer or owner_key.title(),
        partner="Brian" if owner_key == "hannah" else "Hannah",
        source_action_id=source_action_id,
        split_action_id="",
        source_worksheet=source_worksheet,
        source_category=source_category,
        source_row=source_row,
        expense_date=expense_date,
        item=item,
        location=location,
        gross_amount=round(float(gross_amount), 2),
        split_method=split_method,
        payer_share=round(float(payer_share), 2),
        partner_share=round(float(partner_share), 2),
    )


def _worksheet() -> Any:
    return get_sheets_repo().shared_reimbursements_sheet()


def _ensure_headers(ws: Any) -> None:
    rows = ws.get_all_values()
    current = rows[0] if rows else []
    if current[: len(SHARED_REIMBURSEMENT_HEADERS)] == SHARED_REIMBURSEMENT_HEADERS:
        return
    if any(str(value).strip() for value in current):
        raise RuntimeError("Shared Reimbursements has an unexpected header row.")
    if hasattr(ws, "update"):
        try:
            ws.update([SHARED_REIMBURSEMENT_HEADERS], range_name="A1:V1")
        except TypeError:
            ws.update("A1:V1", [SHARED_REIMBURSEMENT_HEADERS])
        return
    for column, value in enumerate(SHARED_REIMBURSEMENT_HEADERS, start=1):
        ws.update_cell(1, column, value)


def _allocation_row(allocation: SharedAllocation) -> list[str]:
    return [
        allocation.allocation_id,
        allocation.created_at,
        allocation.updated_at,
        allocation.actor_key,
        allocation.owner_key,
        allocation.payer,
        allocation.partner,
        allocation.source_action_id,
        allocation.split_action_id,
        allocation.source_worksheet,
        allocation.source_category,
        str(allocation.source_row),
        allocation.expense_date,
        allocation.item,
        allocation.location,
        f"{allocation.gross_amount:.2f}",
        allocation.split_method,
        f"{allocation.payer_share:.2f}",
        f"{allocation.partner_share:.2f}",
        allocation.status,
        f"{allocation.received_amount:.2f}",
        allocation.received_at,
    ]


def append_allocation(allocation: SharedAllocation) -> None:
    ws = _worksheet()
    _ensure_headers(ws)
    ws.append_row(_allocation_row(allocation))


def _parse_allocation(row: list[str]) -> SharedAllocation | None:
    padded = list(row) + [""] * len(SHARED_REIMBURSEMENT_HEADERS)
    try:
        source_row = int(padded[11] or 0)
        method = normalize_split_method(padded[16])
        if not padded[0] or method is None:
            return None
        raw_status = padded[19].strip().lower()
        status: AllocationStatus = raw_status if raw_status in {"outstanding", "reimbursed", "void"} else "outstanding"  # type: ignore[assignment]
        return SharedAllocation(
            allocation_id=padded[0],
            created_at=padded[1],
            updated_at=padded[2],
            actor_key=padded[3],
            owner_key=padded[4],
            payer=padded[5],
            partner=padded[6],
            source_action_id=padded[7],
            split_action_id=padded[8],
            source_worksheet=padded[9],
            source_category=padded[10],
            source_row=source_row,
            expense_date=padded[12],
            item=padded[13],
            location=padded[14],
            gross_amount=clean_money(padded[15]),
            split_method=method,
            payer_share=clean_money(padded[17]),
            partner_share=clean_money(padded[18]),
            status=status,
            received_amount=clean_money(padded[20]),
            received_at=padded[21],
        )
    except (TypeError, ValueError):
        logger.warning("Skipping malformed shared reimbursement row", extra={"row": row})
        return None


def allocations_from_rows(rows: list[list[str]], *, include_void: bool = False) -> list[SharedAllocation]:
    data_rows = rows[1:] if rows and rows[0][: len(SHARED_REIMBURSEMENT_HEADERS)] == SHARED_REIMBURSEMENT_HEADERS else rows
    allocations = [allocation for row in data_rows if (allocation := _parse_allocation(row)) is not None]
    return [allocation for allocation in allocations if include_void or allocation.status != "void"]


def list_allocations(actor_key: str | None = None, *, include_void: bool = False) -> list[SharedAllocation]:
    try:
        ws = _worksheet()
        _ensure_headers(ws)
        rows = ws.get_all_values()[1:]
    except Exception:
        logger.exception("Failed to read shared reimbursements")
        return []
    aliases = actor_key_aliases(actor_key) if actor_key else set()
    allocations = allocations_from_rows(rows, include_void=include_void)
    return [
        allocation
        for allocation in allocations
        if (include_void or allocation.status != "void")
        and (not aliases or allocation.actor_key in aliases)
    ]


def allocation_by_id(allocation_id: str, actor_key: str | None = None) -> SharedAllocation | None:
    return next(
        (allocation for allocation in list_allocations(actor_key, include_void=True) if allocation.allocation_id == allocation_id),
        None,
    )


def allocation_for_source_action(source_action_id: str, actor_key: str | None = None) -> SharedAllocation | None:
    return next(
        (
            allocation
            for allocation in reversed(list_allocations(actor_key, include_void=False))
            if allocation.source_action_id == source_action_id or allocation.split_action_id == source_action_id
        ),
        None,
    )


def matching_outstanding_allocations(actor_key: str | None, match_text: str = "") -> list[SharedAllocation]:
    needles = [part for part in str(match_text or "").lower().split() if part]
    matches: list[SharedAllocation] = []
    for allocation in reversed(list_allocations(actor_key)):
        if allocation.status != "outstanding" or allocation.outstanding_amount <= 0:
            continue
        haystack = " ".join(
            (
                allocation.allocation_id,
                allocation.source_category,
                allocation.item,
                allocation.location,
                allocation.payer,
                allocation.partner,
            )
        ).lower()
        if not needles or all(needle in haystack for needle in needles):
            matches.append(allocation)
    return matches


def allocation_label(allocation: SharedAllocation) -> str:
    description = allocation.item or allocation.location or allocation.source_category or "Shared expense"
    if allocation.location and allocation.location.lower() not in description.lower():
        description = f"{description} at {allocation.location}"
    return f"{description} — ${allocation.outstanding_amount:.2f} owed by {allocation.partner}"


def _find_allocation_row(allocation_id: str) -> tuple[Any, int, SharedAllocation] | None:
    ws = _worksheet()
    _ensure_headers(ws)
    for row_number, row in enumerate(ws.get_all_values()[1:], start=2):
        allocation = _parse_allocation(row)
        if allocation and allocation.allocation_id == allocation_id:
            return ws, row_number, allocation
    return None


def update_allocation(allocation_id: str, **changes: Any) -> SharedAllocation | None:
    found = _find_allocation_row(allocation_id)
    if found is None:
        return None
    ws, row_number, allocation = found
    updated = replace(
        allocation,
        updated_at=now_pacific().isoformat(timespec="seconds"),
        **changes,
    )
    values = _allocation_row(updated)
    if hasattr(ws, "update"):
        try:
            ws.update([values], range_name=f"A{row_number}:V{row_number}")
        except TypeError:
            ws.update(f"A{row_number}:V{row_number}", [values])
    else:
        for column, value in enumerate(values, start=1):
            ws.update_cell(row_number, column, value)
    return updated


def remove_allocation(allocation_id: str) -> bool:
    found = _find_allocation_row(allocation_id)
    if found is None:
        return False
    ws, row_number, _allocation = found
    ws.delete_rows(row_number)
    return True


def mark_reimbursed(allocation_id: str, *, received_at: datetime | None = None) -> SharedAllocation | None:
    allocation = allocation_by_id(allocation_id)
    if allocation is None or allocation.status == "void":
        return None
    timestamp = (received_at or now_pacific()).isoformat(timespec="seconds")
    return update_allocation(
        allocation_id,
        status="reimbursed",
        received_amount=allocation.partner_share,
        received_at=timestamp,
    )


def void_allocation(allocation_id: str) -> SharedAllocation | None:
    return update_allocation(allocation_id, status="void")
