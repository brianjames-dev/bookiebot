from __future__ import annotations

import contextlib
from dataclasses import dataclass
import re
from typing import Iterable, List, Sequence

from openpyxl.utils import column_index_from_string, get_column_letter


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
        self.update_calls = 0
        self.update_cell_calls = 0

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

    def append_row(self, values: Iterable[str]) -> None:
        self._rows.append([str(v) for v in values])

    def delete_rows(self, start_index: int, end_index: int | None = None) -> None:
        start = max(start_index - 1, 0)
        end = start if end_index is None else max(end_index - 1, start)
        del self._rows[start : end + 1]

    def update_cell(self, row: int, col: int, value: str) -> None:
        self.update_cell_calls += 1
        row_idx, col_idx = self._ensure_position(row, col)
        self._rows[row_idx][col_idx] = str(value)

    def update(self, values, range_name: str | None = None, **_kwargs) -> None:
        self.update_calls += 1
        if range_name is None:
            start_row = 1
            start_col = 1
        else:
            start_a1 = range_name.split(":", 1)[0]
            start_row, start_col = self._parse_a1(start_a1)
        for row_offset, row_values in enumerate(values):
            for col_offset, value in enumerate(row_values):
                row_idx, col_idx = self._ensure_position(start_row + row_offset, start_col + col_offset)
                self._rows[row_idx][col_idx] = str(value)

    def _parse_a1(self, a1: str) -> tuple[int, int]:
        match = re.match(r"^([A-Za-z]+)(\d+)$", a1)
        if not match:
            raise ValueError(f"Invalid A1 reference: {a1}")
        col_letters, row_str = match.groups()
        col = column_index_from_string(col_letters)
        row = int(row_str)
        return row, col

    def acell(self, a1: str) -> Cell:
        row, col = self._parse_a1(a1)
        return self.cell(row, col)

    def update_acell(self, a1: str, value: str) -> None:
        row, col = self._parse_a1(a1)
        self.update_cell(row, col, value)


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
        subscription_schedule_rows: Sequence[Sequence[str]] | None = None,
        bill_schedule_rows: Sequence[Sequence[str]] | None = None,
        action_log_rows: Sequence[Sequence[str]] | None = None,
    ):
        self.expense = InMemoryWorksheet(expense_rows, title="Expense")
        self.income = InMemoryWorksheet(income_rows, title="Income")
        self.subscriptions = InMemoryWorksheet(subscriptions_rows, title="Subscriptions")
        self.subscription_schedule = InMemoryWorksheet(
            subscription_schedule_rows,
            title="_BookieBot Subscription Schedule",
        )
        self.bill_schedule = InMemoryWorksheet(
            bill_schedule_rows,
            title="_BookieBot Bill Schedule",
        )
        self.action_log = InMemoryWorksheet(action_log_rows, title="_BookieBot Action Log")

    @contextlib.contextmanager
    def patched(self):
        from bookiebot.sheets.repo import get_sheets_repo, override_sheets_repo

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

    def subscription_schedule_sheet(self):
        return self.subscription_schedule

    def bill_schedule_sheet(self):
        return self.bill_schedule

    def action_log_sheet(self):
        return self.action_log
