from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest

from unit_tests.reports.test_accounts import store
from bookiebot.reports import shared_bills
from bookiebot.reports.accounts import AccountConflict
from bookiebot.reports.shared_bill_store import SharedBillStore
from bookiebot.sheets import recurring_storage

BRIAN='676638528590970917'
HANNAH='830984827904851969'


@pytest.fixture
def catalog(store):
    result=SharedBillStore(store)
    result.initialize()
    return result


def people(catalog):
    return shared_bills.account_for(BRIAN,store=catalog),shared_bills.account_for(HANNAH,store=catalog)


def apply(catalog,action,actor=None,revision=0,**kwargs):
    payer,member=people(catalog)
    return catalog.apply(actor=actor or (member if action in {'accept','decline'} else payer),payer=payer,member=member,
        plan_id='rent-plan',member_plan_id=kwargs.pop('member_plan_id',''),action=action,revision=revision,
        request_id=kwargs.pop('request_id',uuid4().hex),fingerprint=kwargs.pop('fingerprint','fixture-change'))


def bill(identity='rent-plan',name='Rent'):
    return {'id':identity,'name':name,'version':'plan-v1','type':'fixed','amountCents':300000,'cadence':'monthly',
        'pullDay':1,'pullMonths':[],'category':'rent','account':'Private account label', 'active':True,
        'effectiveFrom':'2026-11','effectiveUntil':'9999-12','splitMethod':'custom','payerBasisPoints':6667,
        'nextDate':'2026-12-01','needsSetup':False,'earliestEffectiveMonth':'2026-11','nextChange':None,
        'charge':{'amountCents':230000,'billAmountCents':300000,'date':'2026-11-01','status':'paid','recorded':True},'prediction':None}


def listing(actor):
    return {'month':'2026-11','ownerName':'Brian' if actor==BRIAN else 'Hannah','settingsVersion':'v1',
        'bills':[bill(),bill('private-streaming','Unshared streaming')] if actor==BRIAN else [bill('member-rent')]}


def ledger(_owner):
    return {'allocations':[{'id':'rent-november','billPlanId':'rent-plan','payerOwner':'brian','partnerOwner':'hannah',
        'sourceYear':2026,'sourceSheetTitle':'November','grossCents':300000,'payerShareCents':200000,'partnerShareCents':100000,
        'settledCents':70000,'outstandingCents':30000}], 'events':[]}


def test_invitation_acceptance_is_scoped_and_retains_one_authoritative_plan(catalog):
    payer,member=people(catalog)
    initial=apply(catalog,'invite')
    assert initial['status']=='pending' and catalog.links(payer)[0]['plan_id']=='rent-plan'
    assert catalog.links(member)[0]['status']=='pending'
    with pytest.raises(AccountConflict,match='invited person'):
        apply(catalog,'accept',actor=payer,revision=1)
    accepted=apply(catalog,'accept',revision=1,member_plan_id='member-rent')
    assert accepted['id']==initial['id'] and accepted['status']=='active'
    assert catalog.revision('brian')==catalog.revision('hannah')==2
    own=listing(HANNAH);before=deepcopy(own)
    result=shared_bills.enrich_listing(HANNAH,own,store=catalog,load=listing,ledger_read=ledger)
    assert own==before
    assert [b['name'] for b in result['bills']]==['Rent']
    shared=result['bills'][0]
    assert shared['readOnly'] and shared['id']=='shared:'+initial['id']
    assert shared['account']=='' and 'Unshared streaming' not in str(result)
    assert shared['amountCents']==99990, 'The saved recurring rule is distinct from this cycle’s original allocation'
    state=shared['sharing']['state']
    assert state['memberShareCents']==100000 and shared['charge']['amountCents']==100000
    assert state['receivedCents']==70000 and state['remainingCents']==30000
    assert state['paymentStatus']=='paid' and state['repaymentStatus']=='partial'
    assert state['purchaseTotalCents']==300000
    assert len(catalog.links(member))==1


def test_acceptance_never_hides_unverified_same_name_plan_or_duplicates_money(catalog):
    apply(catalog,'invite');apply(catalog,'accept',revision=1)
    result=shared_bills.enrich_listing(HANNAH,listing(HANNAH),store=catalog,load=listing,ledger_read=ledger)
    assert len(result['bills'])==2, 'Unlinked legacy setup must not be silently hidden by a name match'
    with catalog.access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS n FROM app_bill_shares').fetchone()['n']==1
    assert ledger('brian')['allocations'][0]['settledCents']==70000


