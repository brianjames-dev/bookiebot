"""Canonical cash read model for Overview; never writes source worksheets.

Keep source identities from existing named anchors, and normalize only cells
owned by the canonical ledger. Ordinary sheet activity remains authoritative.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from bookiebot.reimbursements.projection import _name, _identity_matches, _source_identity, _PERSONAL_BILL_LABELS, _projection_events
from bookiebot.sheets.bills import bill_label_key, bill_payment_state, list_bill_schedules
from bookiebot.sheets.config import category_layout
from gspread.utils import a1_to_rowcol


def _row_for(metadata: dict[str, Any] | None, name: str, title: str) -> int | None:
    if not metadata:
        return None
    ids = {s['properties']['sheetId'] for s in metadata.get('sheets', []) if s['properties']['title'] == title}
    for value in metadata.get('namedRanges', []):
        anchor = value['range']
        if value['name'] == name and anchor.get('sheetId') in ids and anchor.get('endRowIndex') == anchor.get('startRowIndex', 0) + 1:
            return anchor.get('startRowIndex', 0) + 1
    return None


def _cell(rows, row, col):
    return str(rows[row-1][col-1]) if 0 < row <= len(rows) and col <= len(rows[row-1]) else ''


def _write(rows, row, col, value):
    while len(rows) < row:
        rows.append([])
    rows[row-1].extend([''] * max(0, col-len(rows[row-1])))
    rows[row-1][col-1] = str(value)


def _current_receipt_events(ledger: dict[str, Any]) -> list[dict[str, Any]]:
    """Historical zero receipts keep the identity of their prior source revision."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in ledger['events']:
        grouped.setdefault(event['allocationId'], []).append(event)
    eligible = {event['id'] for allocation in ledger['allocations']
                for event in _projection_events({**allocation, 'events': grouped.get(allocation['id'], [])})}
    return [event for event in ledger['events'] if event['id'] in eligible]


@dataclass
class OverviewCash:
    owner: str
    period: str
    as_of: str
    ledger: dict[str, Any]
    shared: list[list[str]]
    personal: list[list[str]]
    identities: dict[tuple[int, int], str] = field(default_factory=dict)
    bills: list[dict[str, Any]] = field(default_factory=list)
    categories: set[str] = field(default_factory=set)
    bill_addresses: dict[str, tuple[int,int]] = field(default_factory=dict)

    def basis(self, payments) -> dict[str, Any]:
        """Capture exactly the canonical cash represented by this report."""
        by_label = {bill_label_key(item.label): item for item in payments}
        for context in self.bills:
            payment = by_label.get(bill_label_key(context['label'])) or by_label.get(bill_label_key(context['displayName']))
            if payment:
                context['group'] = payment.group
            context['currentEligible'] = bool(payment and payment.status == 'paid')
            context['date'] = payment.date if payment else context['dueDate']
        return {'ownerKey': self.owner, 'period': self.period, 'asOf': self.as_of,
                'versions': {row['id']: row['version'] for row in self.ledger['allocations'] if row.get('accounting') == 'cash_v1'},
                'allocations': [{key: value for key, value in row.items() if key in {
                    'id','payerOwner','partnerOwner','payerPerson','item','location','expenseDate','category','grossCents',
                    'payerShareCents','partnerShareCents','settledCents','clearedCents','outstandingCents','version','accounting',
                    'sourceYear','sourceSheetTitle','sourceWorksheet','billCategory','lifecycle'}} for row in self.ledger['allocations'] if row.get('accounting')=='cash_v1'],
                'events': [{key:value for key,value in event.items() if key in {'id','allocationId','kind','amountCents','status','date'}} for event in _current_receipt_events(self.ledger)], 'bills': self.bills}


