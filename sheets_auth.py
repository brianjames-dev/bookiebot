import os
import json
import gspread
from datetime import datetime
from zoneinfo import ZoneInfo
from google.oauth2.service_account import Credentials
from dotenv import load_dotenv
load_dotenv()

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")

def _now_pacific():
    return datetime.now(PACIFIC_TZ)

# Read the JSON string directly from .env
service_account_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")

if not service_account_json:
    raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not set in .env")

service_account_info = json.loads(service_account_json)

scopes = ["https://www.googleapis.com/auth/spreadsheets"]
creds = Credentials.from_service_account_info(service_account_info, scopes=scopes)
gc = gspread.authorize(creds)

EXPENSE_SHEET_KEY = os.getenv("EXPENSE_SHEET_KEY")
INCOME_SHEET_KEY  = os.getenv("INCOME_SHEET_KEY")

if not EXPENSE_SHEET_KEY or not INCOME_SHEET_KEY:
    raise RuntimeError("Sheet keys not set in .env")

def get_expense_worksheet():
    sheet = gc.open_by_key(EXPENSE_SHEET_KEY)
    month_name = _now_pacific().strftime("%B")
    return sheet.worksheet(month_name)

def get_income_worksheet():
    sheet = gc.open_by_key(INCOME_SHEET_KEY)
    month_name = _now_pacific().strftime("%B")
    return sheet.worksheet(month_name)

def get_subscriptions_worksheet():
    sheet = gc.open_by_key(INCOME_SHEET_KEY)
    return sheet.worksheet("Subscriptions")
