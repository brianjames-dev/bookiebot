"""Owner-scoped bank review with explicit, recoverable sheet-write confirmation."""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from datetime import timedelta
import hashlib
import json
import logging
import time
from threading import Lock
from weakref import WeakKeyDictionary
from typing import Any, Literal, cast

from aiohttp import web

from bookiebot.banking.models import BankTransaction, ReconciliationItem
from bookiebot.banking.receipt_links import matched_receipt_link
from bookiebot.banking.plaid_client import PlaidApiError
from bookiebot.banking.schedule_changes import (
    ScheduleChangeConflict, prepare_schedule_change, public_schedule_change, apply_schedule_change, recover_schedule_change,
)
from bookiebot.core.bank_link import bank_reconnect_url
from bookiebot.banking.reconciliation import (
    ActionLogCandidate, claimed_schedule_action_ids, find_action_log_candidates, find_scheduled_pull_candidates,
)
from bookiebot.banking.service import (
    BankingService, _reconciliation_max_age_days, _scheduled_pulls_for_transactions,
    build_banking_service, clear_schedule_source_cache, read_active_logged_actions,
    refresh_reconciliation_review,
)
from bookiebot.sheets.routing import get_user_config, now_pacific
from bookiebot.sheets.config import get_category_columns

logger = logging.getLogger(__name__)
_LIMIT = 200
_checks: dict[str, asyncio.Task] = {}
_action_sources: WeakKeyDictionary = WeakKeyDictionary()
_action_sources_lock = Lock()


class _ActionSource:
    def __init__(self):
        self.lock = Lock()
        self.saved_at = 0.0
        self.actions: list[Any] = []


def _action_source(service: BankingService, owner: str, actor: str) -> _ActionSource:
    with _action_sources_lock:
        sources = _action_sources.setdefault(service.store, {})
        return sources.setdefault((owner, actor), _ActionSource())


def _review_actions(service: BankingService, owner: str, actor: str, *, fresh: bool = False):
    source = _action_source(service, owner, actor)
    with source.lock:
        if fresh or not source.saved_at or time.monotonic() - source.saved_at >= 30:
            source.saved_at = 0  # A failed refresh must not re-enable an older cached preview.
            source.actions = read_active_logged_actions(actor)
            source.saved_at = time.monotonic()
        return source.actions


def _invalidate_review_actions(service: BankingService, owner: str, actor: str) -> None:
    source = _action_source(service, owner, actor)
    with source.lock:
        source.saved_at = 0


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
        "id": item.id if item else -transaction.id, "stateVersion": _version(transaction, item),
        "version": _version(transaction, item), "status": status,
        "date": transaction.date or transaction.authorized_date or "",
        "merchant": transaction.merchant_name or transaction.name,
        "amountCents": round(transaction.amount * 100), "currency": "USD",
        "accountLabel": account, "suggestions": [],
        "needsCheck": not transaction.pending and item is None,
        "readOnly": recovering,
        "matchLabel": (
            "Sheet change needs recovery in BookieBot" if recovering else
            "Matches logged entry" if item and item.matched_action_log_id else
            "Matches scheduled payment" if item and item.matched_sheet_ref else
            "Transfer or account payment" if item and item.classification == "transfer_or_payment" else None
        ),
        "matchedSuggestionId": item.matched_action_log_id if item else None,
    }


def _recovery_controls(service: BankingService, owner: str, row: dict) -> dict:
    if row['readOnly']:
        operation = service.store.get_import_operation(owner, row['id'])
        row['scheduleRecovery'] = bool(operation and operation.kind == 'schedule_adjustment')
    return row


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
        "items": [_recovery_controls(service, owner, _row(transaction, by_transaction.get(transaction.id))) for transaction in transactions],
    }
    issues = service.connection_issues(owner)
    if issues:
        result['connections'] = issues
        result['notice'] = ('Your bank needs reconnecting. Transactions and pending statuses may be out of date.'
            if any(issue['needsReconnect'] for issue in issues) else
            'Bank sync failed. Transactions and pending statuses may be out of date. Try Check again later.')
        return result
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
        "confidence": candidate.confidence,
    }


