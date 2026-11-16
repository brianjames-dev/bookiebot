"""Recipient planning derived from accepted payer plans and canonical receipts.

No projected entry is written into Transactions or Sheets. Existing recipient
amounts fulfill a forecast once; fully repaid charges cannot be counted twice.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from bookiebot.reports.shared_bills import build_store, account_for, _accounts
from bookiebot.sheets.recurring import selected
from bookiebot.sheets.routing import now_pacific


@dataclass(frozen=True)
class SharedBillForecast:
    id: str
    period: str
    name: str
    category: str
    date: str
    target_cents: int
    member_plan_id: str = ''
    member_label: str = ''
    prediction: dict[str, Any] | None = None


def invoice_estimate(allocations: list[dict[str, Any]], period: str, as_of: str) -> dict[str, Any] | None:
    groups: dict[str,list[int]] = {}
    for value in allocations:
        if value.get('sourceSheetTitle') not in calendar.month_name[1:] or value.get('lifecycle','active') != 'active':
            continue
        key=f"{value['sourceYear']:04d}-{list(calendar.month_name).index(value['sourceSheetTitle']):02d}"
        if key < min(period,as_of) and value['grossCents'] > 0:
            groups.setdefault(key,[]).append(value['grossCents'])
    samples=[(key,values[0]) for key,values in sorted(groups.items()) if len(values)==1]
    if not samples:
        return None
    total=int((Decimal(sum(cents for _,cents in samples))/len(samples)).quantize(Decimal(1),rounding=ROUND_HALF_UP))
    return {'amountCents':total,'source':'history','sampleCount':len(samples),'basis':'shared_bill_invoice',
            'firstMonth':samples[0][0],'lastMonth':samples[-1][0]}


def forecast_inputs(actor: str, periods: list[str]) -> tuple[SharedBillForecast, ...]:
    from bookiebot.sheets.routing import UnknownDiscordUserError
    try:
        store = build_store()
        viewer = account_for(actor, store=store)
    except UnknownDiscordUserError:
        return ()
    links = [link for link in store.links(viewer) if link['member_id'] == viewer.id and link['status'] == 'active']
    if not links:
        return ()
    from bookiebot.sheets.recurring_storage import read_workbook
    from bookiebot.reports.bill_settings import split_preview
    from bookiebot.sheets.recurring_charges import decode_charges, CHARGES_TAB, occurrence_plan
    today = now_pacific().date()
    sources: dict[str, Any] = {}
    result = []
    for link in links:
        payer, _ = _accounts(link)
        if payer.id not in sources:
            sources[payer.id] = read_workbook(payer.actor, today)
        source = sources[payer.id]
        if not any(p.id == link['plan_id'] for p in source.settings.plans):
            from bookiebot.reports.accounts import AccountConflict
            raise AccountConflict('A shared bill’s source is unavailable. Refresh Bills before using its projection.')
        related = [a for a in source.allocations if a.get('billPlanId') == link['plan_id']
            and a.get('payerOwner') == payer.owner and a.get('partnerOwner') == viewer.owner
        ]
        allocations=[a for a in related if a.get('lifecycle','active')=='active']
        for period in periods:
            plan = next((p for p in selected(list(source.settings.plans), period,include_inactive=True) if p.id == link['plan_id']), None)
            if plan is None:
                continue
            existing = [a for a in allocations if a['sourceYear'] == int(period[:4])
                        and a['sourceSheetTitle'] == calendar.month_name[int(period[5:])]]
            cancelled = any(a.get('lifecycle','active')!='active' and a['sourceYear']==int(period[:4])
                and a['sourceSheetTitle']==calendar.month_name[int(period[5:])] for a in related)
            charge = next((c for c in decode_charges(source.rows.get(CHARGES_TAB,[])) if c.plan_id == plan.id and c.month == period),None)
            occurrence = occurrence_plan(charge,plan) if charge and charge.plan_snapshot else plan
            when = occurrence.due_date(period)
            if charge and charge.payment_date:
                when = date.fromisoformat(charge.payment_date)
            if when is None:
                dates={a.get('expenseDate','') for a in existing if a.get('expenseDate','').startswith(period+'-')}
                when = date.fromisoformat(next(iter(dates))) if len(dates)==1 else None
            if when is None:
                continue
            total = charge.initial_amount_cents if charge else occurrence.amount_cents
            prediction = None
            category = occurrence.category
            if existing:
                target = sum(a.get('settledCents',0) + a.get('outstandingCents',a['partnerShareCents']) for a in existing)
                categories={a['billCategory'] for a in existing if a.get('billCategory')}
                if len(categories)==1:
                    category=next(iter(categories))
            elif cancelled:
                target=0
            else:
                if not plan.active or not occurrence.active or occurrence.split_method == 'none':
                    continue
                if occurrence.kind == 'variable' and total and charge is None:
                    prediction={'source':'configured','sampleCount':0,'basis':'shared_bill_invoice'}
                if occurrence.kind == 'variable' and not total:
                    # Use gross invoices, never the payer's net-after-receipt
                    # source cells, as the estimate for a shared purchase.
                    prediction = invoice_estimate(allocations,period,today.strftime('%Y-%m'))
                    if prediction:
                        total = prediction['amountCents']
                if not total:
                    continue
                target = split_preview(occurrence,total,payer.owner)['partnerCents']
                if prediction:
                    prediction['amountCents']=target
            labels={a['partnerSourceLabel'] for a in allocations if a.get('partnerSourceLabel')}
            result.append(SharedBillForecast(link['id'],period,occurrence.name,category,when.isoformat(),target,
                link['member_plan_id'],next(iter(labels)) if len(labels)==1 else '',prediction))
    return tuple(result)


def remaining_forecast(value: SharedBillForecast, payments: list[Any], source_label: str) -> int:
    from bookiebot.sheets.bills import bill_label_key
    recorded = sum(round(p.amount * 100) for p in payments if source_label and bill_label_key(p.label) == bill_label_key(source_label))
    return max(0,value.target_cents-recorded)
