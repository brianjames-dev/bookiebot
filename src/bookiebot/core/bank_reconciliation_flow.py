from __future__ import annotations

import asyncio
import logging
from typing import Any

import discord

from bookiebot.banking.formatting import (
    format_group_match_amount_mismatch,
    format_reconciliation_detail,
)
from bookiebot.banking.service import build_banking_service
from bookiebot.ui.bank_reconciliation import (
    BankExpenseFixedFieldsView,
    BankReconciliationDetailView,
    BankReconciliationGroupAdjustView,
    BankReconciliationLogChoiceView,
)


logger = logging.getLogger(__name__)


async def _review_actor_allowed(interaction: Any, actor_key: str) -> bool:
    user = getattr(interaction, "user", None)
    if user is not None and str(user.id) != str(actor_key):
        await interaction.response.send_message("This reconciliation review belongs to another user.", ephemeral=True)
        return False
    return True


def _default_expense_person(owner_key: str) -> str:
    if owner_key == "hannah":
        return "Hannah"
    return "Brian (BofA)"


async def send_next_bank_reconciliation_item(
    interaction: Any,
    *,
    owner_key: str,
    owner_name: str,
    actor_key: str,
    skipped_ids: set[int] | None = None,
    session_item_ids: set[int] | None = None,
    processed_ids: set[int] | None = None,
) -> None:
    skipped = set(skipped_ids or set())
    processed = set(processed_ids or set())
    service = build_banking_service()
    unresolved = await asyncio.to_thread(
        service.unresolved_reconciliation_items, owner_key, 100, reconciliation_ids=session_item_ids,
    )
    if session_item_ids is None:
        session_item_ids = {item.id for item in unresolved}
    else:
        unresolved = [item for item in unresolved if item.id in session_item_ids]
    skipped.intersection_update(item.id for item in unresolved)
    remaining = [item for item in unresolved if item.id not in skipped and item.id not in processed]
    if not remaining:
        if skipped:
            await interaction.followup.send(
                content=f"Bank reconciliation session paused. `{len(skipped)}` skipped item(s) still need review.",
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            content=("This reconciliation session is complete. Start a new session to review any newly queued transactions."
                     if session_item_ids else "Bank reconciliation is all caught up. No unresolved items remain."),
            ephemeral=True,
        )
        return

    item = remaining[0]
    await send_bank_reconciliation_detail(
        interaction,
        owner_key=owner_key,
        owner_name=owner_name,
        reconciliation_id=item.id,
        actor_key=actor_key,
        session=True,
        skipped_ids=skipped,
        session_item_ids=session_item_ids,
        remaining_count=len(remaining),
        processed_ids=processed,
    )