def detail(service: BankingService, owner: str, actor: str, review_id: int, *, fresh: bool = False):
    transaction, item = _find(service, owner, review_id)
    row = _recovery_controls(service, owner, _row(transaction, item))
    candidates: list[ActionLogCandidate] = []
    if row["status"] in {"needs_review", "pending"} and not row["readOnly"]:
        actions = _review_actions(service, owner, actor, fresh=fresh)
        if item is not None:
            _, candidates, _ = service.reconciliation_match_candidates(owner, item.id, actor_key=actor,
                limit=12, action_log=actions, include_groups=False)
        else:
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
    row["suggestions"].sort(key=lambda entry: entry["confidence"], reverse=True)
    receipt = _receipt_link(owner, actor, item)
    if receipt:
        row['receipt'] = receipt
    if row["status"] == "needs_review" and not row["readOnly"] and item is not None:
        current_month = now_pacific().strftime('%Y-%m')
        bank_month = (transaction.date or transaction.authorized_date or '')[:7]
        row['logging'] = {
            'allowed': current_month == bank_month,
            'kind': 'income' if transaction.amount < 0 else 'expense',
            'categories': list(get_category_columns),
            'paymentMethods': list(get_user_config(actor).expense_payment_methods),
            'reason': '' if current_month == bank_month else
                'Adding bank transactions is supported for the current month. You can still match an existing sheet entry.',
        }
    row["version"] = _version(transaction, item, row["suggestions"])
    # The source reads may be slow; don't display a bank version that changed
    # while they ran (including a pending transaction that has since posted).
    current_transaction, current_item = _find(service, owner, review_id)
    if _version(current_transaction, current_item) != _version(transaction, item):
        raise ReviewConflict("This transaction changed. Check again.")
    return row, candidates, transaction, item


def _receipt_link(owner, actor, item):
    try:
        return matched_receipt_link(owner, actor, item)
    except Exception:
        # An optional shared-payment shortcut cannot invalidate a saved match.
        logger.exception('Shared payment shortcut unavailable')
        return None


def _command_snapshot(service, owner, actor, review_id):
    result = snapshot(service, owner)
    if not any(row['id'] == review_id and row['status'] == 'checked' for row in result['items']):
        return result
    item = service.store.get_reconciliation_item(owner, review_id)
    receipt = _receipt_link(owner, actor, item)
    if receipt and receipt['outstandingCents'] > 0:
        result['receiptFollowup'] = dict(id=review_id, receipt=receipt)
    return result


