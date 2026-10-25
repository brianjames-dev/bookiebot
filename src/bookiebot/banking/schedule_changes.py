"""Reviewed bank-to-schedule changes, claimed once before any sheet write."""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import date
import hashlib
import json
import logging
import math
import re
from typing import Any, cast
from uuid import uuid4

from gspread.exceptions import WorksheetNotFound
from openpyxl.utils import column_index_from_string, get_column_letter

from bookiebot.banking.models import BankImportOperation, BankImportResult, ReconciliationItem
from bookiebot.banking.reconciliation import ActionLogCandidate
from bookiebot.sheets.auth import get_existing_personal_worksheet
from bookiebot.sheets.bills import list_bill_schedules
from bookiebot.sheets.routing import get_user_config, now_pacific, sheet_user_context
from bookiebot.sheets.subscriptions import parse_visible_subscription_schedules
from bookiebot.reimbursements import service as reimbursements
from bookiebot.reimbursements.store import build_reimbursement_store
from bookiebot.sheets.collaboration import SplitMethod, split_amounts, split_method_label, partner_owner_key
from bookiebot.sheets.undo import (
    UndoAction, active_logged_action_by_id, read_active_logged_actions, read_logged_action_history,
    record_undo_action, update_recent_action,
)

logger = logging.getLogger(__name__)


class ScheduleChangeConflict(ValueError):
    pass


def _cell(rows, row, col):
    return str(rows[row - 1][col - 1]) if row <= len(rows) and col <= len(rows[row - 1]) else ''


def _headers(row):
    return [re.sub(r'[^a-z0-9]+', '_', str(value).strip().lower()).strip('_') for value in row]


def _unique_headers(headers):
    named = [value for value in headers if value]
    if len(named) != len(set(named)):
        raise ScheduleChangeConflict('The schedule has ambiguous column headers.')


def _money(value):
    return round(float(str(value).replace('$', '').replace(',', '').strip() or '0') * 100)


def _eligible(owner: str, actor: str, item: ReconciliationItem):
    today = now_pacific().date()
    bank_date = item.transaction.date or item.transaction.authorized_date or ''
    if (get_user_config(actor).budget_owner_key != owner or item.owner_key != owner
            or item.transaction.pending or not math.isfinite(item.transaction.amount) or item.transaction.amount <= 0
            or bank_date[:7] != today.strftime('%Y-%m')
            or item.status not in {'needs_review', 'pending_user', 'conflict'}):
        raise ScheduleChangeConflict('Review a posted payment from the current month before changing its schedule.')


