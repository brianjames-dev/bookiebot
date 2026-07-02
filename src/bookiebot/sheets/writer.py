# expense & income logging

from datetime import datetime
import logging
from typing import Any, Literal, cast, overload
from openpyxl.utils import column_index_from_string
from bookiebot.ui.card import CardButtonView
import asyncio
import os
from zoneinfo import ZoneInfo
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.utils import resolve_query_persons
from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import get_current_discord_user_id
from bookiebot.sheets.undo import UndoAction, _sheet_user_entered_value, _update_contiguous_row, record_undo_action

logger = logging.getLogger(__name__)


# Temporary memory for user interactions (used for dropdown callbacks)
pending_data_by_user = {}


async def _expense_sheet_with_retry(attempts: int = 2):
    last_error: Exception | None = None
    for attempt in range(max(1, attempts)):
        try:
            return get_sheets_repo().expense_sheet()
        except Exception as exc:
            last_error = exc
            if attempt < attempts - 1:
                await asyncio.sleep(0.75)
    assert last_error is not None
    raise last_error


async def write_to_sheet(data, message):
    if data["type"] == "income":
        await write_income_to_sheet(data, message)
        return

    await write_expense_to_sheet(data, message)


async def write_income_to_sheet(data, message):
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
        row, description, amount = cast(
            tuple[int, str, Any],
            log_income_row(data, ws, return_action_id=False),
        )
    except Exception as e:
        logger.error("Could not log income", extra={"exception": str(e)})
        return

    logger.info("Income logged", extra={"description": description, "amount": amount, "row": row})
    if message:
        await message.channel.send(
            f"Income logged: ${amount} from {data.get('source')}"
        )


@overload
def log_income_row(
    data: dict[str, Any],
    worksheet: Any,
    *,
    return_action_id: Literal[True],
    metadata_extra: dict | None = None,
) -> tuple[int, str, Any, str | None]:
    ...


@overload
def log_income_row(
    data: dict[str, Any],
    worksheet: Any,
    *,
    return_action_id: Literal[False] = False,
    metadata_extra: dict | None = None,
) -> tuple[int, str, Any]:
    ...


def log_income_row(data: dict[str, Any], worksheet: Any, *, return_action_id: bool = False, metadata_extra: dict | None = None):
    try:
        summary_cell = worksheet.find("Monthly Income:")
        summary_row = summary_cell.row
    except Exception as e:
        logger.error("Could not find 'Monthly Income:' in the sheet.", extra={"exception": str(e)})
        raise

    col_b_values = worksheet.col_values(2)  # Column B
    last_entry_row = None
    for i in range(summary_row - 1, 0, -1):
        if i <= len(col_b_values) and col_b_values[i - 1].strip():
            last_entry_row = i
            break

    if last_entry_row is None:
        logger.error("Could not find any existing income entries.")
        raise RuntimeError("Could not find any existing income entries.")

    insert_row_index = last_entry_row

    description = f"{data.get('source', '')} {data.get('label', '')}".strip()
    amount = data.get("amount", "")

    worksheet.insert_row(["", description, amount], index=insert_row_index)
    action_id = record_undo_action(
        get_current_discord_user_id(),
        UndoAction(
            worksheet="income",
            kind="delete_row",
            row=insert_row_index,
            columns=[],
            previous_values=[],
            new_values=["", str(description), str(amount)],
            metadata={"type": "income", "source": str(data.get("source") or ""), **(metadata_extra or {})},
            description=f"income ${amount} from {data.get('source')}",
        ),
    )
    if return_action_id:
        return insert_row_index, description, amount, action_id
    return insert_row_index, description, amount


async def write_expense_to_sheet(data, message):
    category = (data.get("category") or "").strip().lower()
    if not category:
        if message:
            await message.channel.send("❌ Could not log entry — missing category.")
        return

    if category not in get_category_columns:
        available = ", ".join(sorted(get_category_columns.keys()))
        await message.channel.send(f"❌ Unknown category: {category}. Available categories: {available}.")
        return

    ws = None
    try:
        ws = await _expense_sheet_with_retry()
    except Exception as e:
        logger.exception("Could not access expense sheet", extra={"exception": str(e), "category": category})
        if message:
            await message.channel.send("❌ I could not access the expense sheet. Please try again in a moment.")
        return
    if ws is None:
        if message:
            await message.channel.send("❌ I could not access the expense sheet. Please try again in a moment.")
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
        pending_key = discord_user_id or discord_user
        owner_user_id = str(getattr(message.author, "id", "") or "") or None
        pending_data_by_user[pending_key] = {
            "data": data,
            "worksheet": ws,
            "category": category,
            "undo_user_key": get_current_discord_user_id() or discord_user_id,
            "owner_user_id": owner_user_id,
        }

        async def handle_selection(interaction, selected_card):
            user = getattr(interaction, "user", None)
            user_id = str(getattr(user, "id", "")) if user is not None else ""
            if owner_user_id and user_id != owner_user_id:
                await interaction.response.send_message(
                    "This card selection belongs to another user.",
                    ephemeral=True,
                )
                return
            stored = pending_data_by_user.pop(pending_key, None)
            if not stored:
                await interaction.response.send_message("❌ Session expired.", ephemeral=True)
                return

            # Acknowledge quickly to avoid "Unknown interaction" errors, then send follow-up.
            try:
                await interaction.response.defer(ephemeral=True)
            except Exception:
                # If already acknowledged, continue to follow-up.
                pass

            stored["data"]["person"] = selected_card
            values = normalize_expense_data(stored["data"], selected_card)
            row = log_category_row(values, stored["worksheet"], stored["category"])
            record_expense_undo(
                stored["category"],
                row,
                values,
                selected_card,
                stored.get("undo_user_key"),
            )

            await interaction.followup.send(
                f"✅ Logged {stored['category']} expense: ${stored['data']['amount']} for {selected_card}",
                ephemeral=True,
            )

        view = CardButtonView(handle_selection, owner_user_id=owner_user_id)
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

    row = log_category_row(values_to_write, ws, category)
    record_expense_undo(category, row, values_to_write, selected_person)

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

    write_columns = []
    write_values = []
    for field, col_letter in columns.items():
        value = values.get(field)
        logger.debug("Writing field", extra={"field": field, "column": col_letter, "value": value})
        if value is not None:
            col_index = column_index_from_string(col_letter)
            logger.debug("Writing cell", extra={"value": value, "row": first_empty_row, "col": col_index, "column": col_letter})
            write_columns.append(col_index)
            write_values.append(_sheet_user_entered_value(field, value))

    _update_contiguous_row(worksheet, first_empty_row, write_columns, write_values)

    logger.info("Logged expense row", extra={"category": category, "row": first_empty_row})
    return first_empty_row


def record_expense_undo(category, row, values_or_amount, person, user_key=None, metadata_extra: dict | None = None):
    columns = get_category_columns[category]["columns"]
    col_indexes = [column_index_from_string(col_letter) for col_letter in columns.values()]
    if isinstance(values_or_amount, dict):
        values = values_or_amount
        amount = values.get("amount")
        new_values = [str(values.get(field, "")) for field in columns.keys()]
    else:
        amount = values_or_amount
        new_values = []
    return record_undo_action(
        user_key or get_current_discord_user_id(),
        UndoAction(
            worksheet="expense",
            kind="clear_cells",
            row=row,
            columns=col_indexes,
            previous_values=["" for _ in col_indexes],
            new_values=new_values,
            metadata={"type": "expense", "category": category, "person": str(person), **(metadata_extra or {})},
            description=f"{category} expense ${amount} for {person}",
        ),
    )
