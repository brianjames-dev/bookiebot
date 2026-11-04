"""Pure, reviewable transforms for the one-column Gas Location migration.

Live orchestration backs up all inputs and stops writers first. These helpers
never infer a merchant from an amount, change money, or execute sheet writes.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import re
from typing import Any

from openpyxl.utils import column_index_from_string

from bookiebot.sheets.config import GAS_LOCATION_LAYOUT, category_layout, get_category_columns, layout_for_version


def _date(value: Any) -> date | None:
    for pattern in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(str(value), pattern).date()
        except ValueError:
            pass
    return None


def _money(value: Any) -> Decimal | None:
    try:
        amount = Decimal(str(value).replace("$", "").replace(",", ""))
        return amount if amount.is_finite() and amount > 0 else None
    except InvalidOperation:
        return None


def recover_gas_locations(sheets: dict[str, list[list[str]]], logs: dict[str, list[list[str]]],
                          transactions: list[dict[str, Any]], reconciliations: list[dict[str, Any]],
                          accounts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recover only a saved exact action link with independently matching identity.

    No fuzzy names, date windows or amount-only joins. Reject ambiguous source
    rows, conflicting eligible merchants, other owners, pending and removed bank
    records. A deleted/corrected source is never recreated from historical data.
    """
    from bookiebot.sheets.routing import get_user_config
    banks = {row["id"]: row for row in transactions}
    owners = {row["id"]: row["owner_key"] for row in accounts}
    results = []
    for title, rows in logs.items():
        if title not in sheets:
            continue
        current = sheets[title]
        columns = category_layout(current)["gas"]["columns"]
        fields = {field: column_index_from_string(col) - 1 for field, col in columns.items()}
        def values(row: list[str]) -> dict[str, str]:
            return {key: row[col] if col < len(row) else "" for key, col in fields.items()}
        def identity(value: dict[str, Any]) -> tuple[Any, Any, Any]:
            return _date(value.get("date")), _money(value.get("amount")), value.get("person")
        for row in rows[1:]:
            if len(row) < 6 or row[3] != "active" or not row[5]:
                continue
            action = json.loads(row[5])
            if action.get("worksheet") != "expense" or action.get("metadata", {}).get("category") != "gas" or action["kind"] != "clear_cells":
                continue
            action_fields = list(layout_for_version(action["metadata"].get("expense_layout", ""))["gas"]["columns"])
            saved = dict(zip(action_fields, action.get("new_values", [])))
            key = identity(saved)
            row_number = action["row"]
            if not all(key) or not 3 <= row_number <= len(current):
                continue
            target = values(current[row_number - 1])
            if target.get("location") or identity(target) != key:
                continue
            if sum(identity(values(other)) == key for other in current[2:]) != 1:
                continue
            owner = get_user_config(row[2]).budget_owner_key
            candidates = []
            for link in reconciliations:
                if link.get("matched_action_log_id") != row[0] or link.get("status") not in {"confirmed", "matched"} or link.get("classification") != "expense" or link.get("owner_key") != owner:
                    continue
                bank = banks.get(link["bank_transaction_id"], {})
                merchant = str(bank.get("merchant_name") or "").strip()
                if (not merchant or len(merchant) > 200 or any(ord(c) < 32 for c in merchant)
                        or owners.get(bank.get("account_id")) != owner or bank.get("pending") or bank.get("removed_at")
                        or _money(bank.get("amount")) != key[1] or key[0] not in {_date(bank.get("date")), _date(bank.get("authorized_date"))}):
                    continue
                candidates.append({"bankTransactionId": bank["id"], "reconciliationId": link["id"], "location": merchant})
            if candidates and len({c["location"].casefold() for c in candidates}) == 1:
                results.append({"title": title, "row": row_number, "actionId": row[0], **candidates[0]})
    # Two active log records claiming one physical purchase need review even if
    # their amount/date are identical. Never let last-write-wins choose a logo.
    return [r for r in results if sum((other["title"],other["row"]) == (r["title"],r["row"]) for other in results) == 1]