def prepare_schedule_change(owner: str, actor: str, item: ReconciliationItem,
                            candidate: ActionLogCandidate, *, update_future: bool = False,
                            split_method: str = 'income') -> dict[str, Any]:
    """Read exact source/mirror/payment cells. No provisioning or writes."""
    _eligible(owner, actor, item)
    if candidate.action_type != 'schedule':
        raise ScheduleChangeConflict('Choose a scheduled payment.')
    source_ref = candidate.sheet_ref.split('#pull=', 1)[0]
    kind = 'subscription' if candidate.action_id.startswith('schedule:subscription:') else 'bill'
    target = f'{abs(item.transaction.amount):.2f}'
    targets: list[dict[str, Any]] = []
    contexts: list[Any] = []
    checks: list[dict[str, Any]] = []
    derived = None
    payment = None
    schedule_amount = None
    future_amount = None
    sharing = None
    allocation = None
    if split_method not in {'income', 'equal', 'none'}:
        raise ScheduleChangeConflict('Choose By income, 50/50, or No split.')
    with sheet_user_context(actor):
        sheets = {}
        def read(title):
            if title not in sheets:
                ws = get_existing_personal_worksheet(title)
                sheets[title] = (ws, ws.get_all_values(), ws.get_all_values(value_render_option='FORMULA'))
            return sheets[title]
        def add(title, row, col, label):
            _, values, raw = read(title)
            old = _cell(raw, row, col)
            if old.startswith('='):
                raise ScheduleChangeConflict('This amount is calculated. Review its source before changing it.')
            targets.append(dict(sheet=title, cell=f'{get_column_letter(col)}{row}', row=row, col=col,
                                old=old, value=target, label=label))
            return _money(_cell(values, row, col))
        def check(title, row, col):
            checks.append(dict(sheet=title, row=row, col=col, value=_cell(read(title)[2], row, col)))
        if kind == 'subscription':
            _, rows, raw = read('Subscriptions')
            matches = [sub for sub in parse_visible_subscription_schedules(rows) if sub.source_range == source_ref or f'subscription:{sub.id or sub.name}' == source_ref]
            if len(matches) != 1 or matches[0].budget_owner_key != owner:
                raise ScheduleChangeConflict('The subscription source changed. Refresh its suggestions.')
            sub = matches[0]
            contexts.append({key: value for key, value in asdict(sub).items() if key != 'updated_at'})
            match = re.fullmatch(r'Subscriptions!([A-Z]+)(\d+):([A-Z]+)(\d+)', source_ref)
            normalized_header = next(((i, _headers(values))
                                      for i, values in enumerate(rows[:10])
                                      if {'cadence', 'name', 'amount', 'pull_day'} <= set(_headers(values))), None)
            if normalized_header:
                header_row, headers = normalized_header
                _unique_headers(headers)
                matching_rows = [i for i in range(header_row + 2, len(rows) + 1)
                                 if _cell(rows, i, headers.index('name') + 1) == sub.name
                                 and _cell(rows, i, headers.index('cadence') + 1) == sub.cadence]
                if len(matching_rows) != 1 or (match and (match[2] != match[4] or int(match[2]) != matching_rows[0])):
                    raise ScheduleChangeConflict('The subscription source is ambiguous.')
                row, col = matching_rows[0], headers.index('amount') + 1
                for column, header in enumerate(headers, 1):
                    if header not in {'amount', 'updated_at'}:
                        check('Subscriptions', row, column)
            else:
                if match is None or match[2] != match[4]:
                    raise ScheduleChangeConflict('The subscription source cannot be located safely.')
                row, col = int(match[2]), column_index_from_string(match[3])
                if _cell(rows, row, col - 1) != sub.name:
                    raise ScheduleChangeConflict('The subscription row changed. Refresh its suggestions.')
                check('Subscriptions', row, col - 1)
                check('Subscriptions', row, col - 2)
            old_amount = add('Subscriptions', row, col, 'Recurring subscription amount')
            reviewed_amount = old_amount
            try:
                _, mirror, _ = read('_BookieBot Subscription Schedule')
            except WorksheetNotFound:
                mirror = []  # The visible source remains authoritative when no mirror exists.
            if mirror:
                headers = _headers(mirror[0])
                _unique_headers(headers)
                if not {'source_range', 'amount', 'name', 'cadence'} <= set(headers):
                    raise ScheduleChangeConflict('The subscription schedule needs a valid header.')
                source_col = headers.index('source_range') + 1
                matching = [i for i in range(2, len(mirror) + 1) if _cell(mirror, i, source_col) == source_ref or (source_ref.startswith('subscription:')
                            and not _cell(mirror, i, source_col) and _cell(mirror, i, headers.index('name') + 1) == sub.name
                            and _cell(mirror, i, headers.index('cadence') + 1) == sub.cadence)]
                if len(matching) != 1:
                    raise ScheduleChangeConflict('The subscription schedule is ambiguous. Refresh its source.')
                mr = matching[0]
                if (_cell(mirror, mr, headers.index('name') + 1) != sub.name
                        or _cell(mirror, mr, headers.index('cadence') + 1) != sub.cadence
                        or ('pull_day' in headers and _cell(mirror, mr, headers.index('pull_day') + 1) != str(sub.pull_day or ''))
                        or ('pull_month' in headers and _cell(mirror, mr, headers.index('pull_month') + 1) != str(sub.pull_month or ''))):
                    raise ScheduleChangeConflict('The subscription source and schedule disagree. Refresh them before changing the amount.')
                schedule_amount = _money(_cell(mirror, mr, headers.index('amount') + 1))
                reviewed_amount = schedule_amount
                for field in ('name', 'cadence', 'source_range', 'pull_day', 'pull_month'):
                    if field in headers:
                        check('_BookieBot Subscription Schedule', mr, headers.index(field) + 1)
                add('_BookieBot Subscription Schedule', mr, headers.index('amount') + 1, 'Subscription schedule')
            name, can_future = sub.name, False
            description = 'Update the recurring subscription amount. Future budget projections and reminders will use the bank amount.'
        else:
            title = '_BookieBot Bill Schedule'
            _, rows, raw = read(title)
            bills = [bill for bill in list_bill_schedules(rows) if bill.source_range == source_ref]
            if len(bills) != 1:
                raise ScheduleChangeConflict('The bill schedule changed. Refresh its suggestions.')
            bill = bills[0]
            contexts.append({key: value for key, value in asdict(bill).items() if key != 'updated_at'})
            match = re.fullmatch(r'_BookieBot Bill Schedule!A(\d+):[A-Z]+\d+', source_ref)
            if match is None:
                raise ScheduleChangeConflict('The bill source cannot be located safely.')
            name, can_future = bill.display_name, bill.tracking_mode != 'automatic'
            future_amount = round(bill.expected_amount * 100) if bill.expected_amount is not None else None
            month = now_pacific().strftime('%B')
            _, month_rows, _ = read(month)
            labels = [(ri, ci) for ri, row_values in enumerate(month_rows, 1)
                      for ci, value in enumerate(row_values, 1)
                      if str(value).strip().casefold() == bill.source_label.strip().casefold()]
            if len(labels) != 1:
                raise ScheduleChangeConflict('The monthly bill row cannot be located uniquely.')
            pr, pc = labels[0]
            check(month, pr, pc)
            for column in range(1, len(rows[0]) + 1):
                if str(rows[0][column - 1]).strip().lower() not in {'expected_amount', 'updated_at'}:
                    check(title, int(match[1]), column)
            if bill.tracking_mode == 'automatic':
                old_amount = round((bill.expected_amount or 0) * 100)
                derived = dict(sheet=month, row=pr, col=pc + 1, value=target)
                check(month, pr, pc + 1)
            else:
                old_amount = add(month, pr, pc + 1, "This month's recorded payment")
                current_actions = read_active_logged_actions(actor)
                def normalized(value):
                    return re.sub(r'[^a-z0-9]', '', value.casefold())
                actions = [logged for logged in current_actions if logged.action.worksheet == 'income'
                           and logged.action.metadata.get('type') == 'payment'
                           and (logged.action.row == pr or normalized(logged.action.metadata.get('category', '')) == normalized(bill.source_label))]
                if len(actions) > 1 or (actions and (actions[0].action.row != pr or pc + 1 not in actions[0].action.columns
                        or normalized(actions[0].action.metadata.get('category', '')) != normalized(bill.source_label))):
                    raise ScheduleChangeConflict('The recorded payment history no longer matches this bill row.')
                payment = dict(row=pr, col=pc + 1, category=bill.bill_key,
                               actionId=actions[0].id if actions else None)
                if actions:
                    contexts.append(asdict(actions[0].action))
                # A monthly cell can already be net of confirmed repayments.
                # Resolve the ledger independently of action-log availability;
                # missing history must never turn a shared bill into a raw write.
                ledger = build_reimbursement_store().snapshot(owner, include_inactive=True) if reimbursements.enabled() else None
                norm = normalized(bill.source_label)
                related = [value for value in (ledger or {}).get('allocations', [])
                           if value['sourceWorksheet'] == 'income'
                           and value['sourceYear'] == now_pacific().year
                           and (value.get('sourceSheetTitle') == month or
                                not value.get('sourceSheetTitle') and value['expenseDate'][:7] == today_month())
                           and (normalized(value['category']) == norm or
                                value['payerOwner'] == owner and value['sourceRow'] == pr)
                           and value.get('lifecycle', 'active') != 'deleted']
                if len(related) > 1 or (related and related[0]['payerOwner'] != owner):
                    raise ScheduleChangeConflict('This bill has another shared payment. Review it in Shared before changing it.')
                allocation = related[0] if related else None
                supported = norm in {'rent', 'pge', 'recology', 'water'}
                method = split_method if supported else 'none'
                if allocation:
                    assert ledger is not None
                    if (allocation['accounting'] != 'cash_v1' or allocation.get('lifecycle', 'active') != 'active'
                            or not actions or actions[0].id != allocation['sourceActionId']
                            or normalized(allocation['category']) != norm
                            or allocation['sourceRow'] != pr or allocation['sourceColumnMap'].get('amount') != pc + 1
                            or allocation['sourceSpreadsheetId'] != read(month)[0].spreadsheet_id
                            or allocation.get('sourceSheetTitle') != month):
                        raise ScheduleChangeConflict('The shared bill history needs review before its amount can change.')
                    method = allocation['method']
                    gross_changed = allocation['grossCents'] != _money(target)
                    events = [event for event in ledger['events'] if event['allocationId'] == allocation['id']]
                    if gross_changed and (allocation.get('settledCents') or allocation.get('clearedCents')
                            or allocation['version'] != allocation['projectedVersion']
                            or any(event['status'] in {'pending', 'confirmed'} for event in events)):
                        raise ScheduleChangeConflict('Resolve pending payments or reverse confirmed repayments in Shared before changing the full bill amount.')
                    payer, partner = (split_amounts(float(target), method, owner,
                                                  custom_payer_basis_points=allocation.get('customPayerBasisPoints')) if gross_changed else
                                      (allocation['payerShareCents'] / 100, allocation['partnerShareCents'] / 100))
                    targets[-1]['value'] = f"{float(target) - allocation['settledCents'] / 100:.2f}"
                else:
                    if supported and not reimbursements.enabled():
                        raise ScheduleChangeConflict('Shared bill accounting must be available before changing this payment.')
                    payer, partner = split_amounts(float(target), cast(SplitMethod, method), owner) if method != 'none' else (float(target), 0)
                sharing = dict(method=method, canChoose=supported and allocation is None,
                               payer=owner.title(), partner=partner_owner_key(owner).title(),
                               payerShareCents=round(payer * 100), partnerShareCents=round(partner * 100),
                               settledCents=allocation['settledCents'] if allocation else 0,
                               budgetAmountCents=_money(targets[-1]['value']),
                               label=split_method_label(cast(SplitMethod, method)) if method != 'none' else 'No split')
                sharing['oldGrossCents'] = allocation['grossCents'] if allocation else None
            if update_future or bill.tracking_mode == 'automatic':
                headers = _headers(rows[0])
                _unique_headers(headers)
                if 'expected_amount' not in headers:
                    raise ScheduleChangeConflict('The bill estimate column is unavailable.')
                add(title, int(match[1]), headers.index('expected_amount') + 1, 'Future bill estimate')
            reviewed_amount = old_amount
            description = ("Update this month's recorded payment and the future bill estimate." if update_future else
                           "Update this month's recorded payment. The future bill estimate stays the same.") if can_future else (
                           'Update the recurring automatic bill amount. Its calculated budget cell will follow this setting.')
        if reviewed_amount != round(candidate.amount * 100) and candidate.amount_recorded:
            raise ScheduleChangeConflict('The scheduled amount changed. Review it again.')
    # Include source identity, recurrence and payment lineage as well as raw target cells.
    bindings = [dict(sheet=title, workbook=ws.spreadsheet_id, worksheet=ws.id) for title, (ws, _, _) in sheets.items()]
    fingerprint = hashlib.sha256(json.dumps([targets, checks, derived, contexts, payment, bindings, update_future, sharing, allocation], sort_keys=True).encode()).hexdigest()
    return dict(kind=kind, name=name, oldAmountCents=old_amount, newAmountCents=round(item.transaction.amount * 100),
                description=description, canUpdateFuture=can_future, updateFuture=update_future,
                scheduleAmountCents=schedule_amount, futureAmountCents=future_amount,
                sharing=sharing, allocation=allocation,
                fingerprint=fingerprint, targets=targets, checks=checks, derived=derived, bindings=bindings, payment=payment, sourceRef=source_ref,
                scheduleRef=candidate.sheet_ref)


