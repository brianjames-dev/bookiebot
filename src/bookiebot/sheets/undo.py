from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
import json
import logging
from typing import Any, Literal
from uuid import uuid4

from bookiebot.sheets.repo import get_sheets_repo

logger = logging.getLogger(__name__)

WorksheetName = Literal["expense", "income"]
ActionKind = Literal["clear_cells", "delete_row", "restore_cells", "move_expense"]


@dataclass
class UndoAction:
    worksheet: WorksheetName
    kind: ActionKind
    row: int
    columns: list[int]
    previous_values: list[str]
    description: str
    new_values: list[str] = field(default_factory=list)
    metadata: dict[str, str] = field(default_factory=dict)


_LAST_ACTION_BY_USER: dict[str, UndoAction] = {}
_GLOBAL_LAST_ACTION: UndoAction | None = None
_PENDING_DELETE_IDS_BY_USER: dict[str, list[str]] = {}
_PENDING_UPDATE_IDS_BY_USER: dict[str, list[str]] = {}
_PENDING_MOVE_IDS_BY_USER: dict[str, list[str]] = {}
_RECENT_ACTION_OFFSET_BY_USER: dict[str, int] = {}
_LOG_HEADERS = ["id", "created_at", "user_key", "status", "undone_at", "action_json"]


def _sheet_value(value: Any) -> str:
    return "" if value is None else str(value)


@dataclass
class LoggedAction:
    id: str
    created_at: str
    user_key: str | None
    action: UndoAction
    status: Literal["active", "undone"] = "active"
    undone_at: str | None = None


def _action_from_dict(payload: dict) -> UndoAction:
    return UndoAction(
        worksheet=payload["worksheet"],
        kind=payload["kind"],
        row=int(payload["row"]),
        columns=[int(col) for col in payload.get("columns", [])],
        previous_values=[_sheet_value(value) for value in payload.get("previous_values", [])],
        description=str(payload.get("description", "")),
        new_values=[_sheet_value(value) for value in payload.get("new_values", [])],
        metadata={str(k): str(v) for k, v in payload.get("metadata", {}).items()},
    )


def _log_sheet():
    return get_sheets_repo().action_log_sheet()


def _ensure_log_header(ws: Any) -> None:
    rows = ws.get_all_values()
    if rows and rows[0][: len(_LOG_HEADERS)] == _LOG_HEADERS:
        return
    for col, header in enumerate(_LOG_HEADERS, start=1):
        ws.update_cell(1, col, header)


def _logged_action_from_row(row: list[str]) -> LoggedAction:
    padded = list(row) + [""] * (len(_LOG_HEADERS) - len(row))
    action_json = padded[5] or "{}"
    payload = json.loads(action_json)
    status: Literal["active", "undone"] = "undone" if padded[3] == "undone" else "active"
    return LoggedAction(
        id=padded[0],
        created_at=padded[1],
        user_key=padded[2] or None,
        status=status,
        undone_at=padded[4] or None,
        action=_action_from_dict(payload),
    )


def _read_log() -> list[LoggedAction]:
    try:
        ws = _log_sheet()
        _ensure_log_header(ws)
        rows = ws.get_all_values()[1:]
    except Exception:
        logger.exception("Failed to read action log worksheet")
        return []
    actions = []
    for row in rows:
        if not row or not row[0]:
            continue
        try:
            actions.append(_logged_action_from_row(row))
        except Exception:
            logger.warning("Skipping malformed action log row", extra={"row": row})
    return actions


def _append_logged_action(user_key: str | None, action: UndoAction) -> None:
    ws = _log_sheet()
    _ensure_log_header(ws)
    rows = ws.get_all_values()
    row_index = len(rows) + 1
    logged = LoggedAction(
        id=uuid4().hex[:8],
        created_at=datetime.now().isoformat(timespec="seconds"),
        user_key=str(user_key) if user_key else None,
        action=action,
    )
    ws.insert_row(
        [
            logged.id,
            logged.created_at,
            logged.user_key or "",
            logged.status,
            logged.undone_at or "",
            json.dumps(asdict(logged.action), separators=(",", ":")),
        ],
        index=row_index,
    )


