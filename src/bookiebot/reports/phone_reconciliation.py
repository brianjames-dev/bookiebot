"""Phone review of existing bank/log records. Never imports or edits sheet amounts."""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from datetime import timedelta
import hashlib
import json
import logging
from typing import Any, Literal, cast

from aiohttp import web

from bookiebot.banking.models import BankTransaction, ReconciliationItem
from bookiebot.banking.reconciliation import (
    ActionLogCandidate, claimed_schedule_action_ids, find_action_log_candidates, find_scheduled_pull_candidates,
)
from bookiebot.banking.service import (
    BankingService, _reconciliation_max_age_days, _scheduled_pulls_for_transactions,
    build_banking_service, clear_schedule_source_cache, read_active_logged_actions,
)
from bookiebot.sheets.routing import now_pacific

logger = logging.getLogger(__name__)
_LIMIT = 200
_checks: dict[str, asyncio.Task] = {}


class ReviewConflict(ValueError):
    pass


class ReviewValidation(ValueError):
    pass


class ReviewNotFound(LookupError):
    pass


def _cutoff() -> str:
    return (now_pacific().date() - timedelta(days=_reconciliation_max_age_days())).isoformat()


def _enabled(service: BankingService, owner: str) -> bool:
    if not service.config.configured:
        return False
    active = {item.id for item in service.linked_items(owner) if item.status == "active"}
    return any(account.watched and account.item_id in active for account in service.accounts(owner))


def _version(transaction: BankTransaction, item: ReconciliationItem | None, suggestions: list | None = None) -> str:
    # Includes the reviewed candidate values as well as the bank/item state. A
    # phone cannot confirm a row that changed while its review was left open.
    payload = [asdict(transaction), asdict(item) if item else None, suggestions]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _row(transaction: BankTransaction, item: ReconciliationItem | None) -> dict[str, Any]:
    status = "pending" if transaction.pending else (
        "ignored" if item and item.status == "ignored" else
        "checked" if item and item.status in {"matched", "confirmed"} else "needs_review"
    )
    account = transaction.account_name or "Bank account"
    if transaction.account_mask:
        account += f" · {transaction.account_mask}"
    recovering = bool(item and item.status == "import_requested")
    return {
        "id": item.id if item else -transaction.id,
        "version": _version(transaction, item), "status": status,
        "date": transaction.date or transaction.authorized_date or "",
        "merchant": transaction.merchant_name or transaction.name,
        "amountCents": round(transaction.amount * 100), "currency": "USD",
        "accountLabel": account, "suggestions": [],
        "needsCheck": not transaction.pending and item is None,
        "readOnly": recovering,
        "matchLabel": (
            "Import needs recovery in BookieBot" if recovering else
            "Matches logged entry" if item and item.matched_action_log_id else
            "Matches scheduled payment" if item and item.matched_sheet_ref else
            "Transfer or account payment" if item and item.classification == "transfer_or_payment" else None
        ),
        "matchedSuggestionId": item.matched_action_log_id if item else None,
    }


def _records(service: BankingService, owner: str):
    transactions = service.store.review_transactions(owner, start_date=_cutoff(), limit=_LIMIT)
    items = service.store.review_reconciliation_items(owner, start_date=_cutoff(), limit=_LIMIT)
    return transactions, {item.bank_transaction_id: item for item in items}


def snapshot(service: BankingService, owner: str) -> dict[str, Any]:
    if not _enabled(service, owner):
        return {"enabled": False, "checkedAt": None, "items": []}
    transactions, by_transaction = _records(service, owner)
    sync = service.store.review_sync_status(owner)
    result: dict[str, Any] = {
        "enabled": True, "checkedAt": sync["checkedAt"],
        "items": [_row(transaction, by_transaction.get(transaction.id)) for transaction in transactions],
    }
    if sync["syncFailed"]:
        result["notice"] = "Bank sync is delayed. Showing the last available transactions."
    elif len(transactions) >= _LIMIT:
        result["notice"] = f"Showing the latest {_LIMIT} transactions."
    return result


