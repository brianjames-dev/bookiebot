import asyncio
import gspread
import json
import os
from datetime import datetime
from openpyxl.utils import column_index_from_string
from card_ui import CardSelectView
from google.oauth2.service_account import Credentials

# Load service account credentials from environment variable
service_account_info = json.loads(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON"))

# Define the required Google Sheets scope
scopes = ["https://www.googleapis.com/auth/spreadsheets"]

# Create credentials and authorize gspread client
creds = Credentials.from_service_account_info(service_account_info, scopes=scopes)
gc = gspread.authorize(creds)

# Temporary memory for user interactions (used for dropdown callbacks)
pending_data_by_user = {}

# Define column mappings for each category
CATEGORY_COLUMNS = {
    "grocery": {
        "start_row": 3,
        "columns": {
            "date": "A",
            "amount": "B",
            "location": "C",
            "person": "D"
        }
    },
    "gas": {
        "start_row": 3,
        "columns": {
            "date": "H",
            "amount": "I",
            "person": "J"
        }
    },
    "food": {
        "start_row": 3,
        "columns": {
            "date": "N",
            "item": "O",
            "amount": "P",
            "location": "Q",
            "person": "R"
        }
    },
    "shopping": {
        "start_row": 3,
        "columns": {
            "date": "V",
            "item": "W",
            "amount": "X",
            "location": "Y",
            "person": "Z"
        }
    }
}

async def write_to_sheet(data, message):
    if data["type"] == "income":
        write_income_to_sheet(data)
        if message:
            await message.channel.send(
                f"Income logged: ${data.get('amount')} from {data.get('source')}"
            )
        return

    # Expense handling starts here
    category = data["category"].lower()
    if category not in CATEGORY_COLUMNS:
        print(f"Unknown category: {category}")
        return

    sheet = gc.open_by_key("10w4dpeNPmn0y-xG1IRWfCDWXA5cpK7gSRXYzdch7G50")
    month_name = datetime.now().strftime("%B")

    try:
        worksheet = sheet.worksheet(month_name)
    except gspread.exceptions.WorksheetNotFound:
        print(f"Sheet tab '{month_name}' not found.")
        return

    discord_user = message.author.name.lower()
    print(f"[DEBUG] Discord user from message.author: {discord_user}")

    # Determine person based on sender
    if discord_user == "hannerish":
        print("Using Initial hannerish assignment")
        data["person"] = "Hannah"

    elif discord_user == ".deebers":
        print("Using .deebers assignment")
        # Ask Deebers which card they used
        pending_data_by_user[discord_user] = {
            "data": data,
            "worksheet": worksheet
        }

        async def handle_selection(interaction, selected_card):
            stored = pending_data_by_user.pop(discord_user, None)
            if not stored:
                await interaction.response.send_message("Session expired.")
                return
            stored["data"]["person"] = selected_card
            # Normalize and validate again for dropdown flow
            values_to_write = {
                "date": datetime.now().strftime("%-m/%-d/%Y"),
                "amount": float(data.get("amount") or 0),
                "location": (data.get("location") or "").strip(),
                "person": selected_card.strip(),
                "item": (data.get("item") or data.get("food") or "").strip()
            }
            log_category_row(values_to_write, stored["worksheet"], category)
            await interaction.response.send_message(
                f"Logged {category} expense: ${stored['data']['amount']} using {selected_card}"
            )

        view = CardSelectView(handle_selection)
        await message.channel.send(
            f"{message.author.mention}, which card did you use?",
            view=view
        )
        return

    else:
        # Fallback person assignment if needed
        print("Using fallback person assignment")
        data["person"] = "Hannah"

    # Normalize and validate required fields
    values_to_write = {
        "date": datetime.now().strftime("%-m/%-d/%Y"),
        "amount": float(data.get("amount") or 0),
        "location": (data.get("location") or "").strip(),
        "person": (data.get("person") or "").strip(),
        "item": (
            data.get("item") or
            data.get("food") or
            ""
        ).strip()
    }

    # Define required fields for validation
    required_fields = ["amount", "person", "item"]
    missing = [field for field in required_fields if not values_to_write[field]]

    if missing:
        reason = ", ".join(missing)
        msg = f"Could not log entry — missing required field(s): {reason}."
        print(msg)
        if message:
            await message.channel.send(msg)
        return

    log_category_row(values_to_write, worksheet, category)

    if message:
        await message.channel.send(
            f"{category.capitalize()} expense logged: ${data.get('amount')} for {data['person']}"
        )


def write_income_to_sheet(data):
    income_sheet = gc.open_by_key("1qRwB3821TCrRuHQO4ueewXXtHbyasLJ8vvRaWqVb11c")
    month_name = datetime.now().strftime("%B")

    try:
        worksheet = income_sheet.worksheet(month_name)
    except gspread.exceptions.WorksheetNotFound:
        print(f"Income sheet tab '{month_name}' not found.")
        return

    # Find the row with "Monthly Income:"
    try:
        summary_cell = worksheet.find("Monthly Income:")
        summary_row = summary_cell.row
    except:
        print("Could not find 'Monthly Income:' in the sheet.")
        return

    # Find the last non-empty row *above* the summary
    col_b_values = worksheet.col_values(2)  # Column B (1-indexed)
    last_entry_row = None
    for i in range(summary_row - 1, 0, -1):  # Start just above the summary
        if i <= len(col_b_values) and col_b_values[i - 1].strip():
            last_entry_row = i
            break

    if last_entry_row is None:
        print("Could not find any existing income entries.")
        return

    insert_row_index = last_entry_row  # Insert AFTER last income row

    # Compose row
    description = f"{data.get('source', '')} {data.get('label', '')}".strip()
    amount = data.get("amount", "")

    worksheet.insert_row(["", description, amount], index=insert_row_index)

    print(f"Income logged: {description} - ${amount} into row {insert_row_index}")


def log_category_row(values, worksheet, category):
    print(f"[DEBUG] VALUES passed to log_category_row(): {values}")

    config = CATEGORY_COLUMNS[category]
    row_start = config["start_row"]
    columns = config["columns"]

    # Choose the reference column (e.g., "amount") to find the next empty row
    ref_col_letter = columns.get("amount") or list(columns.values())[0]
    ref_col_index = column_index_from_string(ref_col_letter)
    col_values = worksheet.col_values(ref_col_index)[row_start - 1:]
    first_empty_row = len(col_values) + row_start

    for field, col_letter in columns.items():
        value = values.get(field)
        print(f"[DEBUG] Field: {field}, Column: {col_letter}, Value: '{value}'")
        if value is not None:
            col_index = column_index_from_string(col_letter)
            print(f"[DEBUG] Writing '{value}' to row {first_empty_row}, col {col_index} ({col_letter})")
            worksheet.update_cell(first_empty_row, col_index, value)

    print(f"Wrote to {category} row {first_empty_row}")
