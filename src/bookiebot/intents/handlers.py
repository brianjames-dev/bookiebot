# all intent handlers
import os

# Disable discord voice/audio stack to avoid loading audioop (deprecated in Python 3.13)
os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

from bookiebot.sheets.writer import write_to_sheet
import bookiebot.sheets.utils as su
import openai
import matplotlib.pyplot as plt
import io
from datetime import datetime
from collections.abc import Awaitable, Callable
from typing import Any, cast
from bookiebot.sheets.utils import resolve_query_persons, get_local_today
from bookiebot.sheets.routing import (
    SheetRoutingError,
    UnknownDiscordUserError,
    get_user_config,
    resolve_actor_key,
    sheet_user_context,
)
from bookiebot.sheets.undo import (
    clear_pending_action_selection,
    delete_recent_action,
    editable_fields_for_action,
    format_action_detail_block,
    format_recent_action_list,
    matching_recent_actions,
    move_recent_action,
    next_recent_actions_page,
    recent_actions,
    reset_recent_actions_page,
    select_recent_action,
    set_pending_delete_selection,
    set_pending_move_selection,
    set_pending_update_field,
    set_pending_update_selection,
    undo_last_action,
    update_recent_action,
)
from bookiebot.ui.recent_actions import (
    MoveCategoryView,
    PersonSelectView,
    RecentActionDecisionView,
    RecentActionSelectView,
    UpdateFieldView,
)

try:
    import discord
except ImportError:  # pragma: no cover - fallback for tests without discord.py
    class _Discord:
        class File:
            def __init__(self, fp, filename):
                self.fp = fp
                self.filename = filename

    discord = _Discord()

IntentEntities = dict[str, Any]
IntentHandler = Callable[[IntentEntities, Any], Awaitable[None]]


INTENT_HANDLERS: dict[str, IntentHandler] = {
    # Logging handlers
    "log_expense":                          lambda e, m: write_transaction_to_sheet("expense", e, m),
    "log_income":                           lambda e, m: write_transaction_to_sheet("income", e, m),
    "log_rent_paid":                        lambda e, m: log_rent_paid_handler(e, m),
    "log_pge_paid":                         lambda e, m: log_pge_paid_handler(e, m),
    "log_recology_paid":                    lambda e, m: log_recology_paid_handler(e, m),
    "log_water_paid":                       lambda e, m: log_water_paid_handler(e, m),
    "log_student_loan_paid":                lambda e, m: log_student_loan_paid_handler(e, m),
    "log_1st_savings":                      lambda e, m: log_1st_savings_handler(e, m),
    "log_2nd_savings":                      lambda e, m: log_2nd_savings_handler(e, m),
    "log_need_expense":                     lambda e, m: log_need_expense_handler(e, m),
    "undo_last_transaction":                lambda e, m: undo_last_transaction_handler(m),
    "delete_recent_action":                 lambda e, m: delete_recent_action_handler(e, m),
    "query_recent_actions":                 lambda e, m: query_recent_actions_handler(e, m),
    "update_recent_action":                 lambda e, m: update_recent_action_handler(e, m),
    "move_recent_action":                   lambda e, m: move_recent_action_handler(e, m),

    # Query handlers
    "query_burn_rate":                      lambda e, m: query_burn_rate_handler(m),
    "query_rent_paid":                      lambda e, m: query_rent_paid_handler(m),
    "query_pge_paid":                       lambda e, m: query_pge_paid_handler(m),
    "query_recology_paid":                  lambda e, m: query_recology_paid_handler(m),
    "query_water_paid":                     lambda e, m: query_water_paid_handler(m),
    "query_student_loans_paid":             lambda e, m: query_student_loan_paid_handler(m),
    "query_total_for_store":                lambda e, m: query_total_for_store_handler(e, m),
    "query_highest_expense_category":       lambda e, m: query_highest_expense_category_handler(e, m),
    "query_total_income":                   lambda e, m: query_total_income_handler(m),
    "query_remaining_budget":               lambda e, m: query_remaining_budget_handler(m), 
    "query_average_daily_spend":            lambda e, m: query_average_daily_spend_handler(e, m),
    "query_expense_breakdown_percentages":  lambda e, m: query_expense_breakdown_handler(e, m),
    "query_total_for_category":             lambda e, m: query_total_for_category_handler(e, m),
    "query_largest_single_expense":         lambda e, m: query_largest_single_expense_handler(e, m),
    "query_top_n_expenses":                 lambda e, m: query_top_n_expenses_handler(e, m),
    "query_spent_this_week":                lambda e, m: query_spent_this_week_handler(e, m),
    "query_projected_spending":             lambda e, m: query_projected_spending_handler(e, m),
    "query_weekend_vs_weekday":             lambda e, m: query_weekend_vs_weekday_handler(e, m),
    "query_no_spend_days":                  lambda e, m: query_no_spend_days_handler(e, m),
    "query_total_for_item":                 lambda e, m: query_total_for_item_handler(e, m),
    "query_subscriptions":                  lambda e, m: query_subscriptions_handler(m),
    "query_daily_spending_calendar":        lambda e, m: query_daily_spending_calendar_handler(e, m),
    "query_best_worst_day_of_week":         lambda e, m: query_best_worst_day_of_week_handler(e, m),
    "query_longest_no_spend_streak":        lambda e, m: query_longest_no_spend_streak_handler(e, m),
    "query_days_budget_lasts":              lambda e, m: query_days_budget_lasts_handler(m),
    "query_most_frequent_purchases":        lambda e, m: query_most_frequent_purchases_handler(e, m),
    "query_expenses_on_day":                lambda e, m: query_expenses_on_day_handler(e, m),
    "query_1st_savings":                    lambda e, m: query_1st_savings_handler(e, m),
    "query_2nd_savings":                    lambda e, m: query_2nd_savings_handler(e, m),
}


