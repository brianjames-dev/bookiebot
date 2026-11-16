"""Shared bill read model and explicitly reviewed membership changes.

One payer's hidden plan remains authoritative. Accepting/sharing never writes
charges, changes a split, records a repayment, or copies a recurring plan.
"""
from __future__ import annotations

import calendar
from functools import lru_cache
import re
from typing import Any

from bookiebot.reports.accounts import Account, AccountConflict, account_store
from bookiebot.reports.app_access import AppAccessStore, AppSession
from bookiebot.reports.shared_bill_store import SharedBillStore
from bookiebot.reports.shared_bill_identity import source_index, related_allocations, member_source
from bookiebot.sheets.recurring import fingerprint
from bookiebot.sheets.routing import get_user_config, get_discord_user_config


@lru_cache(maxsize=8)
def _store_for(access: AppAccessStore) -> SharedBillStore:
    result = SharedBillStore(account_store(access))
    result.initialize()
    return result


def build_store() -> SharedBillStore:
    from bookiebot.reports.phone_app import build_app_access_store
    return _store_for(build_app_access_store())


def account_for(actor: str, *, store: SharedBillStore | None = None) -> Account:
    config = get_user_config(actor)
    adapter = next((key for key,value in get_discord_user_config().items()
                    if key.isdecimal() and value.budget_owner_key == config.budget_owner_key),actor)
    return (store or build_store()).accounts.for_session(AppSession(adapter, config.budget_owner_key, 0), config.name)


def _configured_partner(account: Account, store: SharedBillStore) -> Account:
    # Current workbook adapters already define the two-person financial pair.
    # This does not authorize sharing; every bill still requires acceptance.
    from bookiebot.sheets.collaboration import partner_owner_key
    owner = partner_owner_key(account.owner)
    match = next(((actor, config) for actor, config in get_discord_user_config().items()
                  if actor.isdecimal() and config.budget_owner_key == owner), None)
    if match is None:
        raise AccountConflict('Connect the other person’s BookieBot account first.')
    return account_for(match[0], store=store)


def _validate_adapter(account: Account) -> None:
    if get_user_config(account.actor).budget_owner_key != account.owner:
        raise AccountConflict('A shared workbook connection changed. Reconnect before continuing.')


def delegated_payers(actor: str) -> dict[str, str]:
    from bookiebot.sheets.routing import UnknownDiscordUserError
    try:
        store = build_store()
        account = account_for(actor, store=store)
    except UnknownDiscordUserError:
        return {}
    return {link['member_plan_id']:link['payer_owner'] for link in store.links(account)
            if link['member_id'] == account.id and link['status'] == 'active' and link['member_plan_id']}


def _accounts(link: dict[str, Any]) -> tuple[Account, Account]:
    payer = Account(link['payer_id'], link['payer_owner'], link['payer_actor'], link['payer_name'])
    member = Account(link['member_id'], link['member_owner'], link['member_actor'], link['member_name'])
    _validate_adapter(payer)
    _validate_adapter(member)
    return payer, member


def _parts(bill: dict[str, Any], cents: int, owner: str) -> tuple[int, int]:
    from bookiebot.sheets.collaboration import split_amounts
    method = bill['splitMethod']
    if method == 'none':
        return cents, 0
    first, second = split_amounts(cents / 100, method, owner,
        custom_payer_basis_points=bill['payerBasisPoints'] if method == 'custom' else None)
    return round(first * 100), round(second * 100)


