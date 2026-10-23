"""Private, separately confirmed receipts for saved Discord bank matches."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date
import logging
from typing import Any
from uuid import uuid4

import discord

from bookiebot.banking.receipt_links import matched_receipt_link
from bookiebot.banking.service import build_banking_service
from bookiebot.reimbursements import service as reimbursements
from bookiebot.reimbursements.store import ReimbursementConflictError, ReimbursementNotFoundError, ReimbursementValidationError
from bookiebot.sheets.routing import get_user_config, now_pacific
from bookiebot.ui.bank_reconciliation import BankReconciliationButton, BankReconciliationMatchSelect
from bookiebot.ui.card import SelectOption, ViewBase

logger = logging.getLogger(__name__)


async def _allowed(interaction: Any, owner: str, actor: str) -> bool:
    if (str(getattr(getattr(interaction, "user", None), "id", "")) != actor
            or get_user_config(actor).budget_owner_key != owner):
        await interaction.response.send_message("This repayment review belongs to another user.", ephemeral=True)
        return False
    return True


def _view(callback, buttons, *, choices=None, placeholder="Choose a shared payment"):
    view = ViewBase(timeout=600)
    if choices:
        view.add_item(BankReconciliationMatchSelect(choices, callback, placeholder=placeholder))
    for label, action in buttons:
        view.add_item(BankReconciliationButton(label, action, callback))
    return view


@dataclass(frozen=True)
class ReceiptContext:
    item: Any
    allocation: dict[str, Any]
    pending: list[dict[str, Any]]


def _context(owner: str, actor: str, identity: int) -> ReceiptContext:
    if not reimbursements.enabled():
        raise ReimbursementConflictError("Shared repayments are unavailable.")
    item = build_banking_service().get_reconciliation_item(owner, identity)
    snapshot = reimbursements.snapshot(owner)
    link = matched_receipt_link(owner, actor, item, allocations=snapshot["allocations"])
    if link is None:
        raise ReimbursementConflictError("This bank match no longer identifies one shared expense. Open a fresh reconciliation review.")
    allocation = next(row for row in snapshot["allocations"] if row["id"] == link["allocationId"])
    pending = [event for event in snapshot["events"] if event["allocationId"] == allocation["id"]
               and event["kind"] == "report_payment" and event["status"] == "pending"]
    return ReceiptContext(item, allocation, pending)


def _summary(context: ReceiptContext) -> str:
    row = context.allocation
    label = discord.utils.escape_markdown(str(row.get("item") or row.get("category") or "Shared expense"))[:150]
    return (f"**{row['partnerOwner'].title()}’s share · {label}**\n"
            f"Full bank payment: **${row['grossCents'] / 100:.2f}**\n"
            f"{row['partnerOwner'].title()}’s share: **${row['partnerShareCents'] / 100:.2f}**\n"
            f"Already received: **${row['settledCents'] / 100:.2f}**\n"
            f"Cleared separately: **${row.get('clearedCents', 0) / 100:.2f}**\n"
            f"Still owed: **${row['outstandingCents'] / 100:.2f}**\n\n"
            "The bank match is saved separately. Record only money already received; no transfer is made.")


def _ready(context: ReceiptContext) -> None:
    row = context.allocation
    if row["version"] != row["projectedVersion"]:
        raise ReimbursementConflictError("Saved expense changes are still syncing. Refresh saved sheet updates first.")
    if row.get("clearedCents", 0):
        raise ReimbursementConflictError("This balance was cleared separately. Review its reset in Shared before recording a receipt.")
    if row["outstandingCents"] <= 0:
        raise ReimbursementConflictError("This share is already settled. No new receipt is needed.")


async def send_bank_receipt_review(interaction: Any, *, owner: str, actor: str, identity: int) -> None:
    """Called only after the actor's interaction has been authorized and deferred."""
    try:
        context = await asyncio.to_thread(_context, owner, actor, identity)
        await _ReceiptReview(owner, actor, context).show(interaction)
    except ReimbursementConflictError as exc:
        await interaction.followup.send(str(exc), ephemeral=True)
    except Exception:
        logger.exception("Discord bank repayment review unavailable")
        await interaction.followup.send("Could not load this repayment review. Nothing was recorded; try again or open Shared in the app.", ephemeral=True)


