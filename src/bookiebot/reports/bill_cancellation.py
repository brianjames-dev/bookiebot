"""Reviewed recurring cancellation; corrections belong to their original books/months.

Only automatic, unlinked sources are removable here. Recorded cash, repayments,
bank matches and ambiguous history remain authoritative. Each annual write uses
Bills' existing owner claim and atomic settings receipt; no current-month credit.
"""
from __future__ import annotations

import calendar
from dataclasses import asdict, replace
from datetime import date
import json
import re
from typing import Any

from bookiebot.sheets.recurring import (BILL_TAB, SUBSCRIPTION_TAB, SETTINGS_LOG_TAB, LAST_MONTH,
    BillConflict, BillPlan, BillValidation, fingerprint, month_key, selected, versioned)
from bookiebot.sheets.recurring_rows import decode, encode, runtime_tables
from bookiebot.sheets.recurring_charges import BillCharge, CHARGES_TAB, decode_charges, encode_charges, occurrence_plan, source_anchor
from bookiebot.sheets.recurring_storage import WorkbookSnapshot, SheetBatch, cell, numeric, project_sources, LOG_HEADERS

AUDIT_COLUMN = 'cancellation_audit'


def configured_years(actor: str, today: date) -> list[int]:
    from bookiebot.sheets.reimbursement_history import configured_reimbursement_workbooks
    return sorted(y for y, identity in configured_reimbursement_workbooks(actor, today.year).items() if identity)


def bank_refs(owner: str) -> set[str]:
    from bookiebot.banking.config import load_banking_config
    from bookiebot.banking.service import build_banking_service
    config = load_banking_config()
    if not (config.configured or config.database_url or config.sqlite_path.exists()):
        return set()
    return build_banking_service().store.matched_sheet_refs(owner)


def _plans(source: WorkbookSnapshot, identity: str) -> list[BillPlan]:
    return [p for p in source.settings.plans if p.id == identity]


def _match(source: WorkbookSnapshot, plan: BillPlan) -> BillPlan | None:
    values = [p for p in source.settings.records() if p.id == plan.id]
    if not values:
        values = [p for p in source.settings.records() if p.source_tab == plan.source_tab
                  and p.source_label.casefold() == plan.source_label.casefold()]
    if len(values) > 1:
        raise BillConflict('The historical bill identity is ambiguous. No bill was changed.')
    return values[0] if values else None


def _summary(source: WorkbookSnapshot, period: str, category: str) -> tuple[int, int, int]:
    title = calendar.month_name[int(period[5:])]
    labels = {'subscriptions (wants)'} if category == 'subscriptions_wants' else {'subscriptions (needs)', 'static bills & subscriptions (needs)'}
    found = [i for i, row in enumerate(source.rows[title], 1) if cell([row], 1, 2).strip().casefold() in labels]
    if len(found) != 1:
        raise BillConflict('The subscription subtotal needs verification before removing a charge.')
    column = 4 if category == 'subscriptions_wants' else 3
    return found[0], column, round(numeric(cell(source.rows[title], found[0], column)) * 100)


def _summary_verified(source: WorkbookSnapshot, period: str, category: str) -> bool:
    from bookiebot.reports.expense_breakdown import _subscription_items, _subscription_day_in_month, _subscription_bucket, BudgetMonth
    _, virtual, _ = runtime_tables(source.owner, source.rows.get(BILL_TAB, []), source.rows.get(SUBSCRIPTION_TAB, []),
                                   source.rows.get('Subscriptions', []), source.rows.get(CHARGES_TAB, []))
    month = BudgetMonth(*map(int, period.split('-')))
    expected = sum(round(p.amount * 100) for p in _subscription_items(virtual)
                   if _subscription_bucket(p) == category and _subscription_day_in_month(p, month))
    try:
        return _summary(source, period, category)[2] == expected
    except (BillConflict, ValueError):
        return False


def _matched(refs: set[str], plan: BillPlan, period: str, when: str, row: int | None) -> bool:
    prefixes = {plan.source_range, 'billplan:' + plan.id}
    return any(any(ref == f'{prefix}#pull={key}' for prefix in prefixes if prefix for key in (period, when))
               or row is not None and ref.startswith(f'income!row {row}#') and f'#month={period}' in ref for ref in refs)


