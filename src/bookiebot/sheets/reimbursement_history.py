"""Owner-scoped, read-only reimbursement history across configured annual books.

Annual books can contain copied ledger rows. Resolve lifecycle versions before
filtering outstanding items so a later receipt or cancellation never resurrects
an older debt. Missing tabs are empty; failed reads and malformed records are
explicitly incomplete, and callers that write must require complete coverage.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import os
import re
from typing import Any, Literal

from gspread.exceptions import WorksheetNotFound

from bookiebot.sheets.collaboration import (
    LEGACY_SHARED_REIMBURSEMENT_HEADERS,
    SHARED_REIMBURSEMENT_HEADERS,
    SharedAllocation,
    allocations_from_rows,
)
from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import (
    DEFAULT_YEARLY_SHEET_CONFIG,
    PACIFIC_TZ,
    actor_key_aliases,
    get_user_config,
    now_pacific,
    sheet_user_context,
)


class ReimbursementHistoryUnavailableError(RuntimeError):
    """A complete, unambiguous reimbursement ledger could not be read."""


@dataclass(frozen=True)
class ReimbursementLedger:
    year: int
    worksheet: Any
    rows: list[list[str]]


@dataclass(frozen=True)
class AllocationRecord:
    allocation: SharedAllocation
    worksheet: Any
    row_number: int
    year: int


@dataclass(frozen=True)
class ReimbursementHistory:
    records: tuple[AllocationRecord, ...]
    ledgers: tuple[ReimbursementLedger, ...]
    as_of: datetime
    years: tuple[int, ...]
    unavailable_years: tuple[int, ...] = ()
    excluded_records: int = 0

    @property
    def status(self) -> Literal["complete", "partial", "unavailable"]:
        if not self.unavailable_years and not self.excluded_records:
            return "complete"
        return "partial" if self.years else "unavailable"

    @property
    def outstanding_records(self) -> tuple[AllocationRecord, ...]:
        return tuple(
            record for record in self.records
            if record.allocation.status == "outstanding"
            and record.allocation.outstanding_amount > 0
            and (expense_date := _expense_date(record.allocation.expense_date)) is not None
            and expense_date <= self.as_of.date()
        )

    @property
    def received_records(self) -> tuple[AllocationRecord, ...]:
        """Keep settled expenses in the read-only ledger after their balance clears."""
        return tuple(
            record for record in self.records
            if record.allocation.status != "void"
            and record.allocation.outstanding_amount <= 0
            and (expense_date := _expense_date(record.allocation.expense_date)) is not None
            and expense_date <= self.as_of.date()
        )

    def require_complete(self) -> None:
        if self.status != "complete":
            raise ReimbursementHistoryUnavailableError(
                "Some reimbursement records could not be checked. Please try again before recording a payment."
            )

    def coverage_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "asOf": self.as_of.date().isoformat(),
            "years": list(self.years),
            "unavailableYears": list(self.unavailable_years),
            "excludedRecords": self.excluded_records,
        }


def configured_reimbursement_workbooks(actor_key: str, through_year: int) -> dict[int, str]:
    """Discover every configured payer book without requiring other owners' IDs."""
    owner = get_user_config(actor_key).budget_owner_key
    prefix = f"{owner.upper()}_BUDGET_SPREADSHEET_ID_"
    years = {year for year, config in DEFAULT_YEARLY_SHEET_CONFIG.items()
             if config.get(f"{owner}_budget_spreadsheet_id")}
    years.update(int(match.group(1)) for key in os.environ
                 if (match := re.fullmatch(re.escape(prefix) + r"(\d{4})", key)))
    years.add(through_year)
    return {
        year: os.getenv(
            f"{prefix}{year}",
            DEFAULT_YEARLY_SHEET_CONFIG.get(year, {}).get(f"{owner}_budget_spreadsheet_id", ""),
        ).strip()
        for year in sorted(years) if year <= through_year
    }


def read_reimbursement_history(actor_key: str, *, as_of: datetime | None = None) -> ReimbursementHistory:
    """Read existing annual ledgers; never provision tabs or cache financial rows."""
    current = _pacific(as_of or now_pacific())
    workbooks = configured_reimbursement_workbooks(actor_key, current.year)
    ledgers: list[ReimbursementLedger] = []
    years: list[int] = []
    unavailable: list[int] = []
    gc = None
    for year, spreadsheet_id in workbooks.items():
        if not spreadsheet_id:
            unavailable.append(year)
            continue
        try:
            if year == current.year:
                with sheet_user_context(actor_key):
                    worksheet = get_sheets_repo().find_shared_reimbursements_sheet()
            else:
                if gc is None:
                    from bookiebot.sheets.auth import get_gspread_client
                    gc = get_gspread_client()
                worksheet = gc.open_by_key(spreadsheet_id).worksheet("Shared Reimbursements")
            rows = [[str(value) for value in row] for row in worksheet.get_all_values()]
            ledgers.append(ReimbursementLedger(year, worksheet, rows))
            years.append(year)
        except WorksheetNotFound:
            years.append(year)
        except Exception:
            # A failed lookup is not evidence that the ledger is empty. Report
            # consumers show coverage; settlement callers require completeness.
            unavailable.append(year)
    return reimbursement_history_from_ledgers(
        actor_key, ledgers, as_of=current, years=years, unavailable_years=unavailable,
    )


