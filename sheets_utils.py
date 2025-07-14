from sheets_auth import get_expense_worksheet, get_income_worksheet
from openpyxl.utils import column_index_from_string
from datetime import datetime, timedelta
import re
from sheets_writer import get_category_columns
from dateutil import parser as dateparser

# HELPER FUNCTIONS
def _sum_column(ws, col_letter, start_row=3):
    col_idx = column_index_from_string(col_letter)
    values = ws.col_values(col_idx)[start_row - 1:]
    return sum(clean_money(v) for v in values if v.strip())


def clean_money(value: str) -> float:
    """
    Remove $ and , then convert to float.
    Example: '$1,250.00' -> 1250.00
    Empty or invalid strings return 0.0.
    """
    if not value or value.strip() == "":
        return 0.0
    try:
        return float(value.replace('$', '').replace(',', '').strip())
    except Exception as e:
        print(f"[WARN] Failed to clean money value: {value} ({e})")
        return 0.0


# QUERY FUNCTIONS
async def calculate_burn_rate():
    ws = get_income_worksheet()
    try:
        # get all cell values
        all_cells = ws.get_all_values()

        # search manually for a row with 'burn rate' in any cell
        for r, row in enumerate(all_cells, 1):
            for c, cell in enumerate(row, 1):
                if "burn rate" in cell.lower():
                    val_text = cell.strip()
                    print(f"[DEBUG] Found burn rate cell: '{val_text}' at ({r},{c})")

                    parts = val_text.split(":")
                    if len(parts) < 2:
                        print(f"[ERROR] Unexpected format in burn rate cell: {val_text}")
                        return None, None

                    burn_rate_val = parts[1].strip()
                    desc = ""
                    # try to get description 2 columns to the right if it exists
                    if c + 2 <= len(row):
                        desc = row[c + 1].strip()
                    return burn_rate_val, desc

        print("[ERROR] Could not find any cell containing 'burn rate'")
        return None, None

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
    ws = get_expense_worksheet()
    try:
        today = datetime.today()
        day_of_month = today.day

        # Grab T7 and AB7
        shopping_cell = ws.cell(7, column_index_from_string("T")).value
        food_cell = ws.cell(7, column_index_from_string("AB")).value

        # Clean values
        shopping_total = clean_money(shopping_cell)
        food_total = clean_money(food_cell)

        # Compute total spend in these categories
        total_spent = shopping_total + food_total

        avg_daily_spend = total_spent / day_of_month
        return round(avg_daily_spend, 2)

    except Exception as e:
        print(f"[ERROR] Failed to compute average daily spend: {e}")
        return None


async def expense_breakdown_percentages():
    ws = get_expense_worksheet()
    category_amounts = {}
    categories = {
        'grocery': 'F7',
        'gas': 'L7',
        'food': 'T7',
        'shopping': 'AB7'
    }

    # Get grand total from AE35
    grand_row = 35
    grand_col = column_index_from_string("AE")
    grand_total_val = ws.cell(grand_row, grand_col).value
    grand_total = clean_money(grand_total_val)

    if grand_total == 0:
        print("[WARN] Grand total in AE35 is 0. Cannot calculate breakdown.")
        return {}

    # Fetch category amounts from respective cells
    for category, cell_ref in categories.items():
        row = int(re.sub(r'\D', '', cell_ref))
        col = column_index_from_string(re.sub(r'\d', '', cell_ref))
        val = ws.cell(row, col).value
        amount = clean_money(val)
        category_amounts[category] = amount

    # Build result
    breakdown = {}
    for cat, amt in category_amounts.items():
        pct = round(amt / grand_total * 100, 2)
        breakdown[cat] = {
            "amount": round(amt, 2),
            "percentage": pct
        }

    result = {
        "categories": breakdown,
        "grand_total": round(grand_total, 2)
    }

    return result


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
    rows = ws.get_all_values()[2:]  # skip header rows

    # Indices for Food
    food_date_idx = column_index_from_string('N') - 1
    food_item_idx = column_index_from_string('O') - 1
    food_amount_idx = column_index_from_string('P') - 1
    food_location_idx = column_index_from_string('Q') - 1

    # Indices for Shopping
    shop_date_idx = column_index_from_string('V') - 1
    shop_item_idx = column_index_from_string('W') - 1
    shop_amount_idx = column_index_from_string('X') - 1
    shop_location_idx = column_index_from_string('Y') - 1

    max_amount = 0.0
    result = {}

    for row in rows:
        # Check Food
        if len(row) > max(food_location_idx, food_amount_idx):
            try:
                amt = clean_money(row[food_amount_idx])
                if amt > max_amount:
                    max_amount = amt
                    result = {
                        "category": "food",
                        "amount": round(amt, 2),
                        "date": row[food_date_idx],
                        "item": row[food_item_idx],
                        "location": row[food_location_idx]
                    }
            except Exception:
                pass

        # Check Shopping
        if len(row) > max(shop_location_idx, shop_amount_idx):
            try:
                amt = clean_money(row[shop_amount_idx])
                if amt > max_amount:
                    max_amount = amt
                    result = {
                        "category": "shopping",
                        "amount": round(amt, 2),
                        "date": row[shop_date_idx],
                        "item": row[shop_item_idx],
                        "location": row[shop_location_idx]
                    }
            except Exception:
                pass

    if result:
        return result
    else:
        return None


