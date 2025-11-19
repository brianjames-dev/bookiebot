from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Sequence

from openpyxl.utils import column_index_from_string

from unit_tests.support.sheets_repo_stub import SheetsRepoStub

DATE_FMT = "%m/%d/%Y"


def _resolve_placeholder(value):
    if isinstance(value, str) and value.startswith("__TODAY__"):
        offset_str = value.replace("__TODAY__", "")
        days = int(offset_str) if offset_str else 0
        target = datetime.now() + timedelta(days=days)
        return target.strftime(DATE_FMT)
    return value

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures"


def _normalize_sheet_rows(rows: Sequence, *, min_columns: int = 26) -> List[List[str]]:
    if not rows:
        return []

    if isinstance(rows[0], list):
        return [list(map(str, row)) for row in rows]

    # Rows defined as mappings of column letter -> value.
    max_col = min_columns
    for row in rows:
        for letter in row.keys():
            idx = column_index_from_string(letter)
            max_col = max(max_col, idx)

    normalized = []
    for row in rows:
        values = [""] * max_col
        for letter, value in row.items():
            idx = column_index_from_string(letter) - 1
            values[idx] = str(_resolve_placeholder(value))
        normalized.append(values)

    return normalized


def load_sheet_fixture(name: str) -> Dict[str, List[List[str]]]:
    path = FIXTURE_ROOT / "sheets" / f"{name}.json"
    payload = json.loads(path.read_text())

    result: Dict[str, List[List[str]]] = {}
    for sheet_name, sheet_data in payload.items():
        rows = sheet_data.get("rows", [])
        min_cols = sheet_data.get("columns", 26)
        if isinstance(min_cols, str):
            min_cols = column_index_from_string(min_cols)
        result[sheet_name] = _normalize_sheet_rows(rows, min_columns=min_cols)
    return result


def build_repo_from_fixture(name: str) -> SheetsRepoStub:
    data = load_sheet_fixture(name)
    return SheetsRepoStub(
        expense_rows=data.get("expense"),
        income_rows=data.get("income"),
        subscriptions_rows=data.get("subscriptions"),
    )
