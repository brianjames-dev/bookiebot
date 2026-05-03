from __future__ import annotations

from datetime import datetime, timezone

import pytest

from bookiebot.sheets import routing


BRIAN_ID = "676638528590970917"
HANNAH_ID = "830984827904851969"
SHORTCUT_RELAY_ID = "1395120954589315303"


class FakeSpreadsheet:
    def __init__(self, spreadsheet_id: str, worksheets: dict[str, object]):
        self.spreadsheet_id = spreadsheet_id
        self.worksheets = worksheets

    def worksheet(self, name: str):
        if name not in self.worksheets:
            raise ValueError(f"missing worksheet {name}")
        return self.worksheets[name]


class FakeGC:
    def __init__(self, spreadsheets: dict[str, FakeSpreadsheet]):
        self.spreadsheets = spreadsheets
        self.opened_ids: list[str] = []

    def open_by_key(self, key: str):
        self.opened_ids.append(key)
        if key not in self.spreadsheets:
            raise ValueError(f"missing spreadsheet {key}")
        return self.spreadsheets[key]


def test_brian_user_resolves_to_brian_budget_spreadsheet():
    sheet_id = routing.get_budget_spreadsheet_id_for_user(BRIAN_ID, 2026)
    assert sheet_id == "1ArI4qapaj-LGg7v5OC47WdfYijjLdu3QPRPgKLbgD3U"


def test_hannah_user_resolves_to_hannah_budget_spreadsheet():
    sheet_id = routing.get_budget_spreadsheet_id_for_user(HANNAH_ID, 2026)
    assert sheet_id == "1lEULEvZ5UzjuhnGPncpvh56xxA8JsfYyns0JS_Okmsg"


def test_hannah_shortcut_user_resolves_to_hannah_budget_spreadsheet():
    actor_key = routing.resolve_actor_key(SHORTCUT_RELAY_ID, "hannerish#0000")
    sheet_id = routing.get_budget_spreadsheet_id_for_user(actor_key, 2026)
    assert sheet_id == "1lEULEvZ5UzjuhnGPncpvh56xxA8JsfYyns0JS_Okmsg"


def test_brian_shortcut_user_resolves_to_brian_budget_spreadsheet():
    actor_key = routing.resolve_actor_key(SHORTCUT_RELAY_ID, ".Deebers#0000")
    sheet_id = routing.get_budget_spreadsheet_id_for_user(actor_key, 2026)
    assert sheet_id == "1ArI4qapaj-LGg7v5OC47WdfYijjLdu3QPRPgKLbgD3U"


def test_hannah_shortcut_user_stays_hannah_when_old_env_lists_relay_for_brian(monkeypatch):
    monkeypatch.setenv("BRIAN_DISCORD_USER_IDS", f"{BRIAN_ID},{SHORTCUT_RELAY_ID}")

    config = routing.get_user_config(routing.resolve_actor_key(SHORTCUT_RELAY_ID, "hannerish#0000"))

    assert config.name == "Hannah"
    assert config.budget_owner_key == "hannah"
    assert config.expense_persons == ("Hannah",)


def test_env_user_ids_are_additive_with_defaults(monkeypatch):
    monkeypatch.setenv("HANNAH_DISCORD_USER_IDS", "extra-hannah-id")

    assert routing.get_user_config(HANNAH_ID).name == "Hannah"
    assert routing.get_user_config(routing.resolve_actor_key(SHORTCUT_RELAY_ID, "hannerish#0000")).name == "Hannah"
    assert routing.get_user_config("extra-hannah-id").name == "Hannah"


def test_both_users_resolve_to_same_shared_expenses_spreadsheet():
    shared = routing.get_shared_expenses_spreadsheet_id(2026)
    assert shared == "1t2Nm5luEjm-RKiiMyuIFvJBhdI0ubufWkrdjRzBsTgU"
    assert routing.get_year_config(2026).shared_expenses_spreadsheet_id == shared


def test_current_month_tab_name_is_simple_month_name():
    now = datetime(2026, 5, 3, 12, 0, tzinfo=routing.PACIFIC_TZ)
    assert routing.get_current_month_name(now) == "May"


def test_current_year_uses_america_los_angeles_timezone():
    utc_new_year = datetime(2027, 1, 1, 7, 30, tzinfo=timezone.utc)

    assert getattr(routing.PACIFIC_TZ, "key", "") == "America/Los_Angeles"
    assert routing.get_current_year(utc_new_year) == 2026
    assert routing.get_current_month_name(utc_new_year) == "December"


def test_unknown_discord_user_errors_clearly():
    with pytest.raises(routing.UnknownDiscordUserError, match="Discord account mapped"):
        routing.get_user_config("999")


def test_missing_year_config_errors_clearly():
    with pytest.raises(routing.MissingYearConfigError, match="No spreadsheet configuration found for 2027"):
        routing.get_year_config(2027)


def test_future_year_can_be_configured_with_environment(monkeypatch):
    monkeypatch.setenv("BRIAN_BUDGET_SPREADSHEET_ID_2027", "brian-2027")
    monkeypatch.setenv("HANNAH_BUDGET_SPREADSHEET_ID_2027", "hannah-2027")
    monkeypatch.setenv("SHARED_EXPENSES_SPREADSHEET_ID_2027", "shared-2027")

    config = routing.get_year_config(2027)

    assert config.brian_budget_spreadsheet_id == "brian-2027"
    assert config.hannah_budget_spreadsheet_id == "hannah-2027"
    assert config.shared_expenses_spreadsheet_id == "shared-2027"


def test_resolve_sheet_context_opens_personal_and_shared_month_tabs():
    now = datetime(2026, 5, 3, 12, 0, tzinfo=routing.PACIFIC_TZ)
    brian_sheet_id = routing.get_budget_spreadsheet_id_for_user(BRIAN_ID, 2026)
    shared_sheet_id = routing.get_shared_expenses_spreadsheet_id(2026)
    personal_ws = object()
    shared_ws = object()
    gc = FakeGC(
        {
            brian_sheet_id: FakeSpreadsheet(brian_sheet_id, {"May": personal_ws}),
            shared_sheet_id: FakeSpreadsheet(shared_sheet_id, {"May": shared_ws}),
        }
    )

    context = routing.resolve_sheet_context(BRIAN_ID, gc, now)

    assert context.year == 2026
    assert context.month_name == "May"
    assert context.user_name == "Brian"
    assert context.budget_owner_key == "brian"
    assert context.personal_budget_worksheet is personal_ws
    assert context.shared_expenses_worksheet is shared_ws


def test_get_month_worksheet_errors_when_tab_missing():
    sheet_id = "sheet-id"
    gc = FakeGC({sheet_id: FakeSpreadsheet(sheet_id, {"April": object()})})

    with pytest.raises(routing.MissingMonthWorksheetError, match="Worksheet 'May'"):
        routing.get_month_worksheet(gc, sheet_id, "May")


def test_get_month_worksheet_errors_when_spreadsheet_cannot_be_opened():
    gc = FakeGC({})

    with pytest.raises(routing.SpreadsheetAccessError, match="Could not open spreadsheet 'sheet-id'"):
        routing.get_month_worksheet(gc, "sheet-id", "May")