def _find_log_row(logged_id: str) -> tuple[Any, int, LoggedAction] | None:
    ws = _log_sheet()
    _ensure_log_header(ws)
    rows = ws.get_all_values()
    for row_index, row in enumerate(rows[1:], start=2):
        if row and row[0] == logged_id:
            return ws, row_index, _logged_action_from_row(row)
    return None


def _worksheet(name: WorksheetName):
    repo = get_sheets_repo()
    if name == "expense":
        return repo.expense_sheet()
    if name == "income":
        return repo.income_sheet()
    raise ValueError(f"Unsupported worksheet: {name}")


def record_undo_action(user_key: str | None, action: UndoAction) -> None:
    global _GLOBAL_LAST_ACTION
    _GLOBAL_LAST_ACTION = action
    if user_key:
        _LAST_ACTION_BY_USER[str(user_key)] = action
    try:
        _append_logged_action(user_key, action)
    except Exception:
        logger.exception("Failed to persist undo action")


def recent_actions(user_key: str | None, limit: int = 5, offset: int = 0) -> list[LoggedAction]:
    key = str(user_key) if user_key else None
    matches = [
        action
        for action in _read_log()
        if action.status == "active" and (key is None or action.user_key == key)
    ]
    start = max(offset, 0)
    end = start + max(limit, 1)
    return list(reversed(matches))[start:end]


def _format_actions(actions: list[LoggedAction], *, empty_message: str, final_prompt: str) -> str:
    if not actions:
        return empty_message

    lines = ["Recent logged actions I can work with:"]
    for index, logged in enumerate(actions, start=1):
        lines.append("```")
        lines.extend(_format_action_list_item(index, logged.action))
        lines.append("```")
    lines.append(final_prompt)
    return "\n".join(lines)


def action_option_label(action: UndoAction) -> str:
    field_values = _field_values_for_action(action)
    category = action.metadata.get("category") or action.metadata.get("type") or "transaction"
    item = field_values.get("item")
    location = field_values.get("location")
    amount = field_values.get("amount")
    person = field_values.get("person") or action.metadata.get("person")
    label_parts = [part for part in (item, location, f"${amount}" if amount else "", person) if part]
    label = " - ".join(label_parts) or action.description or category
    return label[:100]


def format_recent_actions(user_key: str | None, limit: int = 5, offset: int = 0) -> str:
    return _format_actions(
        recent_actions(user_key, limit, offset),
        empty_message="I do not have any recent logged actions for you this month.",
        final_prompt="Type the number of the transaction, followed by what should happen to it (change, move, or undo).\n\nType `show more` to see older transactions.",
    )


def next_recent_actions_page(user_key: str | None, page_size: int = 5) -> tuple[str, list[LoggedAction]]:
    key = str(user_key) if user_key else ""
    offset = _RECENT_ACTION_OFFSET_BY_USER.get(key, 0)
    actions = recent_actions(user_key, page_size, offset)
    if actions and key:
        _RECENT_ACTION_OFFSET_BY_USER[key] = offset + page_size
    return (
        _format_actions(
            actions,
            empty_message="I do not have more recent logged actions for you this month.",
            final_prompt="Type the number of the transaction, followed by what should happen to it (change, move, or undo).\n\nType `show more` to continue.",
        ),
        actions,
    )


def reset_recent_actions_page(user_key: str | None) -> None:
    key = str(user_key) if user_key else ""
    if key:
        _RECENT_ACTION_OFFSET_BY_USER[key] = 5


def _action_search_text(logged: LoggedAction) -> str:
    action = logged.action
    parts = [
        logged.id,
        action.description,
        action.worksheet,
        str(action.row),
        *action.new_values,
        *action.metadata.values(),
    ]
    return " ".join(str(part).lower() for part in parts if part is not None)


def select_recent_action(
    user_key: str | None,
    *,
    index: int | None = None,
    action_id: str | None = None,
    match_text: str | None = None,
    limit: int = 10,
) -> LoggedAction | None:
    actions = recent_actions(user_key, limit)
    if action_id:
        action_id = action_id.strip().lower()
        for logged in actions:
            if logged.id.lower() == action_id:
                return logged
    if index is not None and 1 <= index <= len(actions):
        return actions[index - 1]
    if match_text:
        needles = [part for part in match_text.lower().split() if part]
        for logged in actions:
            haystack = _action_search_text(logged)
            if all(needle in haystack for needle in needles):
                return logged
    return None


