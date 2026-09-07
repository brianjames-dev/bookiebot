"""Public frontend fingerprint; contains no account or financial information."""
from __future__ import annotations

from functools import lru_cache
import hashlib
from pathlib import Path
from aiohttp import web


@lru_cache(maxsize=1)
def frontend_version() -> str:
    assets = Path(__file__).with_name('assets')
    digest = hashlib.sha256()
    for name in ('expense-report-app.js', 'expense-report-app.css', 'phone-setup.js'):
        digest.update(name.encode())
        digest.update((assets / name).read_bytes())
    return digest.hexdigest()[:24]


async def app_version(_request: web.Request) -> web.Response:
    return web.json_response({'version':frontend_version()}, headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})
