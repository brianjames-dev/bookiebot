import asyncio
import discord
import logging
import os
import json
import urllib.request
from urllib.error import URLError, HTTPError
from datetime import datetime, timezone
from typing import cast
import time

import aiohttp
from discord import app_commands
from dotenv import load_dotenv

from bookiebot.intent_parser import parse_message_llm
from bookiebot.intent_handlers import handle_intent
from bookiebot import intent_explorer
from bookiebot.logging_config import get_recent_logs, init_logging, uptime_seconds

init_logging()
logger = logging.getLogger(__name__)

logger.info("🚀 Starting bot...")

# Load environment variables
load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
if not TOKEN:
    raise RuntimeError("❌ DISCORD_TOKEN is not set in the environment!")

CHANNEL_NAME = os.getenv("CHANNEL_NAME", "babys-books")
CHANNEL_ID = int(os.getenv("CHANNEL_ID", "0")) or None

# Discord intents
intents = discord.Intents.default()
intents.messages = True
intents.message_content = True

client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

DEBUG_ALLOWLIST = {u.strip() for u in os.getenv("DEBUG_ADMINS", "").split(",") if u.strip()}
AGENT_ENDPOINT = os.getenv("DEBUG_AGENT_ENDPOINT", "").strip()
AGENT_API_KEY = os.getenv("DEBUG_AGENT_API_KEY", "").strip()
GITHUB_DISPATCH_TOKEN = os.getenv("GITHUB_DISPATCH_TOKEN", "").strip()
GITHUB_REPO = os.getenv("GITHUB_REPO", "").strip()
GITHUB_DISPATCH_EVENT = os.getenv("GITHUB_DISPATCH_EVENT", "codex_autofix").strip()
GITHUB_API_BASE = "https://api.github.com"


def _is_debug_allowed(user: discord.abc.User) -> bool:
    if not DEBUG_ALLOWLIST:
        return False
    return str(user.id) in DEBUG_ALLOWLIST


def _current_build_env() -> tuple[str, str]:
    git_sha = os.getenv("GIT_SHA") or os.getenv("RAILWAY_GIT_COMMIT_SHA") or "unknown"
    env_name = os.getenv("BOT_ENV") or os.getenv("ENV") or "unknown"
    return git_sha, env_name


def _build_incident_payload(
    summary: str,
    requester: discord.abc.User,
    channel: object | None,
    logs: list[str],
    intent: str | None = None,
    entities: dict | None = None,
) -> dict:
    git_sha, env_name = _current_build_env()
    return {
        "summary": summary,
        "user": str(requester),
        "user_id": str(getattr(requester, "id", "")),
        "channel": getattr(channel, "name", None) or getattr(channel, "id", "unknown"),
        "intent": intent,
        "entities": entities or {},
        "build": git_sha,
        "env": env_name,
        "uptime_seconds": uptime_seconds(),
        "logs": logs,
    }


