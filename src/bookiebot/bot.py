import asyncio
import discord
import logging
import os
import json
import urllib.request
from urllib.error import URLError, HTTPError
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


async def _poll_for_pr(branch_prefix: str, *, attempts: int = 10, delay_seconds: float = 6.0) -> str | None:
    """
    Poll GitHub for the newest open PR whose head branch starts with branch_prefix.
    Best-effort; returns the PR URL or None.
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
@app_commands.describe(lines="Number of lines to return (default 200, max 2000)", level="Optional level filter (INFO/WARN/ERROR)", contains="Optional substring filter")
async def debug_logs(interaction: discord.Interaction, lines: int = 200, level: str | None = None, contains: str | None = None):
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

    await interaction.response.defer(ephemeral=True)
    ok, msg, pr_url = await trigger_codex_autofix(payload)
    if not ok:
        await interaction.followup.send(f"❌ Could not dispatch Codex autofix: {msg}", ephemeral=True)
        return

    workflow_link = f"https://github.com/{GITHUB_REPO}/actions/workflows/codex-autofix.yml" if GITHUB_REPO else "Workflow link unavailable."
    text = f"✅ Sent incident to Codex autofix.\n🔗 Workflow: {workflow_link}"
    await interaction.followup.send(text, ephemeral=True, suppress_embeds=True)

    # Best-effort poll for the PR using the branch prefix used in the workflow.
    branch_prefix = f"codex/autofix-"
    pr_url_polled = await _poll_for_pr(branch_prefix)
    if pr_url_polled:
        await interaction.followup.send(f"🔗 Codex PR: {pr_url_polled}", ephemeral=True, suppress_embeds=True)
    elif pr_url:
        await interaction.followup.send(f"🔗 Codex PR (best effort): {pr_url}", ephemeral=True, suppress_embeds=True)

try:
    client.run(TOKEN)
except Exception as e:
    logger.exception("Bot failed to start", extra={"exception": str(e)})
