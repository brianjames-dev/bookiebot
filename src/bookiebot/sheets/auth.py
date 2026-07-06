import json
import os
from typing import Any, cast

try:
    import gspread
except ImportError:  # pragma: no cover - fallback for tests
    class _FakeGC:
        def open_by_key(self, key):
            raise RuntimeError("gspread is not installed.")

    class _FakeGspread:
        def authorize(self, creds):
            return _FakeGC()

    gspread = _FakeGspread()

from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from bookiebot.sheets.routing import (
    get_current_discord_user_id,
    get_current_month_name,
    get_current_year,
    get_month_worksheet,
    get_shared_expenses_spreadsheet_id,
    get_budget_spreadsheet_id_for_user,
    now_pacific,
)

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
_GC: Any = None
_ACTION_LOG_WORKSHEET_BY_TITLE = {}
_SUBSCRIPTION_SCHEDULE_WORKSHEET_BY_KEY = {}
_BILL_SCHEDULE_WORKSHEET_BY_KEY = {}
SUBSCRIPTION_SCHEDULE_WORKSHEET_TITLE = "_BookieBot Subscription Schedule"
BILL_SCHEDULE_WORKSHEET_TITLE = "_BookieBot Bill Schedule"


def _get_gc():
    global _GC
    if _GC is None:
        service_account_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
        if not service_account_json:
            raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not set in environment.")
        info = json.loads(service_account_json)
        creds = Credentials.from_service_account_info(info, scopes=SCOPES)
        gspread_client = cast(Any, gspread)
        _GC = gspread_client.authorize(creds)
        try:
            setattr(_GC, "bookiebot_service_account_email", str(info.get("client_email") or ""))
        except Exception:
            pass
    return _GC


def get_gspread_client():
    return _get_gc()


def _open_month_sheet(spreadsheet_id: str):
    return get_month_worksheet(_get_gc(), spreadsheet_id, get_current_month_name())


def get_expense_worksheet():
    year = get_current_year()
    spreadsheet_id = get_shared_expenses_spreadsheet_id(year)
    return _open_month_sheet(spreadsheet_id)


def get_income_worksheet():
    year = get_current_year()
    spreadsheet_id = get_budget_spreadsheet_id_for_user(get_current_discord_user_id(), year)
    return _open_month_sheet(spreadsheet_id)


def get_subscriptions_worksheet():
    year = get_current_year()
    sheet_key = get_budget_spreadsheet_id_for_user(get_current_discord_user_id(), year)
    gc = _get_gc()
    sheet = gc.open_by_key(sheet_key)
    return sheet.worksheet("Subscriptions")


def get_subscription_schedule_worksheet():
    year = get_current_year()
    sheet_key = get_budget_spreadsheet_id_for_user(get_current_discord_user_id(), year)
    cache_key = (sheet_key, SUBSCRIPTION_SCHEDULE_WORKSHEET_TITLE)
    if cache_key in _SUBSCRIPTION_SCHEDULE_WORKSHEET_BY_KEY:
        return _SUBSCRIPTION_SCHEDULE_WORKSHEET_BY_KEY[cache_key]

    spreadsheet = _get_gc().open_by_key(sheet_key)
    try:
        worksheet = spreadsheet.worksheet(SUBSCRIPTION_SCHEDULE_WORKSHEET_TITLE)
        _SUBSCRIPTION_SCHEDULE_WORKSHEET_BY_KEY[cache_key] = worksheet
        return worksheet
    except Exception:
        worksheet = spreadsheet.add_worksheet(title=SUBSCRIPTION_SCHEDULE_WORKSHEET_TITLE, rows=200, cols=14)
        try:
            spreadsheet.batch_update(
                {
                    "requests": [
                        {
                            "updateSheetProperties": {
                                "properties": {
                                    "sheetId": worksheet.id,
                                    "hidden": True,
                                },
                                "fields": "hidden",
                            }
                        }
                    ]
                }
            )
        except Exception:
            pass
        _SUBSCRIPTION_SCHEDULE_WORKSHEET_BY_KEY[cache_key] = worksheet
        return worksheet


def get_bill_schedule_worksheet():
    year = get_current_year()
    sheet_key = get_budget_spreadsheet_id_for_user(get_current_discord_user_id(), year)
    cache_key = (sheet_key, BILL_SCHEDULE_WORKSHEET_TITLE)
    if cache_key in _BILL_SCHEDULE_WORKSHEET_BY_KEY:
        return _BILL_SCHEDULE_WORKSHEET_BY_KEY[cache_key]

    spreadsheet = _get_gc().open_by_key(sheet_key)
    try:
        worksheet = spreadsheet.worksheet(BILL_SCHEDULE_WORKSHEET_TITLE)
        _BILL_SCHEDULE_WORKSHEET_BY_KEY[cache_key] = worksheet
        return worksheet
    except Exception:
        worksheet = spreadsheet.add_worksheet(title=BILL_SCHEDULE_WORKSHEET_TITLE, rows=100, cols=9)
        try:
            spreadsheet.batch_update(
                {
                    "requests": [
                        {
                            "updateSheetProperties": {
                                "properties": {
                                    "sheetId": worksheet.id,
                                    "hidden": True,
                                },
                                "fields": "hidden",
                            }
                        }
                    ]
                }
            )
        except Exception:
            pass
        _BILL_SCHEDULE_WORKSHEET_BY_KEY[cache_key] = worksheet
        return worksheet


def get_action_log_worksheet():
    year = get_current_year()
    spreadsheet_id = get_shared_expenses_spreadsheet_id(year)
    title = f"_BookieBot Action Log - {now_pacific():%Y-%m}"
    cache_key = (spreadsheet_id, title)
    if cache_key in _ACTION_LOG_WORKSHEET_BY_TITLE:
        return _ACTION_LOG_WORKSHEET_BY_TITLE[cache_key]

    spreadsheet = _get_gc().open_by_key(spreadsheet_id)

    try:
        worksheet = spreadsheet.worksheet(title)
        _ACTION_LOG_WORKSHEET_BY_TITLE[cache_key] = worksheet
        return worksheet
    except Exception:
        worksheet = spreadsheet.add_worksheet(title=title, rows=1000, cols=6)
        worksheet.update_cell(1, 1, "id")
        worksheet.update_cell(1, 2, "created_at")
        worksheet.update_cell(1, 3, "user_key")
        worksheet.update_cell(1, 4, "status")
        worksheet.update_cell(1, 5, "undone_at")
        worksheet.update_cell(1, 6, "action_json")
        try:
            spreadsheet.batch_update(
                {
                    "requests": [
                        {
                            "updateSheetProperties": {
                                "properties": {
                                    "sheetId": worksheet.id,
                                    "hidden": True,
                                },
                                "fields": "hidden",
                            }
                        }
                    ]
                }
            )
        except Exception:
            pass
        _ACTION_LOG_WORKSHEET_BY_TITLE[cache_key] = worksheet
        return worksheet
