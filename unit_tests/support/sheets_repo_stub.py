from __future__ import annotations

import contextlib
from dataclasses import dataclass
from typing import Iterable, List, Sequence


@dataclass
class Cell:
    row: int
    col: int
    value: str


class InMemoryWorksheet:
    """
    Tiny subset of the gspread Worksheet API that the bot relies on.
    All values are stored as strings, mirroring what gspread returns.
    """

    def __init__(self, rows: Sequence[Sequence[str]] | None = None, title: str = "Sheet"):
        self.title = title
        self._rows: List[List[str]] = [list(map(str, row)) for row in rows or []]

    def _ensure_position(self, row: int, col: int) -> tuple[int, int]:
        while len(self._rows) < row:
            self._rows.append([])
        row_idx = row - 1
        while len(self._rows[row_idx]) < col:
            self._rows[row_idx].append("")
        return row_idx, col - 1

    def get_all_values(self) -> List[List[str]]:
        return [row.copy() for row in self._rows]

    def col_values(self, col: int) -> List[str]:
        values = []
        for row in self._rows:
            if col <= len(row):
                values.append(row[col - 1])
            else:
                values.append("")
        return values

    def cell(self, row: int, col: int) -> Cell:
        row_idx, col_idx = self._ensure_position(row, col)
        return Cell(row=row, col=col, value=self._rows[row_idx][col_idx])

    def find(self, needle: str) -> Cell:
        needle_lower = str(needle).lower()
        for r, row in enumerate(self._rows, start=1):
            for c, value in enumerate(row, start=1):
                if needle_lower in str(value).lower():
                    return Cell(row=r, col=c, value=value)
        raise ValueError(f"Value '{needle}' not found in sheet '{self.title}'.")

    def insert_row(self, values: Iterable[str], index: int) -> None:
        idx = max(index - 1, 0)
        row = [str(v) for v in values]
        self._rows.insert(idx, row)

    def update_cell(self, row: int, col: int, value: str) -> None:
        row_idx, col_idx = self._ensure_position(row, col)
        self._rows[row_idx][col_idx] = str(value)


class SheetsRepoStub:
    """
    Convenience wrapper exposing the three worksheets the production code uses.
    Tests can patch sheets_auth.get_*_worksheet with these instances.
    """

    def __init__(
        self,
        *,
        expense_rows: Sequence[Sequence[str]] | None = None,
        income_rows: Sequence[Sequence[str]] | None = None,
        subscriptions_rows: Sequence[Sequence[str]] | None = None,
    ):
        self.expense = InMemoryWorksheet(expense_rows, title="Expense")
        self.income = InMemoryWorksheet(income_rows, title="Income")
        self.subscriptions = InMemoryWorksheet(subscriptions_rows, title="Subscriptions")

    @contextlib.contextmanager
    def patched(self):
        from sheets_repo import get_sheets_repo, override_sheets_repo

        previous = get_sheets_repo()
        override_sheets_repo(self)
        try:
            yield self
        finally:
            override_sheets_repo(previous)

    # SheetsRepository interface
    def expense_sheet(self):
        return self.expense

    def income_sheet(self):
        return self.income

    def subscriptions_sheet(self):
        return self.subscriptions