def matching_recent_actions(user_key: str | None, match_text: str, limit: int = 10) -> list[LoggedAction]:
    needles = [part for part in match_text.lower().split() if part]
    if not needles:
        return []
    matches = []
    for logged in recent_actions(user_key, limit):
        haystack = _action_search_text(logged)
        if all(needle in haystack for needle in needles):
            matches.append(logged)
    return matches


def format_delete_candidates(user_key: str | None, match_text: str, limit: int = 10) -> str:
    key = str(user_key) if user_key else ""
    actions = matching_recent_actions(user_key, match_text, limit)
    if key:
        _PENDING_DELETE_IDS_BY_USER[key] = [logged.id for logged in actions]
    return _format_actions(
        actions,
        empty_message=f"I could not find a recent logged action matching '{match_text}'.",
        final_prompt="Type the number of the transaction you want to delete.",
    )


def format_update_candidates(user_key: str | None, match_text: str, limit: int = 10) -> str:
    key = str(user_key) if user_key else ""
    actions = matching_recent_actions(user_key, match_text, limit)
    if key:
        _PENDING_UPDATE_IDS_BY_USER[key] = [logged.id for logged in actions]
    return _format_actions(
        actions,
        empty_message=f"I could not find a recent logged action matching '{match_text}'.",
        final_prompt="Type the number of the transaction you want to update, followed by the new value.",
    )


def format_move_candidates(user_key: str | None, match_text: str, limit: int = 10) -> str:
    key = str(user_key) if user_key else ""
    actions = matching_recent_actions(user_key, match_text, limit)
    if key:
        _PENDING_MOVE_IDS_BY_USER[key] = [logged.id for logged in actions]
    return _format_actions(
        actions,
        empty_message=f"I could not find a recent logged action matching '{match_text}'.",
        final_prompt="Type the number of the transaction you want to move, followed by the new category.",
    )


def set_pending_update_selection(user_key: str | None, action_id: str) -> None:
    key = str(user_key) if user_key else ""
    if key:
        _PENDING_UPDATE_IDS_BY_USER[key] = [action_id]


def set_pending_delete_selection(user_key: str | None, action_id: str) -> None:
    key = str(user_key) if user_key else ""
    if key:
        _PENDING_DELETE_IDS_BY_USER[key] = [action_id]


def set_pending_move_selection(user_key: str | None, action_id: str) -> None:
    key = str(user_key) if user_key else ""
    if key:
        _PENDING_MOVE_IDS_BY_USER[key] = [action_id]


def clear_pending_action_selection(user_key: str | None) -> None:
    key = str(user_key) if user_key else ""
    if key:
        _PENDING_UPDATE_IDS_BY_USER.pop(key, None)
        _PENDING_DELETE_IDS_BY_USER.pop(key, None)
        _PENDING_MOVE_IDS_BY_USER.pop(key, None)


def has_pending_action_selection(user_key: str | None) -> bool:
    key = str(user_key) if user_key else ""
    return bool(
        key
        and (
            _PENDING_UPDATE_IDS_BY_USER.get(key)
            or _PENDING_DELETE_IDS_BY_USER.get(key)
            or _PENDING_MOVE_IDS_BY_USER.get(key)
        )
    )


def pending_action_selection_kind(user_key: str | None) -> Literal["update", "delete", "move"] | None:
    key = str(user_key) if user_key else ""
    if key and _PENDING_UPDATE_IDS_BY_USER.get(key):
        return "update"
    if key and _PENDING_DELETE_IDS_BY_USER.get(key):
        return "delete"
    if key and _PENDING_MOVE_IDS_BY_USER.get(key):
        return "move"
    return None


def _field_columns_for_action(action: UndoAction) -> dict[str, int]:
    if action.worksheet == "expense":
        from bookiebot.sheets.config import get_category_columns

        category = action.metadata.get("category")
        if category and category in get_category_columns:
            fields = get_category_columns[category]["columns"].keys()
            return {
                field: col
                for field, col in zip(fields, action.columns)
            }

    if action.metadata.get("type") in {"payment", "savings"}:
        return {"amount": action.columns[0]} if action.columns else {}

    return {}