def _state(bill: dict[str, Any], link: dict[str, Any], period: str, ledger: dict[str, Any],
           related: list[dict[str, Any]]) -> dict[str, Any]:
    values = [a for a in related if a.get('sourceYear') == int(period[:4])
              and a.get('sourceSheetTitle') == calendar.month_name[int(period[5:])]
              and a.get('lifecycle','active')=='active']
    cancelled = not values and any(a.get('lifecycle','active')!='active' and a.get('sourceYear')==int(period[:4])
        and a.get('sourceSheetTitle')==calendar.month_name[int(period[5:])] for a in related)
    known = bill.get('charge', {}).get('billAmountCents')
    estimate = None
    if bill['type'] == 'variable' and not values and not bill.get('charge',{}).get('recorded') and not bill.get('charge',{}).get('amountCents'):
        from bookiebot.reports.shared_bill_forecast import invoice_estimate
        from bookiebot.sheets.routing import now_pacific
        estimate = ({'amountCents':bill['amountCents'],'source':'configured','sampleCount':0,'basis':'shared_bill_invoice'}
            if bill.get('amountCents') else invoice_estimate(related,period,now_pacific().strftime('%Y-%m')))
    total = (sum(a['grossCents'] for a in values) if values else known
             if isinstance(known, int) and known > 0 else bill.get('amountCents'))
    if not total and estimate:
        total = estimate.get('amountCents')
    payer_share, member_share = _parts(bill, int(total or 0), link['payer_owner'])
    if values:
        payer_share = sum(a['payerShareCents'] for a in values)
        member_share = sum(a['partnerShareCents'] for a in values)
    elif cancelled:
        payer_share,member_share=int(total or 0),0
    paid_back = sum(a['settledCents'] for a in values)
    cleared = sum(a.get('clearedCents',0) for a in values)
    remaining = sum(a['outstandingCents'] for a in values) if values else 0
    pending = any(e.get('status') == 'pending' and e.get('allocationId') in {a['id'] for a in values}
                  for e in ledger.get('events', []))
    return {'purchaseTotalCents': total, 'payerShareCents': payer_share, 'memberShareCents': member_share,
            'receivedCents': paid_back, 'remainingCents': remaining,'clearedCents':cleared,
            'repaymentStatus': 'cancelled' if cancelled else 'not-billed' if not values else 'reported' if pending else 'cleared' if remaining == 0 and cleared else 'settled' if remaining == 0 else 'partial' if paid_back else 'outstanding',
            'paymentStatus': bill.get('charge', {}).get('status', 'unconfirmed'),
            'paymentDate': bill.get('charge', {}).get('date'), 'predicted': bool(estimate and not values),
            'allocationIds': [a['id'] for a in values], 'month': period,
            'prediction': {**estimate,'amountCents':member_share} if estimate and not values else None}


def _public_link(link: dict[str, Any], viewer: Account) -> dict[str, Any]:
    return {'id': link['id'], 'revision': link['revision'], 'status': link['status'],
            'role': 'payer' if link['payer_id'] == viewer.id else 'member',
            'payerName': link['payer_name'], 'memberName': link['member_name']}


def enrich_listing(actor: str, own: dict[str, Any], *, store: SharedBillStore | None = None,
                   load: Any = None, ledger_read: Any = None) -> dict[str, Any]:
    store = store or build_store()
    account = account_for(actor, store=store)
    partner = _configured_partner(account, store)
    links = store.links(account)
    own_bills = [{**bill, 'sharing': None} for bill in own.get('bills', [])]
    by_id = {bill['id']: bill for bill in own_bills}
    for link in links:
        if link['payer_id'] == account.id and link['plan_id'] in by_id:
            by_id[link['plan_id']]['sharing'] = _public_link(link, account)
    result = {**own, 'bills': own_bills, 'sharingPartner': {'id': partner.id, 'name': partner.name}}
    incoming = [link for link in links if link['member_id'] == account.id and link['status'] in {'active', 'pending'}]
    # Existing memberships own their verified mirror before invitations are
    # considered, regardless of SQL creation/order. A pending conflict must
    # remain accessible so it can be declined, never block the entire page.
    incoming.sort(key=lambda link: link['status'] != 'active')
    if not incoming:
        return result
    if load is None:
        from bookiebot.reports.bill_settings import listing
        load = listing
    if ledger_read is None:
        from bookiebot.reimbursements import service
        ledger_read = lambda owner: service.build_reimbursement_store().snapshot(owner,include_inactive=True) if service.enabled() else {}
    sources: dict[str, Any] = {}
    ledgers: dict[str, Any] = {}
    hidden = set()
    member_sources = source_index((b['id'], b.get('sourceLabel', '')) for b in own_bills)
    adopted: dict[str, str] = {}
    for link in incoming:
        payer, _ = _accounts(link)
        source = sources.setdefault(payer.id, None)
        if source is None:
            source = sources[payer.id] = load(payer.actor)
            ledgers[payer.id] = ledger_read(payer.owner)
        bill = next((b for b in source['bills'] if b['id'] == link['plan_id']), None)
        if bill is None:
            # Fail visibly rather than silently dropping a shared obligation.
            raise AccountConflict('A shared bill’s source is unavailable. Refresh or ask its payer to check Bills.')
        related = related_allocations(ledgers[payer.id].get('allocations', []), plan_id=link['plan_id'],
            payer=payer.owner, member=account.owner,
            sources=source_index((b['id'], b.get('sourceLabel', '')) for b in source['bills']),
            starts={b['id']: b.get('sourceFrom', b['effectiveFrom']) for b in source['bills']})
        local_id = link['member_plan_id'] or member_source(related, member_sources)
        # An independent positive rule must remain visible until explicitly
        # ended. Acceptance also rechecks its complete effective-dated source.
        local = by_id.get(local_id)
        if not link['member_plan_id'] and local:
            from bookiebot.sheets.recurring_charges import following_month
            if local.get('hasFutureAmount') or any(p.get('active') and p.get('amountCents') and p['effectiveUntil'] > following_month(own['month'])
                   for p in (local, local.get('nextChange')) if p):
                local_id = ''
        if local_id:
            if local_id in adopted and link['status'] == 'active':
                raise AccountConflict('Different shared bills refer to the same local bill. Check their sources before continuing.')
            if local_id not in adopted:
                adopted[local_id] = link['id']
                hidden.add(local_id)
        state = _state(bill, link, own['month'], ledgers[payer.id], related)
        sharing = {**_public_link(link, account), 'state': state, 'sourcePlanId': link['plan_id']}
        future = bill.get('nextChange')
        if future:
            amount = future.get('amountCents')
            future = {**future,'account':'','id':'shared:'+link['id'],
                'amountCents':_parts(future,amount,payer.owner)[1] if isinstance(amount,int) else None,
                'prediction':None}
        # Keep the total out of the recipient's ordinary amount field. The
        # shared editor names total/share/received explicitly and has no writer.
        result['bills'].append({**bill, 'id': 'shared:' + link['id'], 'account': '', 'nextChange': future,
            'amountCents': _parts(bill,bill['amountCents'],payer.owner)[1] if isinstance(bill.get('amountCents'),int) else None,
            'prediction': state['prediction'], 'readOnly': True, 'sharing': sharing,
            'charge': {**bill.get('charge', {}), 'amountCents': state['memberShareCents'],
                'billAmountCents': state['memberShareCents'], 'canConfirmAmount': False},
            'version': fingerprint([bill['version'], sharing, future])})
    result['bills'] = [b for b in result['bills'] if b['id'] not in hidden]
    return result


