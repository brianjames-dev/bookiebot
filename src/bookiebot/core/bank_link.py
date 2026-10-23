from __future__ import annotations

import base64
import asyncio
import hashlib
import hmac
import json
import os
import time
from typing import Any
from urllib.parse import urlencode

from aiohttp import web

from bookiebot.banking.plaid_client import PlaidApiError
from bookiebot.banking.service import build_banking_service


class BankLinkTokenError(ValueError):
    pass


def _signing_secret() -> str:
    return os.getenv("BANK_LINK_SIGNING_SECRET", "").strip() or os.getenv("BANK_TOKEN_ENCRYPTION_KEY", "").strip()


def _plaid_webhook_secret() -> str:
    return os.getenv("PLAID_WEBHOOK_SECRET", "").strip()


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def create_bank_link_setup_token(
    *,
    actor_key: str,
    owner_key: str,
    ttl_seconds: int = 900,
    item_db_id: int | None = None,
) -> str:
    secret = _signing_secret()
    if not secret:
        raise BankLinkTokenError("Bank link signing secret is not configured")
    payload = {
        "actor_key": str(actor_key),
        "owner_key": str(owner_key),
        "exp": int(time.time()) + max(60, int(ttl_seconds)),
    }
    if item_db_id is not None:
        if type(item_db_id) is not int or item_db_id <= 0:
            raise BankLinkTokenError('Invalid bank connection')
        payload['item_db_id'] = str(item_db_id)
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return f"{_b64encode(payload_bytes)}.{_b64encode(signature)}"


def verify_bank_link_setup_token(token: str) -> dict[str, str]:
    secret = _signing_secret()
    if not secret:
        raise BankLinkTokenError("Bank link signing secret is not configured")
    try:
        payload_part, signature_part = token.split(".", 1)
        payload_bytes = _b64decode(payload_part)
        signature = _b64decode(signature_part)
        expected = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise BankLinkTokenError("Bank link token signature is invalid")
        payload = json.loads(payload_bytes.decode("utf-8"))
    except BankLinkTokenError:
        raise
    except Exception as exc:
        raise BankLinkTokenError("Bank link token is invalid") from exc

    if int(payload.get("exp") or 0) < int(time.time()):
        raise BankLinkTokenError("Bank link token has expired")
    actor_key = str(payload.get("actor_key") or "")
    owner_key = str(payload.get("owner_key") or "")
    if not actor_key or not owner_key:
        raise BankLinkTokenError("Bank link token is missing owner data")
    result = {"actor_key": actor_key, "owner_key": owner_key}
    if 'item_db_id' in payload:
        item_id = str(payload['item_db_id'])
        if not item_id.isdecimal() or int(item_id) <= 0:
            raise BankLinkTokenError('Invalid bank connection')
        result['item_db_id'] = item_id
    return result


def bank_reconnect_url(actor_key: str, owner_key: str, item_db_id: int, base_url: str = '') -> str:
    token = create_bank_link_setup_token(actor_key=actor_key, owner_key=owner_key, item_db_id=item_db_id)
    return f"{base_url.rstrip('/')}/bank/link?{urlencode({'token': token})}"


def create_bank_link_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", _health)
    app.router.add_get("/bank/link", _bank_link_page)
    app.router.add_post("/bank/link-token", _bank_link_token)
    app.router.add_post("/bank/exchange-public-token", _bank_exchange_public_token)
    app.router.add_post('/bank/reconnect-complete', _bank_reconnect_complete)
    app.router.add_post("/bank/plaid-webhook", _bank_plaid_webhook)
    return app


async def _health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def _bank_link_page(request: web.Request) -> web.Response:
    token = request.query.get("token", "").strip()
    try:
        data = verify_bank_link_setup_token(token)
    except BankLinkTokenError as exc:
        return web.Response(text=f"Invalid or expired bank link: {exc}", status=400)
    html = _reconnect_page_html(token, complete=request.query.get('complete') == '1') if 'item_db_id' in data else _link_page_html(token)
    return web.Response(text=html, content_type="text/html",
        headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})


