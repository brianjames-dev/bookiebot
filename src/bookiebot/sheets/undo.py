from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import Literal

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


_LAST_ACTION_BY_USER: dict[str, UndoAction] = {}
_GLOBAL_LAST_ACTION: UndoAction | None = None


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


def undo_last_action(user_key: str | None) -> tuple[bool, str]:
    global _GLOBAL_LAST_ACTION
    key = str(user_key) if user_key else None
    if key:
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

    if _GLOBAL_LAST_ACTION is action:
        _GLOBAL_LAST_ACTION = None
    return True, f"Undid: {action.description}"
