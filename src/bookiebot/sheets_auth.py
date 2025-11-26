import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

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

load_dotenv()

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
_GC = None


def _now_pacific():
    return datetime.now(PACIFIC_TZ)


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


def _open_month_sheet(sheet_key_env: str):
    sheet_key = os.getenv(sheet_key_env)
    if not sheet_key:
        raise RuntimeError(f"{sheet_key_env} not set in environment.")
    gc = _get_gc()
    sheet = gc.open_by_key(sheet_key)
    month_name = _now_pacific().strftime("%B")
    return sheet.worksheet(month_name)


def get_expense_worksheet():
    return _open_month_sheet("EXPENSE_SHEET_KEY")


def get_income_worksheet():
    return _open_month_sheet("INCOME_SHEET_KEY")


def get_subscriptions_worksheet():
    sheet_key = os.getenv("INCOME_SHEET_KEY")
    if not sheet_key:
        raise RuntimeError("INCOME_SHEET_KEY not set in environment.")
    gc = _get_gc()
    sheet = gc.open_by_key(sheet_key)
    return sheet.worksheet("Subscriptions")
