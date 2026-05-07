from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
import json
import logging
import os
from pathlib import Path
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


@dataclass
class LoggedAction:
    id: str
    created_at: str
    user_key: str | None
    action: UndoAction
    status: Literal["active", "undone"] = "active"
    undone_at: str | None = None


def _log_dir() -> Path:
    configured = os.getenv("BOOKIEBOT_ACTION_LOG_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".bookiebot" / "action_logs"


def _month_key(now: datetime | None = None) -> str:
    return (now or datetime.now()).strftime("%Y-%m")


def _log_path(month_key: str | None = None) -> Path:
    return _log_dir() / f"{month_key or _month_key()}.json"


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


def _logged_action_from_dict(payload: dict) -> LoggedAction:
    return LoggedAction(
        id=str(payload["id"]),
        created_at=str(payload["created_at"]),
        user_key=str(payload["user_key"]) if payload.get("user_key") else None,
        action=_action_from_dict(payload["action"]),
        status=payload.get("status", "active"),
        undone_at=payload.get("undone_at"),
    )


def _read_log(month_key: str | None = None) -> list[LoggedAction]:
    path = _log_path(month_key)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
    except Exception:
        logger.exception("Failed to read action log", extra={"path": str(path)})
        return []
    if not isinstance(payload, list):
        return []
    actions = []
    for entry in payload:
        try:
            actions.append(_logged_action_from_dict(entry))
        except Exception:
            logger.warning("Skipping malformed action log entry", extra={"entry": entry})
    return actions


def _write_log(actions: list[LoggedAction], month_key: str | None = None) -> None:
    path = _log_path(month_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([asdict(action) for action in actions], indent=2))


def _append_logged_action(user_key: str | None, action: UndoAction) -> None:
    actions = _read_log()
    actions.append(
        LoggedAction(
            id=uuid4().hex[:8],
            created_at=datetime.now().isoformat(timespec="seconds"),
            user_key=str(user_key) if user_key else None,
            action=action,
        )
    )
    _write_log(actions)


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


def format_recent_actions(user_key: str | None, limit: int = 10) -> str:
    actions = recent_actions(user_key, limit)
    if not actions:
        return "I do not have any recent logged actions for you this month."

    lines = [f"Recent logged actions I can work with:"]
    for index, logged in enumerate(actions, start=1):
        action = logged.action
        where = f"{action.worksheet} row {action.row}"
        category = action.metadata.get("category")
        if category:
            where = f"{category} / {where}"
        lines.append(f"{index}. {action.description} ({where}, id `{logged.id}`)")
    lines.append("Which one should I change or undo, and what should happen to it?")
    return "\n".join(lines)


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
    actions = _read_log()
    for logged in actions:
        if logged.id != logged_id:
            continue
        columns = logged.action.columns
        values = list(logged.action.new_values)
        while len(values) < len(columns):
            values.append("")
        for col, value in updates_by_col.items():
            if col in columns:
                values[columns.index(col)] = str(value)
        logged.action.new_values = values
        _write_log(actions)
        return


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
    actions = _read_log()
    for logged in actions:
        if logged.id == logged_id:
            logged.status = "undone"
            logged.undone_at = datetime.now().isoformat(timespec="seconds")
            _write_log(actions)
            return


def _latest_logged_action(user_key: str | None) -> LoggedAction | None:
    actions = recent_actions(user_key, 1)
    return actions[0] if actions else None


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
    except Exception as e:
        logger.exception("Failed to undo last action", extra={"exception": str(e)})
        if key:
            _LAST_ACTION_BY_USER[key] = action
        return False, "Something went wrong while undoing the last transaction."

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
    return True, f"Undid: {action.description}"
