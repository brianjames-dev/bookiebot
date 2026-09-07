"""Read-only worksheet transport adapters used by financial reports.

Report assembly chooses the owner, workbook, and months. These helpers only
look up existing sheets and return their formatted values; they never provision
worksheets or cache mutable financial data.
"""

import calendar
from collections.abc import Iterable
from typing import Any

from gspread.utils import absolute_range_name, fill_gaps


def read_workbook_tabs(gc: Any, spreadsheet_id: str, titles: Iterable[str]) -> dict[str, list[list[str]]]:
    """Read existing requested tabs in one metadata call and one values batch.

    Use the HTTP transport directly: opening a gspread Spreadsheet and then
    looking up each Worksheet repeats metadata requests. Missing optional tabs
    are omitted; failed or incomplete reads never masquerade as empty rows.
    """
    transport = gc.http_client
    metadata = transport.fetch_sheet_metadata(spreadsheet_id)
    sheets = metadata.get("sheets") if isinstance(metadata, dict) else None
    if not isinstance(sheets, list):
        raise ValueError("Incomplete workbook metadata")
    available: set[str] = set()
    for sheet in sheets:
        properties = sheet.get("properties") if isinstance(sheet, dict) else None
        title = properties.get("title") if isinstance(properties, dict) else None
        if not isinstance(title, str) or not title or title in available:
            raise ValueError("Invalid workbook tab metadata")
        available.add(title)
    selected = list(dict.fromkeys(title for title in titles if title in available))
    if not selected:
        return {}
    result = transport.values_batch_get(spreadsheet_id, [absolute_range_name(title) for title in selected],
                                        params={"valueRenderOption": "FORMATTED_VALUE"})
    ranges = result.get("valueRanges") if isinstance(result, dict) else None
    if not isinstance(ranges, list) or len(ranges) != len(selected):
        raise ValueError("Incomplete workbook values response")
    rows_by_title = {}
    for title, value_range in zip(selected, ranges):
        reported_range = value_range.get("range") if isinstance(value_range, dict) else None
        if not isinstance(reported_range, str):
            raise ValueError("Missing workbook values range")
        reported_title = reported_range.rsplit("!", 1)[0]
        if reported_title.startswith("'") and reported_title.endswith("'"):
            reported_title = reported_title[1:-1].replace("''", "'")
        if reported_title != title:
            raise ValueError("Workbook values did not match the requested tab")
        rows = value_range.get("values", [[]])
        if not isinstance(rows, list) or not all(isinstance(row, list) and all(
            isinstance(cell, (str, int, float, bool)) for cell in row
        ) for row in rows):
            raise ValueError("Invalid workbook values response")
        rows_by_title[title] = [[str(value) for value in row] for row in fill_gaps(rows or [[]])]
    return rows_by_title


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
