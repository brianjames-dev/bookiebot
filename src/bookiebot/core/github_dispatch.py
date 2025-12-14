import aiohttp
from datetime import datetime
import logging
from typing import Tuple

from bookiebot.core import config

logger = logging.getLogger(__name__)


async def fetch_latest_pr() -> str | None:
    """
    Best-effort: fetch the latest open PR URL (used only for fallback messaging).
    """
    if not config.GITHUB_DISPATCH_TOKEN or not config.GITHUB_REPO:
        return None
    url = f"{config.GITHUB_API_BASE}/repos/{config.GITHUB_REPO}/pulls?state=open&sort=created&direction=desc&per_page=1"
    headers = {
        "Authorization": f"token {config.GITHUB_DISPATCH_TOKEN}",
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


async def find_latest_workflow_run(started_after: datetime) -> tuple[int | None, str | None, str | None]:
    """
    Best-effort: find the latest codex-autofix workflow run created after started_after.
    Returns (run_id, status, html_url).
    """
    if not config.GITHUB_DISPATCH_TOKEN or not config.GITHUB_REPO:
        return None, None, None

    url = f"{config.GITHUB_API_BASE}/repos/{config.GITHUB_REPO}/actions/workflows/codex-autofix.yml/runs?event=repository_dispatch&per_page=5"
    headers = {
        "Authorization": f"token {config.GITHUB_DISPATCH_TOKEN}",
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


async def fetch_run_step_status(run_id: int) -> tuple[str | None, str | None]:
    """
    Return (run_status, step_label) for the run's primary job, best-effort.
    """
    if not config.GITHUB_DISPATCH_TOKEN or not config.GITHUB_REPO:
        return None, None

    url = f"{config.GITHUB_API_BASE}/repos/{config.GITHUB_REPO}/actions/runs/{run_id}/jobs?per_page=20"
    headers = {
        "Authorization": f"token {config.GITHUB_DISPATCH_TOKEN}",
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
    if not config.GITHUB_DISPATCH_TOKEN or not config.GITHUB_REPO or not config.GITHUB_DISPATCH_EVENT:
        return False, "GITHUB_DISPATCH_TOKEN, GITHUB_REPO, or GITHUB_DISPATCH_EVENT not configured.", None

    url = f"{config.GITHUB_API_BASE}/repos/{config.GITHUB_REPO}/dispatches"
    body = {
        "event_type": config.GITHUB_DISPATCH_EVENT,
        "client_payload": {
            "incident": incident_payload,
            "summary": incident_payload.get("summary"),
        },
    }
    headers = {
        "Authorization": f"token {config.GITHUB_DISPATCH_TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "codex-autofix-dispatch-bot",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body, headers=headers) as resp:
                if resp.status == 204:
                    pr_url = await fetch_latest_pr()
                    return True, "Dispatch created.", pr_url
                text = await resp.text()
                logger.error("GitHub dispatch failed: %s %s", resp.status, text)
                return False, f"GitHub dispatch failed ({resp.status}): {text}", None
    except Exception as e:
        logger.exception("Dispatch exception", extra={"exception": str(e)})
        return False, f"Exception during dispatch: {e}", None


async def find_pr_for_branch(branch_prefix: str, created_after: datetime | None = None) -> str | None:
    """
    Single-attempt check for an open PR whose branch starts with the given prefix.
    If created_after is provided, only consider PRs created at or after that timestamp.
    """
    if not config.GITHUB_DISPATCH_TOKEN or not config.GITHUB_REPO:
        return None

    url = f"{config.GITHUB_API_BASE}/repos/{config.GITHUB_REPO}/pulls?state=open&sort=created&direction=desc&per_page=5"
    headers = {
        "Authorization": f"token {config.GITHUB_DISPATCH_TOKEN}",
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
                            try:
                                created_at = datetime.fromisoformat(
                                    created_at_str.replace("Z", "+00:00")
                                )
                            except Exception:
                                created_at = None

                            if created_at and created_at < created_after:
                                continue

                        return pr.get("html_url")
    except Exception:
        return None
    return None