def test_replayed_confirmation_has_one_membership_one_revision_and_private_recovery(catalog):
    payer,member=people(catalog)
    identity=uuid4().hex
    first=apply(catalog,'invite',request_id=identity,fingerprint='same')
    assert apply(catalog,'invite',request_id=identity,fingerprint='same')==first
    assert catalog.revision('brian')==1
    assert catalog.recover(identity,payer)==first and catalog.recover(identity,member) is None
    with pytest.raises(AccountConflict,match='different change'):
        apply(catalog,'invite',request_id=identity,fingerprint='different')
    apply(catalog,'accept',revision=1)
    apply(catalog,'stop',actor=member,revision=2)
    assert catalog.links(payer)[0]['status']=='revoked'
    result=shared_bills.enrich_listing(HANNAH,listing(HANNAH),store=catalog,
        load=lambda _:pytest.fail('Revoked membership may not read the payer’s bill'),ledger_read=ledger)
    assert not any(b.get('readOnly') for b in result['bills'])
    assert catalog.recover(identity,payer)==first, 'Recovery never resurrects a later-revoked membership'


def test_source_payment_and_receipt_status_are_independent_and_use_original_cycle(catalog):
    apply(catalog,'invite');apply(catalog,'accept',revision=1)
    def early(actor):
        data=listing(actor);data['bills'][0]['charge']['status']='confirmed';return data
    def settled(_):
        data=ledger(_);data['allocations'][0].update(settledCents=100000,outstandingCents=0)
        # A differently dated month's allocation must not alter this cycle.
        data['allocations'].append({**data['allocations'][0],'id':'december','sourceSheetTitle':'December','settledCents':0,'outstandingCents':100000})
        return data
    result=shared_bills.enrich_listing(HANNAH,listing(HANNAH),store=catalog,load=early,ledger_read=settled)
    state=next(b for b in result['bills'] if b.get('readOnly'))['sharing']['state']
    assert state['paymentStatus']=='confirmed' and state['repaymentStatus']=='settled'
    assert state['receivedCents']==100000 and state['remainingCents']==0


def test_one_review_checks_permissions_plan_changes_and_original_request_recovery(catalog,monkeypatch):
    from bookiebot.reports import bill_settings
    monkeypatch.setattr(bill_settings,'listing',listing)
    body={'action':'invite','billId':'rent-plan'}
    checked=shared_bills.review(BRIAN,body,store=catalog,load=listing)
    assert '_payer' not in shared_bills.public_review(checked)
    with pytest.raises(AccountConflict,match='changed'):
        shared_bills.command(BRIAN,{**body,'requestId':uuid4().hex,'reviewVersion':'stale'},store=catalog)
    command={**body,'requestId':uuid4().hex,'reviewVersion':checked['reviewVersion']}
    saved=shared_bills.command(BRIAN,command,store=catalog)
    monkeypatch.setattr(bill_settings,'listing',lambda _:pytest.fail('Recover the saved request before reading mutable Sheets'))
    assert shared_bills.command(BRIAN,command,store=catalog)==saved
    with pytest.raises(AccountConflict):
        shared_bills.command(HANNAH,command,store=catalog)


def test_accept_review_coalesces_only_canonical_partner_bill_lineage(catalog,monkeypatch):
    apply(catalog,'invite')
    payer,member=people(catalog)
    identity=catalog.links(member)[0]['id']
    snapshot=SimpleNamespace(allocations=[{'payerOwner':'brian','partnerOwner':'hannah','billPlanId':'rent-plan','partnerSourceLabel':'Rent'}],
        settings=SimpleNamespace(plans=[],records=lambda:[SimpleNamespace(id='member-rent',source_label='Rent')]))
    monkeypatch.setattr(recurring_storage,'read_workbook',lambda *_:snapshot)
    checked=shared_bills.review(HANNAH,{'action':'accept','shareId':identity},store=catalog,load=listing)
    assert checked['_memberPlanId']=='member-rent'
    snapshot.allocations[0]['billPlanId']='unrelated'
    checked=shared_bills.review(HANNAH,{'action':'accept','shareId':identity},store=catalog,load=listing)
    assert checked['_memberPlanId']==''
    with pytest.raises(AccountConflict,match='invited person'):
        shared_bills.review(BRIAN,{'action':'accept','shareId':identity},store=catalog,load=listing)


