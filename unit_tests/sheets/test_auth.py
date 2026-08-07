from bookiebot.sheets import auth


class _Spreadsheet:
    def __init__(self, worksheet):
        self._worksheet = worksheet
        self.worksheet_calls = 0

    def worksheet(self, name):
        self.worksheet_calls += 1
        return self._worksheet


class _GC:
    def __init__(self, spreadsheet):
        self._spreadsheet = spreadsheet
        self.open_calls = 0

    def open_by_key(self, key):
        self.open_calls += 1
        return self._spreadsheet


def test_month_worksheet_is_cached_by_spreadsheet_and_month(monkeypatch):
    worksheet = object()
    spreadsheet = _Spreadsheet(worksheet)
    gc = _GC(spreadsheet)
    monkeypatch.setattr(auth, "_MONTH_WORKSHEET_BY_KEY", {})
    monkeypatch.setattr(auth, "_get_gc", lambda: gc)
    monkeypatch.setattr(auth, "get_current_month_name", lambda: "August")

    first = auth._open_month_sheet("sheet-id")
    second = auth._open_month_sheet("sheet-id")

    assert first is worksheet
    assert second is worksheet
    assert gc.open_calls == 1
    assert spreadsheet.worksheet_calls == 1
