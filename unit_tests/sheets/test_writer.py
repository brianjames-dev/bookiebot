import pytest

from bookiebot.sheets import writer


@pytest.mark.asyncio
async def test_expense_sheet_with_retry_recovers_from_transient_access_error(monkeypatch):
    calls = []
    worksheet = object()

    class Repo:
        def expense_sheet(self):
            calls.append("expense_sheet")
            if len(calls) == 1:
                raise RuntimeError("temporary sheets access failure")
            return worksheet

    async def fake_sleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(writer, "get_sheets_repo", lambda: Repo())
    monkeypatch.setattr(writer.asyncio, "sleep", fake_sleep)

    assert await writer._expense_sheet_with_retry() is worksheet
    assert calls == ["expense_sheet", "expense_sheet"]
