from __future__ import annotations

from typing import Protocol, Any
from contextlib import contextmanager
from contextvars import ContextVar

from bookiebot.sheets.auth import (
    get_action_log_worksheet,
    get_bill_schedule_worksheet,
    get_expense_worksheet,
    get_existing_personal_worksheet,
    get_income_worksheet,
    get_shared_reimbursements_worksheet,
    get_subscription_schedule_worksheet,
    get_subscriptions_worksheet,
)


class SheetsRepository(Protocol):
    def expense_sheet(self) -> Any:
        ...

    def income_sheet(self) -> Any:
        ...

    def subscriptions_sheet(self) -> Any:
        ...

    def subscription_schedule_sheet(self) -> Any:
        ...

    def bill_schedule_sheet(self) -> Any:
        ...

    def action_log_sheet(self) -> Any:
        ...

    def shared_reimbursements_sheet(self) -> Any:
        ...

    def find_bill_schedule_sheet(self) -> Any:
        ...

    def find_shared_reimbursements_sheet(self) -> Any:
        ...


class GSpreadSheetsRepository:
    """Production repository that simply delegates to sheets_auth helpers."""

    def expense_sheet(self):
        return get_expense_worksheet()

    def income_sheet(self):
        return get_income_worksheet()

    def subscriptions_sheet(self):
        return get_subscriptions_worksheet()

    def subscription_schedule_sheet(self):
        return get_subscription_schedule_worksheet()

    def bill_schedule_sheet(self):
        return get_bill_schedule_worksheet()

    def action_log_sheet(self):
        return get_action_log_worksheet()

    def shared_reimbursements_sheet(self):
        return get_shared_reimbursements_worksheet()

    def find_bill_schedule_sheet(self):
        return get_existing_personal_worksheet("_BookieBot Bill Schedule")

    def find_shared_reimbursements_sheet(self):
        return get_existing_personal_worksheet("Shared Reimbursements")


_REPO: SheetsRepository = GSpreadSheetsRepository()
_SCOPED_REPO: ContextVar[SheetsRepository | None] = ContextVar("scoped_sheets_repository", default=None)


def get_sheets_repo() -> SheetsRepository:
    return _SCOPED_REPO.get() or _REPO


def override_sheets_repo(repo: SheetsRepository) -> None:
    global _REPO
    _REPO = repo


@contextmanager
def sheets_repository_context(repo: SheetsRepository):
    """Bind an explicit existing month to this worker without changing other users."""
    token = _SCOPED_REPO.set(repo)
    try:
        yield
    finally:
        _SCOPED_REPO.reset(token)


def scoped_sheet_period():
    return getattr(_SCOPED_REPO.get(), "period", None)


_SHEET_COMMAND_ID: ContextVar[str | None] = ContextVar("sheet_command_id", default=None)


@contextmanager
def sheet_command_context(request_id: str):
    token = _SHEET_COMMAND_ID.set(request_id)
    try:
        yield
    finally:
        _SHEET_COMMAND_ID.reset(token)


def sheet_command_id() -> str | None:
    return _SHEET_COMMAND_ID.get()
