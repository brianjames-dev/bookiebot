"""Authenticated and bounded read-only questions about the phone report."""
from __future__ import annotations

import asyncio
from collections import deque
import json
import logging
import time
from typing import Any
from aiohttp import web

from bookiebot.reports.phone_history import available_phone_month, phone_report_payload, InvalidReportMonthError, UnavailableReportMonthError
from bookiebot.reports.report_questions import answer_report_question

logger = logging.getLogger(__name__)
_STATE = web.AppKey('phone_questions', dict)


async def _ask(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _same_origin_action, _json
    from bookiebot.reports.web import _REPORT_BUILDS
    if not _same_origin_action(request):
        return _json({'error':'Ask from your BookieBot app.'}, status=403)
    owner: str | None = None
    active: set[str] = request.app[_STATE]['active']
    try:
        session = await _session(request)
        if session is None:
            return _json({'error':'Reconnect using /expense_app in Discord.'}, status=401)
        if request.content_length and request.content_length > 12000:
            return _json({'error':'Keep your question under 2,000 characters.'}, status=400)
        raw = bytearray()
        async for chunk in request.content.iter_chunked(2048):
            raw.extend(chunk)
            if len(raw) > 12000:
                return _json({'error':'Keep your question under 2,000 characters.'}, status=400)
        body = json.loads(raw)
        if not isinstance(body, dict) or set(body)-{'question','mode','month'}:
            raise ValueError('Invalid question request.')
        question, mode = body.get('question'), body.get('mode')
        if not isinstance(question, str) or not question.strip() or len(question) > 2000 or not isinstance(mode, str) or mode not in {'current','projected'}:
            raise ValueError('Enter a question up to 2,000 characters and choose Current or Projected.')
        raw_month = body.get('month')
        if raw_month is not None and not isinstance(raw_month, str):
            raise ValueError('Invalid report month.')
        now = time.monotonic()
        requests: dict[str, deque[float]] = request.app[_STATE]['requests']
        for key in list(requests):
            while requests[key] and now-requests[key][0] >= 60:
                requests[key].popleft()
            if not requests[key]:
                del requests[key]
        recent = requests.setdefault(session.owner_key, deque())
        if session.owner_key in active or len(active) >= 2 or len(recent) >= 4:
            response = _json({'error':'Please wait a moment before asking another question.'}, status=429)
            response.headers['Retry-After']='15'
            return response
        owner = session.owner_key
        active.add(owner)
        recent.append(now)
        month = await available_phone_month(request, session, raw_month)
        payload = await request.app[_REPORT_BUILDS].data(phone_report_payload(session, month))
        # Read authorization again before sharing a report with the existing AI provider.
        if await _session(request) != session:
            return _json({'error':'Reconnect using /expense_app in Discord.'}, status=401)
        result = await answer_report_question(question.strip(), payload, mode)
        if await _session(request) != session:
            return _json({'error':'Reconnect using /expense_app in Discord.'}, status=401)
        return _json(result)
    except UnavailableReportMonthError as exc:
        return _json({'error':str(exc)}, status=404)
    except (ValueError, InvalidReportMonthError):
        return _json({'error':'Enter a valid question and available report month.'}, status=400)
    except asyncio.CancelledError:
        raise
    except Exception:
        # Provider/validation exceptions may contain report values or the user's
        # prompt. Keep failures observable without recording their contents.
        logger.warning('Phone report question unavailable')
        return _json({'error':'BookieBot could not answer right now. Your report is still available; please try again.'}, status=503)
    finally:
        if owner is not None:
            active.discard(owner)


def register_phone_question_routes(app: web.Application) -> None:
    app[_STATE] = {'active':set(), 'requests':{}}
    app.router.add_post('/app/expenses/ask', _ask)