async def _bank_link_token(request: web.Request) -> web.Response:
    try:
        token_data = await _verified_request_token(request)
        service = build_banking_service()
        if 'item_db_id' in token_data:
            base_url = (service.config.public_base_url or '').rstrip('/')
            if not base_url:
                return _json_error('Bank reconnect is not configured. Please try again later.', status=503)
            completion = base_url + '/bank/link?' + urlencode({
                'token': (await _request_json(request))['setup_token'], 'complete': '1',
            })
            hosted_url = await service.create_reconnect_link(token_data['owner_key'], int(token_data['item_db_id']), completion)
            return web.json_response({'hosted_link_url': hosted_url}, headers={'Cache-Control': 'no-store'})
        link_token = await service.create_link_token(token_data["owner_key"])
        return web.json_response({"link_token": link_token})
    except web.HTTPException as exc:
        return _json_error(exc.text or exc.reason, status=exc.status)
    except PlaidApiError as exc:
        return _json_error(str(exc), status=502)
    except ValueError as exc:
        return _json_error(str(exc), status=404)
    except Exception as exc:
        return _json_error(f"{type(exc).__name__}: {exc}", status=500)


async def _bank_exchange_public_token(request: web.Request) -> web.Response:
    try:
        token_data = await _verified_request_token(request)
        if 'item_db_id' in token_data:
            return _json_error('Reconnect uses the existing bank connection.', status=400)
        body = await _request_json(request)
        public_token = str(body.get("public_token") or "").strip()
        metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
        institution = metadata.get("institution") if isinstance(metadata, dict) else {}
        institution_name = None
        if isinstance(institution, dict):
            institution_name = str(institution.get("name") or "").strip() or None
        if not public_token:
            return _json_error("Missing public_token", status=400)

        service = build_banking_service()
        item = await service.link_public_token(
            token_data["owner_key"],
            public_token,
            institution_name=institution_name,
        )
        return web.json_response(
            {
                "ok": True,
                "institution_name": item.institution_name,
                "owner_key": item.owner_key,
            }
        )
    except web.HTTPException as exc:
        return _json_error(exc.text or exc.reason, status=exc.status)
    except PlaidApiError as exc:
        return _json_error(str(exc), status=502)
    except Exception as exc:
        return _json_error(f"{type(exc).__name__}: {exc}", status=500)


async def _bank_reconnect_complete(request: web.Request) -> web.Response:
    try:
        data = await _verified_request_token(request)
        if 'item_db_id' not in data:
            return _json_error('Use an existing bank reconnect link.', status=400)
        service = build_banking_service()
        result = await asyncio.wait_for(service.complete_reconnect(data['owner_key'], int(data['item_db_id'])), timeout=60)
        return web.json_response({'ok': True, 'added': result.added, 'modified': result.modified,
                                 'removed': result.removed}, headers={'Cache-Control': 'no-store'})
    except web.HTTPException as exc:
        return _json_error(exc.text or exc.reason, status=exc.status)
    except ValueError as exc:
        return _json_error(str(exc), status=404)
    except Exception:
        return _json_error('Bank sync is not ready yet. Retry checking the connection, or return to Reconcile for a fresh reconnect link.', status=502)


def _reconnect_page_html(setup_token: str, *, complete: bool = False) -> str:
    # Plaid hosts the credential/OAuth screens. Completion never exchanges a
    # public token; the server checks the original Item with its saved token.
    return '''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Reconnect bank · BookieBot</title>
<style>body{font:16px system-ui;margin:0;background:#111318;color:#f4f4f5}main{max-width:520px;margin:12vh auto;padding:24px}button,a{font:inherit;min-height:44px}button{padding:12px 18px;background:#7c3aed;color:white;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.6}p{line-height:1.6}a{color:#c4b5fd}#status{white-space:pre-wrap}</style>
</head><body><main><h1>Reconnect bank</h1><p>Restore your existing read-only bank connection. Your transactions and review history stay in BookieBot. Sign in only on Plaid or your bank’s secure screen.</p>
<button id="connect">Reconnect bank</button><p id="status" role="status" aria-live="polite"></p><p><a href="/app/expenses">Return to BookieBot</a></p></main>
<script>
const setupToken = SETUP_TOKEN;
const complete = IS_COMPLETE;
const button = document.getElementById('connect'), status = document.getElementById('status');
async function post(path) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store', body:JSON.stringify({setup_token:setupToken})});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Could not reconnect. Please try again.');
  return data;
}
async function run() {
  button.disabled = true;
  status.textContent = complete ? 'Checking your bank connection and syncing transactions…' : 'Opening secure Plaid reconnect…';
  try {
    if (complete) {
      await post('/bank/reconnect-complete');
      status.textContent = 'Bank reconnected. Transaction sync succeeded. New bank activity may take a few minutes to arrive. Return to Reconcile and tap Check for matches.';
      button.hidden = true;
    } else {
      const result = await post('/bank/link-token');
      const url = new URL(result.hosted_link_url);
      if (url.protocol !== 'https:' || url.hostname !== 'secure.plaid.com') throw Error('Invalid Plaid reconnect link.');
      window.location.assign(url.href);
    }
  } catch (error) { status.textContent = error.message; button.disabled = false; }
}
button.textContent = complete ? 'Retry checking connection' : 'Reconnect bank';
button.addEventListener('click', run);
if (complete) run();
</script></body></html>'''.replace('SETUP_TOKEN', json.dumps(setup_token)).replace('IS_COMPLETE', json.dumps(complete))