async def _post_to_agent(payload: dict) -> tuple[bool, str, dict]:
    """
    Send a JSON payload to the configured agent endpoint.
    Returns (ok, message, response_json).
    """
    if not AGENT_ENDPOINT:
        return False, "No DEBUG_AGENT_ENDPOINT configured.", {}

    headers = {"Content-Type": "application/json"}
    if AGENT_API_KEY:
        headers["Authorization"] = f"Bearer {AGENT_API_KEY}"

    data = json.dumps(payload).encode("utf-8")

    def _send():
        req = urllib.request.Request(AGENT_ENDPOINT, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            if not body:
                return {}
            return json.loads(body.decode("utf-8"))

    try:
        resp_json = await client.loop.run_in_executor(None, _send)
        return True, "ok", resp_json
    except HTTPError as e:
        return False, f"HTTP {e.code}: {e.reason}", {}
    except URLError as e:
        return False, f"Network error: {e.reason}", {}
    except Exception as e:
        return False, str(e), {}


async def _fetch_latest_pr() -> str | None:
    """
    Best-effort: fetch the latest open PR URL (used only for fallback messaging).
    """
    if not GITHUB_DISPATCH_TOKEN or not GITHUB_REPO:
        return None
    url = f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/pulls?state=open&sort=created&direction=desc&per_page=1"
    headers = {
        "Authorization": f"token {GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
                if isinstance(data, list) and data:
                    return data[0].get("html_url")
    except Exception:
        return None
    return None


async def _find_latest_workflow_run(started_after: datetime) -> tuple[int | None, str | None, str | None]:
    """
    Best-effort: find the latest codex-autofix workflow run created after started_after.
    Returns (run_id, status, html_url).
    """
    if not GITHUB_DISPATCH_TOKEN or not GITHUB_REPO:
        return None, None, None

    url = f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/actions/workflows/codex-autofix.yml/runs?event=repository_dispatch&per_page=5"
    headers = {
        "Authorization": f"token {GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    return None, None, None
                data = await resp.json()
                runs = data.get("workflow_runs", []) if isinstance(data, dict) else []
                for run in runs:
                    created_at = run.get("created_at")
                    if not created_at:
                        continue
                    try:
                        created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                    except Exception:
                        continue
                    if created_dt >= started_after:
                        return run.get("id"), run.get("status"), run.get("html_url")
    except Exception:
        return None, None, None
    return None, None, None


async def _fetch_run_step_status(run_id: int) -> tuple[str | None, str | None]:
    """
    Return (run_status, step_label) for the run's primary job, best-effort.
    """
    if not GITHUB_DISPATCH_TOKEN or not GITHUB_REPO:
        return None, None

    url = f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/actions/runs/{run_id}/jobs?per_page=20"
    headers = {
        "Authorization": f"token {GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    return None, None
                data = await resp.json()
                jobs = data.get("jobs", []) if isinstance(data, dict) else []
                if not jobs:
                    return None, None
                job = jobs[0]
                run_status = job.get("status")
                steps = job.get("steps", []) or []

                # Find the first step that is in_progress or queued; otherwise last step name.
                current_step_name = None
                total_steps = len(steps)
                current_idx = None
                for idx, step in enumerate(steps, start=1):
                    status = step.get("status")
                    if status in {"in_progress", "queued", "waiting"}:
                        current_step_name = step.get("name")
                        current_idx = idx
                        break
                if current_step_name is None and steps:
                    current_step_name = steps[-1].get("name")
                    current_idx = total_steps

                if current_step_name and total_steps and current_idx:
                    step_label = f"{current_step_name} ({current_idx}/{total_steps})"
                else:
                    step_label = current_step_name

                return run_status, step_label
    except Exception:
        return None, None
    return None, None


async def trigger_codex_autofix(incident_payload: dict) -> tuple[bool, str, str | None]:
    """
    Send a repository_dispatch event to GitHub to trigger the codex-autofix workflow.
    Returns (success, message, pr_url_best_effort).
    """
    if not GITHUB_DISPATCH_TOKEN or not GITHUB_REPO or not GITHUB_DISPATCH_EVENT:
        return False, "GITHUB_DISPATCH_TOKEN, GITHUB_REPO, or GITHUB_DISPATCH_EVENT not configured.", None

    url = f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/dispatches"
    body = {
        "event_type": GITHUB_DISPATCH_EVENT,
        "client_payload": {
            "incident": incident_payload,
            "summary": incident_payload.get("summary"),
        },
    }
    headers = {
        "Authorization": f"token {GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body, headers=headers) as resp:
                if resp.status == 204:
                    pr_url = await _fetch_latest_pr()
                    return True, "Dispatch created.", pr_url
                text = await resp.text()
                logger.error("GitHub dispatch failed: %s %s", resp.status, text)
                return False, f"GitHub dispatch failed ({resp.status}): {text}", None
    except Exception as e:
        logger.exception("Dispatch exception", extra={"exception": str(e)})
        return False, f"Exception during dispatch: {e}", None


async def _poll_for_pr(branch_prefix: str, *, attempts: int = 40, delay_seconds: float = 10.0) -> str | None:
    """
    Poll GitHub for the newest open PR whose head branch starts with branch_prefix.
    Best-effort; returns the PR URL or None.
    (Currently unused, but kept for potential future use.)
    """
    if not GITHUB_DISPATCH_TOKEN or not GITHUB_REPO:
        return None

    url = f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/pulls?state=open&sort=created&direction=desc&per_page=5"
    headers = {
        "Authorization": f"token {GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }

    timeout = aiohttp.ClientTimeout(total=10)
    for _ in range(attempts):
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status != 200:
                        await asyncio.sleep(delay_seconds)
                        continue
                    data = await resp.json()
                    if isinstance(data, list):
                        for pr in data:
                            head = pr.get("head", {})
                            ref = head.get("ref", "")
                            if ref.startswith(branch_prefix):
                                return pr.get("html_url")
        except Exception:
            pass
        await asyncio.sleep(delay_seconds)

    return None


async def _find_pr_for_branch(branch_prefix: str, created_after: datetime | None = None) -> str | None:
    """
    Single-attempt check for an open PR whose branch starts with the given prefix.
    If created_after is provided, only consider PRs created at or after that timestamp.
    """
    if not GITHUB_DISPATCH_TOKEN or not GITHUB_REPO:
        return None

    url = f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/pulls?state=open&sort=created&direction=desc&per_page=5"
    headers = {
        "Authorization": f"token {GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }
    timeout = aiohttp.ClientTimeout(total=10)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
                if isinstance(data, list):
                    for pr in data:
                        head = pr.get("head", {})
                        ref = head.get("ref", "")
                        if not ref.startswith(branch_prefix):
                            continue

                        created_at_str = pr.get("created_at")
                        if created_after and created_at_str:
                            # GitHub uses ISO 8601 with 'Z' (UTC), e.g. "2025-11-28T20:15:23Z"
                            try:
                                created_at = datetime.fromisoformat(
                                    created_at_str.replace("Z", "+00:00")
                                )
                            except Exception:
                                created_at = None

                            # Only consider PRs created at or after this command started
                            if created_at and created_at < created_after:
                                continue

                        return pr.get("html_url")
    except Exception:
        return None
    return None


async def _safe_edit_followup(followup: discord.Webhook, message_id: int, content: str) -> None:
    try:
        await followup.edit_message(
            message_id=message_id,
            content=content,
        )
    except Exception as e:
        logger.exception("Failed to edit followup message", extra={"exception": str(e)})
        try:
            await followup.send(content, ephemeral=True)
        except Exception:
            logger.exception("Failed to send fallback followup", extra={"exception": str(e)})


async def _safe_edit_original(interaction: discord.Interaction, content: str) -> None:
    try:
        await interaction.edit_original_response(content=content)
    except Exception as e:
        logger.exception("Failed to edit original response", extra={"exception": str(e)})


@client.event
async def on_ready():
    logger.info("✅ Logged in as bot", extra={"user": str(client.user)})
    try:
        await tree.sync()
        logger.info("✅ Synced application commands")
    except Exception as e:
        logger.exception("Failed to sync commands", extra={"exception": str(e)})


@client.event
async def on_message(message):
    # Ignore the bot’s own messages
    if message.author == client.user:
        return

    # Only respond in the configured channel
    if CHANNEL_ID:
        if message.channel.id != CHANNEL_ID:
            return
    else:
        if message.channel.name != CHANNEL_NAME:
            return

    content = message.content.strip()
    logger.info(
        "📩 New message",
        extra={
            "text": content,
            "user": str(message.author),
            "user_id": str(message.author.id),
            "channel": message.channel.name,
        },
    )

    # === INTENT LIST COMMANDS ===
    if content.lower() == "list":
        output = intent_explorer.list_intents()
        await message.channel.send(output)
        return

    if content.isdigit():
        idx = int(content)
        output = intent_explorer.describe_intent(idx)
        await message.channel.send(output)
        return

    # === REGULAR BOT FLOW ===
    try:
        intent_data = await parse_message_llm(content)
        intent = intent_data.get("intent")
        entities = intent_data.get("entities", {})
        logger.info(
            "🤖 Detected intent",
            extra={
                "intent": intent,
                "entities": entities,
                "user": str(message.author),
                "user_id": str(message.author.id),
            },
        )
    except Exception as e:
        logger.exception("Failed to parse intent", extra={"exception": str(e)})
        await message.channel.send("❌ Sorry, I couldn’t understand your request.")
        return

    if not intent:
        await message.channel.send("❌ Sorry, I couldn’t understand your request.")
        return

    # Add default `person` if not explicitly specified
    if "person" not in entities or not entities["person"]:
        entities["person"] = None
        logger.info(
            "No person specified; resolver will handle user",
            extra={"user": message.author.name, "user_id": str(message.author.id)},
        )

    try:
        await handle_intent(intent, entities, message)
    except Exception as e:
        logger.exception("Failed to handle intent", extra={"exception": str(e)})
        await message.channel.send("❌ Something went wrong while processing your request.")


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
    if not _is_debug_allowed(interaction.user):
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
    if not _is_debug_allowed(interaction.user):
        await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
        return

    uptime = uptime_seconds()
    git_sha, env_name = _current_build_env()
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
    if not _is_debug_allowed(interaction.user):
        await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
        return

    lines = max(1, min(lines, 2000))
    logs = get_recent_logs(limit=lines)
    payload = _build_incident_payload(
        summary=summary,
        requester=interaction.user,
        channel=interaction.channel,
        logs=logs,
    )

    # 1) Defer so we don't time out
    await interaction.response.defer(ephemeral=True)

    # 2) Trigger Codex autofix
    ok, msg, pr_url = await trigger_codex_autofix(payload)
    if not ok:
        await interaction.followup.send(
            content=f"❌ Could not dispatch Codex autofix: {msg}",
            ephemeral=True,
        )
        return

    # Build workflow URL and a non-embedding display version
    if GITHUB_REPO:
        workflow_url = f"https://github.com/{GITHUB_REPO}/actions/workflows/codex-autofix.yml"
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

        # Stop after max_duration_seconds
        if elapsed >= max_duration_seconds:
            break

        # Poll GitHub at most once per second
        if (now - last_poll_at).total_seconds() >= poll_interval:
            last_poll_at = now

            # Discover workflow run if we don't have it yet
            if run_id is None and (now - last_run_poll).total_seconds() >= poll_interval:
                last_run_poll = now
                run_id, run_status_label, _run_url = await _find_latest_workflow_run(started_at)

            # Update job/step status if we know the run id
            if run_id is not None and (now - last_run_poll).total_seconds() >= poll_interval:
                last_run_poll = now
                run_status_label, run_step_label = await _fetch_run_step_status(run_id)

            pr_url_polled = await _find_pr_for_branch(branch_prefix, created_after=started_at)
            if pr_url_polled:
                pr_link_display = f"<{pr_url_polled}>"
                total_elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
                total_minutes = int(total_elapsed) // 60
                total_seconds = int(total_elapsed) % 60
                elapsed_line = f"⏱️ Elapsed: {total_minutes}:{total_seconds:02d}"
                await _safe_edit_followup(
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

        # Update spinner ~4x/sec using real elapsed time
        if (now - last_spinner_update).total_seconds() >= spinner_interval:
            last_spinner_update = now

            elapsed_seconds_int = int(elapsed)
            minutes = elapsed_seconds_int // 60
            seconds = elapsed_seconds_int % 60
            elapsed_str = f"{minutes}:{seconds:02d}"

            spin = spinner_frames[spinner_idx]
            spinner_idx = (spinner_idx + 1) % len(spinner_frames)

            state_parts = []
            if run_status_label:
                state_parts.append(run_status_label.replace("_", " "))
            if run_step_label:
                state_parts.append(run_step_label)
            state_text = " • ".join(state_parts)

            await _safe_edit_followup(
                interaction.followup,
                status_msg.id,
                (
                    f"{base_text}\n"
                    f"{spin} {elapsed_str}"
                    f"{' • ' + state_text if state_text else ''}"
                ),
            )

        # Small sleep so we don't busy-loop
        await asyncio.sleep(0.1)

    # 5) Fallback if we never saw a PR during polling
    if pr_url:
        fallback_link = f"<{pr_url}>"
    else:
        fallback_link = "(PR not yet detected; check workflow run.)"

    total_elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
    total_minutes = int(total_elapsed) // 60
    total_seconds = int(total_elapsed) % 60
    elapsed_line = f"⏱️ Elapsed: {total_minutes}:{total_seconds:02d}"

    await _safe_edit_followup(
        interaction.followup,
        status_msg.id,
        (
            "⚠️ Codex autofix finished polling.\n"
            f"🔗 Workflow: {workflow_link_display}\n"
            f"🔗 Codex PR (best effort): {fallback_link}\n"
            f"{elapsed_line}"
        ),
    )


try:
    client.run(TOKEN)
except Exception as e:
    logger.exception("Bot failed to start", extra={"exception": str(e)})