def reimbursement_history_from_ledgers(
    actor_key: str,
    ledgers: list[ReimbursementLedger],
    *,
    as_of: datetime,
    years: list[int] | None = None,
    unavailable_years: list[int] | None = None,
) -> ReimbursementHistory:
    if not any(any(value.strip() for row in ledger.rows for value in row) for ledger in ledgers):
        return ReimbursementHistory(
            records=(), ledgers=tuple(ledgers), as_of=_pacific(as_of),
            years=tuple(sorted(set(years if years is not None else [ledger.year for ledger in ledgers]))),
            unavailable_years=tuple(sorted(set(unavailable_years or []))),
        )
    owner = get_user_config(actor_key).budget_owner_key
    aliases = actor_key_aliases(actor_key)
    selected: dict[str, AllocationRecord] = {}
    invalid_ids: set[str] = set()
    excluded = 0
    for ledger in sorted(ledgers, key=lambda item: item.year):
        rows = ledger.rows
        if not rows or not any(any(value.strip() for value in row) for row in rows):
            continue
        if rows[0][:len(LEGACY_SHARED_REIMBURSEMENT_HEADERS)] != LEGACY_SHARED_REIMBURSEMENT_HEADERS:
            excluded += max(1, len(rows) - 1)
            # Unknown column order cannot be safely interpreted as allocations.
            continue
        seen: set[str] = set()
        for row_number, row in enumerate(rows[1:], start=2):
            if not any(value.strip() for value in row):
                continue
            padded = list(row) + [""] * len(SHARED_REIMBURSEMENT_HEADERS)
            row_owner = padded[4].strip()
            if row_owner != owner:
                # The payer owns this ledger even for a fully fronted expense.
                # Another mapped owner's row is out of scope. An unknown owner
                # is malformed; do not imply that this personal ledger is whole.
                if row_owner not in {"brian", "hannah"}:
                    excluded += 1
                continue
            allocation_id = padded[0].strip()
            allocation = _validated_allocation(padded) if padded[3].strip() in aliases else None
            if allocation is None or allocation_id in seen:
                excluded += 1
                if allocation_id:
                    invalid_ids.add(allocation_id)
                continue
            seen.add(allocation_id)
            candidate = AllocationRecord(allocation, ledger.worksheet, row_number, ledger.year)
            previous = selected.get(allocation_id)
            if (
                previous is not None
                and _version(candidate)[0] == _version(previous)[0]
                and replace(candidate.allocation, source_row=0) != replace(previous.allocation, source_row=0)
            ):
                # Equal update times cannot establish which conflicting copy is
                # authoritative. A later workbook must not revive a paid debt.
                excluded += 1
                invalid_ids.add(allocation_id)
                continue
            if previous is None or _version(candidate) > _version(previous):
                selected[allocation_id] = candidate
    records = sorted(
        (record for key, record in selected.items() if key not in invalid_ids),
        key=lambda record: (_expense_date(record.allocation.expense_date) or date.min, record.allocation.allocation_id),
    )
    return ReimbursementHistory(
        records=tuple(records), ledgers=tuple(ledgers), as_of=_pacific(as_of),
        years=tuple(sorted(set(years if years is not None else [ledger.year for ledger in ledgers]))),
        unavailable_years=tuple(sorted(set(unavailable_years or []))), excluded_records=excluded,
    )


def _validated_allocation(row: list[str]) -> SharedAllocation | None:
    if not row[0].strip() or row[19] not in {"outstanding", "reimbursed", "void"}:
        return None
    if _expense_date(row[12]) is None or _timestamp(row[1]) is None or _timestamp(row[2]) is None:
        return None
    try:
        amounts = [Decimal(row[index].replace("$", "").replace(",", "").strip()) for index in (15, 17, 18, 20)]
        if any(not amount.is_finite() or amount < 0 or amount != amount.quantize(Decimal("0.01")) for amount in amounts):
            return None
        gross, personal, partner, received = amounts
        if gross <= 0 or personal + partner != gross or received > partner:
            return None
        if row[19] == "reimbursed" and received != partner:
            return None
        if int(row[11]) <= 0:
            return None
    except (InvalidOperation, ValueError):
        return None
    allocations = allocations_from_rows([row], include_void=True)
    return allocations[0] if len(allocations) == 1 else None


def _expense_date(value: str) -> date | None:
    for format in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), format).date()
        except ValueError:
            continue
    return None


def _pacific(value: datetime) -> datetime:
    return value.replace(tzinfo=PACIFIC_TZ) if value.tzinfo is None else value.astimezone(PACIFIC_TZ)


def _timestamp(value: str) -> datetime | None:
    try:
        return _pacific(datetime.fromisoformat(value.strip()))
    except ValueError:
        return None


def _version(record: AllocationRecord) -> tuple[datetime, int]:
    return (_timestamp(record.allocation.updated_at) or datetime.min.replace(tzinfo=PACIFIC_TZ), record.year)
