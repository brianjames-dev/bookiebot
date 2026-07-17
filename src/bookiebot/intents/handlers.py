# all intent handlers
from contextlib import asynccontextmanager
import os
import re
from collections.abc import AsyncIterator

# Disable discord voice/audio stack to avoid loading audioop (deprecated in Python 3.13)
os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

from bookiebot.sheets.writer import write_to_sheet
import bookiebot.sheets.utils as su
from bookiebot.charts import (
    ChartRenderError,
    build_daily_spending_figure,
    build_expense_breakdown_figure,
    figure_to_discord_file,
)
from bookiebot.reports.expense_breakdown import (
    build_expense_breakdown_report,
    month_from_entities_or_message,
    write_expense_breakdown_report,
)
import openai
from datetime import datetime
from collections.abc import Awaitable, Callable
from typing import Any, AsyncContextManager, cast
from bookiebot.sheets.utils import resolve_query_persons, get_local_today
from bookiebot.sheets.routing import (
    SheetRoutingError,
    UnknownDiscordUserError,
    actor_key_aliases,
    get_user_config,
    resolve_actor_key,
    sheet_user_context,
)
from bookiebot.sheets.config import expense_category_label
from bookiebot.sheets.undo import (
    clear_pending_action_selection,
    delete_recent_action,
    editable_fields_for_action,
    format_action_detail_block,
    format_recent_action_list,
    action_capabilities,
    matching_recent_actions,
    move_recent_action,
    next_recent_actions_page,
    pending_action_selection_id,
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
    DeleteConfirmView,
    MoveCategoryView,
    MoveConfirmView,
    PersonSelectView,
    RecentActionDecisionView,
    RecentActionSelectView,
    UpdateConfirmView,
    UpdateFieldView,
)

IntentEntities = dict[str, Any]
IntentHandler = Callable[[IntentEntities, Any], Awaitable[None]]


@asynccontextmanager
async def _maybe_typing(message: Any, intent: str) -> AsyncIterator[None]:
    channel = getattr(message, "channel", None)
    typing = getattr(channel, "typing", None)
    if not callable(typing):
        yield
        return
    typing_context = cast(AsyncContextManager[Any], typing())
    async with typing_context:
        yield


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
        async with _maybe_typing(message, intent):
            await fallback_handler(message.content, message, context=last_context)
        return

    async with _maybe_typing(message, intent):
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

    actor_key = _message_actor_key(message)
    match_text = entities.get("match_text") or entities.get("description") or entities.get("location") or entities.get("item")
    success, detail = delete_recent_action(
        actor_key,
        index=index,
        action_id=entities.get("action_id"),
        match_text=match_text,
    )
    if detail.startswith("Recent logged actions"):
        actions = matching_recent_actions(actor_key, str(match_text), 10) if match_text else recent_actions(actor_key, 5)
        view = _delete_candidates_view(actor_key, actions) if actions else None
        detail = _without_single_candidate_instruction(detail, actions)
        await _send_recent_private_message(message, _with_component_spacer(detail, view), view=view)
        return
    await _send_action_result(message, success, detail)


async def query_recent_actions_handler(entities: IntentEntities, message: Any) -> None:
    page_size = 5
    max_explicit_limit = 25
    try:
        limit = int(entities.get("n") or 5)
    except (TypeError, ValueError):
        limit = page_size
    max_limit = max_explicit_limit if entities.get("explicit_n") else page_size
    limit = min(max(limit, 1), max_limit)
    actor_key = _message_actor_key(message)
    if entities.get("more"):
        output, actions = next_recent_actions_page(actor_key, page_size)
    else:
        actions = recent_actions(actor_key, limit)
        reset_recent_actions_page(actor_key, limit)
        output = format_recent_action_list(actions)

    view = _recent_action_select_view(actor_key, actions) if actions else None
    await _send_recent_private_message(
        message,
        _with_component_spacer(output, view),
        view=view,
        public_ack="I sent your recent transactions list to your DMs.",
    )


async def _send_recent_private_message(message: Any, content: str, public_ack: str | None = None, **kwargs: Any) -> None:
    chunks = _discord_message_chunks(content)
    author_send = getattr(getattr(message, "author", None), "send", None)
    if callable(author_send):
        async_author_send = cast(Callable[..., Awaitable[Any]], author_send)
        try:
            for index, chunk in enumerate(chunks):
                chunk_kwargs = kwargs if index == len(chunks) - 1 else {}
                await async_author_send(chunk, **chunk_kwargs)
        except Exception:
            await message.channel.send("❌ I could not send that recent transaction workflow privately. Please check your DM settings.")
            return
        if public_ack:
            await message.channel.send(public_ack)
        return
    for index, chunk in enumerate(chunks):
        chunk_kwargs = kwargs if index == len(chunks) - 1 else {}
        await message.channel.send(chunk, **chunk_kwargs)