def review(actor: str, body: dict[str, Any], *, store: SharedBillStore | None = None,
           load: Any = None) -> dict[str, Any]:
    if (set(body) - {'action', 'billId', 'shareId', 'reviewVersion', 'requestId'}
            or body.get('action') not in {'invite', 'accept', 'decline', 'stop'}):
        raise AccountConflict('Choose a bill-sharing action.')
    store = store or build_store()
    viewer = account_for(actor, store=store)
    if load is None:
        from bookiebot.reports.bill_settings import listing
        load = listing
    links = store.links(viewer)
    if body['action'] == 'invite':
        payer, member = viewer, _configured_partner(viewer, store)
        plan_id = body.get('billId')
        if not isinstance(plan_id, str) or not plan_id or len(plan_id) > 96 or body.get('shareId'):
            raise AccountConflict('Choose one of your saved bills to share.')
        link = next((item for item in links if item['plan_id'] == plan_id and item['payer_id'] == viewer.id), None)
        if link and link['status'] in {'active', 'pending'}:
            raise AccountConflict('This bill is already shared or waiting for acceptance.')
    else:
        link = next((item for item in links if item['id'] == body.get('shareId')), None)
        if link is None:
            raise AccountConflict('This sharing request is unavailable.')
        payer, member = _accounts(link)
        plan_id = link['plan_id']
        if body['action'] in {'accept', 'decline'} and (viewer.id != member.id or link['status'] != 'pending'):
            raise AccountConflict('Only the invited person can respond to this bill.')
        if body['action'] == 'stop' and link['status'] not in {'active', 'pending'}:
            raise AccountConflict('This bill is no longer shared.')
    source = load(payer.actor) if body['action'] in {'invite', 'accept'} else None
    bill = next((b for b in source['bills'] if b['id'] == plan_id), None) if source else None
    future = bill.get('nextChange') if bill else None
    configuration = future if future and future['active'] and future['splitMethod'] != 'none' else bill
    if body['action'] in {'invite', 'accept'} and (configuration is None or not configuration['active'] or configuration['splitMethod'] == 'none'):
        raise AccountConflict('Save this bill’s recurring split before sharing it.')
    if body['action'] in {'invite','accept'} and configuration and configuration.get('needsSetup'):
        raise AccountConflict('Finish this bill’s amount and payment schedule before sharing it.')
    member_plan_id = link['member_plan_id'] if link else ''
    # Coalesce a legacy recipient plan only with canonical bill lineage, never
    # merely because two merchants happen to have the same display name.
    if body['action'] == 'accept':
        from bookiebot.sheets.recurring_storage import read_workbook
        from bookiebot.sheets.routing import now_pacific
        assert source is not None and link is not None
        snapshot = read_workbook(member.actor, now_pacific().date())
        related = related_allocations(snapshot.allocations, plan_id=plan_id, payer=payer.owner, member=member.owner,
            sources=source_index((b['id'], b.get('sourceLabel', '')) for b in source['bills']),
            starts={b['id']: b.get('sourceFrom', b['effectiveFrom']) for b in source['bills']})
        member_plan_id = member_source(related, source_index((p.id, p.source_label) for p in snapshot.settings.records()))
        if member_plan_id:
            for other in links:
                if other['id'] == link['id'] or other['member_id'] != member.id or other['status'] != 'active':
                    continue
                other_local = other['member_plan_id']
                if not other_local and other['payer_id'] == payer.id:
                    prior = related_allocations(snapshot.allocations, plan_id=other['plan_id'], payer=payer.owner, member=member.owner,
                        sources=source_index((b['id'], b.get('sourceLabel', '')) for b in source['bills']),
                        starts={b['id']: b.get('sourceFrom', b['effectiveFrom']) for b in source['bills']})
                    other_local = member_source(prior, source_index((p.id, p.source_label) for p in snapshot.settings.records()))
                if other_local == member_plan_id:
                    raise AccountConflict('A different shared bill already uses this local bill source.')
            from datetime import date
            current = now_pacific().date()
            following = date(current.year + (current.month == 12), current.month % 12 + 1, 1).strftime('%Y-%m')
            if any(p.id == member_plan_id and p.active and p.amount_cents
                   and p.effective_until > following for p in snapshot.settings.plans):
                raise AccountConflict('End your separate recurring setup for this bill from next month first, then accept the shared bill. Existing charges stay unchanged.')
    version = fingerprint([viewer.id, body['action'], payer.id, member.id, plan_id,
        link['revision'] if link else 0, bill['version'] if bill else None,
        configuration['version'] if configuration else None, member_plan_id])
    return {'action': body['action'], 'reviewVersion': version, 'shareId': SharedBillStore.identity(payer.id, member.id, plan_id),
        'revision': link['revision'] if link else 0, 'name': bill['name'] if bill else None,
        'payerName': payer.name, 'memberName': member.name,
        'bill': {k:v for k,v in configuration.items() if k in {'name','type','amountCents','cadence','pullDay','splitMethod','payerBasisPoints','effectiveFrom'}} if configuration else None,
        '_payer': payer, '_member': member, '_planId': plan_id, '_memberPlanId': member_plan_id}


