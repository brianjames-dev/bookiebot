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


@pytest.mark.asyncio
async def test_write_income_to_sheet_reports_failure(monkeypatch):
    class Repo:
        def income_sheet(self):
            return object()

    sent = []

    class Channel:
        async def send(self, content):
            sent.append(content)

    message = type("Message", (), {"channel": Channel()})()

    def boom(*_args, **_kwargs):
        raise RuntimeError("insert failed after partial write")

    monkeypatch.setattr(writer, "get_sheets_repo", lambda: Repo())
    monkeypatch.setattr(writer, "log_income_row", boom)

    await writer.write_income_to_sheet({"source": "Job", "amount": 10}, message)

    assert len(sent) == 1
    assert "Could not finish logging income" in sent[0]
    assert "undo" in sent[0].lower()