def normalize_cash(*, owner: str, period: str, as_of: date, ledger: dict[str, Any], shared: list[list[str]],
                   personal: list[list[str]], schedules: list[list[str]], forecasts: tuple[Any, ...],
                   shared_metadata=None, personal_metadata=None) -> OverviewCash:
    from bookiebot.sheets.collaboration import expense_person_for_owner
    from bookiebot.reports.expense_breakdown import _payment_group_for_label, _normalize_label
    year, number = map(int, period.split('-'))
    title = calendar.month_name[number]
    result = OverviewCash(owner, period, as_of.isoformat(), ledger, [r[:] for r in shared], [r[:] for r in personal])
    layouts = category_layout(shared)
    plans = list_bill_schedules(schedules, period=period)
    by_id = {a['id']: a for a in ledger['allocations']}
    for allocation in ledger['allocations']:
        if allocation.get('accounting') != 'cash_v1' or allocation.get('lifecycle', 'active') != 'active':
            continue
        payer = allocation['payerOwner'] == owner
        same_month = allocation['sourceYear'] == year and allocation.get('sourceSheetTitle') == title
        if same_month and payer:
            rows = result.shared if allocation['sourceWorksheet'] == 'expense' else result.personal
            metadata = shared_metadata if allocation['sourceWorksheet'] == 'expense' else personal_metadata
            row = _row_for(metadata, _name('source', allocation['id']), title) or allocation['sourceRow']
            fields = allocation['sourceColumnMap']
            first, last = min(fields.values()), max(fields.values())
            values = [_cell(rows, row, col) for col in range(first, last+1)]
            if not _identity_matches(values, fields, _source_identity(allocation)):
                # Never redirect a display correction onto a similar merchant.
                raise ValueError('The shared expense source changed while loading Overview.')
            _write(rows, row, fields['amount'], (allocation['grossCents']-allocation['settledCents'])/100)
            if allocation['sourceWorksheet'] == 'expense':
                result.identities[row-1, fields['amount']-1] = 'source:'+allocation['id']
                result.categories.add(allocation['category'])
        if same_month and allocation['sourceWorksheet'] == 'income':
            label = allocation['sourceValues'].get('item') or allocation['category'] if payer else allocation.get('partnerSourceLabel') or _PERSONAL_BILL_LABELS.get(str(allocation['category']).casefold())
            if not label:
                continue
            label = str(label)
            if not payer:
                row = _row_for(personal_metadata, _name('partner_bill', allocation['id']), title)
                if row is None:
                    matches = [i for i, values in enumerate(result.personal, 1) if len(values)>1 and str(values[1]).strip()==label]
                    if len(matches)>1:
                        raise ValueError('The shared bill source is ambiguous.')
                    row = matches[0] if matches else len(result.personal)+1
                column = 4 if allocation.get('billCategory') == 'subscriptions_wants' else 3
                _write(result.personal, row, 2, label)
                _write(result.personal, row, column, allocation['settledCents']/100)
            result.bill_addresses[allocation['id']] = (row, fields['amount'] if payer else column)
            timing = bill_payment_state(label, year, number, plans, as_of=as_of)
            plan = next((p for p in plans if bill_label_key(p.source_label)==bill_label_key(label)), None)
            forecast = next((f for f in forecasts if f.period==period and bill_label_key(f.member_label)==bill_label_key(label)), None) if not payer else None
            result.bills.append({'allocationId': allocation['id'], 'label': label, 'displayName': plan.display_name if plan else allocation['item'],
                'group': allocation.get('billCategory') or (plan.category if plan else '') or _payment_group_for_label(_normalize_label(label)) or 'bills_utilities',
                'payer': payer, 'dueDate': timing.withdrawal_date.isoformat() if timing.withdrawal_date else '',
                'schedulePaid': timing.paid, 'forecast': bool(forecast) or (not payer and period >= as_of.strftime('%Y-%m')), 'forecastDate': forecast.date if forecast else timing.withdrawal_date.isoformat() if timing.withdrawal_date else allocation['expenseDate']})
    # Receipt events are actual recorded cash, even if their Sheet projection
    # has not appended its row. Pending reports never create spending.
    for event in _current_receipt_events(ledger):
        allocation = by_id.get(event['allocationId'])
        if (not allocation or allocation.get('accounting')!='cash_v1' or allocation.get('lifecycle','active')!='active'
                or allocation['sourceWorksheet']!='expense' or allocation['partnerOwner']!=owner or not event['date'].startswith(period)):
            continue
        category = allocation['category'] if allocation['category'] in layouts else 'need_expenses'
        config = layouts[category]
        fields = {key:a1_to_rowcol(value+'1')[1] for key,value in config['columns'].items()}
        row = _row_for(shared_metadata, _name('receipt', event['id']), title)
        prefix = 'Offset' if event['kind']=='offset' else 'Reimbursement'
        expected = {'date': event['date'], 'item': prefix+' · '+allocation['item'],
                    'location': prefix+' to '+allocation['payerOwner'].title()+' · '+allocation['location'],
                    'person': expense_person_for_owner(owner)}
        if row is not None:
            first,last=min(fields.values()),max(fields.values())
            if not _identity_matches([_cell(result.shared,row,col) for col in range(first,last+1)], fields, expected):
                raise ValueError('The linked receipt source changed while loading Overview.')
        elif shared_metadata is None:
            raise ValueError('The linked receipt identities are unavailable for Overview.')
        elif event['status']!='confirmed':
            continue
        else:
            row = len(result.shared)+1
            for field,col in fields.items():
                if field!='amount':
                    _write(result.shared,row,col,expected.get(field,''))
        _write(result.shared,row,fields['amount'],event['amountCents']/100 if event['status']=='confirmed' else 0)
        result.identities[row-1,fields['amount']-1]='receipt:'+event['id']
        result.categories.add(category)
    return result