def today_month():
    return now_pacific().strftime('%Y-%m')


def public_schedule_change(plan: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in plan.items() if key not in {'targets', 'checks', 'derived', 'bindings', 'payment', 'allocation', 'sourceRef', 'scheduleRef'}}


def _verify_targets(request: dict, actor: str) -> None:
    plan = request['plan']
    with sheet_user_context(actor):
        sheets = {title: get_existing_personal_worksheet(title)
                  for title in {entry['sheet'] for entry in [*plan['targets'], *plan['checks']]}}
        for binding in plan['bindings']:
            ws = get_existing_personal_worksheet(binding['sheet'])
            if ws.spreadsheet_id != binding['workbook'] or ws.id != binding['worksheet']:
                raise ScheduleChangeConflict('The source workbook or worksheet changed.')
        raw = {title: ws.get_all_values(value_render_option='FORMULA') for title, ws in sheets.items()}
        for target in plan['targets']:
            if _money(_cell(raw[target['sheet']], target['row'], target['col'])) != _money(target['value']):
                raise ScheduleChangeConflict('The updated sheet amount could not be verified.')
        for check in plan['checks']:
            if _cell(raw[check['sheet']], check['row'], check['col']) != check['value']:
                raise ScheduleChangeConflict('The schedule identity changed before verification.')
        if plan['derived']:
            derived = plan['derived']
            rows = sheets[derived['sheet']].get_all_values()
            if _money(_cell(rows, derived['row'], derived['col'])) != _money(derived['value']):
                raise ScheduleChangeConflict('The calculated bill amount did not follow its setting.')