def _automatic_formula(source: WorkbookSnapshot, plan: BillPlan, formula: str) -> bool:
    from bookiebot.sheets.recurring_storage import _price_references
    refs=_price_references({tab:source.rows.get(tab,[]) for tab in (BILL_TAB,SUBSCRIPTION_TAB)})
    if plan.version in refs and formula.replace('$','').strip()=='='+refs[plan.version]:
        return True
    # Exact legacy automatic lookup; an arbitrary formula mentioning a hidden
    # schedule is not sufficient evidence that this charge was app-generated.
    from bookiebot.sheets.recurring_rows import header
    from openpyxl.utils import get_column_letter
    names=header(source.rows.get(plan.source_tab,[]))
    label='source_label' if plan.source_tab==BILL_TAB else 'name'
    price='expected_amount' if plan.source_tab==BILL_TAB else 'amount'
    if label not in names or price not in names:
        return False
    col=get_column_letter(names.index(label)+1);money=get_column_letter(names.index(price)+1)
    tab=re.escape(plan.source_tab);name=re.escape(plan.source_label.replace('"','""'))
    return bool(re.fullmatch(rf'=SUMIF\(\s*\'{tab}\'!\$?{col}:\$?{col}\s*,\s*"{name}"\s*,\s*\'{tab}\'!\$?{money}:\$?{money}\s*\)',formula.strip(),re.IGNORECASE))


def book_items(source: WorkbookSnapshot, plan: BillPlan, start: str, today: date, refs: set[str]) -> list[dict[str, Any]]:
    result = []
    charges = {(c.plan_id, c.month): c for c in decode_charges(source.rows.get(CHARGES_TAB, []))}
    for number in range(1, 13):
        period, title = f'{source.year:04d}-{number:02d}', calendar.month_name[number]
        if period < start or title not in source.rows:
            continue
        original = next((p for p in selected(list(source.settings.plans), period, include_inactive=True) if p.id == plan.id), None)
        if original is None:
            continue
        charge = charges.get((plan.id, period))
        prior = occurrence_plan(charge, original) if charge else original
        info = source.charge(original, period)
        when = info.get('date')
        amount = info.get('billAmountCents') if info.get('virtual') else info.get('amountCents')
        if not when or not isinstance(amount, int) or amount <= 0:
            continue
        matched = _matched(refs, prior, period, when, info.get('row'))
        formula = cell(source.formulas[title], info.get('row') or 0, info.get('amountColumn', 3))
        future = when > today.isoformat()
        if future and not (info.get('recorded') or matched or not info.get('virtual') and not formula.startswith('=')):
            continue  # Unentered future schedule/forecast stops automatically.
        reason = ''
        if any(a['sourceYear']==source.year and a['sourceSheetTitle']==title for a in source.bill_allocations(prior, period)):
            reason = 'Shared payment — keep'
        elif matched:
            reason = 'Bank-linked payment — keep'
        elif future:
            reason = 'Confirmed scheduled payment — keep'
        elif charge and (charge.source_action_id or not charge.virtual):
            reason = 'Recorded payment — keep'
        elif not info.get('virtual'):
            if prior.kind == 'variable' or not _automatic_formula(source,prior,formula) or amount != prior.amount_cents:
                reason = 'Entered payment — keep'
        elif not _summary_verified(source, period, prior.category):
            reason = 'Historical subtotal needs verification — keep'
        result.append({'month': period, 'date': when, 'amountCents': amount, 'category': prior.category,
                       'removable': not reason, 'reason': reason, 'virtual': bool(info.get('virtual'))})
    return result


def _frozen(source: WorkbookSnapshot, plan: BillPlan, period: str, today: date) -> BillCharge:
    info = source.charge(plan, period)
    existing = next((c for c in decode_charges(source.rows.get(CHARGES_TAB, [])) if c.plan_id == plan.id and c.month == period), None)
    if existing and existing.plan_snapshot:
        return existing
    when = info.get('date')
    if not when or not info.get('virtual') and info.get('row') is None:
        raise BillConflict('The original payment source needs verification before ending this bill.')
    frozen = plan if plan.pull_day else replace(plan, pull_day=date.fromisoformat(when).day)
    saved = json.dumps(asdict(frozen), sort_keys=True, separators=(',', ':'))
    if existing:
        return replace(existing, plan_snapshot=saved, payment_date=when)
    return BillCharge(plan.id, period, when, plan.source_label, plan.category,
        source.properties[calendar.month_name[int(period[5:])]]['sheetId'], info.get('row') or 0, info['amountColumn'],
        source_anchor(plan.id, period), int(info.get('billAmountCents') or info.get('amountCents') or 0), True,
        created_at=today.isoformat(), payer_owner=source.responsible_owner(plan, period) or '',
        plan_snapshot=saved, virtual=bool(info.get('virtual')), payment_date=when)