def cash_calendar(events, cash: OverviewCash):
    from bookiebot.reports.expense_breakdown import CalendarEvent
    by_id = {row['id']: row for row in cash.ledger['allocations']}
    result = list(events)
    used = set()
    for context in cash.bills:
        keys = {bill_label_key(context['label']), bill_label_key(context['displayName'])}
        if keys & used:
            raise ValueError('More than one shared bill owns this Overview source.')
        used |= keys
        result = [e for e in result if not (e.kind=='bill' and bill_label_key(e.label) in keys)]
        allocation = by_id[context['allocationId']]
        amount = allocation['grossCents']-allocation['settledCents'] if context['payer'] else allocation['settledCents']
        when = context['date'] or context['dueDate']
        if amount and when and when.startswith(cash.period):
            result.append(CalendarEvent('bill',context['displayName'],amount/100,int(when[8:]),context['group'],projected_only=not context['currentEligible']))
        remaining = allocation['outstandingCents']
        when = context['forecastDate']
        if not context['payer'] and context['forecast'] and remaining and when.startswith(cash.period):
            result.append(CalendarEvent('bill',context['displayName'],remaining/100,int(when[8:]),context['group'],projected_only=True,shared_forecast=True))
    return result


def tag_calendar(events, basis):
    for event in events:
        if event['kind']!='bill':
            continue
        context = next((b for b in basis['bills'] if bill_label_key(event['label']) in {bill_label_key(b['label']),bill_label_key(b['displayName'])}), None)
        if context:
            event['canonicalCashId'] = 'bill:'+context['allocationId']+(':forecast' if event.get('sharedBillForecast') else '')


def history_basis(cash: OverviewCash, basis, history, schedules, month, recorded_dates):
    """Reuse the existing history parser for zero/new-series presentation."""
    from dataclasses import replace
    from bookiebot.reports.expense_breakdown import _utility_history_items, _utility_history_payload
    groups = frozenset({'rent','bills_utilities','static_bills_subscriptions_needs'})
    for context in basis['bills']:
        if context['group'] not in groups:
            continue
        row,column = cash.bill_addresses[context['allocationId']]
        def series(amount):
            rows=[r[:] for r in cash.personal]
            _write(rows,row,column,amount)
            values=_utility_history_items(tuple(replace(h,rows=rows) if h.month==month else h for h in history),schedules,month,
                groups=groups,as_of=date.fromisoformat(cash.as_of),recorded_dates=recorded_dates)
            return next((value for value in values if bill_label_key(value.label) in {bill_label_key(context['label']),bill_label_key(context['displayName'])}),None)
        zero=series(0)
        context['historyAtZero']=zero is not None
        template=zero or series(.01)
        if template:
            context['historyTemplate']=_utility_history_payload(template)
