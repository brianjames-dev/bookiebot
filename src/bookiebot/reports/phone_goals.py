"""Authenticated personal savings goal API; no bank or sheet mutations."""
from __future__ import annotations

import asyncio
import json
import logging

from aiohttp import web

from bookiebot.reports.goals_store import (
    GoalConflictError, GoalNotFoundError, GoalValidationError, build_goals_store,
)

logger = logging.getLogger(__name__)


async def _goals(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action, _session

    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Make savings goal changes from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        if request.method == "POST":
            if request.content_length is not None and request.content_length > 4096:
                raise GoalValidationError("Savings goal request is too large.")
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 4096:
                    raise GoalValidationError("Savings goal request is too large.")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise GoalValidationError("Invalid savings goal request.")
            from bookiebot.reports.savings_transfers import can_archive_goal, goal_payload
            def command_goal():
                store = build_goals_store()
                before_archive = None
                if body.get('operation') == 'archive':
                    from bookiebot.reports.bill_settings import _commands
                    commands = _commands(store.access)
                    before_archive = lambda owner, identity: can_archive_goal(session.actor_key, owner, identity, commands=commands)
                value = store.command(session.owner_key, body, before_archive=before_archive)
                enriched = goal_payload(session.actor_key, {'goals': [value['goal']]})
                return {**value, 'goal': enriched['goals'][0]}
            result = await asyncio.to_thread(command_goal)
        elif "goal_id" in request.match_info:
            try:
                offset = int(request.query.get("offset", "0"))
            except ValueError as exc:
                raise GoalValidationError("Invalid history page.") from exc
            from bookiebot.reports.savings_transfers import goal_history
            result = await asyncio.to_thread(lambda: goal_history(session.actor_key, session.owner_key,
                request.match_info['goal_id'], offset, store=build_goals_store()))
        else:
            result = await asyncio.to_thread(lambda: build_goals_store().list_goals(session.owner_key))
            from bookiebot.reports.savings_transfers import goal_payload
            result = await asyncio.to_thread(goal_payload, session.actor_key, result)
        current = await _session(request)
        if current is None or current.owner_key != session.owner_key:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        return _json(result)
    except (GoalValidationError, ValueError, TypeError) as error:
        # Validation errors contain only controlled messages, never user input.
        return _json({"error": str(error) if isinstance(error, GoalValidationError) else "Invalid savings goal request."}, status=400)
    except GoalNotFoundError as exc:
        return _json({"error": str(exc)}, status=404)
    except GoalConflictError as exc:
        return _json({"error": str(exc)}, status=409)
    except Exception:
        logger.exception("Could not process savings goal request")
        return _json({"error": "Savings goals are temporarily unavailable. Please try again."}, status=503)


def register_phone_goal_routes(app: web.Application) -> None:
    app.router.add_get("/app/goals", _goals)
    app.router.add_post("/app/goals", _goals)
    app.router.add_get("/app/goals/{goal_id}/contributions", _goals)
