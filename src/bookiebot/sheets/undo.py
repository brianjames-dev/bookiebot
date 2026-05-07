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
ActionKind = Literal["clear_cells", "delete_row", "restore_cells"]


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
_LOG_HEADERS = ["id", "created_at", "user_key", "status", "undone_at", "action_json"]


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
        previous_values=[str(value) for value in payload.get("previous_values", [])],
        description=str(payload.get("description", "")),
        new_values=[str(value) for value in payload.get("new_values", [])],
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


def recent_actions(user_key: str | None, limit: int = 10) -> list[LoggedAction]:
    key = str(user_key) if user_key else None
    matches = [
        action
        for action in _read_log()
        if action.status == "active" and (key is None or action.user_key == key)
    ]
    return list(reversed(matches))[: max(limit, 1)]


def _format_actions(actions: list[LoggedAction], *, empty_message: str, final_prompt: str) -> str:
    if not actions:
        return empty_message

    lines = ["Recent logged actions I can work with:"]
    for index, logged in enumerate(actions, start=1):
        action = logged.action
        where = f"{action.worksheet} row {action.row}"
        category = action.metadata.get("category")
        if category:
            where = f"{category} / {where}"
        lines.append(f"{index}. {action.description} ({where}, id `{logged.id}`)")
    lines.append(final_prompt)
    return "\n".join(lines)


def format_recent_actions(user_key: str | None, limit: int = 10) -> str:
    return _format_actions(
        recent_actions(user_key, limit),
        empty_message="I do not have any recent logged actions for you this month.",
        final_prompt="Which one should I change or undo, and what should happen to it?",
    )


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
        final_prompt="Which one should I delete? Reply with the number from this list or the action id.",
    )


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


def update_recent_action(
    user_key: str | None,
    *,
    updates: dict[str, Any],
    index: int | None = None,
    action_id: str | None = None,
    match_text: str | None = None,
) -> tuple[bool, str]:
    logged = select_recent_action(
        user_key,
        index=index,
        action_id=action_id,
        match_text=match_text,
    )
    if logged is None:
        return False, format_recent_actions(user_key, 10)

    field_columns = _field_columns_for_action(logged.action)
    if not field_columns:
        return False, "I found that action, but I do not know how to edit its fields yet."

    normalized_updates = {
        str(field).strip().lower(): value
        for field, value in updates.items()
        if value not in (None, "")
    }
    unknown = sorted(set(normalized_updates) - set(field_columns))
    if unknown:
        available = ", ".join(sorted(field_columns))
        return False, f"I can update {available} for that action, but not: {', '.join(unknown)}."

    if not normalized_updates:
        return False, "Tell me which field to change, like amount, location, item, person, or date."

    ws = _worksheet(logged.action.worksheet)
    previous_values: list[str] = []
    columns: list[int] = []
    values: list[str] = []
    updates_by_col: dict[int, Any] = {}
    for field, value in normalized_updates.items():
        col = field_columns[field]
        previous_values.append(ws.cell(logged.action.row, col).value)
        columns.append(col)
        values.append(str(value))
        updates_by_col[col] = value

    try:
        for col, value in zip(columns, values):
            ws.update_cell(logged.action.row, col, value)
    except Exception as e:
        logger.exception("Failed to update recent action", extra={"exception": str(e)})
        return False, "Something went wrong while updating that logged action."

    _update_logged_new_values(logged.id, updates_by_col)
    record_undo_action(
        user_key,
        UndoAction(
            worksheet=logged.action.worksheet,
            kind="restore_cells",
            row=logged.action.row,
            columns=columns,
            previous_values=previous_values,
            new_values=values,
            metadata={
                **logged.action.metadata,
                "type": "update",
                "updated_action_id": logged.id,
            },
            description=f"updated {logged.action.description}",
        ),
    )
    changes = ", ".join(f"{field} to {normalized_updates[field]}" for field in normalized_updates)
    return True, f"Updated {logged.action.description}: {changes}."


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
    if action.kind == "delete_row":
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
        return False, format_recent_actions(user_key, 10)

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