def _verify_sharing(plan: dict, action_id: str) -> None:
    sharing = plan.get('sharing')
    if not sharing or sharing['method'] == 'none':
        return
    store = build_reimbursement_store()
    prior = plan.get('allocation')
    value = store.get_allocation(prior['id']) if prior else store.find_by_source(action_id, now_pacific().year)
    if not value or (value['sourceActionId'] != action_id or value['accounting'] != 'cash_v1'
            or value.get('lifecycle', 'active') != 'active'
            or value['grossCents'] != plan['newAmountCents']
            or value['method'] != sharing['method']
            or value['payerShareCents'] != sharing['payerShareCents']
            or value['partnerShareCents'] != sharing['partnerShareCents']
            or value['settledCents'] != sharing['settledCents']
            or value['projectedVersion'] != value['version']):
        raise ScheduleChangeConflict('The shared bill is saved but its split or sheet projection needs verification. Refresh Shared first.')
    if prior:
        changed = prior['grossCents'] != value['grossCents']
        if value['version'] != prior['version'] + int(changed):
            raise ScheduleChangeConflict('The shared bill changed after this review.')
        if changed:
            revision = value.get('sourceRevision', {})
            before = revision.get('before', {})
            if (revision.get('operation') != 'update' or revision.get('version') != value['version']
                    or before.get('grossCents') != prior['grossCents']
                    or before.get('sourceActionId') != prior['sourceActionId']):
                raise ScheduleChangeConflict('The bill correction history needs review.')


