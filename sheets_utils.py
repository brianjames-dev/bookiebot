from sheets_auth import get_expense_worksheet, get_income_worksheet
from openpyxl.utils import column_index_from_string
from datetime import datetime, timedelta
import re

# HELPER FUNCTIONS
def _sum_column(ws, col_letter, start_row=3):
    col_idx = column_index_from_string(col_letter)
    values = ws.col_values(col_idx)[start_row - 1:]
    return sum(clean_money(v) for v in values if v.strip())

def clean_money(value: str) -> float:
    """
    Remove $ and , then convert to float.
    Example: '$1,250.00' -> 1250.00
    """
    try:
        return float(value.replace('$', '').replace(',', '').strip())
    except Exception as e:
        print(f"[WARN] Failed to clean money value: {value} ({e})")
        return 0.0

# QUERY FUNCTIONS
async def calculate_burn_rate():
    ws = get_income_worksheet()
    try:
        # find the cell that contains '🔥 Burn rate:'
        cell = ws.find("🔥 Burn rate: ")
        
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
        if amount_cell:
            cleaned = clean_money(amount_cell)
            if cleaned > 0:
                return True, cleaned
    except Exception as e:
        print(f"[ERROR] Failed to check rent paid: {e}")
    return False, 0.0

async def check_utilities_paid():
    ws = get_income_worksheet()
    try:
        cell = ws.find("SMUD")
        amount_cell = ws.cell(cell.row, cell.col + 1).value
        if amount_cell:
            cleaned = clean_money(amount_cell)
            if cleaned > 0:
                return True, cleaned
    except Exception as e:
        print(f"[ERROR] Failed to check utilities paid: {e}")
    return False, 0.0

async def check_student_loan_paid():
    ws = get_income_worksheet()
    try:
        cell = ws.find("Student Loan Payment")
        amount_cell = ws.cell(cell.row, cell.col + 1).value
        if amount_cell:
            cleaned = clean_money(amount_cell)
            if cleaned > 0:
                return True, cleaned
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
                    total += clean_money(row[food_amount_idx])
                    continue
                except ValueError:
                    pass

        # Check Shopping section
        if len(row) > max(shop_amount_idx, shop_location_idx):
            location_val = row[shop_location_idx].lower()
            if store in location_val:
                try:
                    total += clean_money(row[shop_amount_idx])
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
        return clean_money(income_val)
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
        remaining_budget = clean_money(val)
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

async def largest_single_expense():
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]
    max_val = 0.0
    max_row = None

    # define which columns we expect amounts in
    amount_cols = [column_index_from_string(c) - 1 for c in ['B', 'I', 'P', 'X']]

    for row in rows:
        for idx in amount_cols:
            if idx >= len(row):
                continue
            try:
                amt = clean_money(row[idx])
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

    amount_cols = [column_index_from_string(c) - 1 for c in ['B', 'I', 'P', 'X']]

    for row in rows:
        for idx in amount_cols:
            if idx >= len(row):
                continue
            try:
                amt = clean_money(row[idx])
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
                amount_cols = [column_index_from_string(c) - 1 for c in ['B', 'I', 'P', 'X']]
                for idx in amount_cols:
                    if idx >= len(row):
                        continue
                    try:
                        total += clean_money(row[idx])
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
    amount_cols = [column_index_from_string(c) - 1 for c in ['B', 'I', 'P', 'X']]

    for row in rows:
        try:
            date_str = row[0]
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
            if date_obj.month == today.month and date_obj.year == today.year:
                for idx in amount_cols:
                    if idx >= len(row):
                        continue
                    try:
                        total_so_far += clean_money(row[idx])
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
    amount_cols = [column_index_from_string(c) - 1 for c in ['B', 'I', 'P', 'X']]

    for row in rows:
        try:
            date_str = row[0]
            date_obj = datetime.strptime(date_str, "%m/%d/%Y")
            is_weekend = date_obj.weekday() >= 5
            for idx in amount_cols:
                if idx >= len(row):
                    continue
                try:
                    amt = clean_money(row[idx])
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
