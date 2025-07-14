from sheets_auth import get_expense_worksheet, get_income_worksheet
from openpyxl.utils import column_index_from_string
from datetime import datetime, timedelta
import re

def _sum_column(ws, col_letter, start_row=3):
    col_idx = column_index_from_string(col_letter)
    values = ws.col_values(col_idx)[start_row - 1:]
    return float(sum(float(v) for v in values if v.strip()))

async def calculate_burn_rate():
    ws = get_income_worksheet()
    try:
        # find the cell that contains '🔥 Burn rate:'
        cell = ws.find("🔥 Burn rate:")
        
        # example cell.value: "🔥 Burn rate: $2.63/day"
        val_text = cell.value
        
        # extract value after the colon
        burn_rate_val = val_text.split(":")[1].strip()
        
        # also grab the description two cells to the right
        desc = ws.cell(cell.row, cell.col + 2).value
        
        return burn_rate_val, desc
    except Exception as e:
        print(f"[ERROR] Failed to fetch burn rate: {e}")
        return None, None


async def check_rent_paid():
    ws = get_income_worksheet()
    try:
        cell = ws.find("Rent")
        amount_cell = ws.cell(cell.row, cell.col + 1).value
        if amount_cell and float(amount_cell) > 0:
            return True, float(amount_cell)
    except Exception as e:
        print(f"[ERROR] Failed to check rent paid: {e}")
    return False, 0.0

async def check_utilities_paid():
    ws = get_income_worksheet()
    try:
        cell = ws.find("SMUD")
        amount_cell = ws.cell(cell.row, cell.col + 1).value
        if amount_cell and float(amount_cell) > 0:
            return True, float(amount_cell)
    except Exception as e:
        print(f"[ERROR] Failed to check utilities paid: {e}")
    return False, 0.0

async def check_student_loan_paid():
    ws = get_income_worksheet()
    try:
        cell = ws.find("Student Loan Payment")
        amount_cell = ws.cell(cell.row, cell.col + 1).value
        if amount_cell and float(amount_cell) > 0:
            return True, float(amount_cell)
    except Exception as e:
        print(f"[ERROR] Failed to check student loan paid: {e}")
    return False, 0.0

async def total_spent_at_store(store):
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]  # skip header
    total = 0.0
    store = store.lower()

    # Food: columns P (amount) and Q (location)
    # Shopping: columns X (amount) and Y (location)
    # Get column indices for P, Q, X, Y
    food_amount_idx = column_index_from_string('P') - 1
    food_location_idx = column_index_from_string('Q') - 1
    shop_amount_idx = column_index_from_string('X') - 1
    shop_location_idx = column_index_from_string('Y') - 1

    for row in rows:
        # Check Food section
        if len(row) > max(food_amount_idx, food_location_idx):
            location_val = row[food_location_idx].lower()
            if store in location_val:
                try:
                    total += float(row[food_amount_idx])
                    continue
                except ValueError:
                    pass

        # Check Shopping section
        if len(row) > max(shop_amount_idx, shop_location_idx):
            location_val = row[shop_location_idx].lower()
            if store in location_val:
                try:
                    total += float(row[shop_amount_idx])
                    continue
                except ValueError:
                    pass

    return total

async def highest_expense_category():
    ws = get_expense_worksheet()
    category_totals = {}
    categories = {
        'grocery': 'B',
        'gas': 'I',
        'food': 'P',
        'shopping': 'X'
    }
    for category, col in categories.items():
        category_totals[category] = _sum_column(ws, col)
    highest = max(category_totals.items(), key=lambda x: x[1])
    return highest  # (category, amount)

async def total_income():
    ws = get_income_worksheet()
    try:
        cell = ws.find("Monthly Income:")
        income_val = ws.cell(cell.row, cell.col + 1).value
        income_val = income_val.strip()

        # Try to convert to float if possible
        return float(income_val.replace(',', '').replace('$', ''))
    except (AttributeError, ValueError) as e:
        print(f"[WARN] Income value is missing or invalid: {e}")
        return 0.0
    except Exception as e:
        print(f"[ERROR] Failed to fetch income: {e}")
        return 0.0

async def remaining_budget():
    ws = get_income_worksheet()
    try:
        cell = ws.find("Margins:")
        val = ws.cell(cell.row, cell.col + 2).value
        remaining_budget = float(val.strip())
        return remaining_budget
    except Exception as e:
        print(f"[ERROR] Failed to get remaining budget: {e}")
        return 0.0

