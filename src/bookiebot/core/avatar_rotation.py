from __future__ import annotations

import asyncio
from dataclasses import asdict
from datetime import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import now_pacific
from bookiebot.sheets.undo import UndoAction, _update_range

logger = logging.getLogger(__name__)

AVATAR_STATE_ID = "__bookiebot_avatar_state__"
AVATAR_STATE_USER = "__system__"
AVATAR_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
DEFAULT_AVATAR_DIR = Path(__file__).resolve().parents[3] / "assets" / "avatars"


def _avatar_rotation_enabled() -> bool:
    value = os.getenv("BOOKIEBOT_AVATAR_ROTATION_ENABLED", "true").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _avatar_dir() -> Path:
    configured = os.getenv("BOOKIEBOT_AVATAR_DIR", "").strip()
    return Path(configured).expanduser() if configured else DEFAULT_AVATAR_DIR


def _avatar_files() -> list[Path]:
    avatar_dir = _avatar_dir()
    if not avatar_dir.exists():
        return []
    return sorted(
        path
        for path in avatar_dir.iterdir()
        if path.is_file() and path.suffix.lower() in AVATAR_EXTENSIONS
    )


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def _avatar_for_date(day: datetime, files: list[Path]) -> Path:
    return files[(day.timetuple().tm_yday - 1) % len(files)]


def _state_action(state: dict[str, str]) -> UndoAction:
    return UndoAction(
        worksheet="expense",
        kind="restore_cells",
        row=0,
        columns=[],
        previous_values=[],
        new_values=[],
        description="BookieBot avatar rotation state",
        metadata={"type": "system_state", "state": json.dumps(state, separators=(",", ":"))},
    )


def _state_from_action_json(action_json: str) -> dict[str, str]:
    try:
        payload = json.loads(action_json or "{}")
        state_json = payload.get("metadata", {}).get("state", "{}")
        state = json.loads(state_json)
    except Exception:
        return {}
    return {str(key): str(value) for key, value in state.items()}


def _read_avatar_state(ws: Any) -> tuple[int | None, dict[str, str]]:
    rows = ws.get_all_values()
    for row_index, row in enumerate(rows, start=1):
        if row and row[0] == AVATAR_STATE_ID:
            action_json = row[5] if len(row) > 5 else ""
            return row_index, _state_from_action_json(action_json)
    return None, {}


def _write_avatar_state(ws: Any, row_index: int | None, state: dict[str, str]) -> None:
    action_json = json.dumps(asdict(_state_action(state)), separators=(",", ":"))
    row = [
        AVATAR_STATE_ID,
        datetime.now().isoformat(timespec="seconds"),
        AVATAR_STATE_USER,
        "state",
        "",
        action_json,
    ]
    if row_index is None:
        if hasattr(ws, "append_row"):
            ws.append_row(row)
            return
        rows = ws.get_all_values()
        ws.insert_row(row, index=len(rows) + 1)
        return
    _update_range(ws, row_index, 1, [row])


async def rotate_avatar_once(client: Any) -> bool:
    if not _avatar_rotation_enabled():
        return False

    files = _avatar_files()
    if not files:
        logger.debug("No avatar rotation files found", extra={"path": str(_avatar_dir())})
        return False

    today = now_pacific()
    selected = _avatar_for_date(today, files)
    digest = _file_digest(selected)
    date_key = today.strftime("%Y-%m-%d")

    try:
        ws = get_sheets_repo().action_log_sheet()
        row_index, state = _read_avatar_state(ws)
    except Exception:
        logger.exception("Could not read avatar rotation state")
        return False

    if state.get("date") == date_key and state.get("digest") == digest:
        return False

    user = getattr(client, "user", None)
    edit = getattr(user, "edit", None)
    if not callable(edit):
        logger.warning("Discord client user cannot edit avatar")
        return False

    try:
        await edit(avatar=selected.read_bytes())
        _write_avatar_state(
            ws,
            row_index,
            {
                "date": date_key,
                "filename": selected.name,
                "digest": digest,
            },
        )
        logger.info("Rotated BookieBot avatar", extra={"avatar": selected.name, "date": date_key})
        return True
    except Exception:
        logger.exception("Failed to rotate BookieBot avatar", extra={"avatar": str(selected)})
        return False


async def run_avatar_rotation_loop(client: Any, *, interval_seconds: int = 3600) -> None:
    while True:
        await rotate_avatar_once(client)
        await asyncio.sleep(interval_seconds)
