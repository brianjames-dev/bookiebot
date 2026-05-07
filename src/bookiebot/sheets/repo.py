from __future__ import annotations

from typing import Protocol, Any

from bookiebot.sheets.auth import (
    get_action_log_worksheet,
    get_expense_worksheet,
    get_income_worksheet,
    get_subscriptions_worksheet,
)


class SheetsRepository(Protocol):
    def expense_sheet(self) -> Any:
        ...

    def income_sheet(self) -> Any:
        ...

    def subscriptions_sheet(self) -> Any:
        ...

    def action_log_sheet(self) -> Any:
        ...


class GSpreadSheetsRepository:
    """Production repository that simply delegates to sheets_auth helpers."""

    def expense_sheet(self):
        return get_expense_worksheet()

    def income_sheet(self):
        return get_income_worksheet()

    def subscriptions_sheet(self):
        return get_subscriptions_worksheet()

    def action_log_sheet(self):
        return get_action_log_worksheet()


_REPO: SheetsRepository = GSpreadSheetsRepository()


def get_sheets_repo() -> SheetsRepository:
    return _REPO


def override_sheets_repo(repo: SheetsRepository) -> None:
    global _REPO
    _REPO = repo