def book_batch(source: WorkbookSnapshot, plan: BillPlan, start: str, remove: list[str], today: date,
               refs: set[str], request_id: str = 'end-review-preview') -> tuple[SheetBatch, dict[str, Any]]:
    items = book_items(source, plan, start, today, refs)
    allowed = {item['month'] for item in items if item['removable']}
    if not set(remove) <= allowed:
        raise BillConflict('A selected charge is recorded, linked or changed. Review the removal again.')
    after = replace(plan, active=False, effective_from=start, version='', request_id='')
    plans = versioned(list(source.settings.plans), after, request_id)
    # Kept occurrences retain their exact original definition, independently of
    # the recurring end month. Selected removals cannot revive through a map.
    before_charges = decode_charges(source.rows.get(CHARGES_TAB, []))
    charges = [c for c in before_charges if not (c.plan_id == plan.id and c.month in remove)]
    periods = {item['month'] for item in items if item['month'] not in remove}
    periods.update(f'{source.year:04d}-{n:02d}' for n in range(1, 13)
        if f'{source.year:04d}-{n:02d}' >= start and calendar.month_name[n] in source.rows
        and (candidate := next((p for p in selected(list(source.settings.plans), f'{source.year:04d}-{n:02d}', include_inactive=True) if p.id == plan.id), None))
        and source.charge(candidate, f'{source.year:04d}-{n:02d}').get('recorded'))
    for period in sorted(periods - set(remove)):
        original = next((p for p in selected(list(source.settings.plans), period, include_inactive=True) if p.id == plan.id), None)
        if original:
            frozen = _frozen(source, original, period, today)
            charges = [c for c in charges if (c.plan_id, c.month) != (plan.id, period)] + [frozen]
    batch = SheetBatch(source)
    encoded = encode(plans, plan.source_tab, source.formulas.get(plan.source_tab, []))
    batch.table(plan.source_tab, encoded)
    if charges != before_charges:
        batch.table(CHARGES_TAB, encode_charges(charges, source.rows.get(CHARGES_TAB, [])))
    tables = {tab: encoded if tab == plan.source_tab else source.rows.get(tab, []) for tab in (BILL_TAB, SUBSCRIPTION_TAB)}
    project_sources(batch, plans, tables, start_month=start, today=today, charges=charges,
                    skip_occurrences={(plan.id,period) for period in remove})
    cells = []
    for item in items:
        if item['month'] not in remove:
            continue
        title = calendar.month_name[int(item['month'][5:])]
        original = next(p for p in selected(list(source.settings.plans), item['month'], include_inactive=True) if p.id == plan.id)
        if item['virtual']:
            row, column, amount = _summary(source, item['month'], item['category'])
            remaining = amount - item['amountCents']
            if remaining < 0:
                raise BillConflict('The original subscription subtotal changed.')
            value = f'=SUM({remaining / 100:.2f})+N("{SUBSCRIPTION_TAB}")' if item['month'] >= source.settings.period else remaining / 100
            batch.values(title, row, column, [[value]], formulas=isinstance(value, str))
        else:
            info = source.charge(original, item['month']);row, column = info['row'], info['amountColumn']
            batch.values(title, row, column, [[0]])
        cells.append({'month': item['month'], 'row': row, 'column': column, 'label': cell(source.rows[title], row, 2),
            'beforeCents': round(numeric(cell(source.rows[title], row, column)) * 100),
            'beforeFormula':cell(source.formulas[title],row,column),
            'afterFormula':value if item['virtual'] and isinstance(value,str) else None,
            **({'otherCents':round(numeric(cell(source.rows[title],row,7-column))*100),
                'otherFormula':cell(source.formulas[title],row,7-column)} if not item['virtual'] else {}),
            'afterCents': remaining if item['virtual'] else 0, 'removedCents': item['amountCents']})
    audit = {'version': 1, 'planId': plan.id, 'start': start, 'items': items, 'removeMonths': remove,
        'beforePlans': [asdict(p) for p in _plans(source, plan.id)], 'afterPlans': [asdict(p) for p in plans if p.id == plan.id],
        'beforeCharges': [asdict(c) for c in before_charges if c.plan_id == plan.id],
        'afterCharges': [asdict(c) for c in charges if c.plan_id == plan.id], 'cells': cells}
    return batch, audit