def _field_values_for_action(action: UndoAction, values: list[str] | None = None) -> dict[str, str]:
    display_fields = action.metadata.get("display_fields")
    if display_fields:
        try:
            fields = [str(field) for field in json.loads(display_fields)]
        except Exception:
            fields = []
        source_values = list(values if values is not None else action.new_values)
        while len(source_values) < len(fields):
            source_values.append("")
        return {
            field: _sheet_value(source_values[index])
            for index, field in enumerate(fields)
        }

    field_columns = _field_columns_for_action(action)
    fields = list(field_columns.keys())
    source_values = list(values if values is not None else action.new_values)
    while len(source_values) < len(fields):
        source_values.append("")
    return {
        field: _sheet_value(source_values[index])
        for index, field in enumerate(fields)
    }


def _format_action_snapshot(action: UndoAction, values: list[str] | None = None) -> str:
    field_values = _field_values_for_action(action, values)
    if action.metadata.get("type") in {"expense", "update", "move"}:
        category = action.metadata.get("category", "expense")
        item = field_values.get("item") or category
        amount = field_values.get("amount", "")
        location = field_values.get("location", "")
        person = field_values.get("person") or action.metadata.get("person", "")
        parts = [f"{category} expense"]
        if item:
            parts.append(f"item '{item}'")
        if amount:
            prefix = "" if str(amount).startswith("$") else "$"
            parts.append(f"amount {prefix}{amount}")
        if location:
            parts.append(f"location '{location}'")
        if person:
            parts.append(f"person/card '{person}'")
        return ", ".join(parts)

    if action.metadata.get("type") in {"payment", "savings"}:
        amount = field_values.get("amount", "")
        return f"{action.description} amount ${amount}" if amount else action.description

    return action.description


def _format_action_list_item(index: int, action: UndoAction) -> list[str]:
    field_values = _field_values_for_action(action)
    action_type = action.metadata.get("type")
    category = action.metadata.get("category")
    title = "transaction"
    if action_type == "expense":
        title = f"{category or 'expense'} expense".title()
    elif action_type == "update":
        title = f"Updated: {(category or 'transaction').capitalize()} Expense"
    elif action_type == "move":
        source = action.metadata.get("source_category", "unknown")
        destination = action.metadata.get("destination_category") or category or "unknown"
        title = f"Moved: {source.capitalize()} -> {destination.capitalize()}"
    elif action_type == "need_expense":
        title = "Need Expense"
    elif action_type == "payment":
        title = f"{category or 'payment'} payment".title()
    elif action_type == "savings":
        title = f"{category or 'savings'} deposit".title()
    elif action.metadata.get("source"):
        title = "Income"

    lines = [f"{index}. {title}"]

    display_fields = [
        ("date", "Date"),
        ("item", "Item"),
        ("location", "Location"),
        ("amount", "Amount"),
        ("person", "Person"),
    ]
    for field, label in display_fields:
        value = field_values.get(field)
        if not value and field == "person":
            value = action.metadata.get("person")
        if value:
            prefix = "$" if field == "amount" and not str(value).startswith("$") else ""
            lines.append(f"   {label}: {prefix}{value}")

    if len(lines) == 1:
        lines.append(f"   {action.description}")
    return lines


def _update_logged_new_values(logged_id: str, updates_by_col: dict[int, Any]) -> None:
    found = _find_log_row(logged_id)
    if found is None:
        return
    ws, row_index, logged = found
    columns = logged.action.columns
    values = list(logged.action.new_values)
    while len(values) < len(columns):
        values.append("")
    for col, value in updates_by_col.items():
        if col in columns:
            values[columns.index(col)] = str(value)
    logged.action.new_values = values
    ws.update_cell(row_index, 6, json.dumps(asdict(logged.action), separators=(",", ":")))


def _category_columns(category: str) -> dict[str, int]:
    from openpyxl.utils import column_index_from_string

    from bookiebot.sheets.config import get_category_columns

    return {
        field: column_index_from_string(col_letter)
        for field, col_letter in get_category_columns[category]["columns"].items()
    }