async def top_n_expenses_food_and_shopping(n=5):
    ws = get_expense_worksheet()
    rows = ws.get_all_values()[2:]  # skip header

    # Food indices
    food_date_idx = column_index_from_string('N') - 1
    food_item_idx = column_index_from_string('O') - 1
    food_amount_idx = column_index_from_string('P') - 1
    food_location_idx = column_index_from_string('Q') - 1

    # Shopping indices
    shop_date_idx = column_index_from_string('V') - 1
    shop_item_idx = column_index_from_string('W') - 1
    shop_amount_idx = column_index_from_string('X') - 1
    shop_location_idx = column_index_from_string('Y') - 1

    expenses = []

    for row in rows:
        # Food
        if len(row) > max(food_location_idx, food_amount_idx):
            try:
                amt = clean_money(row[food_amount_idx])
                if amt > 0:
                    expenses.append({
                        "category": "food",
                        "amount": round(amt, 2),
                        "date": row[food_date_idx],
                        "item": row[food_item_idx],
                        "location": row[food_location_idx]
                    })
            except Exception:
                pass

        # Shopping
        if len(row) > max(shop_location_idx, shop_amount_idx):
            try:
                amt = clean_money(row[shop_amount_idx])
                if amt > 0:
                    expenses.append({
                        "category": "shopping",
                        "amount": round(amt, 2),
                        "date": row[shop_date_idx],
                        "item": row[shop_item_idx],
                        "location": row[shop_location_idx]
                    })
            except Exception:
                pass

    # Sort by amount descending
    expenses.sort(key=lambda x: x["amount"], reverse=True)

    return expenses[:n]


async def spent_this_week():
    ws = get_expense_worksheet()
    today = datetime.today()
    start_of_week = today - timedelta(days=today.weekday())  # Monday
    total = 0.0

    category_columns = get_category_columns  # or get_category_columns() if a function

    for category, config in category_columns.items():
        start_row = config["start_row"]
        date_col_letter = config["columns"]["date"]
        amount_col_letter = config["columns"]["amount"]

        date_idx = column_index_from_string(date_col_letter) - 1
        amount_idx = column_index_from_string(amount_col_letter) - 1

        rows = ws.get_all_values()[start_row - 1:]

        for row in rows:
            if max(date_idx, amount_idx) >= len(row):
                continue

            date_str = row[date_idx].strip()
            amount_str = row[amount_idx].strip()

            if not date_str or not amount_str:
                continue

            try:
                date_obj = dateparser.parse(date_str, dayfirst=False, yearfirst=False)
                if date_obj.date() >= start_of_week.date():
                    amt = clean_money(amount_str)
                    print(f"[MATCH] {date_obj.date()} ${amt:.2f}")
                    total += amt
                else:
                    print(f"[SKIP] {date_obj.date()} before start of week {start_of_week.date()}")
            except Exception as e:
                print(f"[WARN] Skipping row: {e}")
                continue

    return total