def receipt(batch: SheetBatch, request_id: str, digest: str, result: dict[str, Any], audit: dict[str, Any], today: date):
    source = batch.snapshot
    rows = source.rows.get(SETTINGS_LOG_TAB, [])
    headers = list(rows[0]) if rows else list(LOG_HEADERS)
    if headers[:4] != LOG_HEADERS:
        raise BillConflict('The bill settings receipt needs verification.')
    if AUDIT_COLUMN not in headers:
        headers.append(AUDIT_COLUMN)
    row = [''] * len(headers)
    row[:4] = [request_id, digest, json.dumps(result), today.isoformat()]
    row[headers.index(AUDIT_COLUMN)] = json.dumps(audit, sort_keys=True)
    batch.values(SETTINGS_LOG_TAB, 1, 1, [headers], hidden=True)
    batch.values(SETTINGS_LOG_TAB, max(2, len(rows)+1), 1, [row], hidden=True)


def _book(actor: str, year: int, today: date) -> WorkbookSnapshot:
    from bookiebot.reports.bill_settings import read_workbook
    return read_workbook(actor, today if year == today.year else date(year, 12, 31))


def _validate(source: WorkbookSnapshot, body: dict[str, Any], today: date) -> tuple[BillPlan, str]:
    allowed = {'operation', 'id', 'version', 'settingsVersion', 'effectiveFrom', 'removeMonths', 'reviewVersion', 'requestId'}
    if body.get('operation')=='end-year':
        allowed.update({'year','rootRequestId'})
    if set(body)-allowed or body.get('settingsVersion') != source.settings.version:
        raise BillConflict('Bill settings changed. Review the cancellation again.')
    plan = next((p for p in source.settings.records() if p.id == body.get('id')), None)
    if plan is None or plan.version != body.get('version'):
        raise BillConflict('This bill changed. Review its cancellation again.')
    start = month_key(body.get('effectiveFrom'))
    years = configured_years(source.actor, today)
    if not years or start < f'{min(years):04d}-01' or start >= LAST_MONTH:
        raise BillValidation('Choose a month in your available bill history.')
    remove = body.get('removeMonths')
    if remove is not None and (not isinstance(remove, list) or len(remove)>1200 or any(not isinstance(m,str) for m in remove) or len(set(remove))!=len(remove)):
        raise BillValidation('Choose the individual charges to remove.')
    return plan, start


def review_end(actor: str, source: WorkbookSnapshot, body: dict[str, Any], today: date) -> dict[str, Any]:
    plan, start = _validate(source, body, today)
    refs = bank_refs(source.owner)
    books = {source.year: (source, plan)}
    for year in configured_years(actor, today):
        if int(start[:4]) <= year < today.year:
            old = _book(actor, year, today);match = _match(old, plan)
            if match:
                books[year] = (old, match)
    all_items = sorted([item for book, p in books.values() for item in book_items(book, p, start, today, refs)], key=lambda item:item['month'])
    remove = body.get('removeMonths')
    if remove is None:
        remove = [item['month'] for item in all_items if item['removable']]
    if not set(remove) <= {item['month'] for item in all_items if item['removable']}:
        raise BillConflict('A selected charge can no longer be removed. Review it again.')
    commands = []
    for year, (book, p) in sorted(books.items()):
        local = [m for m in remove if int(m[:4])==year]
        _, audit = book_batch(book, p, start, local, today, refs)
        if year != source.year:
            command = {'operation':'end-year', 'year':year, 'id':p.id, 'version':p.version,
                'settingsVersion':book.settings.version, 'effectiveFrom':start, 'removeMonths':local}
            command['reviewVersion'] = _year_proof(source.owner, command, audit, refs)
            commands.append(command)
    result = {'operation':'end', 'before':plan.public(source.settings.period),
        'after':replace(plan,active=False,effective_from=start).public(source.settings.period), 'effectiveFrom':start,
        'cancellation':{'items':[{**i,'selected':i['month'] in remove} for i in all_items], 'removeMonths':remove,
            'removedCents':sum(i['amountCents'] for i in all_items if i['month'] in remove), 'historyCommands':commands}}
    result['reviewVersion'] = fingerprint([source.owner, source.settings.version, start, result, sorted(refs)])
    return result


