import json
import os

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
)

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
_GC = None


def _get_gc():
    global _GC
    if _GC is None:
        service_account_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
        if not service_account_json:
            raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not set in environment.")
        info = json.loads(service_account_json)
        creds = Credentials.from_service_account_info(info, scopes=SCOPES)
        _GC = gspread.authorize(creds)
    return _GC


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