def recover_schedule_change(store, operation: BankImportOperation) -> BankImportResult:
    if operation.status == 'completed':
        item = store.get_reconciliation_item(operation.owner_key, operation.reconciliation_id)
        if item is not None and item.status == 'confirmed' and item.matched_sheet_ref == operation.matched_sheet_ref and item.matched_action_log_id == operation.matched_action_log_id:
            return BankImportResult('completed', 'Scheduled payment already updated and matched.', operation.operation_id, operation.matched_action_log_id)
        return BankImportResult('rejected', 'This schedule change was already completed. Review its existing payment before another change.', operation.operation_id)
    request = json.loads(operation.request_json)
    try:
        if request['bank_date'][:7] != now_pacific().strftime('%Y-%m'):
            raise ScheduleChangeConflict('The month changed before recovery.')
        _verify_targets(request, operation.actor_key)
        action_id = None
        payment = request['plan']['payment']
        if payment:
            with sheet_user_context(operation.actor_key):
                history = read_logged_action_history(operation.actor_key)
                evidence = [entry for entry in history if entry.status == 'active'
                            and entry.action.metadata.get('type') != 'split'
                            and entry.action.metadata.get('bank_import_operation_id') == operation.operation_id]
                prior = request['plan'].get('allocation')
                if not prior and len(evidence) != 1:
                    raise ScheduleChangeConflict('The payment action needs recovery.')
                active = read_active_logged_actions(operation.actor_key)
                found = [entry for entry in active if entry.action.worksheet == 'income' and entry.action.row == payment['row']
                         and entry.action.metadata.get('type') == 'payment']
                if len(found) != 1:
                    raise ScheduleChangeConflict('The current payment action needs recovery.')
                action_id = found[0].id
                if prior and action_id != prior['sourceActionId']:
                    raise ScheduleChangeConflict('The shared bill source changed.')
                _verify_sharing(request['plan'], action_id)
        ref = request['plan']['scheduleRef']
        if payment:
            ref += f" + income!row {payment['row']}#cols={payment['col']}#month={request['bank_date'][:7]}"
        operation = store.complete_reconciliation_import(operation, action_id=action_id, sheet_ref=ref)
        if operation.status == 'completed':
            return BankImportResult('completed', 'Scheduled payment updated and matched.', operation.operation_id, action_id)
    except Exception:
        logger.exception('Scheduled payment change needs recovery')
    return BankImportResult('needs_recovery', 'Check status before another change; the sheet may already be updated.', operation.operation_id)


