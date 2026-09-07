from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib.parse import quote

from aiohttp import web


_REPORT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.html$")
_EPHEMERAL_REPORT_SECRET = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
_COMPARISON_HANDOFF_SECONDS = 10


class _ReportBuildBusy(RuntimeError):
    pass


class _ReportBuilds:
    """Bound live reads; hand just-completed data to an adjacent comparison."""

    def __init__(self) -> None:
        try:
            limit = max(1, min(8, int(os.getenv("BOOKIEBOT_REPORT_MAX_CONCURRENT_BUILDS", "2"))))
        except ValueError:
            limit = 2
        self._semaphore = asyncio.Semaphore(limit)
        self._capacity = limit * 4
        self._tasks: dict[tuple, asyncio.Task[Any]] = {}
        self._comparison_handoffs: dict[tuple, tuple[float, dict[str, Any]]] = {}

    async def render(self, payload: dict) -> str:
        return await self._submit(payload, "html")

    async def data(self, payload: dict) -> dict[str, Any]:
        return await self._submit(payload, "data")

    async def catalog(self, payload: dict) -> dict[str, Any]:
        return await self._submit(payload, "catalog")

    async def comparison_data(self, payload: dict) -> dict[str, Any]:
        key = self._key(payload, "data")
        # A newer refresh always takes precedence, including its failure.
        if key in self._tasks:
            return await self.data(payload)
        self._prune_handoffs()
        handoff = self._comparison_handoffs.get(key)
        if handoff is not None:
            return handoff[1]
        return await self.data(payload)

    @staticmethod
    def _key(payload: dict, representation: str) -> tuple:
        return (
            representation,
            str(payload["actor_key"]),
            str(payload["owner_name"]),
            tuple(sorted(str(person) for person in payload["persons"])),
            int(payload["year"]),
            int(payload["month"]),
        )

    def _prune_handoffs(self) -> None:
        cutoff = time.monotonic() - _COMPARISON_HANDOFF_SECONDS
        for key, (created, _) in list(self._comparison_handoffs.items()):
            if created <= cutoff:
                self._comparison_handoffs.pop(key, None)

    async def _submit(self, payload: dict, representation: str) -> Any:
        key = self._key(payload, representation)
        task = self._tasks.get(key)
        if task is None:
            # Direct refresh never reads a handoff or falls back to an old one.
            self._comparison_handoffs.pop(key, None)
            if len(self._tasks) >= self._capacity:
                raise _ReportBuildBusy("Report refresh is busy. Please try again shortly.")
            task = asyncio.create_task(self._render(payload, representation))
            self._tasks[key] = task
            task.add_done_callback(lambda completed: self._finished(key, completed))
        # An HTTP disconnect must not cancel another request's shared build or
        # release its concurrency slot while the worker thread is still running.
        return await asyncio.shield(task)

    async def _render(self, payload: dict, representation: str = "html") -> Any:
        async with self._semaphore:
            renderer = (_render_live_report_catalog if representation == "catalog"
                        else _render_live_report_data if representation == "data" else _render_live_report)
            return await asyncio.to_thread(renderer, payload)

    def _finished(self, key: tuple, task: asyncio.Task[Any]) -> None:
        self._tasks.pop(key, None)
        if not task.cancelled():
            error = task.exception()  # Retrieve failures even if every requester disconnected.
            if error is None and key[0] == "data":
                self._prune_handoffs()
                self._comparison_handoffs[key] = (time.monotonic(), task.result())
                while len(self._comparison_handoffs) > self._capacity:
                    self._comparison_handoffs.pop(next(iter(self._comparison_handoffs)))

    async def close(self) -> None:
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._comparison_handoffs.clear()


_REPORT_BUILDS = web.AppKey("bookiebot_report_builds", _ReportBuilds)


def _render_live_report(payload: dict) -> str:
    from bookiebot.reports.expense_breakdown import BudgetMonth, build_expense_breakdown_report, render_expense_breakdown_html
    from bookiebot.sheets.routing import sheet_user_context

    actor_key = str(payload["actor_key"])
    with sheet_user_context(actor_key):
        report = build_expense_breakdown_report(
            actor_key=actor_key,
            owner_name=str(payload["owner_name"]),
            persons=[str(person) for person in payload["persons"]],
            month=BudgetMonth(int(payload["year"]), int(payload["month"])),
        )
        return render_expense_breakdown_html(report)