async def send_bank_reconciliation_detail(
    interaction: Any,
    *,
    owner_key: str,
    owner_name: str,
    reconciliation_id: int,
    actor_key: str,
    fallback: bool = False,
    session: bool = False,
    skipped_ids: set[int] | None = None,
    session_item_ids: set[int] | None = None,
    processed_ids: set[int] | None = None,
    remaining_count: int | None = None,
) -> None:
    skipped = set(skipped_ids or set())
    session_scope = set(session_item_ids or {reconciliation_id})
    processed = set(processed_ids or set())
    service = build_banking_service()
    item, candidates, groups = await asyncio.to_thread(
        service.reconciliation_match_candidates,
        owner_key,
        reconciliation_id,
        actor_key=actor_key,
        fallback=fallback,
        limit=15 if fallback else 5,
    )
    async def continue_session(action_interaction: Any) -> None:
        if session:
            processed.add(reconciliation_id)
            await send_next_bank_reconciliation_item(
                action_interaction,
                owner_key=owner_key,
                owner_name=owner_name,
                actor_key=actor_key,
                skipped_ids=skipped,
                session_item_ids=session_scope,
                processed_ids=processed,
            )

    async def stale_review(action_interaction: Any, current: Any) -> None:
        if current is None:
            message = "This bank transaction is no longer available for review. The review queue has been refreshed."
        elif current.status in {"confirmed", "matched"}:
            message = "This transaction is already reconciled. The app and Discord share the same review status."
        elif current.status == "ignored":
            message = "This transaction has already been ignored. The app and Discord share the same review status."
        elif current.status == "import_requested":
            message = "An import is already in progress for this transaction. Check its recovery status before trying again."
        else:
            message = "This transaction changed since this review was opened. Review its current details before continuing."
        await action_interaction.followup.send(content=message, ephemeral=True)
        if current is None or current.status in {"confirmed", "matched", "ignored", "import_requested"}:
            await continue_session(action_interaction)
        else:
            await send_bank_reconciliation_detail(
                action_interaction, owner_key=owner_key, owner_name=owner_name,
                reconciliation_id=reconciliation_id, actor_key=actor_key, session=session,
                skipped_ids=skipped, session_item_ids=session_scope,
                processed_ids=processed, remaining_count=remaining_count,
            )

    if item is None or item.status in {"confirmed", "matched", "ignored"}:
        await stale_review(interaction, item)
        return

    if item.status == 'import_requested':
        result = await asyncio.to_thread(
            service.recover_reconciliation_import, owner_key, reconciliation_id, actor_key=actor_key,
        )
        await interaction.followup.send(content=result.message, ephemeral=True)
        if result.status == 'completed':
            await continue_session(interaction)
        return

    async def handle_action(action_interaction: Any, action: str) -> None:
        if not await _review_actor_allowed(action_interaction, actor_key):
            return
        await action_interaction.response.defer(ephemeral=True, thinking=True)
        try:
            if action == "cancel":
                await action_interaction.followup.send("Canceled.", ephemeral=True)
                return
            current = await asyncio.to_thread(service.get_reconciliation_item, owner_key, reconciliation_id)
            if current != item:
                await stale_review(action_interaction, current)
                return
            if action.startswith("group_adjust:"):
                _prefix, group_index_text, adjust_action_id = action.split(":", 2)
                group_index = int(group_index_text)
                if group_index < 0 or group_index >= len(groups):
                    await action_interaction.followup.send("That grouped match is no longer available.", ephemeral=True)
                    return
                group = groups[group_index]
                action_ids = [candidate.action_id for candidate in group.candidates]
                matched_item, matched_candidates, status = await asyncio.to_thread(
                    service.confirm_reconciliation_action_group_match,
                    owner_key,
                    reconciliation_id,
                    actor_key=actor_key,
                    action_ids=action_ids,
                    expected_item=item,
                    adjust_action_id=adjust_action_id,
                )
                if matched_item is None or status in {"changed", "not_unresolved"}:
                    await stale_review(action_interaction, matched_item)
                    return
                if status != "matched_adjusted":
                    await action_interaction.followup.send(
                        content=f"Could not adjust and match that grouped suggestion yet: `{status}`.",
                        ephemeral=True,
                    )
                    return
                total = sum(candidate.amount for candidate in matched_candidates)
                adjusted = next(
                    (candidate for candidate in matched_candidates if candidate.action_id == adjust_action_id),
                    None,
                )
                adjustment_note = f"\nAdjusted `{adjusted.label}` to `${adjusted.amount:.2f}`." if adjusted else ""
                await action_interaction.followup.send(
                    content=(
                        f"Matched `{matched_item.transaction.name}` for `${abs(matched_item.transaction.amount):.2f}` "
                        f"to {len(matched_candidates)} existing sheet rows.\n"
                        f"Rows total: `${total:.2f}`"
                        f"{adjustment_note}"
                    ),
                    ephemeral=True,
                )
                await continue_session(action_interaction)
                return

            if action.startswith("group:"):
                group_index = int(action.split(":", 1)[1])
                if group_index < 0 or group_index >= len(groups):
                    await action_interaction.followup.send("That grouped match is no longer available.", ephemeral=True)
                    return
                group = groups[group_index]
                action_ids = [candidate.action_id for candidate in group.candidates]
                matched_item, matched_candidates, status = await asyncio.to_thread(
                    service.confirm_reconciliation_action_group_match,
                    owner_key,
                    reconciliation_id,
                    actor_key=actor_key,
                    action_ids=action_ids,
                    expected_item=item,
                )
                if matched_item is None or status in {"changed", "not_unresolved"}:
                    await stale_review(action_interaction, matched_item)
                    return
                if status == "amount_mismatch":
                    await action_interaction.followup.send(
                        content=format_group_match_amount_mismatch(
                            matched_item,
                            matched_candidates,
                            reconciliation_id=reconciliation_id,
                            action_ids=action_ids,
                        )[:1900],
                        view=BankReconciliationGroupAdjustView(
                            matched_candidates,
                            handle_action,
                            group_index=group_index,
                            bank_amount=abs(matched_item.transaction.amount),
                        ),
                        ephemeral=True,
                    )
                    return
                if status not in {"matched", "matched_adjusted"}:
                    await action_interaction.followup.send(
                        content=f"Could not match that grouped suggestion yet: `{status}`.",
                        ephemeral=True,
                    )
                    return
                total = sum(candidate.amount for candidate in matched_candidates)
                await action_interaction.followup.send(
                    content=(
                        f"Matched `{matched_item.transaction.name}` for `${abs(matched_item.transaction.amount):.2f}` "
                        f"to {len(matched_candidates)} existing sheet rows.\n"
                        f"Rows total: `${total:.2f}`"
                    ),
                    ephemeral=True,
                )
                await continue_session(action_interaction)
                return

            if action.startswith("candidate:"):
                candidate_index = int(action.split(":", 1)[1])
                if candidate_index < 0 or candidate_index >= len(candidates):
                    await action_interaction.followup.send("That row match is no longer available.", ephemeral=True)
                    return
                candidate = candidates[candidate_index]
                if candidate.action_type == "schedule" or candidate.action_id.startswith("schedule:"):
                    matched_item, matched_candidate, status = await asyncio.to_thread(
                        service.confirm_reconciliation_schedule_match,
                        owner_key,
                        reconciliation_id,
                        actor_key=actor_key,
                        schedule_ref=candidate.sheet_ref,
                        expected_item=item,
                    )
                    if matched_item is None or status in {"changed", "not_unresolved"}:
                        await stale_review(action_interaction, matched_item)
                        return
                    if status != "matched" or matched_candidate is None:
                        await action_interaction.followup.send(
                            content=f"Could not match that schedule yet: `{status}`.",
                            ephemeral=True,
                        )
                        return
                    await action_interaction.followup.send(
                        content=(
                            f"Matched `{matched_item.transaction.name}` for `${abs(matched_item.transaction.amount):.2f}` "
                            f"to `{matched_candidate.label}`.\n"
                            f"Schedule: `{matched_candidate.sheet_ref}`"
                        ),
                        ephemeral=True,
                    )
                    await continue_session(action_interaction)
                    return
                matched_item, matched_candidate, status = await asyncio.to_thread(
                    service.confirm_reconciliation_action_match,
                    owner_key,
                    reconciliation_id,
                    actor_key=actor_key,
                    action_id=candidate.action_id,
                    expected_item=item,
                )
                if matched_item is None or status in {"changed", "not_unresolved"}:
                    await stale_review(action_interaction, matched_item)
                    return
                if status not in {"matched", "matched_updated"} or matched_candidate is None:
                    await action_interaction.followup.send(
                        content=("That row is already linked to another transaction or is no longer eligible. "
                                 "Choose another row, or open a fresh review to check its status."
                                 if status in {'already_matched', 'match_unavailable'} else
                                 f"Could not match that row yet: `{status}`."),
                        ephemeral=True,
                    )
                    return
                update_note = ""
                if status == "matched_updated":
                    update_note = f"\nUpdated sheet amount to `${abs(matched_item.transaction.amount):.2f}`."
                await action_interaction.followup.send(
                    content=(
                        f"Matched `{matched_item.transaction.name}` for `${abs(matched_item.transaction.amount):.2f}` "
                        f"to existing `{matched_candidate.action_type}` row.\n"
                        f"Sheet: `{matched_candidate.label} - ${matched_candidate.amount:.2f} - {matched_candidate.sheet_ref}`"
                        f"{update_note}"
                    ),
                    ephemeral=True,
                )
                await continue_session(action_interaction)
                return

            if action == "fallback":
                await send_bank_reconciliation_detail(
                    action_interaction,
                    owner_key=owner_key,
                    owner_name=owner_name,
                    reconciliation_id=reconciliation_id,
                    actor_key=actor_key,
                    fallback=True,
                    session=session,
                    skipped_ids=skipped,
                    session_item_ids=session_scope,
                    remaining_count=remaining_count,
                    processed_ids=processed,
                )
                return

            if action == "log":
                await action_interaction.followup.send(
                    content="How should this bank item be logged?",
                    view=_log_choice_view(
                        item=item,
                        owner_key=owner_key,
                        actor_key=actor_key,
                        continue_session=continue_session,
                    ),
                    ephemeral=True,
                )
                return

            if action == "skip":
                skipped.add(reconciliation_id)
                await action_interaction.followup.send(
                    f"Skipped bank reconciliation item `{reconciliation_id}` for now.",
                    ephemeral=True,
                )
                await continue_session(action_interaction)
                return

            if action == "ignore":
                ignored = await asyncio.to_thread(service.ignore_reconciliation_item, owner_key, reconciliation_id, expected_item=item)
                if ignored is None:
                    await stale_review(action_interaction, await asyncio.to_thread(
                        service.get_reconciliation_item, owner_key, reconciliation_id,
                    ))
                    return
                await action_interaction.followup.send(
                    f"Ignored `{ignored.transaction.name}` for `${abs(ignored.transaction.amount):.2f}`.",
                    ephemeral=True,
                )
                await continue_session(action_interaction)
        except Exception:
            logger.exception("Discord reconciliation action failed", extra={"reconciliation_id": reconciliation_id})
            await action_interaction.followup.send(
                content="Could not finish this review. Check the current status in the app or View Inbox before trying again.",
                ephemeral=True,
            )

    view = BankReconciliationDetailView(
        candidates,
        groups,
        handle_action,
        fallback_available=not fallback,
        session_controls=session,
        pending=item.transaction.pending,
    )
    header = ""
    if session and remaining_count is not None:
        header = f"Reconciling item `{len(session_scope) - remaining_count + 1}` of `{len(session_scope)}` in this session.\n\n"
    await interaction.followup.send(
        content=(
            header
            + format_reconciliation_detail(
                item,
                candidates,
                groups,
                fallback=fallback,
                include_commands=False,
            )
        )[:1900],
        view=view,
        ephemeral=True,
    )


