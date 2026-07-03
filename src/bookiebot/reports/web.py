from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import quote

from aiohttp import web


_REPORT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.html$")
_EPHEMERAL_REPORT_SECRET = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")


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


def public_report_url(filename: str) -> str:
    return f"{public_base_url()}/reports/{quote(filename)}"


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
    app.router.add_get("/reports/expense-breakdown", _serve_expense_breakdown_report)
    app.router.add_get("/reports/{name}", _serve_report)


async def _serve_expense_breakdown_report(request: web.Request) -> web.Response:
    token = request.query.get("token", "").strip()
    try:
        payload = _verify_expense_report_token(token)
    except ValueError as exc:
        raise web.HTTPNotFound(text=str(exc)) from exc

    try:
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
        return web.Response(text=render_expense_breakdown_html(report), content_type="text/html")
    except web.HTTPException:
        raise
    except Exception as exc:
        snapshot_path = _static_report_path_for_payload(payload)
        if snapshot_path is not None:
            return _report_file_response(snapshot_path)
        raise web.HTTPInternalServerError(text=f"Could not render expense report: {type(exc).__name__}: {exc}") from exc


async def _serve_report(request: web.Request) -> web.StreamResponse:
    name = request.match_info.get("name", "")
    if not _REPORT_NAME_RE.fullmatch(name):
        raise web.HTTPNotFound()

    path = (reports_dir() / name).resolve()
    root = reports_dir()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise web.HTTPNotFound() from exc
    if not path.is_file():
        raise web.HTTPNotFound()

    return _report_file_response(path)


def _report_file_response(path: Path) -> web.FileResponse:
    return web.FileResponse(
        path,
        headers={"Cache-Control": "private, max-age=86400"},
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
