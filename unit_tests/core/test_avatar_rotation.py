from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest

from bookiebot.core import avatar_rotation
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


class FakeUser:
    def __init__(self):
        self.avatars = []

    async def edit(self, *, avatar):
        self.avatars.append(avatar)


@pytest.mark.asyncio
async def test_avatar_rotation_updates_once_per_day(monkeypatch, tmp_path):
    avatar_dir = tmp_path / "avatars"
    avatar_dir.mkdir()
    first = avatar_dir / "a.png"
    second = avatar_dir / "b.png"
    first.write_bytes(b"first")
    second.write_bytes(b"second")

    repo = SheetsRepoStub(expense_rows=[[], []])
    user = FakeUser()
    client = SimpleNamespace(user=user)

    monkeypatch.setenv("BOOKIEBOT_AVATAR_DIR", str(avatar_dir))
    monkeypatch.setattr(avatar_rotation, "now_pacific", lambda: datetime(2026, 5, 11, 8, 0, 0))

    with repo.patched():
        changed = await avatar_rotation.rotate_avatar_once(client)
        unchanged = await avatar_rotation.rotate_avatar_once(client)

    assert changed is True
    assert unchanged is False
    assert len(user.avatars) == 1
    assert user.avatars[0] in {b"first", b"second"}
    rows = repo.action_log.get_all_values()
    state_row = next(row for row in rows if row and row[0] == avatar_rotation.AVATAR_STATE_ID)
    assert state_row[2] == avatar_rotation.AVATAR_STATE_USER
    assert state_row[3] == "state"
    assert "2026-05-11" in state_row[5]


@pytest.mark.asyncio
async def test_avatar_rotation_noops_without_images(monkeypatch, tmp_path):
    repo = SheetsRepoStub(expense_rows=[[], []])
    user = FakeUser()
    client = SimpleNamespace(user=user)

    monkeypatch.setenv("BOOKIEBOT_AVATAR_DIR", str(tmp_path))

    with repo.patched():
        changed = await avatar_rotation.rotate_avatar_once(client)

    assert changed is False
    assert user.avatars == []