def _discord_message_chunks(content: str, *, max_chars: int = 1900) -> list[str]:
    if len(content) <= max_chars:
        return [content]
    blocks = _recent_transaction_message_blocks(content)
    if len(blocks) > 1:
        return _discord_block_chunks(blocks, max_chars=max_chars)
    return _discord_line_chunks(content, max_chars=max_chars)


def _recent_transaction_message_blocks(content: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    in_code_block = False
    saw_transaction = False

    for line in content.splitlines():
        starts_transaction = bool(re.match(r"^\d+\.\s", line)) and not in_code_block
        starts_footer = line.startswith("Type `show more`") and not in_code_block
        if (starts_transaction or starts_footer) and current:
            blocks.append("\n".join(current))
            current = []
        if starts_transaction:
            saw_transaction = True
        current.append(line)
        if line.strip() == "```":
            in_code_block = not in_code_block

    if current:
        blocks.append("\n".join(current))
    return blocks if saw_transaction else [content]


def _discord_block_chunks(blocks: list[str], *, max_chars: int) -> list[str]:
    chunks: list[str] = []
    current = ""

    for block in blocks:
        if len(block) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_discord_line_chunks(block, max_chars=max_chars))
            continue
        candidate = block if not current else f"{current}\n{block}"
        if len(candidate) > max_chars:
            if current:
                chunks.append(current)
            current = block
        else:
            current = candidate

    if current:
        chunks.append(current)
    return chunks or [""]


def _discord_line_chunks(content: str, *, max_chars: int) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    in_code_block = False

    def flush_current() -> None:
        nonlocal current, current_len
        if not current:
            return
        chunk_lines = list(current)
        if in_code_block:
            chunk_lines.append("```")
        chunks.append("\n".join(chunk_lines))
        current = ["```"] if in_code_block else []
        current_len = 4 if in_code_block else 0

    for line in content.splitlines():
        line_len = len(line) + 1
        fence_margin = 4 if in_code_block else 0
        if current and current_len + line_len + fence_margin > max_chars:
            flush_current()
        if line_len > max_chars:
            if current:
                flush_current()
            for start in range(0, len(line), max_chars):
                chunks.append(line[start : start + max_chars])
            continue
        current.append(line)
        current_len += line_len
        if line.strip() == "```":
            in_code_block = not in_code_block
    if current:
        chunks.append("\n".join(current))
    return chunks or [""]


def _interaction_actor_key(interaction: Any) -> str | None:
    user = getattr(interaction, "user", None) or getattr(interaction, "author", None)
    if user is None:
        return None
    return resolve_actor_key(
        getattr(user, "id", None),
        getattr(user, "name", None) or getattr(user, "display_name", None),
    )


def _interaction_belongs_to_actor(interaction: Any, actor_key: str | None) -> bool:
    if not actor_key:
        return True
    interaction_actor = _interaction_actor_key(interaction)
    if not interaction_actor:
        return True
    return interaction_actor in actor_key_aliases(str(actor_key))


async def _reject_unowned_recent_interaction(interaction: Any, actor_key: str | None) -> bool:
    if _interaction_belongs_to_actor(interaction, actor_key):
        return False
    await interaction.response.send_message("This recent transaction workflow belongs to another user.", ephemeral=True)
    return True