def _first_empty_category_row(ws: Any, category: str) -> int:
    from bookiebot.sheets.config import get_category_columns

    config = get_category_columns[category]
    row_start = config["start_row"]
    columns = config["columns"]
    ref_col_letter = columns.get("amount") or list(columns.values())[0]
    ref_col_index = _category_columns(category)[next(field for field, col in columns.items() if col == ref_col_letter)]
    col_values = ws.col_values(ref_col_index)[row_start - 1:]
    for offset, value in enumerate(col_values):
        if not str(value).strip():
            return row_start + offset
    return len(col_values) + row_start


def _values_for_category(source_values: dict[str, str], destination_category: str, overrides: dict[str, Any]) -> dict[str, str]:
    from bookiebot.sheets.config import get_category_columns

    destination_fields = get_category_columns[destination_category]["columns"].keys()
    clean_overrides = {
        field: value
        for field, value in overrides.items()
        if value not in (None, "")
    }
    values = {
        field: _sheet_value(clean_overrides.get(field, source_values.get(field, "")))
        for field in destination_fields
    }
    if "item" in values and not values["item"]:
        values["item"] = str(clean_overrides.get("item") or source_values.get("location") or source_values.get("item") or "")
    return values


def _missing_required_move_fields(values: dict[str, str], destination_category: str) -> list[str]:
    required = ["date", "amount", "person"]
    if destination_category in {"food", "shopping"}:
        required.append("item")
    return [field for field in required if field in values and not str(values[field]).strip()]


def move_recent_action(
    user_key: str | None,
    *,
    destination_category: str | None,
    updates: dict[str, Any] | None = None,
    index: int | None = None,
    action_id: str | None = None,
    match_text: str | None = None,
) -> tuple[bool, str]:
    from bookiebot.sheets.config import get_category_columns

    updates = updates or {}
    destination_category = (destination_category or "").strip().lower()
    if match_text and not index and not action_id:
        return False, format_move_candidates(user_key, match_text, 10)

    key = str(user_key) if user_key else ""
    if index is not None and key and key in _PENDING_MOVE_IDS_BY_USER:
        candidate_ids = _PENDING_MOVE_IDS_BY_USER.get(key, [])
        if 1 <= index <= len(candidate_ids):
            action_id = candidate_ids[index - 1]
            index = None

    if not index and not action_id and not match_text:
        return False, format_recent_actions(user_key, 5)

    if destination_category not in get_category_columns:
        available = ", ".join(sorted(get_category_columns))
        return False, f"Tell me which category to move it to. Available categories: {available}."

    logged = select_recent_action(user_key, index=index, action_id=action_id, match_text=match_text)
    if logged is None:
        return False, format_recent_actions(user_key, 5)

    action = logged.action
    if action.metadata.get("type") != "expense" or action.worksheet != "expense":
        return False, "I can only move normal expense rows between categories right now."

    source_category = action.metadata.get("category", "")
    if source_category == destination_category:
        return False, f"That expense is already in {destination_category}."

    source_values = _field_values_for_action(action)
    destination_values = _values_for_category(source_values, destination_category, updates)
    missing = _missing_required_move_fields(destination_values, destination_category)
    if missing:
        return False, f"I can move it to {destination_category}, but I still need: {', '.join(missing)}."

    ws = _worksheet("expense")
    source_columns = action.columns
    source_current_values = [_sheet_value(ws.cell(action.row, col).value) for col in source_columns]
    destination_row = _first_empty_category_row(ws, destination_category)
    destination_columns_by_field = _category_columns(destination_category)
    destination_fields = list(destination_values.keys())
    destination_columns = [destination_columns_by_field[field] for field in destination_fields]
    destination_new_values = [destination_values[field] for field in destination_fields]
    destination_previous_values = [_sheet_value(ws.cell(destination_row, col).value) for col in destination_columns]

    try:
        for col in source_columns:
            ws.update_cell(action.row, col, "")
        for col, value in zip(destination_columns, destination_new_values):
            ws.update_cell(destination_row, col, value)
    except Exception as e:
        logger.exception("Failed to move recent action", extra={"exception": str(e)})
        return False, "Something went wrong while moving that expense."

    _mark_undone(logged.id)
    if key:
        _PENDING_MOVE_IDS_BY_USER.pop(key, None)

    record_undo_action(
        user_key,
        UndoAction(
            worksheet="expense",
            kind="move_expense",
            row=destination_row,
            columns=destination_columns,
            previous_values=destination_previous_values,
            new_values=destination_new_values,
            metadata={
                "type": "move",
                "category": destination_category,
                "person": destination_values.get("person", ""),
                "source_action_id": logged.id,
                "source_category": source_category,
                "source_row": str(action.row),
                "source_columns": json.dumps(source_columns),
                "source_values": json.dumps(source_current_values),
                "destination_category": destination_category,
                "display_fields": json.dumps(destination_fields),
            },
            description=f"moved {source_category} expense to {destination_category}",
        ),
    )
    return (
        True,
        "Moved logged expense:\n"
        f"Before: {_format_action_snapshot(action, source_current_values)}\n"
        f"After: {destination_category} expense, "
        + ", ".join(f"{field} '{value}'" for field, value in destination_values.items() if value),
    )