def command(service: BankingService, owner: str, actor: str, body: dict) -> dict:
    operation = body.get("operation")
    if not isinstance(operation, str) or operation not in {"confirm", "update_match", "update_schedule", "recover_schedule", "log", "ignore", "reopen"}:
        raise ReviewValidation("Invalid review action.")
    review_id = body.get("id")
    expected = body.get("version")
    if type(review_id) is not int or review_id <= 0 or not isinstance(expected, str) or len(expected) != 64:
        raise ReviewValidation("Check this transaction before reviewing it.")
    transaction, item = _find(service, owner, review_id)
    if operation == 'recover_schedule':
        if item is None or expected != _version(transaction, item) or item.status != 'import_requested':
            raise ReviewConflict('This payment changed. Check status before verifying it.')
        saved = service.store.get_import_operation(owner, item.id)
        if saved is None or saved.kind != 'schedule_adjustment':
            raise ReviewConflict('No scheduled payment change is awaiting verification.')
        result = recover_schedule_change(service.store, saved)
        _invalidate_review_actions(service, owner, actor)
        clear_schedule_source_cache(actor)
        if result.status != 'completed':
            raise ReviewConflict('The saved amounts or payment history need inspection. No write was retried.')
        return _command_snapshot(service, owner, actor, review_id)
    if item is None or transaction.pending or item.status == "import_requested":
        raise ReviewConflict("This transaction cannot be changed yet. Check again.")
    if operation != "reopen" and item.status in {"confirmed", "ignored"}:
        raise ReviewConflict("This transaction was already reviewed in the app or Discord. Check status to see the current decision.")
    action_id = sheet_ref = None
    if operation == 'log':
        if (transaction.date or transaction.authorized_date or '')[:7] != now_pacific().strftime('%Y-%m'):
            raise ReviewConflict('Adding bank transactions is supported for the current month. Match an existing sheet entry instead.')
        if expected != _version(transaction, item):
            raise ReviewConflict('This transaction changed. Review it again.')
        fields = body.get('fields')
        kind = 'income' if transaction.amount < 0 else 'expense'
        allowed = {'source', 'label'} if kind == 'income' else {'category', 'item', 'location', 'person'}
        if not isinstance(fields, dict) or set(fields) != allowed or any(
            not isinstance(value, str) or len(value) > 200 for value in fields.values()
        ):
            raise ReviewValidation('Choose the sheet entry details.')
        fields = {key: value.strip() for key, value in fields.items()}
        if kind == 'expense' and (fields['category'] not in get_category_columns
                or fields['person'] not in get_user_config(actor).expense_payment_methods or not fields['item']):
            raise ReviewValidation('Choose an expense category, payment method, and item.')
        if kind == 'income' and not fields['source']:
            raise ReviewValidation('Enter the income source.')
        result = service.import_reconciliation_item(owner, item.id, actor_key=actor, kind=kind, fields=fields,
            expected_amount=transaction.amount, expected_date=transaction.date or transaction.authorized_date,
            expected_item=item)
        _invalidate_review_actions(service, owner, actor)
        clear_schedule_source_cache(actor)
        if result.status != 'completed':
            raise ReviewConflict('The entry needs review before another attempt. Check status; an entry may already exist.'
                if result.status == 'needs_recovery' else result.message)
        return _command_snapshot(service, owner, actor, review_id)
    if operation in {"confirm", "update_match", "update_schedule"}:
        # A bill/subscription may have been edited since the row was opened.
        # Explicit confirmation must compare current source evidence, not the
        # schedule cache used to keep ordinary browsing inexpensive.
        clear_schedule_source_cache(actor)
        row, candidates, transaction, item = detail(service, owner, actor, review_id, fresh=True)
        if item is None or expected != row["version"] or row["status"] != "needs_review":
            raise ReviewConflict("This transaction or its suggestion changed. Review it again.")
        candidate = next((entry for entry in candidates if entry.action_id == body.get("suggestionId")), None)
        if candidate is None:
            raise ReviewConflict("That suggestion is no longer available. Check again.")
        if operation == 'update_schedule':
            fingerprint = body.get('scheduleVersion')
            update_future = body.get('updateFuture', False)
            split_method = body.get('splitMethod', 'income')
            if not isinstance(fingerprint, str) or len(fingerprint) != 64 or type(update_future) is not bool:
                raise ReviewValidation('Review this scheduled payment before confirming.')
            if not isinstance(split_method, str) or split_method not in {'income', 'equal', 'none'}:
                raise ReviewValidation('Choose By income, 50/50, or No split.')
            result = apply_schedule_change(service, owner, actor, item, candidate, fingerprint,
                                           update_future=update_future, split_method=split_method)
            _invalidate_review_actions(service, owner, actor)
            clear_schedule_source_cache(actor)
            if result.status != 'completed':
                raise ReviewConflict(result.message)
            return _command_snapshot(service, owner, actor, review_id)
        mismatch = round(candidate.amount * 100) != round(abs(transaction.amount) * 100)
        if not candidate.amount_recorded or (mismatch and operation != 'update_match'):
            raise ReviewConflict("Review the amount change before matching this entry.")
        if operation == 'update_match':
            if candidate.action_type == 'schedule' or not mismatch:
                raise ReviewConflict('Choose a recorded expense or income with a different amount.')
            _, _, status = service.confirm_reconciliation_action_match(owner, item.id, actor_key=actor,
                action_id=candidate.action_id, expected_item=item, expected_candidate=candidate)
            _invalidate_review_actions(service, owner, actor)
            clear_schedule_source_cache(actor)
            if status != 'matched_updated':
                raise ReviewConflict('Could not safely update this entry. Check status and review it again.')
            return _command_snapshot(service, owner, actor, review_id)
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
        current = service.get_reconciliation_item(owner, item.id)
        if operation == 'confirm' and current == item:
            raise ReviewConflict("That row is already linked or no longer eligible. Check status or choose another suggestion.")
        raise ReviewConflict("This transaction was already changed. Check again.")
    return _command_snapshot(service, owner, actor, review_id)


