import json
import urllib.request
from urllib.error import URLError, HTTPError
import os

from bookiebot.logging_config import uptime_seconds
from bookiebot.core import config
import discord


def current_build_env() -> tuple[str, str]:
    git_sha = os.getenv("GIT_SHA") or os.getenv("RAILWAY_GIT_COMMIT_SHA") or "unknown"
    env_name = os.getenv("BOT_ENV") or os.getenv("ENV") or "unknown"
    return git_sha, env_name


def build_incident_payload(
    summary: str,
    requester: discord.abc.User,
    channel: object | None,
    logs: list[str],
    intent: str | None = None,
    entities: dict | None = None,
) -> dict:
    git_sha, env_name = current_build_env()
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


async def post_to_agent(client, payload: dict) -> tuple[bool, str, dict]:
    """
    Send a JSON payload to the configured agent endpoint.
    Returns (ok, message, response_json).
    """
    if not config.AGENT_ENDPOINT:
        return False, "No DEBUG_AGENT_ENDPOINT configured.", {}

    headers = {"Content-Type": "application/json"}
    if config.AGENT_API_KEY:
        headers["Authorization"] = f"Bearer {config.AGENT_API_KEY}"

    data = json.dumps(payload).encode("utf-8")

    def _send():
        req = urllib.request.Request(config.AGENT_ENDPOINT, data=data, headers=headers, method="POST")
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