class _ReceiptReview:
    def __init__(self, owner: str, actor: str, context: ReceiptContext):
        self.owner, self.actor, self.context = owner, actor, context
        self.closed = False
        self.confirmation: _ReceiptConfirmation | None = None

    async def show(self, interaction: Any) -> None:
        row = self.context.allocation
        buttons, choices = [], []
        if row["version"] != row["projectedVersion"]:
            text = "\n\nSaved sheet updates are pending. Refresh retries only those saved updates."
            buttons.append(("Refresh saved sheet updates", "refresh"))
        elif row["outstandingCents"] <= 0 or row.get("clearedCents", 0):
            text = "\n\nThis share is settled or cleared; no new receipt is available."
        elif self.context.pending:
            text = "\n\nReview a payment Hannah already reported before recording another receipt." if row["partnerOwner"] == "hannah" else "\n\nReview the reported payment before recording another receipt."
            for event in self.context.pending[:25]:
                action = f"reported:{event['id']}"
                choices.append((SelectOption(label=f"Review reported ${event['amountCents'] / 100:.2f}",
                    value=action, description=event["date"]), action))
            if len(self.context.pending) > 25:
                text += " Open Shared in the app for additional reported payments."
        else:
            text = "\n\nEnter the amount and date, then review a separate confirmation. Partial receipts are supported."
            buttons.append((f"Mark {row['partnerOwner'].title()}’s share received", "enter"))
        buttons.append(("Cancel", "cancel"))
        await interaction.followup.send(_summary(self.context) + text, ephemeral=True,
            view=_view(self.handle, buttons, choices=choices, placeholder="Review a reported payment"))

    async def handle(self, interaction: Any, action: str) -> None:
        if not await _allowed(interaction, self.owner, self.actor):
            return
        if action == "enter" and not self.closed:
            if self.confirmation and not self.confirmation.finished:
                await interaction.response.send_message("Finish or cancel the existing receipt confirmation first. Retry that same record if its outcome is uncertain.", ephemeral=True)
                return
            await interaction.response.send_modal(_ReceiptModal(self))
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        if self.closed:
            await interaction.followup.send("This review is closed. Open a fresh repayment review.", ephemeral=True)
            return
        if action == "cancel":
            if self.confirmation and (self.confirmation.uncertain or self.confirmation.lock.locked()):
                await self.confirmation.show(interaction, retry=True)
                return
            self.closed = True
            await interaction.followup.send("Canceled. No repayment was recorded; the bank match is unchanged.", ephemeral=True)
            return
        try:
            if action == "refresh":
                await asyncio.to_thread(reimbursements.snapshot, self.owner, retry_projection=True)
                await send_bank_receipt_review(interaction, owner=self.owner, actor=self.actor, identity=self.context.item.id)
                return
            if self.confirmation and not self.confirmation.finished:
                await self.confirmation.show(interaction, retry=self.confirmation.uncertain)
                return
            current = await asyncio.to_thread(_context, self.owner, self.actor, self.context.item.id)
            if current != self.context:
                raise ReimbursementConflictError("This payment or bank match changed. Open a fresh repayment review.")
            _ready(current)
            event = next((event for event in current.pending if action == f"reported:{event['id']}"), None)
            if event is None:
                raise ReimbursementConflictError("This reported payment is no longer available.")
            body = dict(operation="confirm_payment", requestId=uuid4().hex, allocationId=current.allocation["id"],
                        version=current.allocation["version"], eventId=event["id"])
            self.confirmation = _ReceiptConfirmation(self, body, event)
            await self.confirmation.show(interaction)
        except ReimbursementConflictError as exc:
            await interaction.followup.send(str(exc), ephemeral=True)
        except Exception:
            logger.exception("Discord reported repayment review unavailable")
            await interaction.followup.send("Could not verify this review. Nothing was recorded; open a fresh repayment review.", ephemeral=True)