def apply_schedule_change(service, owner: str, actor: str, item: ReconciliationItem,
                          candidate: ActionLogCandidate, fingerprint: str, *, update_future: bool = False,
                          split_method: str = 'income') -> BankImportResult:
    _eligible(owner, actor, item)
    existing = service.store.get_import_operation(owner, item.id)
    if existing:
        if existing.kind != 'schedule_adjustment':
            raise ScheduleChangeConflict('A sheet operation already owns this bank transaction.')
        return recover_schedule_change(service.store, existing)
    plan = prepare_schedule_change(owner, actor, item, candidate, update_future=update_future, split_method=split_method)
    if plan['fingerprint'] != fingerprint:
        raise ScheduleChangeConflict('The scheduled payment changed. Review the new amount before confirming.')
    payment = plan['payment']
    refs = [candidate.sheet_ref, f"schedule-source:{plan['sourceRef']}"]
    if payment:
        refs.append(f"income!row {payment['row']}#cols={payment['col']}#month={(item.transaction.date or item.transaction.authorized_date or '')[:7]}")
    request = dict(plan=plan, bank_amount=item.transaction.amount, bank_date=item.transaction.date or item.transaction.authorized_date,
                   expected_status=item.status, expected_last_seen_at=item.last_seen_at,
                   expected_updated_at=item.transaction.updated_at, reserved_sheet_refs=' + '.join(refs),
                   reserved_action_id=payment['actionId'] if payment else None)
    operation, claimed = service.store.claim_reconciliation_import(owner, item.id, operation_id=uuid4().hex,
        actor_key=actor, kind='schedule_adjustment', request=request)
    if operation is None:
        raise ScheduleChangeConflict('This payment or schedule is already claimed or changed. Check status.')
    if not claimed:
        return recover_schedule_change(service.store, operation)
    writing = False
    try:
        # Validate once more after obtaining the cross-process source reservation.
        current = prepare_schedule_change(owner, actor, item, candidate, update_future=update_future, split_method=split_method)
        if current['fingerprint'] != fingerprint:
            raise ScheduleChangeConflict('The source changed before writing.')
        if not service.store.mark_import_writing(owner, operation.operation_id):
            return recover_schedule_change(service.store, operation)
        writing = True
        with sheet_user_context(actor):
            metadata = dict(origin='bank_reconciliation', bank_reconciliation_id=str(item.id),
                            bank_import_operation_id=operation.operation_id)
            targets = list(plan['targets'])
            allocation, sharing = plan.get('allocation'), plan.get('sharing')
            action_id = payment['actionId'] if payment else None
            if allocation:
                assert sharing is not None
                # The ledger's version guard also rejects a concurrent receipt.
                # Save exactly the reviewed gross and shares, then use the same
                # recoverable projection as Discord/Shared; never raw-write net.
                ledger = build_reimbursement_store()
                if allocation['grossCents'] != plan['newAmountCents']:
                    values = dict(allocation['sourceValues'], amount=f'{item.transaction.amount:.2f}')
                    ledger.revise_allocation(owner, allocation['id'], allocation['version'], dict(
                        grossCents=plan['newAmountCents'], payerShareCents=sharing['payerShareCents'],
                        partnerShareCents=sharing['partnerShareCents'], sourceValues=values), operation='update')
                    from bookiebot.reimbursements.projection import sync_pending
                    if not sync_pending(ledger, allocation_ids={allocation['id']}):
                        raise ScheduleChangeConflict('The bill correction is saved; refresh Shared to finish syncing.')
                targets = [target for target in targets if target['sheet'] != now_pacific().strftime('%B')]
            elif payment and payment['actionId']:
                success, _ = update_recent_action(actor, action_id=payment['actionId'],
                    updates={'amount': f'{item.transaction.amount:.2f}'}, metadata_extra=metadata)
                if not success:
                    raise ScheduleChangeConflict('The recorded payment could not be safely updated.')
                targets = [target for target in targets if target['sheet'] != now_pacific().strftime('%B')]
            if targets:
                worksheets = {target['sheet']: get_existing_personal_worksheet(target['sheet']) for target in targets}
                books = {ws.spreadsheet_id for ws in worksheets.values()}
                bindings = {binding['sheet']: binding for binding in plan['bindings']}
                if any(ws.spreadsheet_id != bindings[title]['workbook'] or ws.id != bindings[title]['worksheet'] for title, ws in worksheets.items()):
                    raise ScheduleChangeConflict('The source workbook or worksheet changed before writing.')
                if len(books) != 1:
                    raise ScheduleChangeConflict('Schedule changes must share one budget workbook.')
                first = next(iter(worksheets.values()))
                first.spreadsheet.values_batch_update({'valueInputOption': 'RAW', 'data': [
                    {'range': f"'{target['sheet']}'!{target['cell']}", 'values': [[float(target['value'])]]} for target in targets]})
            if payment and not payment['actionId']:
                actual = next(target for target in plan['targets'] if target['sheet'] == now_pacific().strftime('%B'))
                action_id = record_undo_action(actor, UndoAction(worksheet='income', kind='restore_cells',
                    row=payment['row'], columns=[payment['col']], previous_values=[actual['old']], new_values=[actual['value']],
                    metadata={'type': 'payment', 'category': payment['category'], **metadata},
                    description=f"{payment['category']} payment ${actual['value']}"))
                if not action_id:
                    raise ScheduleChangeConflict('The payment audit record needs recovery.')
            if payment and not allocation and sharing and sharing['method'] != 'none':
                assert action_id is not None
                logged = active_logged_action_by_id(actor, action_id)
                if not logged:
                    raise ScheduleChangeConflict('The payment source needs recovery before splitting.')
                logged = replace(logged, action=replace(logged.action,
                    metadata={**logged.action.metadata, 'category': payment['category']}))
                ws = get_existing_personal_worksheet(now_pacific().strftime('%B'))
                success, _ = reimbursements.record_split(actor, logged, ws, {'amount': payment['col']},
                    {'amount': f'{item.transaction.amount:.2f}'}, get_user_config(actor).name,
                    sharing['method'], item.transaction.amount,
                    sharing['payerShareCents'] / 100, sharing['partnerShareCents'] / 100,
                    expense_date=date.fromisoformat(str(request['bank_date'])))
                if not success:
                    raise ScheduleChangeConflict('The shared bill split needs recovery.')
        return recover_schedule_change(service.store, operation)
    except Exception:
        if not writing:
            service.store.cancel_unwritten_schedule_change(operation)
            raise ScheduleChangeConflict('The source changed before writing. Refresh its suggestions; no amounts were changed.')
        service.store.mark_import_needs_recovery(owner, operation.operation_id, 'Scheduled payment change requires readback/review')
        logger.exception('Scheduled payment change did not finish')
        return BankImportResult('needs_recovery', 'Check status before another change; the sheet may already be updated.', operation.operation_id)