async def _bank_plaid_webhook(request: web.Request) -> web.Response:
    try:
        secret = _plaid_webhook_secret()
        if secret:
            supplied = request.headers.get("X-BookieBot-Webhook-Secret", "").strip()
            supplied = supplied or request.query.get("secret", "").strip()
            if not hmac.compare_digest(supplied, secret):
                return _json_error("Invalid webhook secret", status=401)
        body = await _request_json(request)
        service = build_banking_service()
        event = service.receive_plaid_webhook(body)
        return web.json_response({"ok": True, "event_id": event.id})
    except Exception as exc:
        return _json_error(f"{type(exc).__name__}: {exc}", status=500)


async def _verified_request_token(request: web.Request) -> dict[str, str]:
    body = await _request_json(request)
    token = str(body.get("setup_token") or "").strip()
    try:
        return verify_bank_link_setup_token(token)
    except BankLinkTokenError as exc:
        raise web.HTTPUnauthorized(text=str(exc)) from exc


async def _request_json(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise web.HTTPBadRequest(text="Invalid JSON") from exc
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON body must be an object")
    return body


def _json_error(message: str, *, status: int) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _link_page_html(setup_token: str) -> str:
    safe_token = json.dumps(setup_token)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BookieBot Bank Link</title>
  <style>
    body {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #111318; color: #f4f4f5; }}
    main {{ max-width: 560px; margin: 12vh auto; padding: 0 24px; }}
    button {{ font: inherit; padding: 10px 14px; border: 0; border-radius: 6px; background: #7c3aed; color: white; cursor: pointer; }}
    button:disabled {{ opacity: .6; cursor: wait; }}
    .status {{ margin-top: 18px; color: #d4d4d8; white-space: pre-wrap; }}
  </style>
</head>
<body>
  <main>
    <h1>Connect Bank To BookieBot</h1>
    <p>This creates a read-only Plaid connection for transactions and account balances.</p>
    <button id="connect">Connect bank</button>
    <div id="status" class="status"></div>
  </main>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const setupToken = {safe_token};
    const button = document.getElementById('connect');
    const status = document.getElementById('status');
    function setStatus(text) {{ status.textContent = text; }}
    async function postJson(path, body) {{
      const response = await fetch(path, {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify(body)
      }});
      const text = await response.text();
      let data = {{}};
      if (text) {{
        try {{
          data = JSON.parse(text);
        }} catch (_error) {{
          data = {{ error: text }};
        }}
      }}
      if (!response.ok) throw new Error(data.error || text || 'Request failed');
      return data;
    }}
    button.addEventListener('click', async () => {{
      button.disabled = true;
      setStatus('Creating Plaid Link session...');
      try {{
        const tokenData = await postJson('/bank/link-token', {{ setup_token: setupToken }});
        const handler = Plaid.create({{
          token: tokenData.link_token,
          onSuccess: async (public_token, metadata) => {{
            setStatus('Saving bank connection...');
            await postJson('/bank/exchange-public-token', {{
              setup_token: setupToken,
              public_token,
              metadata
            }});
            setStatus('Bank connected. You can close this window and return to Discord.');
            button.style.display = 'none';
          }},
          onExit: (err) => {{
            button.disabled = false;
            setStatus(err ? ('Plaid Link exited: ' + err.display_message) : 'Plaid Link closed.');
          }}
        }});
        handler.open();
      }} catch (error) {{
        button.disabled = false;
        setStatus('Error: ' + error.message);
      }}
    }});
  </script>
</body>
</html>
"""