def _find(service: BankingService, owner: str, review_id: int):
    transactions, by_transaction = _records(service, owner)
    for transaction in transactions:
        item = by_transaction.get(transaction.id)
        if (item.id if item else -transaction.id) == review_id:
            return transaction, item
    raise ReviewNotFound("This transaction is no longer available. Check again.")


def _suggestion(candidate: ActionLogCandidate, transaction: BankTransaction) -> dict[str, Any]:
    amount = round(candidate.amount * 100)
    recorded = candidate.amount_recorded
    return {
        "id": candidate.action_id, "item": candidate.label,
        "date": candidate.date.isoformat(), "amountCents": amount,
        "category": candidate.action_type.replace("_", " ").title(),
        "amountMismatch": amount != round(abs(transaction.amount) * 100),
        "kind": "schedule" if candidate.action_type == "schedule" else "recorded",
        "recorded": recorded,
        "confirmable": recorded and not transaction.pending and amount == round(abs(transaction.amount) * 100),
    }


def detail(service: BankingService, owner: str, actor: str, review_id: int):
    transaction, item = _find(service, owner, review_id)
    row = _row(transaction, item)
    candidates: list[ActionLogCandidate] = []
    if row["status"] in {"needs_review", "pending"} and not row["readOnly"]:
        if item is not None:
            _, candidates, _ = service.reconciliation_match_candidates(owner, item.id, actor_key=actor, limit=12)
        else:
            actions = read_active_logged_actions(actor)
            pulls = _scheduled_pulls_for_transactions([transaction], actor_key=actor)
            excluded = service.store.matched_action_log_ids(owner) | claimed_schedule_action_ids(
                pulls, actions, service.store.matched_sheet_refs(owner),
            )
            candidates = find_action_log_candidates(
                transaction, actions,
                excluded_action_ids=excluded, limit=8,
            )
            candidates += find_scheduled_pull_candidates(
                transaction, pulls, limit=4, action_log=actions,
            )
    row["suggestions"] = [_suggestion(candidate, transaction) for candidate in candidates]
    row["version"] = _version(transaction, item, row["suggestions"])
    # The source reads may be slow; don't display a bank version that changed
    # while they ran (including a pending transaction that has since posted).
    current_transaction, current_item = _find(service, owner, review_id)
    if _version(current_transaction, current_item) != _version(transaction, item):
        raise ReviewConflict("This transaction changed. Check again.")
    return row, candidates, transaction, item


def command(service: BankingService, owner: str, actor: str, body: dict) -> dict:
    operation = body.get("operation")
    if not isinstance(operation, str) or operation not in {"confirm", "ignore", "reopen"}:
        raise ReviewValidation("Invalid review action.")
    review_id = body.get("id")
    expected = body.get("version")
    if type(review_id) is not int or review_id <= 0 or not isinstance(expected, str) or len(expected) != 64:
        raise ReviewValidation("Check this transaction before reviewing it.")
    transaction, item = _find(service, owner, review_id)
    if item is None or transaction.pending or item.status == "import_requested":
        raise ReviewConflict("This transaction cannot be changed yet. Check again.")
    action_id = sheet_ref = None
    if operation == "confirm":
        # A bill/subscription may have been edited since the row was opened.
        # Explicit confirmation must compare current source evidence, not the
        # schedule cache used to keep ordinary browsing inexpensive.
        clear_schedule_source_cache(actor)
        row, candidates, transaction, item = detail(service, owner, actor, review_id)
        if item is None or expected != row["version"] or row["status"] != "needs_review":
            raise ReviewConflict("This transaction or its suggestion changed. Review it again.")
        candidate = next((entry for entry in candidates if entry.action_id == body.get("suggestionId")), None)
        if candidate is None:
            raise ReviewConflict("That suggestion is no longer available. Check again.")
        if not candidate.amount_recorded or round(candidate.amount * 100) != round(abs(transaction.amount) * 100):
            raise ReviewConflict("Update the logged amount in BookieBot, then check again.")
        sheet_ref = candidate.sheet_ref
        action_id = candidate.action_id if candidate.action_type != "schedule" else None
    elif expected != _version(transaction, item):
        # Expanded rows use a detail version. Validate it without persisting any
        # financial values or trusting a candidate supplied by the phone.
        row, _, transaction, item = detail(service, owner, actor, review_id)
        if expected != row["version"] or item is None:
            raise ReviewConflict("This transaction changed. Review it again.")
    assert item is not None
    applied = service.store.apply_reconciliation_review(
        owner, item.id, action=cast(Literal["confirm", "ignore", "reopen"], operation), expected_status=item.status,
        expected_updated_at=transaction.updated_at, expected_last_seen_at=item.last_seen_at,
        matched_action_log_id=action_id, matched_sheet_ref=sheet_ref,
    )
    if applied is None:
        raise ReviewConflict("This transaction was already changed. Check again.")
    return snapshot(service, owner)