def _recent_action_select_view(actor_key: str | None, actions: list[Any], *, destination_category: str | None = None, updates: dict[str, Any] | None = None):
    async def handle_select(interaction: Any, action_id: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        if destination_category:
            try:
                await interaction.response.defer(ephemeral=True)
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

        async def handle_decision(decision_interaction: Any, decision: str) -> None:
            if await _reject_unowned_recent_interaction(decision_interaction, actor_key):
                return
            selected = select_recent_action(actor_key, action_id=action_id)
            capabilities = action_capabilities(selected.action) if selected else None
            if decision == "update":
                if capabilities and not capabilities.can_update:
                    await decision_interaction.response.send_message(capabilities.update_reason, ephemeral=True)
                    return
                set_pending_update_selection(actor_key, action_id)
                logged = selected
                fields = editable_fields_for_action(logged.action) if logged else []
                if not fields:
                    await decision_interaction.response.send_message("I do not know how to update fields for that transaction yet.", ephemeral=True)
                    return
                await decision_interaction.response.send_message(
                    _with_component_spacer("Which field would you like to update?", True),
                    view=_update_field_view(actor_key, action_id, fields),
                    ephemeral=True,
                )
                return
            if decision == "delete":
                if capabilities and not capabilities.can_delete:
                    await decision_interaction.response.send_message(capabilities.delete_reason, ephemeral=True)
                    return
                set_pending_delete_selection(actor_key, action_id)
                try:
                    await decision_interaction.response.defer(ephemeral=True)
                except Exception:
                    pass
                success, detail = delete_recent_action(actor_key, index=1)
                await _send_interaction_action_result(decision_interaction, success, detail)
                return
            if decision == "move":
                if capabilities and not capabilities.can_move:
                    await decision_interaction.response.send_message(capabilities.move_reason, ephemeral=True)
                    return
                set_pending_move_selection(actor_key, action_id)
                await decision_interaction.response.send_message(
                    _with_component_spacer(_move_category_prompt(actor_key, action_id), True),
                    view=_move_category_view(actor_key, action_id),
                    ephemeral=True,
                )
                return
            clear_pending_action_selection(actor_key)
            await decision_interaction.response.send_message("Canceled.", ephemeral=True)

        logged = select_recent_action(actor_key, action_id=action_id)
        capabilities = action_capabilities(logged.action) if logged else None
        detail_block = f"\n\n{format_action_detail_block(logged.action)}" if logged else ""
        await interaction.response.send_message(
            _with_component_spacer(f"What would you like to do with this transaction?{detail_block}", True),
            view=RecentActionDecisionView(handle_decision, capabilities),
            ephemeral=True,
        )

    return RecentActionSelectView(actions, handle_select)


def _delete_candidates_view(actor_key: str | None, actions: list[Any]):
    if len(actions) == 1:
        return _delete_confirm_view(actor_key, actions[0].id)
    return _delete_action_select_view(actor_key, actions)


def _delete_action_select_view(actor_key: str | None, actions: list[Any]):
    async def handle_select(interaction: Any, action_id: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        logged = select_recent_action(actor_key, action_id=action_id)
        detail_block = f"\n\n{format_action_detail_block(logged.action)}" if logged else ""
        set_pending_delete_selection(actor_key, action_id)
        await interaction.response.send_message(
            _with_component_spacer(f"Delete this transaction?{detail_block}", True),
            view=_delete_confirm_view(actor_key, action_id),
            ephemeral=True,
        )

    return RecentActionSelectView(actions, handle_select)


def _delete_confirm_view(actor_key: str | None, action_id: str):
    async def handle_confirm(interaction: Any, decision: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        if decision == "confirm_delete":
            set_pending_delete_selection(actor_key, action_id)
            try:
                await interaction.response.defer(ephemeral=True)
            except Exception:
                pass
            success, detail = delete_recent_action(actor_key, action_id=action_id)
            await _send_interaction_action_result(interaction, success, detail)
            return
        clear_pending_action_selection(actor_key)
        await interaction.response.send_message("Canceled.", ephemeral=True)

    return DeleteConfirmView(handle_confirm)


def _move_candidates_view(
    actor_key: str | None,
    actions: list[Any],
    *,
    destination_category: str | None = None,
    updates: dict[str, Any] | None = None,
):
    if len(actions) == 1:
        return _move_confirm_view(
            actor_key,
            actions[0].id,
            destination_category=destination_category,
            updates=updates,
        )
    return _move_action_select_view(
        actor_key,
        actions,
        destination_category=destination_category,
        updates=updates,
    )


def _move_action_select_view(
    actor_key: str | None,
    actions: list[Any],
    *,
    destination_category: str | None = None,
    updates: dict[str, Any] | None = None,
):
    async def handle_select(interaction: Any, action_id: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        logged = select_recent_action(actor_key, action_id=action_id)
        detail_block = f"\n\n{format_action_detail_block(logged.action)}" if logged else ""
        set_pending_move_selection(actor_key, action_id)
        await interaction.response.send_message(
            _with_component_spacer(f"Move this transaction?{detail_block}", True),
            view=_move_confirm_view(
                actor_key,
                action_id,
                destination_category=destination_category,
                updates=updates,
            ),
            ephemeral=True,
        )

    return RecentActionSelectView(actions, handle_select)


def _move_confirm_view(
    actor_key: str | None,
    action_id: str,
    *,
    destination_category: str | None = None,
    updates: dict[str, Any] | None = None,
):
    async def handle_confirm(interaction: Any, decision: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        if decision == "confirm_move":
            set_pending_move_selection(actor_key, action_id)
            if destination_category:
                try:
                    await interaction.response.defer(ephemeral=True)
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
            await interaction.response.send_message(
                _with_component_spacer(_move_category_prompt(actor_key, action_id), True),
                view=_move_category_view(actor_key, action_id, updates),
                ephemeral=True,
            )
            return
        clear_pending_action_selection(actor_key)
        await interaction.response.send_message("Canceled.", ephemeral=True)

    return MoveConfirmView(handle_confirm)


def _move_category_view(actor_key: str | None, action_id: str, updates: dict[str, Any] | None = None):
    async def handle_category(interaction: Any, category: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        try:
            await interaction.response.defer(ephemeral=True)
        except Exception:
            pass
        success, detail = move_recent_action(
            actor_key,
            destination_category=category,
            updates=updates or {},
            action_id=action_id,
        )
        await _send_interaction_action_result(interaction, success, detail)

    logged = select_recent_action(actor_key, action_id=action_id)
    source_category = logged.action.metadata.get("category") if logged else None
    return MoveCategoryView(handle_category, exclude_category=source_category)


def _move_category_prompt(actor_key: str | None, action_id: str) -> str:
    logged = select_recent_action(actor_key, action_id=action_id)
    source_category = logged.action.metadata.get("category") if logged else None
    if source_category:
        source_label = "Needs" if source_category == "need_expenses" else source_category
        return f"Move this {source_label} expense to which category?"
    return "Which category would you like to move this transaction to?"


async def _send_update_field_prompt(target: Any, actor_key: str | None, action_id: str) -> None:
    logged = select_recent_action(actor_key, action_id=action_id)
    fields = editable_fields_for_action(logged.action) if logged else []
    if not fields:
        await target.response.send_message("I do not know how to update fields for that transaction yet.", ephemeral=True)
        return
    detail_block = f"\n\n{format_action_detail_block(logged.action)}" if logged else ""
    await target.response.send_message(
        _with_component_spacer(f"Which field would you like to update?{detail_block}", True),
        view=_update_field_view(actor_key, action_id, fields),
        ephemeral=True,
    )


def _update_candidates_view(actor_key: str | None, actions: list[Any]):
    if len(actions) == 1:
        return _update_confirm_view(actor_key, actions[0].id)
    return _update_action_select_view(actor_key, actions)


def _update_action_select_view(actor_key: str | None, actions: list[Any]):
    async def handle_select(interaction: Any, action_id: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        logged = select_recent_action(actor_key, action_id=action_id)
        detail_block = f"\n\n{format_action_detail_block(logged.action)}" if logged else ""
        set_pending_update_selection(actor_key, action_id)
        await interaction.response.send_message(
            _with_component_spacer(f"Update this transaction?{detail_block}", True),
            view=_update_confirm_view(actor_key, action_id),
            ephemeral=True,
        )

    return RecentActionSelectView(actions, handle_select)


def _update_confirm_view(actor_key: str | None, action_id: str):
    async def handle_confirm(interaction: Any, decision: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        if decision == "confirm_update":
            set_pending_update_selection(actor_key, action_id)
            await _send_update_field_prompt(interaction, actor_key, action_id)
            return
        clear_pending_action_selection(actor_key)
        await interaction.response.send_message("Canceled.", ephemeral=True)

    return UpdateConfirmView(handle_confirm)


def _update_field_view(actor_key: str | None, action_id: str, fields: list[str]):
    async def handle_field(interaction: Any, field: str) -> None:
        if await _reject_unowned_recent_interaction(interaction, actor_key):
            return
        if field == "person":
            async def handle_person(person_interaction: Any, person: str) -> None:
                if await _reject_unowned_recent_interaction(person_interaction, actor_key):
                    return
                try:
                    await person_interaction.response.defer(ephemeral=True)
                except Exception:
                    pass
                success, detail = update_recent_action(
                    actor_key,
                    updates={"person": person},
                    action_id=action_id,
                )
                await _send_interaction_action_result(person_interaction, success, detail)

            await interaction.response.send_message(
                _with_component_spacer("Which person/card should this transaction use?", True),
                view=PersonSelectView(handle_person),
                ephemeral=True,
            )
            return

        set_pending_update_field(actor_key, action_id, field)
        label = field.replace("_", " ")
        await interaction.response.send_message(f"Reply with the new {label}.", ephemeral=True)

    return UpdateFieldView(fields, handle_field)


async def update_recent_action_handler(entities: IntentEntities, message: Any) -> None:
    updates = entities.get("updates") or {}
    if not isinstance(updates, dict):
        updates = {}

    for field in ("amount", "location", "item", "person", "source"):
        if field in entities and field not in updates:
            updates[field] = entities[field]
    has_update_values = any(value not in (None, "") for value in updates.values())

    index = entities.get("index")
    try:
        index = int(index) if index is not None else None
    except (TypeError, ValueError):
        index = None

    actor_key = _message_actor_key(message)
    action_id = entities.get("action_id")
    match_text = entities.get("match_text") or entities.get("description") or entities.get("location") or entities.get("item")

    success, detail = update_recent_action(
        actor_key,
        updates=updates,
        index=index,
        action_id=action_id,
        match_text=match_text,
    )
    if detail.startswith("Recent logged actions"):
        actions = matching_recent_actions(actor_key, str(match_text), 10) if match_text else recent_actions(actor_key, 5)
        view = _update_candidates_view(actor_key, actions) if actions else None
        detail = _without_single_candidate_instruction(detail, actions)
        await _send_recent_private_message(message, _with_component_spacer(detail, view), view=view)
        return
    if not success and not has_update_values and detail.startswith("I found "):
        selected_action_id = str(action_id) if action_id else None
        if selected_action_id is None and index is not None:
            selected_action_id = pending_action_selection_id(actor_key, "update", index)
            if selected_action_id is None:
                logged = select_recent_action(actor_key, index=index)
                selected_action_id = logged.id if logged else None
        if selected_action_id:
            class _ChannelResponse:
                async def send_message(self, content: str, **kwargs: Any) -> None:
                    kwargs.pop("ephemeral", None)
                    await _send_recent_private_message(message, content, **kwargs)

            class _MessageTarget:
                response = _ChannelResponse()

            await _send_update_field_prompt(_MessageTarget(), actor_key, selected_action_id)
            return
    await _send_action_result(message, success, detail)


async def move_recent_action_handler(entities: IntentEntities, message: Any) -> None:
    updates = entities.get("updates") or {}
    if not isinstance(updates, dict):
        updates = {}
    for field in ("amount", "location", "item", "person", "source"):
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
        view = _move_candidates_view(
            actor_key,
            actions,
            destination_category=str(destination_category) if destination_category else None,
            updates=updates,
        ) if actions else None
        detail = _without_single_candidate_instruction(detail, actions)
        await _send_recent_private_message(message, _with_component_spacer(detail, view), view=view)
        return
    await _send_action_result(message, success, detail)


async def _send_action_result(message: Any, success: bool, detail: str) -> None:
    if detail.startswith("Recent logged actions") or detail.startswith("I do not have more recent logged actions"):
        await _send_recent_private_message(message, detail)
        return
    if _is_move_item_prompt(detail):
        await _send_recent_private_message(message, detail)
        return
    prefix = "✅" if success else "❌"
    await _send_recent_private_message(message, f"{prefix} {detail}")


async def _send_interaction_action_result(interaction: Any, success: bool, detail: str) -> None:
    if _is_move_item_prompt(detail):
        await interaction.followup.send(detail, ephemeral=True)
        return
    prefix = "✅" if success else "❌"
    await interaction.followup.send(f"{prefix} {detail}", ephemeral=True)


def _is_move_item_prompt(detail: str) -> bool:
    return detail.startswith("To move this ") and "reply with the item name" in detail


def _with_component_spacer(content: str, view: Any | None) -> str:
    return f"{content}\n\u200b" if view is not None else content


def _without_single_candidate_instruction(content: str, actions: list[Any]) -> str:
    if len(actions) != 1:
        return content
    lines = content.splitlines()
    if lines and lines[-1].startswith("Use the controls below, or type the number of the transaction you want to "):
        return "\n".join(lines[:-1])
    return content


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
    category_label = "Needs" if category == "need_expenses" else category
    await message.channel.send(
        f"📊 Highest expense category: {category_label} (${amount:.2f})."
    )


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
    owner_name = _budget_profile_name(message)
    persons = _expense_breakdown_persons(owner_name, persons, entities.get("person"))

    try:
        report_month = month_from_entities_or_message(entities, getattr(message, "content", ""))
    except ValueError as exc:
        await message.channel.send(f"❌ {exc}")
        return

    actor_key = _message_actor_key(message)
    try:
        report = build_expense_breakdown_report(
            actor_key=actor_key or "",
            owner_name=owner_name,
            persons=persons,
            month=report_month,
        )
        report_page = write_expense_breakdown_report(report)
    except SheetRoutingError as exc:
        await message.channel.send(f"❌ Could not calculate expense breakdown.\n\n{exc}")
        return
    full_report_link = f"[Open full report]({report_page.url})"

    if not report.breakdown:
        await message.channel.send(f"❌ Could not calculate expense breakdown.\n\nFull report: {full_report_link}")
        return

    lines = []
    non_zero_categories = {}

    for category, info in report.breakdown.items():
        amt = info["amount"]
        pct = info["percentage"]

        if amt == 0:
            continue

        non_zero_categories[category] = info
        label = (
            str(info["label"]).strip()
            if info.get("label")
            else str(category).replace("_", " ").title()
        )
        lines.append(f"{label}: ${amt:.2f} ({pct:.2f}%)")

    if not non_zero_categories:
        await message.channel.send(
            f"📊 No expenses found for {', '.join(persons)} in {report.month.label}.\n\n"
            f"Full report: {full_report_link}"
        )
        return

    people_str = ", ".join(persons)
    grand_total = report.grand_total
    text = (
        f"📊 Expense breakdown for {people_str} ({report.month.label}):\n"
        + "\n".join(lines)
        + f"\n\n💵 Total: ${grand_total:.2f}"
        + f"\n🌐 Full report: {full_report_link}"
    )

    try:
        fig = build_expense_breakdown_figure(
            non_zero_categories,
            grand_total,
        )
        chart_file = await figure_to_discord_file(fig, "expense_breakdown.png")
    except (ChartRenderError, ValueError) as exc:
        await message.channel.send(
            content=f"{text}\n\n⚠️ Could not render chart image: {exc}"
        )
        return

    await message.channel.send(content=text, file=chart_file)


def _expense_breakdown_persons(owner_name: str, persons: list[str], requested_person: Any) -> list[str]:
    requested = str(requested_person or "").strip().lower()
    brian_cards = {"Brian (BofA)", "Brian (AL)"}
    if owner_name == "Brian" and set(persons) == brian_cards and requested in {"", "brian"}:
        return ["Brian (BofA)"]
    return persons


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
        f"💰 Total spent on **{expense_category_label(category)}** this month: ${total:.2f}."
    )


async def query_largest_single_expense_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.largest_single_expense(persons)
    if isinstance(result, dict):
        category_label = "Needs" if result["category"] == "need_expenses" else result["category"]
        await message.channel.send(
            f"💸 Largest single expense: ${result['amount']:.2f} — "
            f"{result['item']} at {result['location']} on {result['date']} "
            f"({category_label})"
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
        category_label = "Needs" if expense["category"] == "need_expenses" else expense["category"]
        lines.append(
            f"{i}. ${expense['amount']:.2f} — {expense['item']} "
            f"at {expense['location']} on {expense['date']} "
            f"({category_label})"
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

    series = await su.daily_spending_series(persons)
    text_summary = series["text_summary"]
    content = f"📆 Here is your daily spending calendar:\n\n{text_summary}"
    points = series.get("points") or []
    if not points:
        await message.channel.send(content)
        return

    try:
        fig = build_daily_spending_figure(
            [point["day"] for point in points],
            [point["amount"] for point in points],
            series["month_label"],
        )
        chart_file = await figure_to_discord_file(fig, "daily_spending_calendar.png")
    except (ChartRenderError, ValueError) as exc:
        await message.channel.send(content=f"{content}\n\n⚠️ Could not render chart image: {exc}")
        return

    await message.channel.send(content=content, file=chart_file)


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
    item = entities.get("item") or entities.get("description")
    amount = entities.get("amount")
    if not item or amount is None:
        await message.channel.send("❌ Please specify both an item and an amount for the Need expense.")
        return
    expense = dict(entities)
    expense["item"] = item
    expense["category"] = "need_expenses"
    expense.pop("description", None)
    await write_transaction_to_sheet("expense", expense, message)