def test_future_split_can_be_shared_without_rewriting_current_unsplit_occurrence(catalog):
    def future(actor):
        value=listing(actor);value['bills'][0]['splitMethod']='none'
        value['bills'][0]['nextChange']={**bill(),'effectiveFrom':'2026-12','version':'future-v1','amountCents':330000}
        return value
    checked=shared_bills.review(BRIAN,{'action':'invite','billId':'rent-plan'},store=catalog,load=future)
    assert checked['bill']['effectiveFrom']=='2026-12' and checked['bill']['amountCents']==330000
    apply(catalog,'invite');apply(catalog,'accept',revision=1)
    result=shared_bills.enrich_listing(HANNAH,listing(HANNAH),store=catalog,load=future,ledger_read=ledger)
    value=next(b for b in result['bills'] if b.get('readOnly'))
    assert value['sharing']['state']['memberShareCents']==100000
    assert value['nextChange']['amountCents']==109989 and value['nextChange']['account']==''


@pytest.mark.parametrize('recorded', [True,False])
def test_variable_invitation_review_separates_monthly_input_from_recorded_invoice(catalog,monkeypatch,recorded):
    apply(catalog,'invite');_,member=people(catalog)
    identity=catalog.links(member)[0]['id']
    monkeypatch.setattr(recurring_storage,'read_workbook',lambda *_:SimpleNamespace(allocations=[],
        settings=SimpleNamespace(plans=[],records=lambda:[])))
    def variable(actor):
        value=listing(actor);current=value['bills'][0]
        current.update(type='variable',amountCents=None)
        current['charge']={**current['charge'],'recorded':recorded,'status':'confirmed' if recorded else 'unconfirmed'}
        current['nextChange']={**current,'nextChange':None,'effectiveFrom':'2026-12','version':'future-variable'}
        return value
    checked=shared_bills.public_review(shared_bills.review(HANNAH,{'action':'accept','shareId':identity},store=catalog,load=variable))
    assert checked['bill']['type']=='variable' and checked['bill']['amountCents'] is None
    assert checked['bill']['effectiveFrom']=='2026-12'
    assert checked['currentCharge']==({'month':'2026-11','amountCents':300000,'date':'2026-11-01'} if recorded else None)
    assert 'Private account' not in str(checked)
    assert catalog.links(member)[0]['status']=='pending'


def test_acceptance_blocks_a_competing_positive_recurring_plan(catalog,monkeypatch):
    apply(catalog,'invite');_,member=people(catalog)
    identity=catalog.links(member)[0]['id']
    local=SimpleNamespace(id='member-rent',source_label='Rent',active=True,amount_cents=100000,effective_until='9999-12')
    snapshot=SimpleNamespace(allocations=[{'payerOwner':'brian','partnerOwner':'hannah','billPlanId':'rent-plan','partnerSourceLabel':'Rent'}],
        settings=SimpleNamespace(plans=[local],records=lambda:[local]))
    monkeypatch.setattr(recurring_storage,'read_workbook',lambda *_:snapshot)
    with pytest.raises(AccountConflict,match='separate recurring setup'):
        shared_bills.review(HANNAH,{'action':'accept','shareId':identity},store=catalog,load=listing)
    assert catalog.links(member)[0]['status']=='pending'


def test_sharing_rechecks_source_inside_the_existing_financial_mutation_lock(catalog,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from bookiebot.sheets import undo
    from bookiebot.reports import bill_settings
    entered,read=Event(),Event()
    source=listing(BRIAN)
    body={'action':'invite','billId':'rent-plan'}
    checked=shared_bills.review(BRIAN,body,store=catalog,load=lambda _:source)
    saved=catalog.saved
    def lookup(*args):
        result=saved(*args);entered.set();return result
    def load(_):
        read.set();return source
    monkeypatch.setattr(catalog,'saved',lookup)
    monkeypatch.setattr(bill_settings,'listing',load)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with undo._RECENT_MUTATION_LOCK:
            pending=executor.submit(shared_bills.command,BRIAN,
                {**body,'requestId':uuid4().hex,'reviewVersion':checked['reviewVersion']},store=catalog)
            assert entered.wait(5)
            assert not read.wait(.1), 'Sharing may not inspect mutable Sheets outside the Bills lock'
            source['bills'][0]['version']='edited-on-another-device'
        with pytest.raises(AccountConflict,match='changed'):
            pending.result(timeout=5)
    assert catalog.links(people(catalog)[0])==[]


def test_two_accepted_links_cannot_adopt_the_same_member_source(catalog):
    payer,member=people(catalog)
    apply(catalog,'invite');apply(catalog,'accept',revision=1,member_plan_id='member-rent')
    other={"payer":payer,"member":member,"plan_id":"other-rent","member_plan_id":"member-rent",
        "request_id":uuid4().hex,"fingerprint":"other","revision":0}
    catalog.apply(actor=payer,action='invite',**other)
    with pytest.raises(AccountConflict,match='different shared bill'):
        catalog.apply(actor=member,action='accept',**{**other,'revision':1,'request_id':uuid4().hex})