async def write_transaction_to_sheet(transaction_type: str, entities: IntentEntities, message: Any) -> None:
    entities["type"] = transaction_type
    await write_to_sheet(entities, message)


def _message_actor_key(message) -> str | None:
    for mentioned in getattr(message, "mentions", []) or []:
        if getattr(mentioned, "bot", False):
            continue
        mentioned_id = getattr(mentioned, "id", None)
        mentioned_name = getattr(mentioned, "name", None) or getattr(mentioned, "display_name", None)
        return resolve_actor_key(mentioned_id, mentioned_name)

    author = getattr(message, "author", None)
    author_id = getattr(author, "id", None)
    author_name = getattr(author, "name", None) or getattr(author, "display_name", None)
    return resolve_actor_key(author_id, author_name)


def _budget_profile_name(message) -> str:
    return get_user_config(_message_actor_key(message)).name


# INTENT HANDLER
async def handle_intent(intent: str, entities: IntentEntities, message: Any, last_context: Any = None) -> None:
    handler = INTENT_HANDLERS.get(intent)
    if not handler or intent == "fallback":
        await fallback_handler(message.content, message, context=last_context)
        return

    actor_user_id = _message_actor_key(message)
    try:
        get_user_config(actor_user_id)
    except UnknownDiscordUserError as e:
        await message.channel.send(str(e))
        return

    with sheet_user_context(actor_user_id):
        if "person" not in entities or not entities["person"]:
            print(f"👤 No person specified, letting resolver handle Discord user: {message.author.name}")
            entities["person"] = None

        # For query intents, resolve to actual list of person(s)
        if intent.startswith("query_"):
            discord_user = getattr(message.author, "name", "").lower()
            person = entities.get("person")
            persons_to_query = resolve_query_persons(discord_user, person, actor_user_id)

            if not persons_to_query:
                await message.channel.send("❌ Could not resolve person(s) to query.")
                return

            # overwrite person in entities with resolved list
            entities["persons"] = persons_to_query
            print(f"🔎 Resolved persons for query: {persons_to_query}")

        try:
            await handler(entities, message)
        except SheetRoutingError as e:
            await message.channel.send(str(e))


