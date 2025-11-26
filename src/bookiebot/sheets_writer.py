# expense & income logging

from datetime import datetime
from openpyxl.utils import column_index_from_string
from bookiebot.card_ui import CardSelectView
import asyncio
import pytz
from bookiebot.sheets_config import get_category_columns
from bookiebot.sheets_utils import resolve_query_persons
from bookiebot.sheets_repo import get_sheets_repo


# Temporary memory for user interactions (used for dropdown callbacks)
pending_data_by_user = {}

async def write_to_sheet(data, message):
    if data["type"] == "income":
        await write_income_to_sheet(data, message)
        return

    await write_expense_to_sheet(data, message)


async def write_income_to_sheet(data, message):
    try:
        ws = get_sheets_repo().income_sheet()
    except Exception as e:
        print(f"Could not access income sheet: {e}")
        if message:
            await message.channel.send("Error accessing income sheet.")
        return

    try:
        summary_cell = ws.find("Monthly Income:")
        summary_row = summary_cell.row
    except:
        print("Could not find 'Monthly Income:' in the sheet.")
        return

    col_b_values = ws.col_values(2)  # Column B
    last_entry_row = None
    for i in range(summary_row - 1, 0, -1):
        if i <= len(col_b_values) and col_b_values[i - 1].strip():
            last_entry_row = i
            break

    if last_entry_row is None:
        print("Could not find any existing income entries.")
        return

    insert_row_index = last_entry_row

    description = f"{data.get('source', '')} {data.get('label', '')}".strip()
    amount = data.get("amount", "")

    ws.insert_row(["", description, amount], index=insert_row_index)

    print(f"Income logged: {description} - ${amount} into row {insert_row_index}")
    if message:
        await message.channel.send(
            f"Income logged: ${amount} from {data.get('source')}"
        )


async def write_expense_to_sheet(data, message):
    category = data["category"].lower()
    if category not in get_category_columns:
        await message.channel.send(f"❌ Unknown category: {category}")
        return

    try:
        ws = get_sheets_repo().expense_sheet()
    except Exception as e:
        print(f"❌ Could not access expense sheet: {e}")
        if message:
            await message.channel.send("Error accessing expense sheet.")
        return

    discord_user = message.author.name.lower()
    print(f"[DEBUG] Discord user: {discord_user}")

    # Determine `person(s)` to log
    person = (data.get("person") or "").strip()
    if not person:
        persons_to_log = resolve_query_persons(discord_user, None)
        print(f"[DEBUG] Resolved persons: {persons_to_log}")
        if not persons_to_log:
            await message.channel.send("❌ Could not determine person for logging.")
            return
    else:
        persons_to_log = resolve_query_persons(discord_user, person)
        print(f"[DEBUG] Resolved explicit person: {persons_to_log}")
        if not persons_to_log:
            await message.channel.send(f"❌ Could not resolve specified person: {person}")
            return

    # If multiple (ambiguous Brian), ask which card
    if len(persons_to_log) > 1:
        pending_data_by_user[discord_user] = {"data": data, "worksheet": ws, "category": category}

        async def handle_selection(interaction, selected_card):
            stored = pending_data_by_user.pop(discord_user, None)
            if not stored:
                await interaction.response.send_message("❌ Session expired.")
                return

            stored["data"]["person"] = selected_card
            values = normalize_expense_data(stored["data"], selected_card)
            log_category_row(values, ws, category)

            await interaction.response.send_message(
                f"✅ Logged {category} expense: ${stored['data']['amount']} for {selected_card}"
            )

        view = CardSelectView(handle_selection)
        await message.channel.send(
            f"{message.author.mention}, which card did you use?",
            view=view
        )
        return

    # Otherwise only one person
    selected_person = persons_to_log[0]
    data["person"] = selected_person
    values_to_write = normalize_expense_data(data, selected_person)

    # Validate required fields
    required_fields = ["amount", "person", "item"]
    missing = [f for f in required_fields if not values_to_write.get(f)]
    if missing:
        msg = f"❌ Could not log entry — missing: {', '.join(missing)}."
        print(msg)
        if message:
            await message.channel.send(msg)
        return

    log_category_row(values_to_write, ws, category)

    if message:
        await message.channel.send(
            f"✅ {category.capitalize()} expense logged: ${data.get('amount')} for {selected_person}"
        )


def normalize_expense_data(data, person):
    tz = pytz.timezone("America/Los_Angeles")  # or whatever timezone you’re in
    local_now = datetime.now(tz)
    return {
        "date": local_now.strftime("%-m/%-d/%Y"),
        "amount": float(data.get("amount") or 0),
        "location": (data.get("location") or "").strip(),
        "person": person.strip(),
        "item": (
            data.get("item") or
            data.get("food") or
            ""
        ).strip()
    }


def log_category_row(values, worksheet, category):
    print(f"[DEBUG] VALUES passed to log_category_row(): {values}")

    config = get_category_columns[category]
    row_start = config["start_row"]
    columns = config["columns"]

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