def _render_live_report_data(payload: dict) -> dict[str, Any]:
    from bookiebot.reports.expense_breakdown import BudgetMonth, build_expense_breakdown_report, expense_breakdown_client_payload
    from bookiebot.sheets.routing import sheet_user_context

    actor_key = str(payload["actor_key"])
    with sheet_user_context(actor_key):
        report = build_expense_breakdown_report(
            actor_key=actor_key,
            owner_name=str(payload["owner_name"]),
            persons=[str(person) for person in payload["persons"]],
            month=BudgetMonth(int(payload["year"]), int(payload["month"])),
        )
        return expense_breakdown_client_payload(report)


def _render_live_report_catalog(payload: dict) -> dict[str, Any]:
    from datetime import datetime
    from bookiebot.reports.phone_history import load_phone_month_catalog
    from bookiebot.sheets.routing import PACIFIC_TZ
    return load_phone_month_catalog(str(payload["actor_key"]), current=datetime(
        int(payload["year"]), int(payload["month"]), 1, tzinfo=PACIFIC_TZ))


async def _close_report_builds(app: web.Application) -> None:
    await app[_REPORT_BUILDS].close()


def reports_dir() -> Path:
    return Path(os.getenv("BOOKIEBOT_REPORT_DIR", "data/reports")).resolve()


def public_base_url() -> str:
    explicit = os.getenv("BOOKIEBOT_PUBLIC_BASE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")

    domain = (
        os.getenv("RAILWAY_PUBLIC_DOMAIN", "").strip()
        or os.getenv("RAILWAY_STATIC_URL", "").strip()
        or os.getenv("PUBLIC_BASE_URL", "").strip()
    )
    if domain:
        if domain.startswith(("http://", "https://")):
            return domain.rstrip("/")
        return f"https://{domain.rstrip('/')}"

    port = os.getenv("PORT", "8080").strip() or "8080"
    return f"http://localhost:{port}"


def public_report_url(filename: str, *, token: str) -> str:
    return f"{public_base_url()}/reports/{quote(filename)}?token={quote(token)}"


def public_expense_report_url(token: str) -> str:
    return f"{public_base_url()}/reports/expense-breakdown?token={quote(token)}"


def create_expense_report_token(
    *,
    actor_key: str,
    owner_name: str,
    persons: list[str],
    year: int,
    month: int,
    filename: str | None = None,
    ttl_seconds: int = 604800,
) -> str:
    payload = {
        "actor_key": str(actor_key),
        "owner_name": str(owner_name),
        "persons": [str(person) for person in persons],
        "year": int(year),
        "month": int(month),
        "exp": int(time.time()) + max(60, int(ttl_seconds)),
    }
    if filename:
        payload["filename"] = str(filename)
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(_report_secret().encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return f"{_b64encode(payload_bytes)}.{_b64encode(signature)}"


def register_report_routes(app: web.Application) -> None:
    from bookiebot.reports.phone_app import register_phone_app_routes

    app[_REPORT_BUILDS] = _ReportBuilds()
    app.on_cleanup.append(_close_report_builds)
    app.router.add_get("/reports/expense-breakdown", _serve_expense_breakdown_report)
    app.router.add_get("/reports/{name}", _serve_report)
    register_phone_app_routes(app)


async def _serve_expense_breakdown_report(request: web.Request) -> web.StreamResponse:
    token = request.query.get("token", "").strip()
    try:
        payload = _verify_expense_report_token(token)
    except ValueError as exc:
        raise web.HTTPNotFound(text=str(exc)) from exc

    snapshot_path = _static_report_path_for_request(payload, request.query)
    if snapshot_path is not None:
        return _report_file_response(snapshot_path)

    try:
        html = await request.app[_REPORT_BUILDS].render(payload)
        return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "private, no-store"})
    except web.HTTPException:
        raise
    except _ReportBuildBusy as exc:
        snapshot_path = _static_report_path_for_payload(payload)
        if snapshot_path is not None:
            return _report_file_response(snapshot_path)
        raise web.HTTPServiceUnavailable(text=str(exc), headers={"Retry-After": "5"}) from exc
    except Exception as exc:
        snapshot_path = _static_report_path_for_payload(payload)
        if snapshot_path is not None:
            return _report_file_response(snapshot_path)
        raise web.HTTPInternalServerError(text=f"Could not render expense report: {type(exc).__name__}: {exc}") from exc