async def undo_last_transaction_handler(message: Any) -> None:
    success, detail = undo_last_action(_message_actor_key(message))
    prefix = "✅" if success else "❌"
    await message.channel.send(f"{prefix} {detail}")


async def delete_recent_action_handler(entities: IntentEntities, message: Any) -> None:
    index = entities.get("index")
    try:
        index = int(index) if index is not None else None
    except (TypeError, ValueError):
        index = None

    success, detail = delete_recent_action(
        _message_actor_key(message),
        index=index,
        action_id=entities.get("action_id"),
        match_text=entities.get("match_text") or entities.get("description") or entities.get("location") or entities.get("item"),
    )
    await _send_action_result(message, success, detail)


async def query_recent_actions_handler(entities: IntentEntities, message: Any) -> None:
    try:
        limit = int(entities.get("n") or 5)
    except (TypeError, ValueError):
        limit = 5
    limit = min(max(limit, 1), 25)
    actor_key = _message_actor_key(message)
    if entities.get("more"):
        output, actions = next_recent_actions_page(actor_key, 5)
    else:
        actions = recent_actions(actor_key, limit)
        reset_recent_actions_page(actor_key)
        output = format_recent_action_list(actions)

    view = _recent_action_select_view(actor_key, actions) if actions else None
    await message.channel.send(_with_component_spacer(output, view), view=view)


def _recent_action_select_view(actor_key: str | None, actions: list[Any], *, destination_category: str | None = None, updates: dict[str, Any] | None = None):
    async def handle_select(interaction: Any, action_id: str) -> None:
        if destination_category:
            try:
                await interaction.response.defer()
            except Exception:
                pass
            success, detail = move_recent_action(
                actor_key,
                destination_category=destination_category,
                updates=updates or {},
                action_id=action_id,
            )
            await _send_interaction_action_result(interaction, success, detail)
            return

        set_pending_update_selection(actor_key, action_id)

        async def handle_decision(decision_interaction: Any, decision: str) -> None:
            if decision == "update":
                set_pending_update_selection(actor_key, action_id)
                logged = select_recent_action(actor_key, action_id=action_id)
                fields = editable_fields_for_action(logged.action) if logged else []
                if not fields:
                    await decision_interaction.response.send_message("I do not know how to update fields for that transaction yet.")
                    return
                await decision_interaction.response.send_message(
                    "Which field would you like to update?",
                    view=_update_field_view(actor_key, action_id, fields),
                )
                return
            if decision == "delete":
                set_pending_delete_selection(actor_key, action_id)
                try:
                    await decision_interaction.response.defer()
                except Exception:
                    pass
                success, detail = delete_recent_action(actor_key, index=1)
                await _send_interaction_action_result(decision_interaction, success, detail)
                return
            if decision == "move":
                set_pending_move_selection(actor_key, action_id)
                await decision_interaction.response.send_message(
                    "Which category would you like to move this transaction to?",
                    view=_move_category_view(actor_key, action_id),
                )
                return
            clear_pending_action_selection(actor_key)
            await decision_interaction.response.send_message("Canceled.")

        logged = select_recent_action(actor_key, action_id=action_id)
        detail_block = f"\n\n{format_action_detail_block(logged.action)}" if logged else ""
        await interaction.response.send_message(
            f"What would you like to do with this transaction?{detail_block}",
            view=RecentActionDecisionView(handle_decision),
        )

    return RecentActionSelectView(actions, handle_select)


def _move_category_view(actor_key: str | None, action_id: str, updates: dict[str, Any] | None = None):
    async def handle_category(interaction: Any, category: str) -> None:
        try:
            await interaction.response.defer()
        except Exception:
            pass
        success, detail = move_recent_action(
            actor_key,
            destination_category=category,
            updates=updates or {},
            action_id=action_id,
        )
        await _send_interaction_action_result(interaction, success, detail)

    return MoveCategoryView(handle_category)