class _ReceiptModal(discord.ui.Modal, title="Review money received"):
    amount = discord.ui.TextInput(label="Amount actually received ($)", max_length=20)
    when = discord.ui.TextInput(label="Date received (YYYY-MM-DD)", max_length=10)
    note = discord.ui.TextInput(label="Note (optional)", max_length=500, required=False)

    def __init__(self, review: _ReceiptReview):
        super().__init__(timeout=600)
        self.review = review
        self.amount.default = f"{review.context.allocation['outstandingCents'] / 100:.2f}"
        self.when.default = now_pacific().date().isoformat()

    async def on_submit(self, interaction: discord.Interaction) -> None:
        review = self.review
        if not await _allowed(interaction, review.owner, review.actor):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        if review.confirmation and not review.confirmation.finished:
            await review.confirmation.show(interaction, retry=review.confirmation.uncertain)
            return
        try:
            current = await asyncio.to_thread(_context, review.owner, review.actor, review.context.item.id)
            if review.closed or current != review.context:
                raise ReimbursementConflictError("This payment or bank match changed. Open a fresh repayment review.")
            _ready(current)
            amount = reimbursements.money_cents(str(self.amount.value))
            when = date.fromisoformat(str(self.when.value))
            if when.isoformat() != str(self.when.value):
                raise ValueError("Use YYYY-MM-DD")
            if not 0 < amount <= current.allocation["outstandingCents"]:
                raise ReimbursementValidationError("Enter a positive amount no greater than the remaining share.")
            if not current.allocation["expenseDate"] <= when.isoformat() <= now_pacific().date().isoformat():
                raise ReimbursementValidationError("Use a receipt date from the expense date through today Pacific.")
            if current.pending:
                raise ReimbursementConflictError("Review the pending reported payment first; no additional receipt was recorded.")
            body = dict(operation="receive", requestId=uuid4().hex, allocationId=current.allocation["id"],
                        version=current.allocation["version"], amountCents=amount, date=when.isoformat(), note=str(self.note.value))
            review.confirmation = _ReceiptConfirmation(review, body, body)
            await review.confirmation.show(interaction)
        except (ReimbursementConflictError, ReimbursementValidationError) as exc:
            await interaction.followup.send(str(exc), ephemeral=True)
        except ValueError:
            await interaction.followup.send("Enter the receipt date as YYYY-MM-DD.", ephemeral=True)
        except Exception:
            logger.exception("Discord receipt details unavailable")
            await interaction.followup.send("Could not verify these details. Nothing was recorded; open a fresh repayment review.", ephemeral=True)


class _ReceiptConfirmation:
    def __init__(self, review: _ReceiptReview, body: dict[str, Any], details: dict[str, Any]):
        self.review, self.body, self.details = review, body, details
        self.lock = asyncio.Lock()
        self.uncertain = self.finished = False

    async def show(self, interaction: Any, *, retry: bool = False) -> None:
        text = (_summary(self.review.context) + f"\n\n**Confirm received record: ${self.details['amountCents'] / 100:.2f}**"
                f"\nDate received: {self.details['date']}")
        note = discord.utils.escape_markdown(str(self.details.get("note", "")))[:500]
        if note:
            text += f"\nNote: {note}"
        if retry:
            text += "\n\nCould not verify the outcome. Retry this same record safely; do not record a second receipt."
        buttons = [("Retry this record" if retry else "Confirm received record", "confirm")]
        if not retry:
            buttons.append(("Cancel", "cancel"))
        await interaction.followup.send(text, ephemeral=True, view=_view(self.handle, buttons))

    async def handle(self, interaction: Any, action: str) -> None:
        review = self.review
        if not await _allowed(interaction, review.owner, review.actor):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        async with self.lock:
            if self.finished or (review.closed and not self.uncertain):
                await interaction.followup.send("This review is closed. Check Shared for the saved repayment status.", ephemeral=True)
                return
            if action == "cancel":
                if self.uncertain:
                    await self.show(interaction, retry=True)
                else:
                    self.finished = True
                    await interaction.followup.send("Canceled. No repayment was recorded; the bank match is unchanged.", ephemeral=True)
                return
            if not self.uncertain:
                try:
                    current = await asyncio.to_thread(_context, review.owner, review.actor, review.context.item.id)
                    if current != review.context:
                        raise ReimbursementConflictError("This payment or bank match changed. Open a fresh repayment review.")
                    _ready(current)
                except ReimbursementConflictError as exc:
                    self.finished = True
                    await interaction.followup.send(str(exc), ephemeral=True)
                    return
                except Exception:
                    logger.exception("Discord receipt preflight unavailable")
                    await interaction.followup.send("Could not check this review. Nothing was recorded; try this confirmation again.", ephemeral=True)
                    return
            try:
                result = await asyncio.to_thread(reimbursements.command, review.owner, self.body)
            except (ReimbursementConflictError, ReimbursementValidationError, ReimbursementNotFoundError) as exc:
                try:
                    store = await asyncio.to_thread(reimbursements.build_reimbursement_store)
                    saved = await asyncio.to_thread(store.get_command_result, review.owner, self.body["requestId"])
                except Exception:
                    saved = True  # An unavailable outcome must retain the original command.
                if saved is None:
                    self.finished = True
                    await interaction.followup.send(str(exc) + " Open a fresh repayment review.", ephemeral=True)
                else:
                    self.uncertain = True
                    await self.show(interaction, retry=True)
                return
            except Exception:
                logger.exception("Discord receipt outcome needs safe retry")
                self.uncertain = True
                await self.show(interaction, retry=True)
                return
            self.finished = True
            review.closed = True
            suffix = (" Saved sheet updates are pending; refresh Shared in the app to retry those updates."
                      if result["projectionPending"] else " Shared balances and expense sheets are updated.")
            await interaction.followup.send(f"Recorded **${self.details['amountCents'] / 100:.2f} received** from "
                f"{review.context.allocation['partnerOwner'].title()}. The full bank match is unchanged." + suffix, ephemeral=True)


