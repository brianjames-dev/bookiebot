from __future__ import annotations

import asyncio
from typing import Any

from bookiebot.banking.formatting import (
    format_group_match_amount_mismatch,
    format_reconciliation_detail,
)
from bookiebot.banking.service import build_banking_service
from bookiebot.ui.bank_reconciliation import BankReconciliationDetailView


async def send_next_bank_reconciliation_item(
    interaction: Any,
    *,
    owner_key: str,
    owner_name: str,
    actor_key: str,
    skipped_ids: set[int] | None = None,
) -> None:
    skipped = set(skipped_ids or set())
    service = build_banking_service()
    unresolved = await asyncio.to_thread(service.unresolved_reconciliation_items, owner_key, 100)
    remaining = [item for item in unresolved if item.id not in skipped]
    if not remaining:
        if skipped:
            await interaction.followup.send(
                content=f"Bank reconciliation session paused. `{len(skipped)}` skipped item(s) still need review.",
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            content="Bank reconciliation is all caught up. No unresolved items remain.",
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
        remaining_count=len(remaining),
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
    remaining_count: int | None = None,
) -> None:
    skipped = set(skipped_ids or set())
    service = build_banking_service()
    item, candidates, groups = await asyncio.to_thread(
        service.reconciliation_match_candidates,
        owner_key,
        reconciliation_id,
        actor_key=actor_key,
        fallback=fallback,
        limit=15 if fallback else 5,
    )
    if item is None:
        await interaction.followup.send(
            content=f"No bank reconciliation item `{reconciliation_id}` was found for {owner_name}.",
            ephemeral=True,
        )
        return

    async def continue_session(action_interaction: Any) -> None:
        if session:
            await send_next_bank_reconciliation_item(
                action_interaction,
                owner_key=owner_key,
                owner_name=owner_name,
                actor_key=actor_key,
                skipped_ids=skipped,
            )

    async def handle_action(action_interaction: Any, action: str) -> None:
        await action_interaction.response.defer(ephemeral=True)
        try:
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
                )
                if matched_item is None:
                    await action_interaction.followup.send(
                        f"No bank reconciliation item `{reconciliation_id}` was found for {owner_name}.",
                        ephemeral=True,
                    )
                    return
                if status == "amount_mismatch":
                    await action_interaction.followup.send(
                        content=format_group_match_amount_mismatch(matched_item, matched_candidates)[:1900],
                        ephemeral=True,
                    )
                    return
                if status != "matched":
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
                matched_item, matched_candidate, status = await asyncio.to_thread(
                    service.confirm_reconciliation_action_match,
                    owner_key,
                    reconciliation_id,
                    actor_key=actor_key,
                    action_id=candidate.action_id,
                )
                if matched_item is None:
                    await action_interaction.followup.send(
                        f"No bank reconciliation item `{reconciliation_id}` was found for {owner_name}.",
                        ephemeral=True,
                    )
                    return
                if status != "matched" or matched_candidate is None:
                    await action_interaction.followup.send(
                        content=f"Could not match that row yet: `{status}`.",
                        ephemeral=True,
                    )
                    return
                await action_interaction.followup.send(
                    content=(
                        f"Matched `{matched_item.transaction.name}` for `${abs(matched_item.transaction.amount):.2f}` "
                        f"to existing `{matched_candidate.action_type}` row.\n"
                        f"Sheet: `{matched_candidate.label} - ${matched_candidate.amount:.2f} - {matched_candidate.sheet_ref}`"
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
                    remaining_count=remaining_count,
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
                ignored = await asyncio.to_thread(service.ignore_reconciliation_item, owner_key, reconciliation_id)
                if ignored is None:
                    await action_interaction.followup.send(
                        f"No bank reconciliation item `{reconciliation_id}` was found for {owner_name}.",
                        ephemeral=True,
                    )
                    return
                await action_interaction.followup.send(
                    f"Ignored `{ignored.transaction.name}` for `${abs(ignored.transaction.amount):.2f}`.",
                    ephemeral=True,
                )
                await continue_session(action_interaction)
        except Exception as exc:
            await action_interaction.followup.send(
                content=f"Could not complete that reconciliation action: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )

    view = BankReconciliationDetailView(
        candidates,
        groups,
        handle_action,
        fallback_available=not fallback,
        session_controls=session,
    )
    header = ""
    if session and remaining_count is not None:
        header = f"Reconciling item 1 of `{remaining_count}` currently queued.\n\n"
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
