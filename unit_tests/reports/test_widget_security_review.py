"""Independent adversarial checks for widget capability and worker lifecycles."""
import asyncio
from threading import Event

import pytest

from bookiebot.reports import phone_app, phone_widgets, widget_store
from unit_tests.reports.test_phone_widgets import BRIAN, HANNAH, client, grant, read


@pytest.mark.asyncio
async def test_pair_mode_edit_does_not_consume_code_without_returning_valid_grant(client, monkeypatch):
    pairing = client.widgets.issue_pairing(BRIAN, "brian", "My widget", "current")
    consume = client.widgets.consume_pairing

    def changed_during_exchange(token):
        result = consume(token)
        assert result is not None
        client.widgets.set_mode("brian", result[1].id, "projected")
        return result

    monkeypatch.setattr(client.widgets, "consume_pairing", changed_during_exchange)
    response = await client.http.post("/app/widgets/pair", json={"pairingToken": pairing["pairingToken"]})
    assert response.status == 200
    value = await response.json()
    assert value["mode"] == "projected"
    current = client.widgets.get_grant(value["token"])
    assert current is not None and current.id == pairing["id"] and current.mode == "projected"


@pytest.mark.asyncio
async def test_grant_expiring_during_financial_read_returns_no_figures(client, monkeypatch):
    token, connection = grant(client)

    def expire(data):
        monkeypatch.setattr(widget_store, "_now", lambda: connection.expires_at)
        return data

    client.state.revise = expire
    response = await read(client, token)
    assert response.status == 401
    assert "budgetRemaining" not in await response.text()


@pytest.mark.asyncio
async def test_revocation_after_final_lookup_but_before_touch_returns_no_figures(client, monkeypatch):
    token, connection = grant(client)
    touch = client.widgets.touch_grant

    def revoke_before_touch(value):
        client.widgets.revoke("brian", connection.id)
        return touch(value)

    monkeypatch.setattr(client.widgets, "touch_grant", revoke_before_touch)
    response = await read(client, token)
    assert response.status == 401
    assert "budgetRemaining" not in await response.text()


@pytest.mark.asyncio
async def test_reset_during_read_revokes_pending_and_active_for_one_owner(client):
    token, _ = grant(client)
    other, _ = grant(client, HANNAH, "hannah")
    pending = client.widgets.issue_pairing(BRIAN, "brian", "Second", "current")

    def reset(data):
        phone_app.reset_phone_access(BRIAN)
        return data

    client.state.revise = reset
    response = await read(client, token)
    assert response.status == 401 and "budgetRemaining" not in await response.text()
    assert client.widgets.consume_pairing(pending["pairingToken"]) is None
    client.state.revise = None
    assert (await read(client, other)).status == 200


@pytest.mark.asyncio
async def test_cancelled_waiters_retain_one_build_per_owner_and_cache_only_minimal_snapshot(client):
    snapshots = client.app[phone_widgets._WIDGET_SNAPSHOTS]
    release, brian_started, hannah_started = Event(), Event(), Event()

    def delayed(data):
        (brian_started if data["ownerName"] == "Brian" else hannah_started).set()
        assert release.wait(3)
        return data

    client.state.revise = delayed
    day = client.state.now.date().isoformat()
    brian_payload = {"actor_key": BRIAN, "owner_name": "Brian", "persons": ["Brian (BofA)"],
                     "year": client.state.now.year, "month": client.state.now.month}
    hannah_payload = {**brian_payload, "actor_key": HANNAH, "owner_name": "Hannah", "persons": ["Hannah"]}
    readers = [asyncio.create_task(snapshots.read(client.app, payload, day))
               for payload in [brian_payload, hannah_payload] * 10]
    try:
        assert await asyncio.to_thread(brian_started.wait, 1)
        assert await asyncio.to_thread(hannah_started.wait, 1)
        for reader in readers:
            reader.cancel()
        cancelled = await asyncio.gather(*readers, return_exceptions=True)
        assert all(isinstance(result, asyncio.CancelledError) for result in cancelled)
        assert len(snapshots.tasks) == 2 and len(client.state.calls) == 2
    finally:
        release.set()
    await asyncio.gather(*snapshots.tasks.values())
    brian = await snapshots.read(client.app, brian_payload, day)
    hannah = await snapshots.read(client.app, hannah_payload, day)
    assert brian["ownerName"] == "Brian" and hannah["ownerName"] == "Hannah"
    assert len(client.state.calls) == 2 and snapshots.tasks == {}
    assert len(snapshots.saved) == 2
    assert "privateItems" not in str(snapshots.saved)
    assert "must never leave this server" not in str(snapshots.saved)


@pytest.mark.asyncio
async def test_snapshot_inflight_limit_rejects_extra_scope_without_cancelling_existing_work(client, monkeypatch):
    snapshots = phone_widgets._WidgetSnapshots()
    release = asyncio.Event()
    all_started = asyncio.Event()
    started = 0

    async def build(_app, payload, day):
        nonlocal started
        started += 1
        if started == 8:
            all_started.set()
        await release.wait()
        return {"updatedAt": client.state.now.isoformat(), "ownerName": payload["owner_name"]}

    monkeypatch.setattr(snapshots, "_build", build)
    payload = {"actor_key": BRIAN, "owner_name": "Brian", "persons": ["Brian (BofA)"]}
    day = client.state.now.date().isoformat()
    readers = [asyncio.create_task(snapshots.read(client.app, {**payload, "actor_key": str(index)}, day))
               for index in range(8)]
    try:
        await asyncio.wait_for(all_started.wait(), timeout=1)
        with pytest.raises(RuntimeError, match="busy"):
            await snapshots.read(client.app, {**payload, "actor_key": "overflow"}, day)
        assert len(snapshots.tasks) == 8
    finally:
        release.set()
        await asyncio.gather(*readers, return_exceptions=True)
    await snapshots.close()
    assert snapshots.tasks == {} and snapshots.saved == {}
