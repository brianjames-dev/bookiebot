"""Shared expense layouts, including unmigrated historical workbooks.

Never infer coordinates from the calendar year: the header is authoritative.
The legacy map remains available for old saved actions without a layout tag.
"""

from copy import deepcopy
from typing import Any

from openpyxl.utils import column_index_from_string, get_column_letter

get_category_columns = {
    "grocery": {
        "start_row": 3,
        "columns": {
            "date": "A",
            "amount": "B",
            "location": "C",
            "person": "D"
        }
    },
    "gas": {
        "start_row": 3,
        "columns": {
            "date": "H",
            "amount": "I",
            "person": "J"
        }
    },
    "food": {
        "start_row": 3,
        "columns": {
            "date": "N",
            "item": "O",
            "amount": "P",
            "location": "Q",
            "person": "R"
        }
    },
    "shopping": {
        "start_row": 3,
        "columns": {
            "date": "V",
            "item": "W",
            "amount": "X",
            "location": "Y",
            "person": "Z"
        }
    },
    "need_expenses": {
        "start_row": 3,
        "columns": {
            "date": "AD",
            "item": "AE",
            "amount": "AF",
            "location": "AG",
            "person": "AH"
        }
    }
}

GAS_LOCATION_LAYOUT = "gas_location_v1"


def category_layout(rows: list[list[Any]]) -> dict[str, Any]:
    """Resolve one fresh worksheet snapshot, without another network request.

    Headerless repository fixtures/old exports retain the legacy layout. An
    identifiable Gas header with an unknown shape is rejected before mutation.
    """
    def cell(row: int, col: int) -> str:
        return str(rows[row - 1][col - 1]).strip().rstrip(":").casefold() if len(rows) >= row and len(rows[row - 1]) >= col else ""

    gas_header = [cell(2, c) for c in (8, 9, 10, 11)]
    if gas_header[:3] == ["date", "amount", "location"] and gas_header[3] == "person":
        layout = layout_for_version(GAS_LOCATION_LAYOUT)
    elif cell(1, 8) == "gas" and gas_header[:3] != ["date", "amount", "person"]:
        raise ValueError("The Gas columns could not be verified. No expense cells were changed.")
    else:
        layout = deepcopy(get_category_columns)
    # Early sheets predate Needs. Their totals occupy the former Needs block.
    need_col = column_index_from_string(layout["need_expenses"]["columns"]["date"])
    if cell(1, 8) == "gas" and cell(1, need_col) not in {"needs", "need expenses", "need_expenses"}:
        layout.pop("need_expenses")
    if cell(1, 8) == "gas":
        for category, config in layout.items():
            first = column_index_from_string(config["columns"]["date"])
            expected = "needs" if category == "need_expenses" else category
            if cell(1, first) != expected or any(cell(2, column_index_from_string(col)) != field for field, col in config["columns"].items()):
                raise ValueError(f"The {category} columns could not be verified. No expense cells were changed.")
    return layout


def layout_for_version(version: str = "") -> dict[str, Any]:
    layout = deepcopy(get_category_columns)
    if version == GAS_LOCATION_LAYOUT:
        for config in layout.values():
            config["columns"] = {field: get_column_letter(column_index_from_string(col) + (column_index_from_string(col) >= 10))
                                 for field, col in config["columns"].items()}
        layout["gas"]["columns"] = {"date": "H", "amount": "I", "location": "J", "person": "K"}
    elif version:
        raise ValueError("Unknown shared expense layout.")
    return layout


def worksheet_category_layout(worksheet: Any) -> dict[str, Any]:
    return category_layout(worksheet.get_all_values())


def expense_layout_metadata(layout: dict[str, Any]) -> dict[str, str]:
    return {"expense_layout": GAS_LOCATION_LAYOUT} if layout["gas"]["columns"].get("location") == "J" else {}


_CATEGORY_ALIASES = {
    "groceries": "grocery",
    "need": "need_expenses",
    "needs": "need_expenses",
    "need_expense": "need_expenses",
    "needs_expense": "need_expenses",
    "need_expenses": "need_expenses",
    "needs_expenses": "need_expenses",
}


def normalize_expense_category(value: object) -> str:
    category = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return _CATEGORY_ALIASES.get(category, category)


def expense_category_label(value: object) -> str:
    category = normalize_expense_category(value)
    if category == "need_expenses":
        return "Needs"
    return category.replace("_", " ").title()
