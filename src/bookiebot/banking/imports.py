"""Recoverable bank-to-Sheets imports.

One durable operation owns each bank item. A writer is called only by the process
that obtained the claim. After a write may have started, a retry may recover the
recorded action but never calls the writer again. An unrecorded or ambiguous
write needs manual inspection; elapsed time alone never releases its claim.
"""
from __future__ import annotations

from datetime import date
import json
import logging
import math
from typing import Any
from uuid import uuid4

from bookiebot.banking.models import BankImportOperation, BankImportResult
from bookiebot.banking.store import BankStore
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import get_user_config, now_pacific, sheet_user_context
from bookiebot.sheets.undo import read_active_logged_actions
from bookiebot.sheets.writer import log_category_row, log_income_row, record_expense_undo


logger = logging.getLogger(__name__)


def _recovery_result(operation: BankImportOperation) -> BankImportResult:
    return BankImportResult(
        'needs_recovery',
        'This bank item has an import in progress or awaiting recovery. '
        'A sheet entry may already exist, so the write will not be retried. Check the sheet and action history '
        f'before resolving import `{operation.operation_id}`.',
        operation.operation_id, operation.matched_action_log_id,
    )


def _completed_result(operation: BankImportOperation) -> BankImportResult:
    return BankImportResult(
        'completed', 'This bank item is imported and linked to its recorded sheet action.',
        operation.operation_id, operation.matched_action_log_id,
    )


def _recover_import(store: BankStore, operation: BankImportOperation) -> BankImportResult:
    if operation.status == 'completed':
        item = store.get_reconciliation_item(operation.owner_key, operation.reconciliation_id)
        if (item is not None and item.status == 'confirmed'
                and item.matched_action_log_id == operation.matched_action_log_id):
            return _completed_result(operation)
        # An intentional undo/reopen must not turn an old form into a new import.
        return _recovery_result(operation)
    try:
        request = json.loads(operation.request_json)
        bank_date = date.fromisoformat(request['bank_date'])
        current = now_pacific().date()
        if (bank_date.year, bank_date.month) != (current.year, current.month):
            return _recovery_result(operation)
        with sheet_user_context(operation.actor_key):
            matches = [
                logged for logged in read_active_logged_actions(operation.actor_key)
                if logged.action.metadata.get('bank_import_operation_id') == operation.operation_id
                and logged.action.metadata.get('bank_reconciliation_id') == str(operation.reconciliation_id)
                and logged.action.metadata.get('bank_import_target_year') == str(bank_date.year)
                and logged.action.metadata.get('bank_import_target_month') == str(bank_date.month)
                and logged.action.metadata.get('type') == operation.kind
                and logged.action.worksheet == operation.kind
                and logged.action.row > 0
            ]
        if len(matches) == 1:
            logged = matches[0]
            operation = store.complete_reconciliation_import(
                operation, action_id=logged.id,
                sheet_ref=f'{logged.action.worksheet}!row {logged.action.row}',
            )
            if operation.status == 'completed':
                return _completed_result(operation)
    except Exception:
        logger.exception('Bank import recovery could not complete', extra={'operation_id': operation.operation_id})
    return _recovery_result(operation)


def recover_reconciliation_import(
    store: BankStore, owner_key: str, reconciliation_id: int, *, actor_key: str,
) -> BankImportResult:
    if get_user_config(actor_key).budget_owner_key != owner_key:
        return BankImportResult('rejected', 'That bank item is not available for this user.')
    operation = store.get_import_operation(owner_key, reconciliation_id)
    if operation is None:
        return BankImportResult('rejected', 'No saved import operation was found for that bank item.')
    return _recover_import(store, operation)


