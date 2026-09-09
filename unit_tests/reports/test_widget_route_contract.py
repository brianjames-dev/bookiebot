"""Real Python producers and the delivered Scriptable consumer share one contract."""
import asyncio
import json
from pathlib import Path
import shutil

import pytest

from unit_tests.reports.test_phone_widgets import (
    BRIAN, HANNAH, HEADERS, ORIGIN, client, connect,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("actor,owner,name", [(BRIAN, "brian", "Brian"), (HANNAH, "hannah", "Hannah")])
@pytest.mark.parametrize("mode", ["current", "projected"])
async def test_actual_widget_routes_accept_distributed_script_requests(client, tmp_path, actor, owner, name, mode):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the Scriptable route contract")
    connect(client, actor, owner)
    issued = await client.http.post("/app/widgets/settings", json={
        "operation": "pair", "label": "Synthetic route contract", "mode": mode,
    }, headers=HEADERS)
    assert issued.status == 200
    setup = (await issued.json())["pairing"]["setupCode"]
    downloaded = await client.http.get("/app/widgets/script")
    assert downloaded.status == 200
    script_path = tmp_path / "BookieBot.js"
    script_path.write_text(await downloaded.text(), encoding="utf-8")
    input_path = tmp_path / "contract.json"
    input_path.write_text(json.dumps({
        "origin": ORIGIN, "localOrigin": str(client.http.make_url("/"))[:-1],
        "scriptPath": str(script_path), "setupCode": setup, "ownerName": name, "mode": mode,
        "budgetRemaining": 1234.56 if mode == "current" else 2345.67,
        "availableToday": 22.35 if mode == "current" else -10.55,
    }), encoding="utf-8")
    root = Path(__file__).resolve().parents[2]
    process = await asyncio.create_subprocess_exec(
        node, str(root / "unit_tests/reports/widget_route_contract_test.cjs"), str(input_path),
        cwd=root, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, stderr.decode() or stdout.decode()
    connections = client.widgets.list_connections(owner)["connections"]
    assert len(connections) == 1
    assert connections[0]["status"] == "active"
    assert connections[0]["lastUsedAt"] is not None
    assert len(client.state.calls) == 1, "widget executions should reuse the source snapshot"
