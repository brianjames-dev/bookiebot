import discord
import asyncio
import os
from datetime import datetime, timezone
from typing import cast

from discord import app_commands

from bookiebot.core import auth, config
from bookiebot.core import incidents
from bookiebot.core import github_dispatch
from bookiebot.core import ui
from bookiebot.banking.formatting import format_bank_transaction_table, format_reconciliation_preview
from bookiebot.banking.plaid_client import PlaidApiError
from bookiebot.banking.service import build_banking_service
from bookiebot.logging_config import get_recent_logs, uptime_seconds
from bookiebot.sheets.routing import (
    get_current_year,
    get_user_config,
    get_year_config,
    MissingYearConfigError,
    sheet_user_context,
)
from bookiebot.sheets.bills import parse_bill_schedules_with_warnings
from bookiebot.sheets.subscriptions import debug_subscription_sync


async def _send_bank_command_error(interaction: discord.Interaction, content: str) -> None:
    if interaction.response.is_done():
        await interaction.edit_original_response(content=content)
    else:
        await interaction.response.send_message(content, ephemeral=True)


def register_commands(tree: app_commands.CommandTree):
    @tree.command(name="debug_bank_status", description="(Admin) Show read-only bank integration status")
    async def debug_bank_status(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.send_message("Checking bank integration status...", ephemeral=True)
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

        await interaction.response.send_message("Linking Plaid Sandbox Item...", ephemeral=True)
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

    @tree.command(name="debug_bank_sync", description="(Admin) Sync Plaid transactions for your budget owner")
    async def debug_bank_sync(interaction: discord.Interaction):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.send_message("Syncing bank transactions...", ephemeral=True)
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

    @tree.command(name="debug_bank_transactions", description="(Admin) Show recent synced bank transactions")
    @app_commands.describe(limit="Number of transactions to show (default 10, max 25)")
    async def debug_bank_transactions(interaction: discord.Interaction, limit: int = 10):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.send_message("Loading recent bank transactions...", ephemeral=True)
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
        lines = [f"Recent bank transactions for {owner.name} ({len(transactions)} of max {capped_limit}):"]
        lines.append(format_bank_transaction_table(transactions))
        await interaction.edit_original_response(content="\n".join(lines)[:1900])

    @tree.command(name="debug_bank_reconcile", description="(Admin) Preview cached bank reconciliation classifications")
    @app_commands.describe(limit="Number of unreconciled transactions to classify (default 25, max 50)")
    async def debug_bank_reconcile(interaction: discord.Interaction, limit: int = 25):
        if not auth.is_debug_allowed(interaction.user):
            await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
            return

        await interaction.response.send_message("Building bank reconciliation preview...", ephemeral=True)
        try:
            owner = get_user_config(interaction.user.id)
            service = build_banking_service()
            preview = service.reconciliation_preview(owner.budget_owner_key, limit=max(1, min(limit, 50)))
        except Exception as exc:
            await _send_bank_command_error(
                interaction,
                f"❌ Could not build reconciliation preview: {type(exc).__name__}: {exc}",
            )
            return

        await interaction.edit_original_response(content=format_reconciliation_preview(preview, max_chars=1900))

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
