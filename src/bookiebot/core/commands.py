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
from bookiebot.logging_config import get_recent_logs, uptime_seconds


def register_commands(tree: app_commands.CommandTree):
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
        sheet_ready = bool(os.getenv("EXPENSE_SHEET_KEY") or os.getenv("INCOME_SHEET_KEY"))

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