def review_year(source: WorkbookSnapshot, body: dict[str, Any], today: date) -> dict[str, Any]:
    plan, start = _validate(source, body, today)
    refs = bank_refs(source.owner)
    command = {k:v for k,v in body.items() if k not in {'rootRequestId','requestId','reviewVersion'}}
    _, audit = book_batch(source, plan, start, body.get('removeMonths') or [], today, refs)
    return {'operation':'end-year', 'reviewVersion':_year_proof(source.owner, command, audit, refs)}


def _year_proof(owner: str, command: dict[str,Any], audit: dict[str,Any], refs: set[str]) -> str:
    # The command binds the complete original source/version and exact month
    # selection. Generated metadata timestamps must not invalidate a safe
    # next-day continuation of already-confirmed historical corrections.
    return fingerprint([owner,command,audit['items'],sorted(refs)])


def child_request_id(root: str, year: int) -> str:
    return 'bill-history-' + fingerprint([root,year])[:48]


def command_source(actor: str, body: dict[str, Any], today: date) -> WorkbookSnapshot:
    year = body.get('year')
    if type(year) is not int or year not in configured_years(actor,today) or year>=today.year:
        raise BillValidation('Choose an available historical bill workbook.')
    return _book(actor,year,today)


def authorized_child(access: Any, owner: str, body: dict[str, Any]):
    with access.connect() as db:
        root=db.execute('SELECT state,result_json FROM app_bill_commands WHERE owner_key=? AND request_id=?',
                        (owner,body.get('rootRequestId'))).fetchone()
    if not root or root['state']!='done':
        raise BillConflict('Check the original cancellation status before continuing its history correction.')
    result=json.loads(root['result_json'])
    if not result.get('success') or not any(c==body for c in result.get('historyCommands',[])):
        raise BillConflict('This historical correction does not match its confirmed cancellation.')


def end_batch(source: WorkbookSnapshot, body: dict[str, Any], checked: dict[str, Any],
              request_id: str, digest: str, today: date) -> tuple[SheetBatch,dict[str,Any]]:
    plan,start=_validate(source,body,today)
    if not isinstance(body.get('removeMonths'),list):
        raise BillValidation('Review the exact charges before ending the bill.')
    local=[m for m in body['removeMonths'] if int(m[:4])==source.year]
    batch,audit=book_batch(source,plan,start,local,today,bank_refs(source.owner),request_id)
    commands=[{**c,'rootRequestId':request_id,'requestId':child_request_id(request_id,c['year'])}
              for c in checked.get('cancellation',{}).get('historyCommands',[])]
    result={'state':'done','success':True,'detail':'Bill ended. Corrections stay in their original months.',
            'historyCommands':commands}
    if body['operation']=='end':
        result['recoveryReview']={**checked,'cancellation':{**checked['cancellation'],'historyCommands':[]}}
    audit.update(operation='end',owner=source.owner,year=source.year,rootRequestId=body.get('rootRequestId',request_id),historyCommands=commands)
    receipt(batch,request_id,digest,result,audit,today)
    return batch,result


def log_audit(source: WorkbookSnapshot, request_id: str) -> dict[str,Any]:
    rows=source.rows.get(SETTINGS_LOG_TAB,[])
    if not rows or AUDIT_COLUMN not in rows[0]:
        raise BillConflict('The original cancellation record is unavailable.')
    row=next((r for r in rows[1:] if r and r[0]==request_id),None)
    if row is None or len(row)<=rows[0].index(AUDIT_COLUMN):
        raise BillConflict('The original cancellation record is unavailable.')
    value=json.loads(row[rows[0].index(AUDIT_COLUMN)])
    if value.get('version')!=1 or value.get('owner')!=source.owner or value.get('year')!=source.year:
        raise BillConflict('The original cancellation record needs verification.')
    return value