def import_reconciliation_item(
    store: BankStore, owner_key: str, reconciliation_id: int, *, actor_key: str,
    kind: str, fields: dict[str, str], expected_amount: float, expected_date: str | None,
) -> BankImportResult:
    """Validate the current item, claim once, write once, then persist its linkage."""
    if get_user_config(actor_key).budget_owner_key != owner_key:
        return BankImportResult('rejected', 'That bank item is not available for this user.')

    existing = store.get_import_operation(owner_key, reconciliation_id)
    if existing is not None:
        return _recover_import(store, existing)

    item = store.get_reconciliation_item(owner_key, reconciliation_id)
    if item is None or item.status not in {'needs_review', 'pending_user', 'conflict'}:
        return BankImportResult('rejected', 'That bank item is no longer awaiting import. Open the current review again.')
    transaction = item.transaction
    bank_date_text = transaction.date or transaction.authorized_date
    if transaction.pending:
        return BankImportResult('rejected', 'Wait until this bank transaction posts before importing it.')
    if transaction.amount != expected_amount or bank_date_text != expected_date:
        return BankImportResult('rejected', 'The bank amount or date changed. Open the current review before importing it.')
    try:
        bank_date = date.fromisoformat(bank_date_text or '')
    except ValueError:
        return BankImportResult('rejected', 'This bank item needs a valid bank date before it can be imported.')
    current = now_pacific().date()
    if (bank_date.year, bank_date.month) != (current.year, current.month):
        return BankImportResult(
            'rejected', f'This transaction belongs to {bank_date:%B %Y}. '
            'Bank imports currently support only the current month because historical undo is not yet supported. '
            'No sheet changes were made; the item remains available for matching to an existing row.',
        )
    if not math.isfinite(transaction.amount):
        return BankImportResult('rejected', 'This bank item needs a valid amount before it can be imported.')
    if kind not in {'expense', 'income'} or (kind == 'expense' and fields.get('category') not in get_category_columns):
        return BankImportResult('rejected', 'Choose a supported import type and expense category.')

    # Persist exactly what this claim is authorized to write for later diagnosis.
    request: dict[str, Any] = {
        'fields': fields, 'bank_amount': transaction.amount,
        'bank_date': bank_date.isoformat(), 'target_month': bank_date.strftime('%B'),
        'target_year': bank_date.year,
    }
    operation, claimed = store.claim_reconciliation_import(
        owner_key, reconciliation_id, operation_id=uuid4().hex,
        actor_key=actor_key, kind=kind, request=request,
    )
    if operation is None:
        return BankImportResult('rejected', 'That bank item changed or is no longer eligible. Open its current review.')
    if not claimed:
        return _recover_import(store, operation)

    metadata = {
        'origin': 'bank_reconciliation', 'bank_reconciliation_id': str(reconciliation_id),
        'bank_import_operation_id': operation.operation_id,
        'bank_import_target_year': str(bank_date.year), 'bank_import_target_month': str(bank_date.month),
    }
    try:
        with sheet_user_context(actor_key):
            repo = get_sheets_repo()
            worksheet = repo.expense_sheet() if kind == 'expense' else repo.income_sheet()
            # The modal or worksheet lookup can span a month rollover.
            current = now_pacific().date()
            if (bank_date.year, bank_date.month) != (current.year, current.month):
                raise RuntimeError('Month changed before import')
            if worksheet.title != request['target_month']:
                raise RuntimeError('Resolved worksheet does not match bank month')
            if not store.mark_import_writing(owner_key, operation.operation_id):
                return _recovery_result(operation)
            if kind == 'expense':
                values = {
                    'date': f'{bank_date.month}/{bank_date.day}/{bank_date.year}',
                    'amount': abs(transaction.amount), 'item': fields.get('item', ''),
                    'location': fields.get('location', ''), 'person': fields.get('person', ''),
                }
                category = fields['category']
                row = log_category_row(values, worksheet, category)
                action_id = record_expense_undo(category, row, values, values['person'], actor_key, metadata)
            else:
                values = {
                    'date': bank_date.isoformat(), 'amount': abs(transaction.amount),
                    'source': fields.get('source', ''), 'label': fields.get('label', ''),
                }
                row, _, _, action_id = log_income_row(values, worksheet, return_action_id=True, metadata_extra=metadata)
            if not action_id:
                raise RuntimeError('Sheet write has no confirmed action-log record')
        operation = store.complete_reconciliation_import(
            operation, action_id=action_id, sheet_ref=f'{kind}!row {row}',
        )
        if operation.status == 'completed':
            return _completed_result(operation)
    except Exception as exc:
        logger.exception('Bank import needs recovery', extra={'operation_id': operation.operation_id})
        try:
            store.mark_import_needs_recovery(owner_key, operation.operation_id, type(exc).__name__)
        except Exception:
            # The pre-write durable claim remains the no-duplicate guard even if
            # persisting this diagnostic fails or the process is interrupted.
            logger.exception('Could not mark bank import for recovery', extra={'operation_id': operation.operation_id})
        return _recover_import(store, operation)
    return _recovery_result(operation)