def public_review(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if not key.startswith('_')}


def command(actor: str, body: dict[str, Any], *, store: SharedBillStore | None = None,
            session_token: str | None = None) -> dict[str, Any]:
    store = store or build_store()
    if not isinstance(body.get('requestId'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', body['requestId']):
        raise AccountConflict('Use the original bill-sharing request to check its status.')
    viewer = account_for(actor, store=store)
    digest = fingerprint(body)
    saved = store.saved(body['requestId'], viewer, digest)
    if saved is not None:
        return saved
    from bookiebot.sheets import undo
    from bookiebot.reimbursements.projection import projection_lock
    # Use the same process/PG locks as Bills and financial projections. The
    # member's local schedule must not change between the fresh source check
    # and acceptance, or an independent schedule could duplicate its forecast.
    # SharedBillStore uses the same operational database as the money ledger.
    with undo._RECENT_MUTATION_LOCK, projection_lock(store):
        saved = store.saved(body['requestId'], viewer, digest)
        if saved is not None:
            return saved
        checked = review(actor, body, store=store)
        if body.get('reviewVersion') != checked['reviewVersion']:
            raise AccountConflict('This shared bill changed. Review it again before confirming.')
        return store.apply(actor=viewer, payer=checked['_payer'], member=checked['_member'],
            plan_id=checked['_planId'], member_plan_id=checked['_memberPlanId'], action=body['action'],
            revision=checked['revision'], request_id=body['requestId'], fingerprint=digest,session_token=session_token)
