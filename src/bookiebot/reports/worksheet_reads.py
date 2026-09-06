"""Read-only worksheet transport adapters used by financial reports.

Report assembly chooses the owner, workbook, and months. These helpers only
look up existing sheets and return their formatted values; they never provision
worksheets or cache mutable financial data.
"""

import calendar
from collections.abc import Iterable
from typing import Any

from gspread.utils import absolute_range_name, fill_gaps


def optional_sheet(factory: Any) -> Any | None:
    try:
        return factory()
    except Exception:
        return None


def worksheet_by_name(spreadsheet: Any, title: str) -> Any | None:
    try:
        return spreadsheet.worksheet(title)
    except Exception:
        return None


def optional_spreadsheet_by_key(gc: Any, spreadsheet_id: str) -> Any | None:
    try:
        return gc.open_by_key(spreadsheet_id)
    except Exception:
        return None


def worksheet_rows(worksheet: Any) -> list[list[str]]:
    if worksheet is None:
        return []
    return [[str(value) for value in row] for row in worksheet.get_all_values()]


def monthly_worksheet_rows(
    spreadsheet: Any, month_numbers: Iterable[int],
) -> list[tuple[int, list[list[str]]]]:
    if callable(getattr(spreadsheet, "worksheets", None)) and callable(getattr(spreadsheet, "values_batch_get", None)):
        # Metadata identifies existing tabs so a missing month cannot fail the
        # values batch. Match get_all_values' formatted/evaluated cell values.
        titles = {worksheet.title for worksheet in spreadsheet.worksheets()}
        selected = [number for number in month_numbers if calendar.month_name[number] in titles]
        if not selected:
            return []
        result = spreadsheet.values_batch_get(
            [absolute_range_name(calendar.month_name[number]) for number in selected],
            params={"valueRenderOption": "FORMATTED_VALUE"},
        )
        ranges = result.get("valueRanges", [])
        if len(ranges) != len(selected):
            raise ValueError("Incomplete budget history values response")
        return [
            (number, [[str(value) for value in row] for row in fill_gaps(value_range.get("values", [[]]))])
            for number, value_range in zip(selected, ranges)
        ]

    # Lightweight repository adapters may expose only individual worksheets.
    history = []
    for number in month_numbers:
        worksheet = worksheet_by_name(spreadsheet, calendar.month_name[number])
        if worksheet is not None:
            history.append((number, worksheet_rows(worksheet)))
    return history
