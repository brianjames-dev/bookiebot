from __future__ import annotations

import os
from pathlib import Path
import re
from urllib.parse import quote

from aiohttp import web


_REPORT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.html$")


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


def register_report_routes(app: web.Application) -> None:
    app.router.add_get("/reports/{name}", _serve_report)


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

    return web.FileResponse(
        path,
        headers={"Cache-Control": "private, max-age=86400"},
    )