def update_recent_action(
    user_key: str | None,
    *,
    updates: dict[str, Any],
    index: int | None = None,
    action_id: str | None = None,
    match_text: str | None = None,
) -> tuple[bool, str]:
    normalized_updates = {
        str(field).strip().lower(): value
        for field, value in updates.items()
        if value not in (None, "")
    }
    if match_text and not normalized_updates and not index and not action_id:
        return False, format_update_candidates(user_key, match_text, 10)

    key = str(user_key) if user_key else ""
    if index is not None and key and key in _PENDING_UPDATE_IDS_BY_USER:
        candidate_ids = _PENDING_UPDATE_IDS_BY_USER.get(key, [])
        if 1 <= index <= len(candidate_ids):
            action_id = candidate_ids[index - 1]
            index = None

    logged = select_recent_action(
        user_key,
        index=index,
        action_id=action_id,
        match_text=match_text,
    )
    if logged is None:
        return False, format_recent_actions(user_key, 5)

    field_columns = _field_columns_for_action(logged.action)
    if not field_columns:
        return False, "I found that action, but I do not know how to edit its fields yet."

    unknown = sorted(set(normalized_updates) - set(field_columns))
    if unknown:
        available = ", ".join(sorted(field_columns))
        return False, f"I can update {available} for that action, but not: {', '.join(unknown)}."

    if not normalized_updates:
        return False, f"I found {_format_action_snapshot(logged.action)}. Please specify the new value."

    ws = _worksheet(logged.action.worksheet)
    display_fields = list(field_columns.keys())
    before_values = list(logged.action.new_values)
    after_values = list(before_values)
    while len(after_values) < len(field_columns):
        after_values.append("")
    previous_values: list[str] = []
    columns: list[int] = []
    values: list[str] = []
    updates_by_col: dict[int, Any] = {}
    for field, value in normalized_updates.items():
        col = field_columns[field]
        previous_values.append(_sheet_value(ws.cell(logged.action.row, col).value))
        columns.append(col)
        values.append(str(value))
        updates_by_col[col] = value
        field_index = list(field_columns).index(field)
        after_values[field_index] = str(value)

    try:
        for col, value in zip(columns, values):
            ws.update_cell(logged.action.row, col, value)
    except Exception as e:
        logger.exception("Failed to update recent action", extra={"exception": str(e)})
        return False, "Something went wrong while updating that logged action."

    _update_logged_new_values(logged.id, updates_by_col)
    if key:
        _PENDING_UPDATE_IDS_BY_USER.pop(key, None)
    record_undo_action(
        user_key,
        UndoAction(
            worksheet=logged.action.worksheet,
            kind="restore_cells",
            row=logged.action.row,
            columns=columns,
            previous_values=previous_values,
            new_values=after_values,
            metadata={
                **logged.action.metadata,
                "type": "update",
                "updated_action_id": logged.id,
                "display_fields": json.dumps(display_fields),
            },
            description=f"updated {logged.action.description}",
        ),
    )
    return (
        True,
        "Updated logged action:\n"
        f"Before: {_format_action_snapshot(logged.action, before_values)}\n"
        f"After: {_format_action_snapshot(logged.action, after_values)}",
    )