def _audit_plans(values: list[dict[str,Any]], identity: str) -> list[BillPlan]:
    try:
        result=[BillPlan(**{**p,'pull_months':tuple(p['pull_months'])}) for p in values]
        if not result or any(p.id!=identity for p in result) or len({p.source_tab for p in result})!=1:
            raise ValueError('identity')
        return decode(encode(result,result[0].source_tab,[]),result[0].source_tab)
    except (ValueError,TypeError,KeyError) as exc:
        raise BillConflict('The original bill configuration needs verification.') from exc


def restore_book(source: WorkbookSnapshot, audit: dict[str,Any], today: date, request_id: str='restore-review-preview') -> tuple[SheetBatch,dict[str,Any]]:
    identity=audit['planId']
    same=lambda a,b:fingerprint(sorted(a,key=lambda p:json.dumps(p,sort_keys=True)))==fingerprint(sorted(b,key=lambda p:json.dumps(p,sort_keys=True)))
    if not same([asdict(p) for p in _plans(source,identity)],audit['afterPlans']):
        raise BillConflict('This bill changed after cancellation. Review its newer settings before restoring history.')
    current_charges=decode_charges(source.rows.get(CHARGES_TAB,[]))
    if not same([asdict(c) for c in current_charges if c.plan_id==identity],audit['afterCharges']):
        raise BillConflict('A bill payment changed after cancellation. Its history cannot be restored automatically.')
    before=_audit_plans(audit['beforePlans'],identity)
    prior_charges=decode_charges(encode_charges([BillCharge(**c) for c in audit['beforeCharges']],[]))
    if any(c.plan_id!=identity for c in prior_charges):
        raise BillConflict('The original payment identity needs verification.')
    plans=[p for p in source.settings.plans if p.id!=identity]+before
    charges=[c for c in current_charges if c.plan_id!=identity]+prior_charges
    batch=SheetBatch(source);tab=before[0].source_tab
    encoded=encode(plans,tab,source.formulas.get(tab,[]));batch.table(tab,encoded)
    if charges!=current_charges:
        batch.table(CHARGES_TAB,encode_charges(charges,source.rows.get(CHARGES_TAB,[])))
    tables={t:encoded if t==tab else source.rows.get(t,[]) for t in (BILL_TAB,SUBSCRIPTION_TAB)}
    project_sources(batch,plans,tables,start_month=audit['start'],today=today,charges=charges,
                    skip_occurrences={(identity,period) for period in audit['removeMonths']})
    from bookiebot.sheets.recurring_storage import _price_references
    price_refs=_price_references(tables)
    for change in audit['cells']:
        period=month_key(change['month']);title=calendar.month_name[int(period[5:])]
        row,column=change['row'],change['column']
        if (int(period[:4])!=source.year or column not in (3,4) or cell(source.rows.get(title,[]),row,2)!=change['label']
                or round(numeric(cell(source.rows[title],row,column))*100)!=change['afterCents']):
            raise BillConflict('A corrected monthly total changed. Review it before restoring this cancellation.')
        formula=cell(source.formulas[title],row,column)
        if 'afterFormula' in change and (formula!=change['afterFormula'] if change['afterFormula'] is not None else formula.startswith('=')):
            raise BillConflict('The corrected source formula changed. Review it before restoring this cancellation.')
        if 'otherCents' in change and (round(numeric(cell(source.rows[title],row,7-column))*100)!=change['otherCents']
                or cell(source.formulas[title],row,7-column)!=change['otherFormula']):
            raise BillConflict('The bill’s other budget column changed. Review it before restoring this cancellation.')
        virtual=any(i['month']==period and i['virtual'] for i in audit['items'])
        if virtual:
            value=f'=SUM({change["beforeCents"]/100:.2f})+N("{SUBSCRIPTION_TAB}")' if period>=source.settings.period else change['beforeCents']/100
        else:
            original=next((p for p in selected(before,period,include_inactive=True) if p.id==identity),None)
            if original is None or original.version not in price_refs:
                raise BillConflict('The original automatic price source needs verification before restoring it.')
            value='='+price_refs[original.version]
        batch.values(title,row,column,[[value]],formulas=isinstance(value,str))
    restore={'version':1,'operation':'restore-end','owner':source.owner,'year':source.year,'planId':identity,
             'undoOf':audit['rootRequestId'],'restoredMonths':audit['removeMonths']}
    return batch,restore