def schedule_preview(service: BankingService, owner: str, actor: str, review_id: int, query):
    expected, suggestion_id = query.get('version'), query.get('suggestionId')
    future = query.get('future', '0')
    split_method = query.get('splitMethod', 'income')
    if not isinstance(expected, str) or len(expected) != 64 or not isinstance(suggestion_id, str) or len(suggestion_id) > 500 or future not in {'0', '1'} or split_method not in {'income', 'equal', 'none'}:
        raise ReviewValidation('Choose a scheduled payment first.')
    clear_schedule_source_cache(actor)
    row, candidates, _, item = detail(service, owner, actor, review_id, fresh=True)
    if item is None or row['version'] != expected:
        raise ReviewConflict('This payment changed. Refresh its suggestions before reviewing the amount.')
    candidate = next((entry for entry in candidates if entry.action_id == suggestion_id), None)
    if candidate is None:
        raise ReviewConflict('This scheduled payment is no longer available.')
    plan = prepare_schedule_change(owner, actor, item, candidate, update_future=future == '1', split_method=split_method)
    return {'change': {**public_schedule_change(plan), 'version': row['version']}}


async def _check(service: BankingService, owner: str, actor: str) -> None:
    # One phone check per owner shares work across taps/devices. Sync and matching
    # operate on bank/reconciliation metadata only; neither logs an expense.
    await service.sync_owner(owner)
    _invalidate_review_actions(service, owner, actor)
    await refresh_reconciliation_review(service, owner, actor)
    from bookiebot.core.bank_reconciliation import notify_bank_reconciliation_refreshed
    await notify_bank_reconciliation_refreshed(actor)


async def _review(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action, _session
    started = time.monotonic()
    operation = 'detail' if 'review_id' in request.match_info else 'snapshot'
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Review transactions from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        service = build_banking_service()
        result: dict[str, Any]
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
            requested_operation = body.get('operation')
            operation = requested_operation if isinstance(requested_operation, str) and requested_operation in {
                'check', 'confirm', 'update_match', 'update_schedule', 'recover_schedule', 'log', 'ignore', 'reopen',
            } else 'invalid'
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
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=45)
                except PlaidApiError:
                    # The sync saved its failure. Keep the known snapshot and
                    # actionable reconnect warning instead of an uncertain mutation error.
                    pass
                result = await asyncio.to_thread(snapshot, service, session.owner_key)
            else:
                result = await asyncio.to_thread(command, service, session.owner_key, session.actor_key, body)
        elif "review_id" in request.match_info:
            try:
                review_id = int(request.match_info["review_id"])
            except ValueError as exc:
                raise ReviewValidation("Invalid review request.") from exc
            if request.path.endswith('/schedule'):
                operation = 'schedule_preview'
                result = await asyncio.to_thread(schedule_preview, service, session.owner_key, session.actor_key,
                                                 review_id, request.query)
            else:
                row, _, _, _ = await asyncio.to_thread(detail, service, session.owner_key, session.actor_key, review_id)
                result = {"item": row}
        else:
            result = await asyncio.to_thread(snapshot, service, session.owner_key)
        current = await _session(request)
        if current is None or current.owner_key != session.owner_key:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        for connection in result.get('connections', []):
            if connection['needsReconnect']:
                connection['reconnectUrl'] = bank_reconnect_url(session.actor_key, session.owner_key, connection['id'])
        return _json(result)
    except (ReviewConflict, ScheduleChangeConflict) as exc:
        return _json({"error": str(exc)}, status=409)
    except ReviewNotFound:
        return _json({"error": "This transaction is no longer available. Check again."}, status=404)
    except ReviewValidation:
        return _json({"error": "Invalid review request. Check again."}, status=400)
    except Exception:
        logger.exception("Phone reconciliation is temporarily unavailable")
        return _json({"error": "Couldn't finish checking. Check status before trying again."}, status=503)

    finally:
        logger.info('Phone reconciliation %s completed in %.3fs', operation, time.monotonic() - started)


def register_phone_reconciliation_routes(app: web.Application) -> None:
    app.router.add_get("/app/reconciliation", _review)
    app.router.add_get("/app/reconciliation/{review_id}", _review)
    app.router.add_get("/app/reconciliation/{review_id}/schedule", _review)
    app.router.add_post("/app/reconciliation", _review)