def _update_field_view(actor_key: str | None, action_id: str, fields: list[str]):
    async def handle_field(interaction: Any, field: str) -> None:
        if field == "person":
            async def handle_person(person_interaction: Any, person: str) -> None:
                try:
                    await person_interaction.response.defer()
                except Exception:
                    pass
                success, detail = update_recent_action(
                    actor_key,
                    updates={"person": person},
                    action_id=action_id,
                )
                await _send_interaction_action_result(person_interaction, success, detail)

            await interaction.response.send_message(
                "Which person/card should this transaction use?",
                view=PersonSelectView(handle_person),
            )
            return

        set_pending_update_field(actor_key, action_id, field)
        label = field.replace("_", " ")
        await interaction.response.send_message(f"Reply with the new {label}.")

    return UpdateFieldView(fields, handle_field)


async def update_recent_action_handler(entities: IntentEntities, message: Any) -> None:
    updates = entities.get("updates") or {}
    if not isinstance(updates, dict):
        updates = {}

    for field in ("amount", "location", "item", "person", "date"):
        if field in entities and field not in updates:
            updates[field] = entities[field]

    index = entities.get("index")
    try:
        index = int(index) if index is not None else None
    except (TypeError, ValueError):
        index = None

    success, detail = update_recent_action(
        _message_actor_key(message),
        updates=updates,
        index=index,
        action_id=entities.get("action_id"),
        match_text=entities.get("match_text") or entities.get("description") or entities.get("location") or entities.get("item"),
    )
    await _send_action_result(message, success, detail)


async def move_recent_action_handler(entities: IntentEntities, message: Any) -> None:
    updates = entities.get("updates") or {}
    if not isinstance(updates, dict):
        updates = {}
    for field in ("amount", "location", "item", "person", "date"):
        if field in entities and field not in updates:
            updates[field] = entities[field]

    index = entities.get("index")
    try:
        index = int(index) if index is not None else None
    except (TypeError, ValueError):
        index = None

    actor_key = _message_actor_key(message)
    destination_category = entities.get("category") or entities.get("destination_category")
    match_text = entities.get("match_text") or entities.get("description") or entities.get("location") or entities.get("item")

    success, detail = move_recent_action(
        actor_key,
        destination_category=destination_category,
        updates=updates,
        index=index,
        action_id=entities.get("action_id"),
        match_text=match_text,
    )
    if detail.startswith("Recent logged actions"):
        if match_text:
            actions = matching_recent_actions(actor_key, match_text, 10)
        else:
            actions = recent_actions(actor_key, 5)
        view = _recent_action_select_view(
            actor_key,
            actions,
            destination_category=str(destination_category) if destination_category else None,
            updates=updates,
        ) if actions else None
        await message.channel.send(_with_component_spacer(detail, view), view=view)
        return
    await _send_action_result(message, success, detail)


async def _send_action_result(message: Any, success: bool, detail: str) -> None:
    if detail.startswith("Recent logged actions") or detail.startswith("I do not have more recent logged actions"):
        await message.channel.send(detail)
        return
    if detail == "What is the name of the item?":
        await message.channel.send(detail)
        return
    prefix = "✅" if success else "❌"
    await message.channel.send(f"{prefix} {detail}")


async def _send_interaction_action_result(interaction: Any, success: bool, detail: str) -> None:
    if detail == "What is the name of the item?":
        await interaction.followup.send(detail)
        return
    prefix = "✅" if success else "❌"
    await interaction.followup.send(f"{prefix} {detail}")


def _with_component_spacer(content: str, view: Any | None) -> str:
    return f"{content}\n\u200b" if view is not None else content