def shifted_columns(columns: list[int], *, gas_block: bool = False) -> list[int]:
    if gas_block and columns == [8, 9, 10]:
        return [8, 9, 10, 11]
    return [col + (col >= 10) for col in columns]


def migrate_action(payload: dict[str, Any], *, location: str = "") -> dict[str, Any]:
    """Shift coordinate-bearing history and widen Gas snapshots exactly once."""
    result = deepcopy(payload)
    meta = result.setdefault("metadata", {})
    if result.get("worksheet") != "expense" or meta.get("type") == "system_state" or meta.get("expense_layout") == GAS_LOCATION_LAYOUT:
        return result
    if meta.get("category") not in get_category_columns:
        raise ValueError("An expense action has an unknown category; review before migrating.")
    gas = meta["category"] == "gas"
    old_columns = result["columns"]
    result["columns"] = shifted_columns(old_columns, gas_block=gas)
    display = json.loads(meta["display_fields"]) if meta.get("display_fields") else list(get_category_columns[meta["category"]]["columns"])
    if gas and "location" not in display:
        index = display.index("person") if "person" in display else len(display)
        if result.get("new_values"):
            if len(result["new_values"]) != len(display):
                raise ValueError("Gas history has an unexpected display snapshot.")
            result["new_values"].insert(index, location or meta.get("supplied_location", ""))
        if old_columns == [8, 9, 10] and len(result.get("previous_values", [])) == 3:
            result["previous_values"].insert(2, "")
        if meta.get("display_fields"):
            display.insert(index, "location")
            meta["display_fields"] = json.dumps(display)
    if gas and meta.get("category_snapshot"):
        snapshot = json.loads(meta["category_snapshot"])
        for row in snapshot:
            if len(row) != 3:
                raise ValueError("Gas deletion has an unexpected snapshot width.")
            row.insert(2, "")
        meta["category_snapshot"] = json.dumps(snapshot)
    source_gas = meta.get("source_category") == "gas"
    for key in ("source_columns", "source_category_columns"):
        if meta.get(key):
            meta[key] = json.dumps(shifted_columns(json.loads(meta[key]), gas_block=source_gas))
    if source_gas:
        for key, nested in (("source_values", False), ("source_category_snapshot", True)):
            if not meta.get(key):
                continue
            values = json.loads(meta[key])
            for row in values if nested else [values]:
                if len(row) != 3:
                    raise ValueError("Gas move has an unexpected snapshot width.")
                row.insert(2, "")
            meta[key] = json.dumps(values)
    meta["expense_layout"] = GAS_LOCATION_LAYOUT
    return result


def migrate_allocation(payload: dict[str, Any], *, shared_id: str, titles: set[str]) -> dict[str, Any]:
    """Translate current projection coordinates, retaining immutable audit rows."""
    result = deepcopy(payload)
    if (result.get("sourceWorksheet") == "expense" and result.get("sourceSpreadsheetId") == shared_id
            and result.get("sourceSheetTitle") in titles and result.get("sourceColumnMap")):
        category = result["category"]
        old = {field: column_index_from_string(col) for field, col in get_category_columns[category]["columns"].items()}
        new = {field: column_index_from_string(col) for field, col in layout_for_version(GAS_LOCATION_LAYOUT)[category]["columns"].items()}
        if result["sourceColumnMap"] == old:
            result["sourceColumnMap"] = new
            if category == "gas":
                result.setdefault("sourceValues", {}).setdefault("location", result.get("location", ""))
        elif result["sourceColumnMap"] != new:
            raise ValueError("A reimbursement has unknown source columns.")
    revision = result.get("sourceRevision", {})
    if isinstance(revision.get("before"), dict):
        revision["before"] = migrate_allocation(revision["before"], shared_id=shared_id, titles=titles)
    return result


