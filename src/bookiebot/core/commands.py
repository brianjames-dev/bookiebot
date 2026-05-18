import asyncio
import os
os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

import discord
from datetime import datetime, timezone
from typing import cast

from discord import app_commands

from bookiebot.core import auth, config
from bookiebot.core import incidents
from bookiebot.core import github_dispatch
from bookiebot.core import ui
from bookiebot.banking.formatting import (
    format_bank_transaction_table_chunks,
    format_bank_transaction_table,
    format_reconciliation_preview,
    format_reconciliation_review,
)
from bookiebot.banking.plaid_client import PlaidApiError
from bookiebot.banking.service import build_banking_service
from bookiebot.core.bank_link import BankLinkTokenError, create_bank_link_setup_token
from bookiebot.logging_config import get_recent_logs, uptime_seconds
from bookiebot.sheets.routing import (
    get_current_year,
    get_user_config,
    get_year_config,
    MissingYearConfigError,
    sheet_user_context,
)
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.writer import log_category_row, log_income_row, record_expense_undo
from bookiebot.sheets.bills import parse_bill_schedules_with_warnings
from bookiebot.sheets.subscriptions import debug_subscription_sync


async def _send_bank_command_error(interaction: discord.Interaction, content: str) -> None:
    if interaction.response.is_done():
        await interaction.edit_original_response(content=content)
    else:
        await interaction.response.send_message(content, ephemeral=True)


def _bank_date_to_sheet_date(value: str | None) -> str:
    if not value:
        current = datetime.now()
        return f"{current.month}/{current.day}/{current.year}"
    try:
        parsed = datetime.strptime(value[:10], "%Y-%m-%d")
    except ValueError:
        current = datetime.now()
        return f"{current.month}/{current.day}/{current.year}"
    return f"{parsed.month}/{parsed.day}/{parsed.year}"


def _clean_command_text(value: str | None) -> str:
    text = (value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1].strip()
    return text


def _log_bank_reconciliation_expense(
    *,
    actor_key: str,
    owner_key: str,
    reconciliation_id: int,
    category: str,
    person: str,
    item_name: str,
    location: str,
):
    service = build_banking_service()
    item = service.get_reconciliation_item(owner_key, reconciliation_id)
    if item is None:
        return None, "not_found"
    if item.status not in {"needs_review", "pending_user", "conflict"}:
        return item, "not_unresolved"
    if item.transaction.amount < 0:
        return item, "not_expense"

    transaction = item.transaction
    source_name = _clean_command_text(transaction.merchant_name or transaction.name)
    clean_person = _clean_command_text(person)
    values = {
        "date": _bank_date_to_sheet_date(transaction.date or transaction.authorized_date),
        "amount": abs(transaction.amount),
        "item": _clean_command_text(item_name) or source_name,
        "location": _clean_command_text(location) or source_name,
        "person": clean_person,
    }
    with sheet_user_context(actor_key):
        worksheet = get_sheets_repo().expense_sheet()
        row = log_category_row(values, worksheet, category)
        record_expense_undo(category, row, values, clean_person, actor_key)
    confirmed = service.confirm_reconciliation_item(
        owner_key,
        reconciliation_id,
        matched_sheet_ref=f"expense!row {row}",
    )
    return confirmed, "logged"


def _log_bank_reconciliation_income(
    *,
    actor_key: str,
    owner_key: str,
    reconciliation_id: int,
    source: str,
    label: str,
):
    service = build_banking_service()
    item = service.get_reconciliation_item(owner_key, reconciliation_id)
    if item is None:
        return None, "not_found"
    if item.status not in {"needs_review", "pending_user", "conflict"}:
        return item, "not_unresolved"
    if item.transaction.amount >= 0:
        return item, "not_income"

    transaction = item.transaction
    source_name = _clean_command_text(source) or _clean_command_text(transaction.merchant_name or transaction.name)
    values = {
        "type": "income",
        "amount": abs(transaction.amount),
        "source": source_name,
        "label": _clean_command_text(label),
    }
    with sheet_user_context(actor_key):
        worksheet = get_sheets_repo().income_sheet()
        row, _description, _amount = log_income_row(values, worksheet)
    confirmed = service.confirm_reconciliation_item(
        owner_key,
        reconciliation_id,
        matched_sheet_ref=f"income!row {row}",
    )
    return confirmed, "logged"