def _log_choice_view(*, item: Any, owner_key: str, actor_key: str, continue_session: Any) -> BankReconciliationLogChoiceView:
    async def handle_log_choice(interaction: Any, action: str) -> None:
        if not await _review_actor_allowed(interaction, actor_key):
            return
        if action == "log:expense":
            await interaction.response.send_message(
                content="Choose the fixed fields for this expense.",
                view=_expense_fixed_fields_view(
                    item=item,
                    owner_key=owner_key,
                    actor_key=actor_key,
                    continue_session=continue_session,
                ),
                ephemeral=True,
            )
            return
        if action == "log:income":
            await interaction.response.send_modal(
                _BankIncomeLogModal(
                    item=item,
                    owner_key=owner_key,
                    actor_key=actor_key,
                    continue_session=continue_session,
                )
            )

    return BankReconciliationLogChoiceView(handle_log_choice)


def _expense_fixed_fields_view(
    *,
    item: Any,
    owner_key: str,
    actor_key: str,
    continue_session: Any,
) -> BankExpenseFixedFieldsView:
    default_category = "food"
    default_person = _default_expense_person(owner_key)
    fixed_view: BankExpenseFixedFieldsView | None = None

    async def handle_field(interaction: Any, field: str, value: str, view: Any) -> None:
        if not await _review_actor_allowed(interaction, actor_key):
            return
        target_view = view or fixed_view
        if target_view is None:
            await interaction.response.defer(ephemeral=True)
            return
        if field == "category":
            target_view.selected_category = value
        if field == "person":
            target_view.selected_person = value
        await interaction.response.defer(ephemeral=True)

    async def handle_continue(interaction: Any, action: str) -> None:
        if not await _review_actor_allowed(interaction, actor_key):
            return
        target_view = fixed_view
        category = getattr(target_view, "selected_category", default_category)
        person = getattr(target_view, "selected_person", default_person)
        await interaction.response.send_modal(
            _BankExpenseLogModal(
                item=item,
                owner_key=owner_key,
                actor_key=actor_key,
                continue_session=continue_session,
                category=category,
                person=person,
            )
        )

    fixed_view = BankExpenseFixedFieldsView(
        handle_field,
        handle_continue,
        default_category=default_category,
        default_person=default_person,
    )
    return fixed_view