def migrate_sheet_ref(value: str, *, months: set[str]) -> str:
    old_blocks = {tuple(column_index_from_string(c) for c in config["columns"].values()): category
                  for category, config in get_category_columns.items()}
    def replace(match: re.Match[str]) -> str:
        columns = tuple(int(c) for c in match[2].split(","))
        if match[3] not in months or columns not in old_blocks:
            return match[0]
        category = old_blocks[columns]
        return match[1] + ",".join(map(str, shifted_columns(list(columns), gas_block=category == "gas"))) + "#month=" + match[3]
    return re.sub(r"(expense!row \d+#cols=)([\d,]+)#month=(\d{4}-\d{2})", replace, value)


def rewrite_import(formula: str, *, source_id: str) -> str:
    """Quoted IMPORTRANGE coordinates do not follow native column insertion."""
    # Require the exact source workbook and a literal single-cell reference.
    pattern = r'(IMPORTRANGE\(\s*"([^"\n]+)"\s*[,;]\s*"([^"\n]*!\$?)(F|L|T|AB|AJ)(\$?\d+)"\s*\))'
    shifted = {"F": "F", "L": "M", "T": "U", "AB": "AC", "AJ": "AK"}
    def replace(match: re.Match[str]) -> str:
        if match[2] != source_id and not re.fullmatch(r"https://docs\.google\.com/spreadsheets/d/" + re.escape(source_id) + r"(?:/.*)?", match[2]):
            return match[0]
        return match[0].replace(match[3] + match[4] + match[5], match[3] + shifted[match[4]] + match[5])
    return re.sub(pattern, replace, formula, flags=re.I)


def shared_sheet_requests(properties: dict[str, Any], rows: list[list[str]], *, locations: dict[int, str] | None = None) -> list[dict[str, Any]]:
    """Insert J natively; retain merges/formulas/anchors/validations to its right."""
    locations = locations or {}
    layout = category_layout(rows)
    if layout["gas"]["columns"].get("location") == "J":
        for row, location in locations.items():
            if rows[row - 1][9] != location:
                raise ValueError("Migrated Gas location differs from the approved recovery plan.")
        return []
    if len(rows) < 2 or [str(value).strip().rstrip(":").casefold() for value in rows[1][7:10]] != ["date", "amount", "person"]:
        raise ValueError("The source Gas header is not the expected legacy layout.")
    identity, height = properties["sheetId"], properties["gridProperties"]["rowCount"]
    target = {"sheetId": identity, "startRowIndex": 1, "endRowIndex": height, "startColumnIndex": 9, "endColumnIndex": 10}
    requests: list[dict[str, Any]] = [
        {"insertDimension": {"range": {"sheetId": identity, "dimension": "COLUMNS", "startIndex": 9, "endIndex": 10}, "inheritFromBefore": False}},
        {"copyPaste": {"source": {**target, "startColumnIndex": 10, "endColumnIndex": 11}, "destination": target, "pasteType": "PASTE_FORMAT"}},
        {"setDataValidation": {"range": target}},
        {"repeatCell": {"range": {**target, "startRowIndex": 2}, "cell": {"userEnteredFormat": {"numberFormat": {"type": "TEXT"}}}, "fields": "userEnteredFormat.numberFormat"}},
        {"updateCells": {"start": {"sheetId": identity, "rowIndex": 1, "columnIndex": 9}, "rows": [{"values": [{"userEnteredValue": {"stringValue": "Location"}}]}], "fields": "userEnteredValue"}},
    ]
    for row, location in locations.items():
        if row < 3 or row > height or not location.strip():
            raise ValueError("Invalid Gas recovery target.")
        requests.append({"updateCells": {"start": {"sheetId": identity, "rowIndex": row - 1, "columnIndex": 9}, "rows": [{"values": [{"userEnteredValue": {"stringValue": location}}]}], "fields": "userEnteredValue"}})
    requests.append({"autoResizeDimensions": {"dimensions": {"sheetId": identity, "dimension": "COLUMNS", "startIndex": 9, "endIndex": 10}}})
    return requests
