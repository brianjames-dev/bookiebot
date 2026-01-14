# expense & income logging

from datetime import datetime
import logging
from openpyxl.utils import column_index_from_string
from bookiebot.ui.card import CardButtonView
import asyncio
import os
from zoneinfo import ZoneInfo
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.utils import resolve_query_persons
from bookiebot.sheets.repo import get_sheets_repo

logger = logging.getLogger(__name__)


# Temporary memory for user interactions (used for dropdown callbacks)
pending_data_by_user = {}

async def write_to_sheet(data, message):
    if data["type"] == "income":
        await write_income_to_sheet(data, message)
        return

    await write_expense_to_sheet(data, message)


async def write_income_to_sheet(data, message):
    ws = None
    try:
        ws = get_sheets_repo().income_sheet()
    except Exception as e:
        logger.error("Could not access income sheet", extra={"exception": str(e)})
        if message:
            await message.channel.send("Error accessing income sheet.")
        return
    if ws is None:
        if message:
            await message.channel.send("Error accessing income sheet.")
        return

    try:
        summary_cell = ws.find("Monthly Income:")
        summary_row = summary_cell.row
    except Exception as e:
        logger.error("Could not find 'Monthly Income:' in the sheet.", extra={"exception": str(e)})
        return

    col_b_values = ws.col_values(2)  # Column B
    last_entry_row = None
    for i in range(summary_row - 1, 0, -1):
        if i <= len(col_b_values) and col_b_values[i - 1].strip():
            last_entry_row = i
            break

    if last_entry_row is None:
        logger.error("Could not find any existing income entries.")
        return

    insert_row_index = last_entry_row

    description = f"{data.get('source', '')} {data.get('label', '')}".strip()
    amount = data.get("amount", "")

    ws.insert_row(["", description, amount], index=insert_row_index)

    logger.info("Income logged", extra={"description": description, "amount": amount, "row": insert_row_index})
    if message:
        await message.channel.send(
            f"Income logged: ${amount} from {data.get('source')}"
        )


async def write_expense_to_sheet(data, message):
    category = (data.get("category") or "").strip().lower()
    if not category:
        if message:
            await message.channel.send("❌ Could not log entry — missing category.")
        return

    if category not in get_category_columns:
        await message.channel.send(f"❌ Unknown category: {category}")
        return

    ws = None
    try:
        ws = get_sheets_repo().expense_sheet()
    except Exception as e:
        logger.error("Could not access expense sheet", extra={"exception": str(e)})
        if message:
            await message.channel.send("Error accessing expense sheet.")
        return
    if ws is None:
        if message:
            await message.channel.send("Error accessing expense sheet.")
        return

    discord_user = getattr(message.author, "name", "").lower()
    discord_user_id = getattr(message.author, "id", None)
    discord_user_id = str(discord_user_id) if discord_user_id is not None else None

    # If the message explicitly mentions a non-bot user, treat that mention as the actor.
    # This lets people post via shortcuts/webhooks and still log under the correct account.
    for mentioned in getattr(message, "mentions", []) or []:
        if getattr(mentioned, "bot", False):
            continue
        discord_user = (getattr(mentioned, "name", None) or getattr(mentioned, "display_name", "")).lower()
        mentioned_id = getattr(mentioned, "id", discord_user_id)
        discord_user_id = str(mentioned_id) if mentioned_id is not None else None
        logger.debug("Using mentioned user for resolution", extra={"user": discord_user, "user_id": discord_user_id})
        break
    logger.debug("Discord user", extra={"user": discord_user})

    # Determine `person(s)` to log
    person = (data.get("person") or "").strip()
    if person.lower() in {"total", "all", "both", "everyone", "all persons", "all people"}:
        person = ""
    if not person:
        persons_to_log = resolve_query_persons(discord_user, None, discord_user_id)
        logger.debug("Resolved persons", extra={"persons": persons_to_log})
        if not persons_to_log:
            await message.channel.send("❌ Could not determine person for logging.")
            return
    else:
        persons_to_log = resolve_query_persons(discord_user, person, discord_user_id)
        logger.debug("Resolved explicit person", extra={"persons": persons_to_log})
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

            # Acknowledge quickly to avoid "Unknown interaction" errors, then send follow-up.
            try:
                await interaction.response.defer(ephemeral=True)
            except Exception:
                # If already acknowledged, continue to follow-up.
                pass

            stored["data"]["person"] = selected_card
            values = normalize_expense_data(stored["data"], selected_card)
            log_category_row(values, ws, category)

            await interaction.followup.send(
                f"✅ Logged {category} expense: ${stored['data']['amount']} for {selected_card}"
            )

        view = CardButtonView(handle_selection)
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
    tz = ZoneInfo(os.getenv("TZ", "America/Los_Angeles"))
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
    logger.debug("Values passed to log_category_row", extra={"values": values})

    config = get_category_columns[category]
    row_start = config["start_row"]
    columns = config["columns"]

    ref_col_letter = columns.get("amount") or list(columns.values())[0]
    ref_col_index = column_index_from_string(ref_col_letter)
    col_values = worksheet.col_values(ref_col_index)[row_start - 1:]
    first_empty_row = len(col_values) + row_start

    for field, col_letter in columns.items():
        value = values.get(field)
        logger.debug("Writing field", extra={"field": field, "column": col_letter, "value": value})
        if value is not None:
            col_index = column_index_from_string(col_letter)
            logger.debug("Writing cell", extra={"value": value, "row": first_empty_row, "col": col_index, "column": col_letter})
            worksheet.update_cell(first_empty_row, col_index, value)

    logger.info("Logged expense row", extra={"category": category, "row": first_empty_row})