def review_restore(actor: str, source: WorkbookSnapshot, body: dict[str,Any], today: date) -> dict[str,Any]:
    allowed={'operation','id','version','settingsVersion','undoOf','requestId','reviewVersion'}
    if body.get('operation')=='restore-end-year':
        allowed.update({'year','rootRequestId'})
    if set(body)-allowed or body.get('settingsVersion')!=source.settings.version:
        raise BillConflict('Bill settings changed. Review the restoration again.')
    plan=next((p for p in source.settings.records() if p.id==body.get('id')),None)
    if plan is None or plan.version!=body.get('version') or not isinstance(body.get('undoOf'),str):
        raise BillConflict('This bill changed. Review its restoration again.')
    audit=log_audit(source,body['undoOf'])
    if audit.get('operation')!='end' or audit.get('planId')!=plan.id:
        raise BillConflict('Choose this bill’s original cancellation.')
    restore_book(source,audit,today)
    items=[{**i,'selected':i['month'] in audit['removeMonths']} for i in audit['items']]
    commands=[]
    if body['operation']=='restore-end':
        for command in audit.get('historyCommands',[]):
            old=command_source(actor,command,today)
            try:original=log_audit(old,command['requestId'])
            except BillConflict:
                # A never-submitted stage has no correction to undo. An
                # uncertain submitted writer remains blocked by owner claims.
                if old.settings.version!=command['settingsVersion']:
                    raise BillConflict('Check the historical cancellation status before restoring it.')
                continue
            restore_book(old,original,today)
            p=next(p for p in old.settings.records() if p.id==original['planId'])
            child={'operation':'restore-end-year','year':old.year,'id':p.id,'version':p.version,
                'settingsVersion':old.settings.version,'undoOf':command['requestId']}
            child['reviewVersion']=fingerprint([old.owner,child,original])
            commands.append(child)
            items.extend({**i,'selected':i['month'] in original['removeMonths']} for i in original['items'])
    before=_audit_plans(audit['beforePlans'],plan.id)
    result={'operation':body['operation'],'before':plan.public(source.settings.period),
        'after':next((p for p in selected(before,source.settings.period,include_inactive=True)),before[-1]).public(source.settings.period),
        'effectiveFrom':audit['start'],'cancellation':{'direction':'restore','items':sorted(items,key=lambda i:i['month']),
            'removeMonths':[i['month'] for i in items if i['selected']],
            'removedCents':sum(i['amountCents'] for i in items if i['selected']),'historyCommands':commands}}
    command={k:v for k,v in body.items() if k not in {'rootRequestId','requestId','reviewVersion'}}
    result['reviewVersion']=fingerprint([source.owner,command,audit]) if body['operation']=='restore-end-year' else fingerprint([source.owner,source.settings.version,result])
    return result


def restore_batch(source: WorkbookSnapshot,body:dict[str,Any],checked:dict[str,Any],request_id:str,digest:str,today:date) -> tuple[SheetBatch,dict[str,Any]]:
    audit=log_audit(source,body['undoOf'])
    batch,restored=restore_book(source,audit,today,request_id)
    commands=[{**c,'rootRequestId':request_id,'requestId':child_request_id(request_id,c['year'])} for c in checked['cancellation']['historyCommands']]
    result={'state':'done','success':True,'detail':'Cancellation restored in the original months.','historyCommands':commands}
    if body['operation']=='restore-end':
        result['recoveryReview']={**checked,'cancellation':{**checked['cancellation'],'historyCommands':[]}}
    receipt(batch,request_id,digest,result,restored,today)
    return batch,result


def latest_cancellation(source: WorkbookSnapshot, identity: str) -> str | None:
    rows=source.rows.get(SETTINGS_LOG_TAB,[])
    if not rows or AUDIT_COLUMN not in rows[0]:
        return None
    column=rows[0].index(AUDIT_COLUMN)
    for row in reversed(rows[1:]):
        if len(row)>column and row[column]:
            value=json.loads(row[column])
            if value.get('planId')==identity and value.get('owner')==source.owner:
                return row[0] if value.get('operation')=='end' and value.get('rootRequestId')==row[0] else None
    return None