async def offer_bank_receipt_review(interaction: Any, *, owner: str, actor: str, item: Any) -> None:
    """Optional post-match shortcut must never turn a successful match into a failure."""
    try:
        link = await asyncio.to_thread(matched_receipt_link, owner, actor, item)
        if link is None or link["outstandingCents"] <= 0:
            return
        async def handle(clicked, action):
            if not await _allowed(clicked, owner, actor):
                return
            await clicked.response.defer(ephemeral=True, thinking=True)
            await send_bank_receipt_review(clicked, owner=owner, actor=actor, identity=item.id)
        await interaction.followup.send("The bank match did not record any repayment. Review the shared receipt separately if money has arrived.",
            ephemeral=True, view=_view(handle, [(f"Review {link['partner']}’s share", "review")]))
    except Exception:
        logger.exception("Optional Discord bank receipt shortcut unavailable")


async def send_bank_receipt_inbox(interaction: Any, *, owner: str, actor: str, page: int = 0) -> None:
    try:
        def load():
            if not reimbursements.enabled():
                return []
            rows = reimbursements.snapshot(owner)["allocations"]
            items = build_banking_service().store.review_reconciliation_items(
                owner, start_date=now_pacific().date().replace(day=1).isoformat(), limit=200)
            found, seen = [], set()
            for item in items:
                link = matched_receipt_link(owner, actor, item, allocations=rows)
                if link and link["outstandingCents"] > 0 and link["allocationId"] not in seen:
                    seen.add(link["allocationId"])
                    found.append((item, link))
            return found
        found = await asyncio.to_thread(load)
        if not found:
            await interaction.followup.send("No outstanding shares are linked to matched bank payments in the latest 200 current-month transactions. Match a shared payment first, or open Shared in the app for other expenses. Nothing was recorded.", ephemeral=True)
            return
        page = max(0, min(page, (len(found) - 1) // 25))
        selected = found[page * 25:(page + 1) * 25]
        async def handle(clicked, action):
            if not await _allowed(clicked, owner, actor):
                return
            await clicked.response.defer(ephemeral=True, thinking=True)
            if action in {"previous", "next"}:
                await send_bank_receipt_inbox(clicked, owner=owner, actor=actor, page=page + (-1 if action == "previous" else 1))
            else:
                identity = next((item.id for item, _ in selected if action == f"receipt:{item.id}"), None)
                if identity is not None:
                    await send_bank_receipt_review(clicked, owner=owner, actor=actor, identity=identity)
        choices = [(SelectOption(label=f"{link['partner']} · ${link['outstandingCents'] / 100:.2f} owed · {item.transaction.name}"[:100],
            value=f"receipt:{item.id}", description=f"{item.transaction.date} · Bank ${abs(item.transaction.amount):.2f}"[:100]),
            f"receipt:{item.id}") for item, link in selected]
        buttons = []
        if page:
            buttons.append(("Previous", "previous"))
        if (page + 1) * 25 < len(found):
            buttons.append(("Next", "next"))
        await interaction.followup.send(f"**Shared repayments · page {page + 1} of {(len(found) + 24) // 25}**\n"
            "Choose a matched bank payment to review money actually received. Matching alone never records repayment. Each receipt needs separate confirmation.",
            ephemeral=True, view=_view(handle, buttons, choices=choices))
    except Exception:
        logger.exception("Discord bank repayment inbox unavailable")
        await interaction.followup.send("Could not load shared repayments. Nothing was recorded; try again or open Shared in the app.", ephemeral=True)