async def projected_spending():
    today = datetime.today()
    ws = get_expense_worksheet()
    total_so_far = 0.0

    category_columns = get_category_columns  # or get_category_columns() if function

    for category, config in category_columns.items():
        start_row = config["start_row"]
        date_col_letter = config["columns"]["date"]
        amount_col_letter = config["columns"]["amount"]

        date_idx = column_index_from_string(date_col_letter) - 1
        amount_idx = column_index_from_string(amount_col_letter) - 1

        rows = ws.get_all_values()[start_row - 1:]

        for row in rows:
            if max(date_idx, amount_idx) >= len(row):
                continue

            date_str = row[date_idx].strip()
            amount_str = row[amount_idx].strip()

            if not date_str or not amount_str:
                continue

            try:
                date_obj = datetime.strptime(date_str, "%m/%d/%Y")
                if date_obj.month == today.month and date_obj.year == today.year:
                    amt = clean_money(amount_str)
                    total_so_far += amt
            except Exception as e:
                print(f"[WARN] Skipping row: {e}")
                continue

    # Project to end of month
    if today.month == 12:
        next_month = datetime(today.year + 1, 1, 1)
    else:
        next_month = datetime(today.year, today.month + 1, 1)

    days_in_month = (next_month - timedelta(days=1)).day
    days_passed = today.day
    daily_avg = total_so_far / days_passed if days_passed else 0.0
    projected = daily_avg * days_in_month
    return projected


async def weekend_vs_weekday():
    ws = get_expense_worksheet()
    weekend = 0.0
    weekday = 0.0

    category_columns = get_category_columns  # or get_category_columns() if a function

    for category, config in category_columns.items():
        start_row = config["start_row"]
        date_col_letter = config["columns"]["date"]
        amount_col_letter = config["columns"]["amount"]

        date_idx = column_index_from_string(date_col_letter) - 1
        amount_idx = column_index_from_string(amount_col_letter) - 1

        rows = ws.get_all_values()[start_row - 1:]

        for row in rows:
            if max(date_idx, amount_idx) >= len(row):
                continue

            date_str = row[date_idx].strip()
            amount_str = row[amount_idx].strip()

            if not date_str or not amount_str:
                continue

            try:
                date_obj = datetime.strptime(date_str, "%m/%d/%Y")
                amt = clean_money(amount_str)

                if date_obj.weekday() >= 5:
                    weekend += amt
                else:
                    weekday += amt

            except Exception as e:
                print(f"[WARN] Skipping row: {e}")
                continue

    return weekend, weekday


async def no_spend_days():
    ws = get_expense_worksheet()
    today = datetime.today()
    days_with_expense = set()

    category_columns = get_category_columns  # or get_category_columns() if function

    for category, config in category_columns.items():
        start_row = config["start_row"]
        date_col_letter = config["columns"]["date"]
        amount_col_letter = config["columns"]["amount"]

        date_idx = column_index_from_string(date_col_letter) - 1
        amount_idx = column_index_from_string(amount_col_letter) - 1

        rows = ws.get_all_values()[start_row - 1:]

        for row in rows:
            if max(date_idx, amount_idx) >= len(row):
                continue

            date_str = row[date_idx].strip()
            amount_str = row[amount_idx].strip()

            if not date_str or not amount_str:
                continue

            try:
                date_obj = datetime.strptime(date_str, "%m/%d/%Y")
                if date_obj.month == today.month and date_obj.year == today.year:
                    days_with_expense.add(date_obj.day)
            except Exception as e:
                print(f"[WARN] Skipping row: {e}")
                continue

    all_days = set(range(1, today.day + 1))
    no_spend = sorted(all_days - days_with_expense)
    return len(no_spend), no_spend