def _mark_undone(logged_id: str) -> None:
    found = _find_log_row(logged_id)
    if found is None:
        return
    ws, row_index, _logged = found
    ws.update_cell(row_index, 4, "undone")
    ws.update_cell(row_index, 5, datetime.now().isoformat(timespec="seconds"))


def _latest_logged_action(user_key: str | None) -> LoggedAction | None:
    actions = recent_actions(user_key, 1)
    return actions[0] if actions else None


def _apply_undo_action(action: UndoAction) -> tuple[bool, str]:
    ws = _worksheet(action.worksheet)
    if action.kind == "move_expense":
        source_row = int(action.metadata["source_row"])
        source_columns = [int(col) for col in json.loads(action.metadata["source_columns"])]
        source_values = [_sheet_value(value) for value in json.loads(action.metadata["source_values"])]
        for col, value in zip(source_columns, source_values):
            ws.update_cell(source_row, col, value)
        for col, value in zip(action.columns, action.previous_values):
            ws.update_cell(action.row, col, value)
    elif action.kind == "delete_row":
        if hasattr(ws, "delete_rows"):
            ws.delete_rows(action.row)
        elif hasattr(ws, "delete_row"):
            ws.delete_row(action.row)
        else:
            return False, "This sheet client cannot delete rows."
    elif action.kind == "clear_cells":
        for col in action.columns:
            ws.update_cell(action.row, col, "")
    elif action.kind == "restore_cells":
        for col, value in zip(action.columns, action.previous_values):
            ws.update_cell(action.row, col, value)
    else:
        return False, "Unknown undo action."
    return True, f"Undid: {action.description}"


def delete_recent_action(
    user_key: str | None,
    *,
    index: int | None = None,
    action_id: str | None = None,
    match_text: str | None = None,
) -> tuple[bool, str]:
    key = str(user_key) if user_key else ""
    if match_text and not index and not action_id:
        return False, format_delete_candidates(user_key, match_text, 10)

    logged: LoggedAction | None = None
    if action_id:
        logged = select_recent_action(user_key, action_id=action_id)
    elif index is not None and key and key in _PENDING_DELETE_IDS_BY_USER:
        candidate_ids = _PENDING_DELETE_IDS_BY_USER.get(key, [])
        if 1 <= index <= len(candidate_ids):
            logged = select_recent_action(user_key, action_id=candidate_ids[index - 1])
    elif index is not None:
        logged = select_recent_action(user_key, index=index)

    if logged is None:
        return False, format_recent_actions(user_key, 5)

    try:
        success, detail = _apply_undo_action(logged.action)
    except Exception as e:
        logger.exception("Failed to delete recent action", extra={"exception": str(e)})
        return False, "Something went wrong while deleting that logged action."

    if not success:
        return False, detail

    _mark_undone(logged.id)
    if key:
        _PENDING_DELETE_IDS_BY_USER.pop(key, None)
    return True, f"Deleted: {logged.action.description}"


def undo_last_action(user_key: str | None) -> tuple[bool, str]:
    global _GLOBAL_LAST_ACTION
    key = str(user_key) if user_key else None
    logged = _latest_logged_action(key)
    if logged:
        action = logged.action
    elif key:
        action = _LAST_ACTION_BY_USER.pop(key, None)
        if action is None:
            return False, "I do not have a recent transaction for you to undo."
    else:
        action = _GLOBAL_LAST_ACTION
        if action is None:
            return False, "I do not have a recent transaction to undo."

    try:
        success, detail = _apply_undo_action(action)
    except Exception as e:
        logger.exception("Failed to undo last action", extra={"exception": str(e)})
        if key:
            _LAST_ACTION_BY_USER[key] = action
        return False, "Something went wrong while undoing the last transaction."
    if not success:
        return False, detail

    if logged:
        updated_action_id = action.metadata.get("updated_action_id")
        if updated_action_id and action.kind == "restore_cells":
            _update_logged_new_values(
                updated_action_id,
                {col: value for col, value in zip(action.columns, action.previous_values)},
            )
        _mark_undone(logged.id)
    if _GLOBAL_LAST_ACTION is action:
        _GLOBAL_LAST_ACTION = None
    return True, detail