# FALLBACK HANDLER
async def fallback_handler(user_message: str, message: Any, context: Any = None) -> None:
    """
    If no intent matched, use GPT to generate a general helpful response.
    Optionally include context from last output.
    """
    prompt = f"""
You are a helpful financial assistant. The user previously saw this context (if any):
\"\"\"{context}\"\"\"

Now the user asks:
\"\"\"{user_message}\"\"\"

Please respond helpfully and clearly.
"""
    try:
        response = cast(
            Any,
            openai.ChatCompletion.create(
                model="gpt-3.5-turbo",
                messages=[
                    {"role": "system", "content": "You are a financial assistant chatbot."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5
            ),
        )
        reply = response.choices[0].message.content
        await message.channel.send(reply)
    except Exception as e:
        print("[ERROR] fallback_handler failed:", e)
        await message.channel.send("❌ Sorry, I couldn't process your request.")


# QUERY HANDLERS
async def query_burn_rate_handler(message: Any) -> None:
    burn_rate, desc = await su.calculate_burn_rate()
    if burn_rate and desc:
        await message.channel.send(f"🔥 Burn rate: You are allowed to spend {burn_rate}\n\n {desc}")
    elif burn_rate:
        await message.channel.send(f"🔥 Burn rate: You are allowed to spend {burn_rate}")
    else:
        await message.channel.send("❌ Could not determine burn rate.")


async def query_rent_paid_handler(message):
    paid, amount = await su.check_rent_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for rent this month.")
    else:
        await message.channel.send("❌ You have NOT paid rent yet this month.")


async def query_pge_paid_handler(message):
    paid, amount = await su.check_pge_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for PG&E this month.")
    else:
        await message.channel.send("❌ You have NOT paid PG&E yet this month.")


async def query_recology_paid_handler(message):
    paid, amount = await su.check_recology_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for Recology this month.")
    else:
        await message.channel.send("❌ You have NOT paid Recology yet this month.")


async def query_water_paid_handler(message):
    paid, amount = await su.check_water_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for water this month.")
    else:
        await message.channel.send("❌ You have NOT paid water yet this month.")


async def query_student_loan_paid_handler(message):
    paid, amount = await su.check_student_loan_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for student loans this month.")
    else:
        await message.channel.send("❌ You have NOT made a student loan payment yet this month.")


async def query_total_for_store_handler(entities, message):
    store = entities.get("store")
    persons_to_query = entities.get("persons")  # <-- already resolved in handle_intent

    if not store:
        await message.channel.send("❌ Please specify a store.")
        return
    if not persons_to_query:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total_result = await su.total_spent_at_store(store, persons_to_query)
    total: float
    matches: list[Any]
    if isinstance(total_result, tuple):
        total, matches = total_result
    else:
        total, matches = total_result, []

    response = f"💰 You’ve spent ${total:.2f} at {store} this month.\n"
    if matches:
        response += "\n**Top transactions:**\n"
        for date_obj, location, amount, category in matches:
            date_str = date_obj.strftime("%m/%d")
            response += f"- {date_str}: ${amount:.2f} at {location} ({category})\n"
    else:
        response += "\n*(No transactions found this month.)*"

    await message.channel.send(response)



async def query_highest_expense_category_handler(entities, message):
    discord_user = getattr(message.author, "name", "").lower()
    discord_user_id = getattr(message.author, "id", None)
    persons_to_query = resolve_query_persons(discord_user, entities.get("person"), discord_user_id)

    if not persons_to_query:
        await message.channel.send("❌ Could not resolve person(s) to query.")
        return

    category, amount = await su.highest_expense_category(persons_to_query)
    await message.channel.send(f"📊 Highest expense category: {category} (${amount:.2f}).")


async def query_total_income_handler(message):
    income = await su.total_income()
    await message.channel.send(f"Total income this month: ${income:.2f}.")


async def query_remaining_budget_handler(message):
    remaining = await su.remaining_budget()
    if remaining >= 0:
        await message.channel.send(
            f"Remaining spending budget this month: ${remaining:.2f}."
        )
    elif remaining < 0:
        await message.channel.send(
            f"You're currently exceeding this month's spending budget by ${abs(remaining):.2f}."
        )
    else:
        await message.channel.send(
            "Sorry, I couldn’t determine your remaining budget."
        )


async def query_average_daily_spend_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    avg = await su.average_daily_spend(persons)
    if avg is not None:
        await message.channel.send(f"📊 Average daily spend this month: ${avg:.2f}.")
    else:
        await message.channel.send("❌ Could not calculate average daily spend.")


async def query_expense_breakdown_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    breakdown = await su.expense_breakdown_percentages(persons)

    if not breakdown:
        await message.channel.send("❌ Could not calculate expense breakdown.")
        return

    # Prepare data
    labels = []
    amounts = []
    lines = []

    for category, info in breakdown["categories"].items():
        amt = info["amount"]
        pct = info["percentage"]

        if amt == 0:
            continue  # 🚨 skip 0 categories

        labels.append(f"{category.capitalize()}\n(${amt:.2f})")
        amounts.append(amt)
        lines.append(f"{category.capitalize()}: ${amt:.2f} ({pct:.2f}%)")

    people_str = ", ".join(persons)
    grand_total = breakdown["grand_total"]

    # Build text breakdown
    text = "\n".join(lines)
    text = f"📊 Expense breakdown for {people_str}:\n{text}\n\n💵 Total: ${grand_total:.2f}"

    # Pie Chart
    fig, ax = plt.subplots(figsize=(6, 6))
    cmap = plt.get_cmap('Pastel1')
    colors = getattr(cmap, "colors", None)

    largest_idx = amounts.index(max(amounts))
    explode = [0.1 if i == largest_idx else 0 for i in range(len(amounts))]

    pie_result = ax.pie(
        amounts,
        labels=labels,
        autopct='%1.1f%%',
        startangle=140,
        shadow=True,
        colors=colors,
        explode=explode,
        radius=0.9,
        textprops={'fontsize': 10}
    )

    wedges = pie_result[0]
    texts = pie_result[1] if len(pie_result) > 1 else []
    autotexts = pie_result[2] if len(pie_result) > 2 else []

    for autotext in autotexts:
        autotext.set_fontsize(11)
        autotext.set_fontweight('bold')

    ax.set_title(
        f"Expense Breakdown\nTotal: ${grand_total:.2f}",
        fontsize=16,
        fontweight='bold',
        pad=10
    )

    ax.axis('equal')

    plt.tight_layout()

    buf = io.BytesIO()
    plt.savefig(buf, format='png', dpi=150)
    buf.seek(0)
    plt.close(fig)

    file = discord.File(fp=buf, filename="expense_breakdown.png")

    await message.channel.send(content=text, file=file)


async def query_total_for_category_handler(entities, message):
    category = entities.get("category")
    persons = entities.get("persons")

    if not category:
        await message.channel.send("❌ Please specify a category.")
        return
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total = await su.total_for_category(category, persons)
    await message.channel.send(
        f"💰 Total spent on **{category.capitalize()}** this month: ${total:.2f}."
    )


async def query_largest_single_expense_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.largest_single_expense(persons)
    if isinstance(result, dict):
        await message.channel.send(
            f"💸 Largest single expense: ${result['amount']:.2f} — "
            f"{result['item']} at {result['location']} on {result['date']} "
            f"({result['category']})"
        )
    else:
        await message.channel.send("❌ Could not find any expenses.")


async def query_top_n_expenses_handler(entities, message):
    n = int(entities.get("n", 5))
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    top_expenses = await su.top_n_expenses_all_categories(persons, n)

    if not top_expenses:
        await message.channel.send("❌ Could not find any expenses.")
        return

    # Build message
    lines = []
    for i, expense in enumerate(top_expenses, 1):
        lines.append(
            f"{i}. ${expense['amount']:.2f} — {expense['item']} "
            f"at {expense['location']} on {expense['date']} "
            f"({expense['category']})"
        )

    text = "\n".join(lines)
    await message.channel.send(f"🔝 Top {n} expenses:\n{text}")


async def query_spent_this_week_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total = await su.spent_this_week(persons)
    await message.channel.send(f"📆 You’ve spent ${total:.2f} so far this week.")


async def query_projected_spending_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    projected = await su.projected_spending(persons)
    await message.channel.send(f"📈 Projected spending for this month: ${projected:,.2f}")


async def query_weekend_vs_weekday_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    weekend, weekday = await su.weekend_vs_weekday(persons)
    await message.channel.send(
        f"🌞 Weekends: ${weekend:.2f}\n📅 Weekdays: ${weekday:.2f}"
    )


async def query_no_spend_days_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    count, days = await su.no_spend_days(persons)
    days_str = ", ".join(str(d) for d in days)
    await message.channel.send(
        f"🚫 No-spend days this month: {count}\nDays: {days_str}"
    )


async def query_total_for_item_handler(entities, message):
    item = entities.get("item")
    persons = entities.get("persons")

    if not item:
        await message.channel.send("❌ Please specify an item.")
        return
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total, matches = await su.total_spent_on_item(item, persons)

    response = f"💰 You’ve spent ${total:.2f} on {item} this month.\n"
    if matches:
        response += "\n**Top transactions:**\n"
        for date_obj, item_name, amount, category, person in matches:
            date_str = date_obj.strftime("%m/%d")
            response += f"- {date_str}: ${amount:.2f} for {item_name} ({category}, {person})\n"
    else:
        response += "\n*(No transactions found this month.)*"

    await message.channel.send(response)


async def query_daily_spending_calendar_handler(entities: IntentEntities, message: Any) -> None:
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    text_summary, chart_file = await su.daily_spending_calendar(persons)
    await message.channel.send(
        content=f"📆 Here is your daily spending calendar:\n\n{text_summary}",
        file=chart_file
    )


async def query_best_worst_day_of_week_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.best_worst_day_of_week(persons)
    best_day, best_avg = result["best"]
    worst_day, worst_avg = result["worst"]

    response = (
        f"📅 Best (lowest) day: {best_day} — ${best_avg:.2f} avg\n"
        f"💸 Worst (highest) day: {worst_day} — ${worst_avg:.2f} avg"
    )

    await message.channel.send(response)


async def query_longest_no_spend_streak_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.longest_no_spend_streak(persons)
    if result is None:
        await message.channel.send("💸 No no-spend streaks found this month.")
        return

    length, start_day, end_day = result
    today = datetime.today()
    month_year = today.strftime("%B %Y")
    response = (
        f"🚫 Longest no-spend streak: {length} days "
        f"({month_year} {start_day}–{end_day})"
    )

    await message.channel.send(response)


async def query_days_budget_lasts_handler(message):
    estimated_days = await su.days_budget_lasts()

    if estimated_days is None:
        await message.channel.send(
            "❌ Could not calculate how long your budget will last."
        )
        return

    await message.channel.send(
        f"📈 At your current pace, your budget will last ~{estimated_days} more days this month."
    )


async def query_most_frequent_purchases_handler(entities, message):
    n = int(entities.get("n", 3))
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    results = await su.most_frequent_purchases(persons, n)

    if not results:
        await message.channel.send("❌ Could not find any purchases this month.")
        return

    response_lines = [f"🔂 Top {n} most frequent purchases this month:"]
    for i, r in enumerate(results, 1):
        response_lines.append(
            f"{i}. {r['item'].capitalize()} — {r['count']} times (${r['total']:.2f} total)"
        )

    response = "\n".join(response_lines)

    await message.channel.send(response)


async def query_expenses_on_day_handler(entities, message):
    day_str = entities.get("date")
    persons = entities.get("persons")

    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    # Try fallback if no date extracted
    if not day_str:
        # naive fallback: extract number from message
        import re
        m = re.search(r"\b(\d{1,2})(st|nd|rd|th)?\b", message.content)
        if m:
            day_str = m.group(1)  # just the number
            # prepend month/year
            today = get_local_today()
            day_str = f"{today.month}/{int(day_str)}/{today.year}"
            print(f"[INFO] Fallback parsed date: {day_str}")
        else:
            await message.channel.send("❌ Please specify a date (e.g., MM/DD, MM/DD/YYYY, or YYYY-MM-DD).")
            return

    entries, total = await su.expenses_on_day(day_str, persons)

    if not entries:
        await message.channel.send(f"📆 No expenses found on {day_str}.")
        return

    # sort entries by amount (descending)
    entries.sort(key=lambda e: e["amount"], reverse=True)

    response_lines = [f"📆 Expenses on {day_str} (total ${total:.2f}):"]
    for e in entries:
        response_lines.append(
            f"- ${e['amount']:.2f} — {e['item']} @ {e['location']} ({e['category']})"
        )

    response = "\n".join(response_lines)
    await message.channel.send(response)


async def query_subscriptions_handler(message):
    needs, needs_total, wants, wants_total = await su.list_subscriptions()

    if not needs and not wants:
        await message.channel.send("❌ No subscriptions found.")
        return

    response_lines = []

    if needs:
        response_lines.append(f"📌 **Needs Subscriptions** (total: ${needs_total:.2f}):")
        for name, amt in needs:
            response_lines.append(f"- {name}: ${amt:.2f}")
        response_lines.append("")

    if wants:
        response_lines.append(f"📌 **Wants Subscriptions** (total: ${wants_total:.2f}):")
        for name, amt in wants:
            response_lines.append(f"- {name}: ${amt:.2f}")

    response = "\n".join(response_lines)
    await message.channel.send(response)


async def log_rent_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for rent.")
        return

    success = su.log_rent_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged rent as paid for {_budget_profile_name(message)}: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not confirm the Rent payment was written.")


async def log_pge_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for PG&E.")
        return

    success = su.log_pge_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged PG&E as paid for {_budget_profile_name(message)}: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not confirm the PG&E payment was written.")


async def log_recology_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for Recology.")
        return

    success = su.log_recology_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged Recology as paid for {_budget_profile_name(message)}: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not confirm the Recology payment was written.")


async def log_water_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for water.")
        return

    success = su.log_water_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged water as paid for {_budget_profile_name(message)}: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not confirm the water payment was written.")


async def log_student_loan_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for your student loan.")
        return

    success = su.log_student_loan_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged student loan as paid for {_budget_profile_name(message)}: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not confirm the Student Loan payment was written.")


async def query_1st_savings_handler(entities, message):
    result = await su.check_1st_savings_deposited()
    if result["deposited"]:
        response = (
            f"✅ 1st savings deposited: ${result['actual']:.2f}\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    else:
        response = (
            f"❌ 1st savings not deposited.\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    await message.channel.send(response)


async def query_2nd_savings_handler(entities, message):
    result = await su.check_2nd_savings_deposited()
    if result["deposited"]:
        response = (
            f"✅ 2nd savings deposited: ${result['actual']:.2f}\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    else:
        response = (
            f"❌ 2nd savings not deposited.\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    await message.channel.send(response)


async def log_1st_savings_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount for 1st savings.")
        return
    success = su.log_1st_savings(amount)
    if success:
        await message.channel.send(f"✅ Logged 1st savings: ${amount:.2f}")
    else:
        await message.channel.send("❌ Failed to log 1st savings.")


async def log_2nd_savings_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount for 2nd savings.")
        return
    success = su.log_2nd_savings(amount)
    if success:
        await message.channel.send(f"✅ Logged 2nd savings: ${amount:.2f}")
    else:
        await message.channel.send("❌ Failed to log 2nd savings.")


async def log_need_expense_handler(entities, message):
    description = entities.get("description")
    amount = entities.get("amount")
    if not description or amount is None:
        await message.channel.send("❌ Please specify both a description and an amount for the Need expense.")
        return
    success = su.log_need_expense(description, amount)
    if success:
        await message.channel.send(f"✅ Logged Need expense: '{description}' - ${amount:.2f}")
    else:
        await message.channel.send("❌ Failed to log Need expense.")