class _BankExpenseLogModal(discord.ui.Modal, title="Log bank item as expense"):
    item_name = discord.ui.TextInput(label="Item", max_length=80)
    location = discord.ui.TextInput(label="Location", max_length=80)

    def __init__(
        self,
        *,
        item: Any,
        owner_key: str,
        actor_key: str,
        continue_session: Any,
        category: str,
        person: str,
    ):
        super().__init__()
        self.item = item
        self.owner_key = owner_key
        self.actor_key = actor_key
        self.continue_session = continue_session
        self.category = category
        self.person = person
        transaction = item.transaction
        source_name = transaction.merchant_name or transaction.name
        self.item_name.default = source_name
        self.location.default = source_name

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await _submit_bank_import(
            interaction, item=self.item, owner_key=self.owner_key, actor_key=self.actor_key,
            kind="expense", fields={
                "category": self.category, "person": self.person,
                "item": str(self.item_name.value).strip(), "location": str(self.location.value).strip(),
            }, continue_session=self.continue_session,
        )


class _BankIncomeLogModal(discord.ui.Modal, title="Log bank item as income/refund"):
    source = discord.ui.TextInput(label="Source", max_length=80)
    label = discord.ui.TextInput(label="Label", placeholder="refund, reimbursement, paycheck", max_length=80)

    def __init__(self, *, item: Any, owner_key: str, actor_key: str, continue_session: Any):
        super().__init__()
        self.item = item
        self.owner_key = owner_key
        self.actor_key = actor_key
        self.continue_session = continue_session
        transaction = item.transaction
        source_name = transaction.merchant_name or transaction.name
        self.source.default = source_name
        self.label.default = "refund"

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await _submit_bank_import(
            interaction, item=self.item, owner_key=self.owner_key, actor_key=self.actor_key,
            kind="income", fields={
                "source": str(self.source.value).strip(), "label": str(self.label.value).strip(),
            }, continue_session=self.continue_session,
        )


async def _submit_bank_import(
    interaction: Any, *, item: Any, owner_key: str, actor_key: str,
    kind: str, fields: dict[str, str], continue_session: Any,
) -> None:
    if not await _review_actor_allowed(interaction, actor_key):
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        service = build_banking_service()
        result = await asyncio.to_thread(
            service.import_reconciliation_item, owner_key, item.id, actor_key=actor_key,
            kind=kind, fields=fields, expected_amount=item.transaction.amount,
            expected_date=item.transaction.date or item.transaction.authorized_date,
            expected_item=item,
        )
    except Exception:
        await interaction.edit_original_response(
            content="Could not complete the bank import. Open the current review to check its status before trying again."
        )
        return
    await interaction.edit_original_response(content=result.message)
    if result.status == "rejected":
        current = await asyncio.to_thread(service.get_reconciliation_item, owner_key, item.id)
        if current is None or current.status in {"confirmed", "matched", "ignored"}:
            await continue_session(interaction)
    if result.status == "completed":
        await continue_session(interaction)