async def average_daily_spend():
    ws = get_income_worksheet()
    try:
        cell = ws.find("🔥 Burn rate:")
        val_text = cell.value  # e.g., "🔥 Burn rate: $2.63/day"
        burn_rate_val = val_text.split(":", 1)[1].strip()
        return burn_rate_val
    except Exception as e:
        print(f"[ERROR] Failed to fetch average daily spend: {e}")
        return None


## DEBUG THESE
async def expense_breakdown_percentages():
    ws = get_expense_worksheet()
    category_totals = {}
    categories = {
        'grocery': 'B',
        'gas': 'I',
        'food': 'P',
        'shopping': 'X'
    }
    total_expense = 0.0

    for category, col in categories.items():
        amt = _sum_column(ws, col)
        category_totals[category] = amt
        total_expense += amt

    if total_expense == 0:
        return {}

    percentages = {
        cat: round(amt / total_expense * 100, 2)
        for cat, amt in category_totals.items()
    }
    return percentages

async def total_for_category(category):
    ws = get_expense_worksheet()
    categories = {
        'grocery': 'B',
        'gas': 'I',
        'food': 'P',
        'shopping': 'X'
    }
    col = categories.get(category.lower())
    if not col:
        return 0.0
    return _sum_column(ws, col)

async def last_payment_to(vendor_or_category):
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]  # skip header

    last_date = None
    vendor_or_category = vendor_or_category.lower()

    for row in rows:
        try:
            date_str = row[0]  # assuming first column is date
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
        except Exception:
            continue

        if any(vendor_or_category in (cell or "").lower() for cell in row):
            if not last_date or date_obj > last_date:
                last_date = date_obj

    return last_date.strftime("%m/%d/%Y") if last_date else None

async def largest_single_expense():
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]
    max_val = 0.0
    max_row = None

    for row in rows:
        for cell in row:
            try:
                amt = float(cell)
                if amt > max_val:
                    max_val = amt
                    max_row = row
            except:
                continue

    return max_val, max_row

async def top_n_expenses(n=5):
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]
    expenses = []

    for row in rows:
        for cell in row:
            try:
                amt = float(cell)
                expenses.append((amt, row))
            except:
                continue

    expenses.sort(reverse=True, key=lambda x: x[0])
    return expenses[:n]

async def spent_this_week():
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]
    total = 0.0
    today = datetime.today()
    start_of_week = today - timedelta(days=today.weekday())  # Monday

    for row in rows:
        try:
            date_str = row[0]
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
            if date_obj >= start_of_week:
                for cell in row[1:]:
                    try:
                        total += float(cell)
                    except:
                        continue
        except:
            continue
    return total

async def projected_spending():
    today = datetime.today()
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]

    total_so_far = 0.0
    for row in rows:
        try:
            date_str = row[0]
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
            if date_obj.month == today.month and date_obj.year == today.year:
                for cell in row[1:]:
                    try:
                        total_so_far += float(cell)
                    except:
                        continue
        except:
            continue

    days_in_month = (datetime(today.year, today.month % 12 + 1, 1) - timedelta(days=1)).day
    days_passed = today.day
    daily_avg = total_so_far / days_passed
    projected = daily_avg * days_in_month
    return projected

async def weekend_vs_weekday():
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]
    weekend = 0.0
    weekday = 0.0

    for row in rows:
        try:
            date_str = row[0]
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
            is_weekend = date_obj.weekday() >= 5
            for cell in row[1:]:
                try:
                    amt = float(cell)
                    if is_weekend:
                        weekend += amt
                    else:
                        weekday += amt
                except:
                    continue
        except:
            continue
    return weekend, weekday

async def no_spend_days():
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]
    today = datetime.today()
    days_with_expense = set()

    for row in rows:
        try:
            date_str = row[0]
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
            if date_obj.month == today.month and date_obj.year == today.year:
                days_with_expense.add(date_obj.day)
        except:
            continue

    days_in_month = (datetime(today.year, today.month % 12 + 1, 1) - timedelta(days=1)).day
    no_spend = [day for day in range(1, today.day + 1) if day not in days_with_expense]
    return len(no_spend), no_spend
