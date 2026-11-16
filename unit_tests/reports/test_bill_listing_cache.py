import asyncio
from threading import Event

import pytest

from bookiebot.reports import bill_listing_cache as module


@pytest.mark.asyncio
async def test_simultaneous_reads_and_disconnected_clients_share_one_build():
    cache = module.BillListingCache()
    started, release = Event(), Event()
    calls = []
    def build():
        calls.append(1); started.set()
        assert release.wait(5)
        return {'bills':[{'amountCents':12345}]}
    key = ('actor','owner','2026-11-16',1,'ledger-v1')
    first = asyncio.create_task(cache.read(key,build))
    assert await asyncio.to_thread(started.wait,5)
    second = asyncio.create_task(cache.read(key,build))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    result = await second
    result['bills'][0]['amountCents']=0
    assert (await cache.read(key,build))['bills'][0]['amountCents']==12345
    assert calls==[1]
    await cache.close()


@pytest.mark.asyncio
async def test_expiry_fresh_refresh_and_failures_never_restore_old_results(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(module.time,'monotonic',lambda:clock[0])
    cache = module.BillListingCache()
    key = ('actor','owner','2026-11-16',1,'ledger-v1')
    count = 0
    def build():
        nonlocal count
        count+=1
        return {'version':count}
    assert (await cache.read(key,build))['version']==1
    assert (await cache.read(key,build))['version']==1
    assert (await cache.read(key,build,fresh=True))['version']==2
    clock[0]+=cache.seconds
    assert (await cache.read(key,build))['version']==3
    def fail():
        raise RuntimeError('Sheets busy')
    with pytest.raises(RuntimeError,match='Sheets busy'):
        await cache.read(key,fail,fresh=True)
    assert (await cache.read(key,build))['version']==4, 'A failed explicit refresh cannot revive a previous success'
    await cache.close()


@pytest.mark.asyncio
async def test_slow_build_has_no_new_cache_lifetime_and_boundaries_stay_isolated(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(module.time,'monotonic',lambda:clock[0])
    cache = module.BillListingCache()
    base = ('actor','owner','2026-11-16',1,'ledger-v1')
    calls = []
    def slow():
        calls.append(1); clock[0]+=cache.seconds
        return {'read':len(calls)}
    assert (await cache.read(base,slow))['read']==1
    assert (await cache.read(base,slow))['read']==2
    keys = [base,('other','owner',*base[2:]),('actor','other',*base[2:]),
        (*base[:2],'2026-11-17',*base[3:]),(*base[:3],2,base[4]),(*base[:4],'ledger-v2')]
    for index,key in enumerate(keys):
        assert (await cache.read(key,lambda index=index:{'scope':index}))['scope']==index
    for index,key in enumerate(keys):
        assert (await cache.read(key,lambda:pytest.fail('Reuse only the exact scope')))['scope']==index
    await cache.close()