async def _check(service: BankingService, owner: str, actor: str) -> None:
    # One phone check per owner shares work across taps/devices. Sync and matching
    # operate on bank/reconciliation metadata only; neither logs an expense.
    await service.sync_owner(owner)
    clear_schedule_source_cache(actor)
    await asyncio.to_thread(service.reconciliation_preview, owner, limit=_LIMIT,
                            force=True, actor_key=actor, start_date=_cutoff())


async def _review(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action, _session
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Review transactions from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        service = build_banking_service()
        if not await asyncio.to_thread(_enabled, service, session.owner_key):
            return _json({"enabled": False, "checkedAt": None, "items": []})
        if request.method == "POST":
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 4096:
                    raise ReviewValidation("Review request is too large.")
            try:
                body = json.loads(raw)
            except (ValueError, UnicodeDecodeError) as exc:
                raise ReviewValidation("Invalid review request.") from exc
            if not isinstance(body, dict):
                raise ReviewValidation("Invalid review request.")
            if body.get("operation") == "check":
                task = _checks.get(session.owner_key)
                if task is None or task.done():
                    task = asyncio.create_task(_check(service, session.owner_key, session.actor_key))
                    _checks[session.owner_key] = task
                    def finished(done: asyncio.Task, owner: str = session.owner_key):
                        if _checks.get(owner) is done:
                            _checks.pop(owner, None)
                        if not done.cancelled():
                            done.exception()  # Retrieve exceptions after a disconnected request.
                    task.add_done_callback(finished)
                await asyncio.wait_for(asyncio.shield(task), timeout=45)
                result = await asyncio.to_thread(snapshot, service, session.owner_key)
            else:
                result = await asyncio.to_thread(command, service, session.owner_key, session.actor_key, body)
        elif "review_id" in request.match_info:
            try:
                review_id = int(request.match_info["review_id"])
            except ValueError as exc:
                raise ReviewValidation("Invalid review request.") from exc
            row, _, _, _ = await asyncio.to_thread(detail, service, session.owner_key, session.actor_key,
                                                   review_id)
            result = {"item": row}
        else:
            result = await asyncio.to_thread(snapshot, service, session.owner_key)
        current = await _session(request)
        if current is None or current.owner_key != session.owner_key:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        return _json(result)
    except ReviewConflict as exc:
        return _json({"error": str(exc)}, status=409)
    except ReviewNotFound:
        return _json({"error": "This transaction is no longer available. Check again."}, status=404)
    except ReviewValidation:
        return _json({"error": "Invalid review request. Check again."}, status=400)
    except Exception:
        logger.exception("Phone reconciliation is temporarily unavailable")
        return _json({"error": "Couldn't finish checking. Check status before trying again."}, status=503)


def register_phone_reconciliation_routes(app: web.Application) -> None:
    app.router.add_get("/app/reconciliation", _review)
    app.router.add_get("/app/reconciliation/{review_id}", _review)
    app.router.add_post("/app/reconciliation", _review)