def register_commands(tree: app_commands.CommandTree):
    @tree.command(name="debug_bank_status", description="(Admin) Show read-only bank integration status")
    async def debug_bank_status(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            service = build_banking_service()
            status = service.status()
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not load banking status: {type(exc).__name__}: {exc}",
            )
            return

        lines = [
            "Bank integration status:",
            f"- Configured: {'yes' if status.configured else 'no'}",
            f"- Plaid env: {status.plaid_env}",
            f"- Store: `{status.sqlite_path}`",
            f"- Linked Items: {status.item_count}",
            f"- Accounts: {status.account_count}",
            f"- Stored transactions: {status.transaction_count}",
            f"- Last successful sync: {status.last_success_at or 'never'}",
            f"- Last sync error: {status.last_error or 'none'}",
        ]
        await interaction.edit_original_response(content="\n".join(lines))

    @tree.command(name="debug_bank_sandbox_link", description="(Admin) Link a Plaid Sandbox Item for your budget owner")
    @app_commands.describe(institution_id="Plaid Sandbox institution id, defaults to ins_109508")
    async def debug_bank_sandbox_link(interaction: discord.Interaction, institution_id: str = "ins_109508"):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            if service.config.plaid_env != "sandbox":
                await _send_bank_command_error(
                    interaction,
                    "❌ Sandbox link command only runs when `PLAID_ENV=sandbox`.",
                )
                return
            item = await asyncio.wait_for(
                service.link_sandbox_item(owner.budget_owner_key, institution_id=institution_id),
                timeout=45,
            )
        except asyncio.TimeoutError:
            await _send_bank_command_error(
                interaction,
                "❌ Plaid Sandbox link timed out after 45 seconds. Check Railway logs and Plaid credentials.",
            )
            return
        except PlaidApiError as exc:
            await _send_bank_command_error(interaction, f"❌ Plaid error: {exc}")
            return
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not link Sandbox Item: {type(exc).__name__}: {exc}",
            )
            return

        await interaction.edit_original_response(
            content=(
                f"Linked Sandbox Item for {owner.name}.\n"
                f"- Institution: {item.institution_name or 'unknown'}\n"
                f"- Owner key: `{item.owner_key}`\n"
                "- Access token stored encrypted locally."
            ),
        )

    @tree.command(name="debug_bank_link", description="(Admin) Create a Plaid Link URL for your budget owner")
    async def debug_bank_link(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            public_base_url = (service.config.public_base_url or "").rstrip("/")
            if not public_base_url:
                await _send_bank_command_error(
                    interaction,
                    "❌ `PUBLIC_BASE_URL` is required before creating a Plaid Link URL.",
                )
                return
            token = create_bank_link_setup_token(
                actor_key=str(interaction.user.id),
                owner_key=owner.budget_owner_key,
            )
        except BankLinkTokenError as exc:
            await _send_bank_command_error(interaction, f"❌ Could not create bank link token: {exc}")
            return
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not create bank link URL: {type(exc).__name__}: {exc}",
            )
            return

        await interaction.edit_original_response(
            content=(
                f"Open this private Plaid Link URL for {owner.name} within 15 minutes:\n"
                f"{public_base_url}/bank/link?token={token}\n\n"
                "After linking, run `/debug_bank_status` and `/debug_bank_sync`."
            )
        )

    @tree.command(name="debug_bank_items", description="(Admin) List linked bank Items for your budget owner")
    async def debug_bank_items(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            items = await asyncio.to_thread(service.linked_items, owner.budget_owner_key)
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not list bank Items: {type(exc).__name__}: {exc}",
            )
            return

        if not items:
            await interaction.edit_original_response(content=f"No bank Items found for {owner.name}.")
            return

        header = f"{'ID':>4}  {'Status':<12}  Institution"
        divider = "-" * len(header)
        rows = [
            f"{item.id:>4}  {item.status:<12}  {item.institution_name or item.item_id}"
            for item in items
        ]
        await interaction.edit_original_response(
            content=f"Bank Items for {owner.name}:\n```text\n" + "\n".join([header, divider, *rows]) + "\n```"
        )

    @tree.command(name="debug_bank_accounts", description="(Admin) List bank accounts and watch status")
    async def debug_bank_accounts(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            accounts = await asyncio.to_thread(service.accounts, owner.budget_owner_key)
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not list bank accounts: {type(exc).__name__}: {exc}",
            )
            return

        if not accounts:
            await interaction.edit_original_response(content=f"No bank accounts found for {owner.name}.")
            return

        header = f"{'ID':>4}  {'Watch':<5}  {'Item':>4}  {'Type':<13}  {'Mask':<4}  Account"
        divider = "-" * len(header)
        rows = []
        for account in accounts[:40]:
            subtype = account.subtype or account.type or ""
            mask = account.mask or ""
            rows.append(
                f"{account.id or 0:>4}  "
                f"{'yes' if account.watched else 'no':<5}  "
                f"{account.item_id:>4}  "
                f"{subtype[:13]:<13}  "
                f"{mask[:4]:<4}  "
                f"{account.name[:45]}"
            )
        suffix = "\n...truncated" if len(accounts) > len(rows) else ""
        await interaction.edit_original_response(
            content=(
                f"Bank accounts for {owner.name}:\n"
                "```text\n"
                + "\n".join([header, divider, *rows])
                + suffix
                + "\n```"
            )[:1900]
        )

    @tree.command(name="debug_bank_watch_account", description="(Admin) Include or exclude a bank account")
    @app_commands.describe(
        account_id="ID shown by /debug_bank_accounts",
        watched="True to include in recent/reconcile views, false to exclude",
    )
    async def debug_bank_watch_account(interaction: discord.Interaction, account_id: int, watched: bool):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            account = await asyncio.to_thread(
                service.set_account_watched,
                owner.budget_owner_key,
                account_id,
                watched,
            )
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not update bank account watch status: {type(exc).__name__}: {exc}",
            )
            return

        if account is None:
            await interaction.edit_original_response(
                content=f"No bank account `{account_id}` was found for {owner.name}."
            )
            return

        await interaction.edit_original_response(
            content=(
                f"Bank account `{account.id}` is now "
                f"{'watched' if account.watched else 'ignored'} for {owner.name}: "
                f"{account.name}{f' *{account.mask}' if account.mask else ''}."
            )
        )

    @tree.command(name="debug_bank_disconnect_item", description="(Admin) Disconnect a linked bank Item")
    @app_commands.describe(item_id="ID shown by /debug_bank_items")
    async def debug_bank_disconnect_item(interaction: discord.Interaction, item_id: int):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            item = await asyncio.to_thread(service.disconnect_item, owner.budget_owner_key, item_id)
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not disconnect bank Item: {type(exc).__name__}: {exc}",
            )
            return

        if item is None:
            await interaction.edit_original_response(content=f"No bank Item `{item_id}` was found for {owner.name}.")
            return

        await interaction.edit_original_response(
            content=(
                f"Disconnected bank Item `{item.id}` for {owner.name}: "
                f"{item.institution_name or item.item_id}.\n"
                "It will no longer sync. Existing cached transactions remain for audit/debug history."
            )
        )

    @tree.command(name="debug_bank_remove_item", description="(Admin) Remove a bank Item from Plaid and disconnect it")
    @app_commands.describe(item_id="ID shown by /debug_bank_items")
    async def debug_bank_remove_item(interaction: discord.Interaction, item_id: int):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            item = await asyncio.wait_for(
                service.remove_item_from_plaid(owner.budget_owner_key, item_id),
                timeout=30,
            )
        except asyncio.TimeoutError:
            await _send_bank_command_error(
                interaction,
                "❌ Plaid Item removal timed out after 30 seconds. Check Railway logs and try again.",
            )
            return
        except PlaidApiError as exc:
            await _send_bank_command_error(interaction, f"❌ Plaid error while removing Item: {exc}")
            return
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not remove bank Item: {type(exc).__name__}: {exc}",
            )
            return

        if item is None:
            await interaction.edit_original_response(content=f"No bank Item `{item_id}` was found for {owner.name}.")
            return

        await interaction.edit_original_response(
            content=(
                f"Removed bank Item `{item.id}` from Plaid and disconnected it for {owner.name}: "
                f"{item.institution_name or item.item_id}.\n"
                "Existing cached transactions remain until you run `/debug_bank_purge_item`."
            )
        )

    @tree.command(name="debug_bank_purge_item", description="(Admin) Delete cached data for a disconnected bank Item")
    @app_commands.describe(item_id="Disconnected ID shown by /debug_bank_items")
    async def debug_bank_purge_item(interaction: discord.Interaction, item_id: int):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            result = await asyncio.to_thread(service.purge_disconnected_item, owner.budget_owner_key, item_id)
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not purge bank Item: {type(exc).__name__}: {exc}",
            )
            return

        if result is None:
            await interaction.edit_original_response(content=f"No bank Item `{item_id}` was found for {owner.name}.")
            return
        if result.get("status") == 0:
            await interaction.edit_original_response(
                content=f"Bank Item `{item_id}` is not disconnected. Disconnect it before purging cached data."
            )
            return

        await interaction.edit_original_response(
            content=(
                f"Purged disconnected bank Item `{item_id}` for {owner.name}.\n"
                f"- Accounts deleted: {result['accounts']}\n"
                f"- Transactions deleted: {result['transactions']}\n"
                f"- Reconciliation rows deleted: {result['reconciliation_items']}"
            )
        )

    @tree.command(name="debug_bank_sync", description="(Admin) Sync Plaid transactions for your budget owner")
    async def debug_bank_sync(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            results = await asyncio.wait_for(service.sync_owner(owner.budget_owner_key), timeout=45)
        except asyncio.TimeoutError:
            await _send_bank_command_error(
                interaction,
                "❌ Bank transaction sync timed out after 45 seconds. Check Railway logs and try again.",
            )
            return
        except PlaidApiError as exc:
            await _send_bank_command_error(interaction, f"❌ Plaid error: {exc}")
            return
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not sync bank transactions: {type(exc).__name__}: {exc}",
            )
            return

        if not results:
            await interaction.edit_original_response(content="No active bank Items are linked for your budget owner yet.")
            return

        lines = [f"Synced {len(results)} bank Item(s) for {owner.name}:"]
        for result in results:
            lines.append(
                "- "
                f"{result.institution_name or f'Item {result.item_id}'}: "
                f"{result.accounts} account(s), "
                f"{result.added} added, {result.modified} modified, {result.removed} removed"
            )
        await interaction.edit_original_response(content="\n".join(lines))

    @tree.command(name="debug_bank_seed_sandbox", description="(Admin) Link and sync a Plaid Sandbox Item")
    @app_commands.describe(institution_id="Plaid Sandbox institution id, defaults to ins_109508")
    async def debug_bank_seed_sandbox(interaction: discord.Interaction, institution_id: str = "ins_109508"):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            if service.config.plaid_env != "sandbox":
                await interaction.followup.send(
                    content="❌ Sandbox seed command only runs when `PLAID_ENV=sandbox`.",
                    ephemeral=True,
                )
                return
            item, results = await asyncio.wait_for(
                service.seed_sandbox_owner(owner.budget_owner_key, institution_id=institution_id),
                timeout=60,
            )
        except asyncio.TimeoutError:
            await interaction.followup.send(
                content="❌ Sandbox seed timed out after 60 seconds. Check Railway logs and try again.",
                ephemeral=True,
            )
            return
        except PlaidApiError as exc:
            await interaction.followup.send(content=f"❌ Plaid error: {exc}", ephemeral=True)
            return
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not seed Sandbox bank data: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        lines = [
            f"Seeded Sandbox bank data for {owner.name}.",
            f"- Institution: {item.institution_name or 'unknown'}",
            f"- Owner key: `{item.owner_key}`",
        ]
        for result in results:
            lines.append(
                "- "
                f"{result.institution_name or f'Item {result.item_id}'}: "
                f"{result.accounts} account(s), "
                f"{result.added} added, {result.modified} modified, {result.removed} removed"
            )
        await interaction.followup.send(content="\n".join(lines), ephemeral=True)

    @tree.command(name="debug_bank_transactions", description="(Admin) Show recent synced bank transactions")
    @app_commands.describe(limit="Number of transactions to show (default 10, max 25)")
    async def debug_bank_transactions(interaction: discord.Interaction, limit: int = 10):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            transactions = service.recent_transactions(owner.budget_owner_key, limit=limit)
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not load bank transactions: {type(exc).__name__}: {exc}",
            )
            return

        if not transactions:
            await interaction.edit_original_response(content="No synced bank transactions found for your budget owner.")
            return

        capped_limit = max(1, min(limit, 25))
        chunks = format_bank_transaction_table_chunks(transactions)
        await interaction.edit_original_response(
            content=(
                f"Recent bank transactions for {owner.name} ({len(transactions)} of max {capped_limit}):\n"
                f"{chunks[0]}"
            )
        )
        for chunk in chunks[1:]:
            await interaction.followup.send(content=chunk, ephemeral=True)

    @tree.command(name="debug_bank_seed_action_log", description="(Admin) Seed debug bank transactions from action log")
    @app_commands.describe(limit="Number of action-log rows to seed as debug transactions (default 25, max 100)")
    async def debug_bank_seed_action_log(interaction: discord.Interaction, limit: int = 25):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            seeded, considered = await asyncio.to_thread(
                service.seed_cached_transactions_from_action_log,
                owner.budget_owner_key,
                str(interaction.user.id),
                limit=max(1, min(limit, 100)),
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not seed action-log bank transactions: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        await interaction.followup.send(
            content=(
                f"Seeded {seeded} debug bank transaction(s) from {considered} active action-log row(s) "
                f"for {owner.name}."
            ),
            ephemeral=True,
        )

    @tree.command(name="debug_bank_seed_unmatched", description="(Admin) Seed one unmatched debug bank transaction")
    @app_commands.describe(
        name="Merchant/source name for the debug transaction",
        amount="Amount for the debug transaction",
        kind="expense or income",
    )
    async def debug_bank_seed_unmatched(
        interaction: discord.Interaction,
        name: str = "Unlogged Test Purchase",
        amount: float = 12.34,
        kind: str = "expense",
    ):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            normalized_kind = _clean_command_text(kind).lower()
            if normalized_kind not in {"expense", "income"}:
                await interaction.followup.send("❌ `kind` must be `expense` or `income`.", ephemeral=True)
                return
            service = build_banking_service()
            transaction = await asyncio.to_thread(
                service.seed_unmatched_debug_transaction,
                owner.budget_owner_key,
                name=_clean_command_text(name),
                amount=amount,
                kind=normalized_kind,
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not seed unmatched bank transaction: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        direction = "income" if transaction.amount < 0 else "expense"
        await interaction.followup.send(
            content=(
                f"Seeded unmatched debug {direction} for {owner.name}: "
                f"`{transaction.name} - ${abs(transaction.amount):.2f} - {transaction.date or transaction.authorized_date}`"
            ),
            ephemeral=True,
        )

    @tree.command(name="debug_bank_reconcile", description="(Admin) Preview cached bank reconciliation classifications")
    @app_commands.describe(
        limit="Number of transactions to classify (default 25, max 50)",
        force="Re-preview already reconciled cached transactions",
    )
    async def debug_bank_reconcile(interaction: discord.Interaction, limit: int = 25, force: bool = False):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            preview = await asyncio.to_thread(
                service.reconciliation_preview,
                owner.budget_owner_key,
                limit=max(1, min(limit, 50)),
                force=force,
                actor_key=str(interaction.user.id),
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not build reconciliation preview: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        await interaction.followup.send(content=format_reconciliation_preview(preview, max_chars=1900), ephemeral=True)

    @tree.command(name="debug_bank_review", description="(Admin) Show unresolved bank reconciliation items")
    @app_commands.describe(limit="Number of unresolved items to show (default 25, max 100)")
    async def debug_bank_review(interaction: discord.Interaction, limit: int = 25):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            items = await asyncio.to_thread(
                service.unresolved_reconciliation_items,
                owner.budget_owner_key,
                limit=max(1, min(limit, 100)),
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not load bank review items: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        await interaction.followup.send(content=format_reconciliation_review(items)[:1900], ephemeral=True)

    @tree.command(name="debug_bank_ignore", description="(Admin) Ignore an unresolved bank reconciliation item")
    @app_commands.describe(reconciliation_id="ID shown by /debug_bank_review")
    async def debug_bank_ignore(interaction: discord.Interaction, reconciliation_id: int):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            item = await asyncio.to_thread(
                service.ignore_reconciliation_item,
                owner.budget_owner_key,
                reconciliation_id,
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not ignore bank review item: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        if item is None:
            await interaction.followup.send(
                content=f"No bank reconciliation item `{reconciliation_id}` was found for {owner.name}.",
                ephemeral=True,
            )
            return

        transaction = item.transaction
        await interaction.followup.send(
            content=(
                f"Ignored bank reconciliation item `{item.id}` for {owner.name}: "
                f"`{transaction.name} - ${abs(transaction.amount):.2f}`"
            ),
            ephemeral=True,
        )

    @tree.command(name="debug_bank_log_expense", description="(Admin) Log an unresolved bank item as an expense")
    @app_commands.describe(
        reconciliation_id="ID shown by /debug_bank_review",
        category="Expense category, such as food, grocery, gas, or shopping",
        person="Budget person/card label, such as Brian (BofA)",
        item="Optional item/description override",
        location="Optional location/merchant override",
    )
    async def debug_bank_log_expense(
        interaction: discord.Interaction,
        reconciliation_id: int,
        category: str,
        person: str,
        item: str = "",
        location: str = "",
    ):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        normalized_category = _clean_command_text(category).lower()
        if normalized_category not in get_category_columns:
            available = ", ".join(sorted(get_category_columns))
            await interaction.followup.send(
                content=f"❌ Unknown category `{category}`. Available categories: {available}.",
                ephemeral=True,
            )
            return
        clean_person = _clean_command_text(person)
        if not clean_person:
            await interaction.followup.send("❌ `person` is required.", ephemeral=True)
            return

        try:
            owner = get_user_config(interaction.user.id)
            confirmed, status = await asyncio.to_thread(
                _log_bank_reconciliation_expense,
                actor_key=str(interaction.user.id),
                owner_key=owner.budget_owner_key,
                reconciliation_id=reconciliation_id,
                category=normalized_category,
                person=clean_person,
                item_name=_clean_command_text(item),
                location=_clean_command_text(location),
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not log bank expense: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        if status == "not_found" or confirmed is None:
            await interaction.followup.send(
                content=f"No bank reconciliation item `{reconciliation_id}` was found for {owner.name}.",
                ephemeral=True,
            )
            return
        if status == "not_unresolved":
            await interaction.followup.send(
                content=f"Bank reconciliation item `{reconciliation_id}` is already `{confirmed.status}`.",
                ephemeral=True,
            )
            return
        if status == "not_expense":
            await interaction.followup.send(
                content=f"Bank reconciliation item `{reconciliation_id}` is not an expense outflow.",
                ephemeral=True,
            )
            return

        transaction = confirmed.transaction
        await interaction.followup.send(
            content=(
                f"Logged bank reconciliation item `{confirmed.id}` as `{normalized_category}` for {clean_person}: "
                f"`{transaction.name} - ${abs(transaction.amount):.2f}`"
            ),
            ephemeral=True,
        )

    @tree.command(name="debug_bank_log_income", description="(Admin) Log an unresolved bank item as income")
    @app_commands.describe(
        reconciliation_id="ID shown by /debug_bank_review",
        source="Optional income source override",
        label="Optional income label, such as paycheck or refund",
    )
    async def debug_bank_log_income(
        interaction: discord.Interaction,
        reconciliation_id: int,
        source: str = "",
        label: str = "",
    ):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            confirmed, status = await asyncio.to_thread(
                _log_bank_reconciliation_income,
                actor_key=str(interaction.user.id),
                owner_key=owner.budget_owner_key,
                reconciliation_id=reconciliation_id,
                source=_clean_command_text(source),
                label=_clean_command_text(label),
            )
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not log bank income: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        if status == "not_found" or confirmed is None:
            await interaction.followup.send(
                content=f"No bank reconciliation item `{reconciliation_id}` was found for {owner.name}.",
                ephemeral=True,
            )
            return
        if status == "not_unresolved":
            await interaction.followup.send(
                content=f"Bank reconciliation item `{reconciliation_id}` is already `{confirmed.status}`.",
                ephemeral=True,
            )
            return
        if status == "not_income":
            await interaction.followup.send(
                content=f"Bank reconciliation item `{reconciliation_id}` is not an income inflow.",
                ephemeral=True,
            )
            return

        transaction = confirmed.transaction
        await interaction.followup.send(
            content=(
                f"Logged bank reconciliation item `{confirmed.id}` as income: "
                f"`{transaction.name} - ${abs(transaction.amount):.2f}`"
            ),
            ephemeral=True,
        )

    @tree.command(name="debug_subscriptions", description="(Admin) Sync and inspect subscription reminder data")
    async def debug_subscriptions(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        actor_key = str(interaction.user.id)
        try:
            with sheet_user_context(actor_key):
                subscriptions, warnings = debug_subscription_sync()
                bills, bill_warnings = parse_bill_schedules_with_warnings()
        except Exception as exc:
            await interaction.followup.send(
                content=f"❌ Could not sync subscriptions: {type(exc).__name__}: {exc}",
                ephemeral=True,
            )
            return

        lines = [
            f"Synced {len(subscriptions)} subscriptions.",
            "Hidden sheet: `_BookieBot Subscription Schedule`",
            f"Loaded {len(bills)} bill schedules.",
            "Hidden bill sheet: `_BookieBot Bill Schedule`",
        ]
        if subscriptions:
            lines.append("")
            lines.append("Parsed subscriptions:")
            for subscription in subscriptions[:20]:
                if subscription.cadence == "yearly":
                    schedule = f"{subscription.pull_month}/{subscription.pull_day}"
                else:
                    schedule = f"{subscription.pull_day}"
                lines.append(f"- {subscription.name}: ${subscription.amount:.2f} {subscription.cadence} on {schedule}")
            if len(subscriptions) > 20:
                lines.append(f"- ...and {len(subscriptions) - 20} more")
        if warnings:
            lines.append("")
            lines.append(f"Skipped {len(warnings)} row(s):")
            for warning in warnings[:10]:
                lines.append(f"- {warning.format()}")
            if len(warnings) > 10:
                lines.append(f"- ...and {len(warnings) - 10} more")
        if bills:
            lines.append("")
            lines.append("Parsed bill schedules:")
            for bill in bills[:20]:
                schedule = f"{bill.pull_day}"
                if bill.recurrence == "quarterly":
                    schedule = f"{bill.pull_day} in months {','.join(str(month) for month in bill.pull_months)}"
                lines.append(f"- {bill.display_name}: {bill.recurrence} on {schedule}")
            if len(bills) > 20:
                lines.append(f"- ...and {len(bills) - 20} more")
        if bill_warnings:
            lines.append("")
            lines.append(f"Skipped {len(bill_warnings)} bill row(s):")
            for warning in bill_warnings[:10]:
                lines.append(f"- {warning.format()}")
            if len(bill_warnings) > 10:
                lines.append(f"- ...and {len(bill_warnings) - 10} more")

        content = "\n".join(lines)
        await interaction.followup.send(content=content[:1900], ephemeral=True)

    @tree.command(name="debug_logs", description="(Admin) Show recent logs")
    @app_commands.describe(
        lines="Number of lines to return (default 200, max 2000)",
        level="Optional level filter (INFO/WARN/ERROR)",
        contains="Optional substring filter",
    )
    async def debug_logs(
        interaction: discord.Interaction,
        lines: int = 200,
        level: str | None = None,
        contains: str | None = None,
    ):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        lines = max(1, min(lines, 2000))
        logs = get_recent_logs(limit=lines, level=level, contains=contains)
        if not logs:
            await interaction.response.send_message("No logs available for the given filters.", ephemeral=True)
            return

        content = "\n".join(logs)
        if len(content) > 1800:
            import io

            buf = io.BytesIO(content.encode("utf-8"))
            await interaction.response.send_message(
                content=f"Last {len(logs)} log lines:",
                file=discord.File(buf, filename="logs.txt"),
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(f"```\n{content}\n```", ephemeral=True)

    @tree.command(name="debug_status", description="(Admin) Show bot status/health")
    async def debug_status(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        uptime = uptime_seconds()
        git_sha, env_name = incidents.current_build_env()
        llm_ready = bool(os.getenv("OPENAI_API_KEY"))
        try:
            get_year_config(get_current_year())
            sheet_ready = bool(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON"))
        except MissingYearConfigError:
            sheet_ready = False

        msg = (
            f"⏱️ Uptime: {uptime/3600:.2f}h\n"
            f"🔖 Build: {git_sha}\n"
            f"🌎 Env: {env_name}\n"
            f"🤖 LLM ready: {'yes' if llm_ready else 'no'}\n"
            f"📄 Sheets configured: {'yes' if sheet_ready else 'no'}"
        )
        await interaction.response.send_message(msg, ephemeral=True)

    @tree.command(name="debug_open_issue", description="(Admin) Capture an incident payload for LLM triage")
    @app_commands.describe(summary="Short description of the issue", lines="Number of log lines to include (default 200)")
    async def debug_open_issue(interaction: discord.Interaction, summary: str, lines: int = 200):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        lines = max(1, min(lines, 2000))
        logs = get_recent_logs(limit=lines)
        payload = incidents.build_incident_payload(
            summary=summary,
            requester=interaction.user,
            channel=interaction.channel,
            logs=logs,
        )

        # 1) Defer so we don't time out
        await interaction.response.defer(ephemeral=True)

        # 2) Trigger Codex autofix
        ok, msg, pr_url = await github_dispatch.trigger_codex_autofix(payload)
        if not ok:
            await interaction.followup.send(
                content=f"❌ Could not dispatch Codex autofix: {msg}",
                ephemeral=True,
            )
            return

        # Build workflow URL and a non-embedding display version
        if config.GITHUB_REPO:
            workflow_url = f"https://github.com/{config.GITHUB_REPO}/actions/workflows/codex-autofix.yml"
            workflow_link_display = f"<{workflow_url}>"  # prevent embed
        else:
            workflow_url = None
            workflow_link_display = "Workflow link unavailable."

        base_text = (
            "✅ Sent incident to Codex autofix.\n"
            f"🔗 Workflow: {workflow_link_display}\n"
            "⏳ Polling for Codex PR..."
        )

        # 3) Send a single ephemeral status message that we'll edit in place.
        status_msg = await interaction.followup.send(
            content=base_text,
            ephemeral=True,
        )
        status_msg = cast(discord.Message, status_msg)

        # Record when this run started so we can ignore older PRs
        started_at = datetime.now(timezone.utc)

        # 4) Braille spinner: show every frame (no skipping), ~4 updates/sec, poll GitHub once/sec
        branch_prefix = "codex/autofix-"
        spinner_frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

        spinner_interval = 0.25        # ~4 edits per second
        poll_interval = 1.0            # poll GitHub once per second
        max_duration_seconds = 300     # 5 minutes

        spinner_idx = 0
        last_poll_at = started_at
        last_spinner_update = started_at
        last_run_poll = started_at
        run_id: int | None = None
        run_status_label: str | None = None
        run_step_label: str | None = None

        while True:
            now = datetime.now(timezone.utc)
            elapsed = (now - started_at).total_seconds()

            if elapsed >= max_duration_seconds:
                break

            if (now - last_poll_at).total_seconds() >= poll_interval:
                last_poll_at = now

                if run_id is None and (now - last_run_poll).total_seconds() >= poll_interval:
                    last_run_poll = now
                    run_id, run_status_label, _run_url = await github_dispatch.find_latest_workflow_run(started_at)

                if run_id is not None and (now - last_run_poll).total_seconds() >= poll_interval:
                    last_run_poll = now
                    run_status_label, run_step_label = await github_dispatch.fetch_run_step_status(run_id)

                pr_url_polled = await github_dispatch.find_pr_for_branch(branch_prefix, created_after=started_at)
                if pr_url_polled:
                    pr_link_display = f"<{pr_url_polled}>"
                    total_elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
                    total_minutes = int(total_elapsed) // 60
                    total_seconds = int(total_elapsed) % 60
                    elapsed_line = f"⏱️ Elapsed: {total_minutes}:{total_seconds:02d}"
                    await ui.safe_edit_followup(
                        interaction.followup,
                        status_msg.id,
                        (
                            "✅ Codex autofix completed.\n"
                            f"🔗 Workflow: {workflow_link_display}\n"
                            f"🔗 Codex PR: {pr_link_display}\n"
                            f"{elapsed_line}"
                        ),
                    )
                    return

            if (now - last_spinner_update).total_seconds() >= spinner_interval:
                last_spinner_update = now

                elapsed_seconds_int = int(elapsed)
                minutes = elapsed_seconds_int // 60
                seconds = elapsed_seconds_int % 60
                elapsed_str = f"{minutes}:{seconds:02d}"

                spin = spinner_frames[spinner_idx]
                spinner_idx = (spinner_idx + 1) % len(spinner_frames)

                status_line = f"{spin} {elapsed_str}"
                if run_status_label:
                    status_line += f" {run_status_label}"
                if run_step_label:
                    status_line += f" • {run_step_label}"

                await ui.safe_edit_followup(
                    interaction.followup,
                    status_msg.id,
                    (
                        f"{base_text}\n"
                        f"{status_line}"
                    ),
                )

            await asyncio.sleep(0.1)

        if pr_url:
            fallback_link = f"<{pr_url}>"
        else:
            fallback_link = "(PR not yet detected; check workflow run.)"

        total_elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
        total_minutes = int(total_elapsed) // 60
        total_seconds = int(total_elapsed) % 60
        elapsed_line = f"⏱️ Elapsed: {total_minutes}:{total_seconds:02d}"

        await ui.safe_edit_followup(
            interaction.followup,
            status_msg.id,
            (
                "⚠️ Codex autofix finished polling.\n"
                f"🔗 Workflow: {workflow_link_display}\n"
                f"🔗 Codex PR (best effort): {fallback_link}\n"
                f"{elapsed_line}"
            ),
        )