async def _serve_report(request: web.Request) -> web.StreamResponse:
    name = request.match_info.get("name", "")
    if not _REPORT_NAME_RE.fullmatch(name):
        raise web.HTTPNotFound()

    try:
        payload = _verify_expense_report_token(request.query.get("token", "").strip())
    except ValueError as exc:
        raise web.HTTPNotFound(text=str(exc)) from exc
    if payload.get("filename") != name:
        raise web.HTTPNotFound()
    path = _safe_report_path(name)
    if path is None or not path.is_file():
        raise web.HTTPNotFound()

    return _report_file_response(path)


def _report_file_response(path: Path) -> web.FileResponse:
    return web.FileResponse(
        path,
        headers={"Cache-Control": "private, no-store"},
    )


def _verify_expense_report_token(token: str) -> dict:
    if not token:
        raise ValueError("Missing report token")
    try:
        payload_part, signature_part = token.split(".", 1)
        payload_bytes = _b64decode(payload_part)
        supplied_signature = _b64decode(signature_part)
    except Exception as exc:
        raise ValueError("Invalid report token") from exc

    expected_signature = hmac.new(_report_secret().encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise ValueError("Invalid report token signature")

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception as exc:
        raise ValueError("Invalid report token payload") from exc

    if int(payload.get("exp") or 0) < int(time.time()):
        raise ValueError("Report link expired")
    if not payload.get("actor_key") or not payload.get("owner_name") or not payload.get("persons"):
        raise ValueError("Report token is missing required context")
    return payload


def _static_report_path_for_payload(payload: dict) -> Path | None:
    filename = str(payload.get("filename") or "").strip()
    if filename:
        exact = _safe_report_path(filename)
        if exact is not None and exact.is_file():
            return exact

    return _latest_matching_expense_report_path(payload)


def _static_report_path_for_request(payload: dict, query: Any) -> Path | None:
    if _live_expense_report_requested(query):
        return None
    if _is_current_expense_report_payload(payload) and not _snapshot_expense_report_requested(query):
        return None
    return _static_report_path_for_payload(payload)


def _live_expense_report_requested(query: Any) -> bool:
    value = str(query.get("live", "") if hasattr(query, "get") else "").strip().lower()
    return value in {"1", "true", "yes", "y"}


def _snapshot_expense_report_requested(query: Any) -> bool:
    value = str(query.get("snapshot", "") if hasattr(query, "get") else "").strip().lower()
    return value in {"1", "true", "yes", "y"}


def _is_current_expense_report_payload(payload: dict) -> bool:
    try:
        year = int(payload["year"])
        month = int(payload["month"])
    except (KeyError, TypeError, ValueError):
        return False
    try:
        from bookiebot.sheets.routing import now_pacific

        current = now_pacific()
    except Exception:
        return False
    return year == current.year and month == current.month


def _safe_report_path(filename: str) -> Path | None:
    if not _REPORT_NAME_RE.fullmatch(filename):
        return None
    root = reports_dir()
    path = (root / filename).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path


def _latest_matching_expense_report_path(payload: dict) -> Path | None:
    try:
        year = int(payload["year"])
        month = int(payload["month"])
    except (KeyError, TypeError, ValueError):
        return None

    owner = _expense_report_owner_slug(str(payload.get("owner_name") or ""))
    prefix = f"expense-breakdown-{owner}-{year}-{month:02d}-"
    matches = [
        path
        for path in reports_dir().glob(f"{prefix}*.html")
        if _REPORT_NAME_RE.fullmatch(path.name) and path.is_file()
    ]
    if not matches:
        return None
    return max(matches, key=lambda path: path.stat().st_mtime)


def _expense_report_owner_slug(owner_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", owner_name.lower()).strip("-") or "budget"


def _report_secret() -> str:
    return (
        os.getenv("BOOKIEBOT_REPORT_SIGNING_SECRET", "").strip()
        or os.getenv("BANK_LINK_SIGNING_SECRET", "").strip()
        or os.getenv("BANK_TOKEN_ENCRYPTION_KEY", "").strip()
        or os.getenv("DISCORD_TOKEN", "").strip()
        or _EPHEMERAL_REPORT_SECRET
    )


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)
