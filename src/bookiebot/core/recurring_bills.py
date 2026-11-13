"""Apply explicitly saved recurring split defaults once to new due charges."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from bookiebot.sheets.routing import now_pacific

logger = logging.getLogger(__name__)
_TASK: asyncio.Task | None = None


def process_owner(actor: str) -> int:
    from bookiebot.reports.bill_settings import read_workbook, review, build_commands
    from bookiebot.sheets.recurring import selected, fingerprint, BillConflict, BillValidation, BILL_TAB, SUBSCRIPTION_TAB
    from bookiebot.reimbursements.service import enabled
    today = now_pacific().date()
    source = read_workbook(actor, today)
    commands = build_commands()
    pending = commands.pending(source.owner)
    if pending and pending.get("operation") in {"project", "rollover", "scheduled"}:
        commands.saved(actor, pending["requestId"])
    if commands.blocked(source.owner):
        return 0
    from bookiebot.sheets.recurring_rows import managed
    if any(not managed(source.rows.get(t, [])) for t in (BILL_TAB, SUBSCRIPTION_TAB)):
        from bookiebot.reports.bill_settings import carry_year
        if carry_year(actor, source, commands):
            source = read_workbook(actor, today)
    if any(managed(source.rows.get(t, [])) for t in (BILL_TAB, SUBSCRIPTION_TAB)):
        from bookiebot.reports.bill_settings import prepare_month
        if prepare_month(actor, source, commands):
            source = read_workbook(actor, today)
    if not enabled():
        return 0
    count = 0
    for plan in selected(list(source.settings.plans), source.settings.period):
        due = plan.due_date(source.settings.period)
        if (plan.kind == "variable" or plan.split_method == "none" or plan.request_id == "baseline" or not due
                or not plan.split_starts_on <= due.isoformat() <= today.isoformat()):
            continue
        request_id = "bill-auto-" + fingerprint([source.owner, plan.id, source.settings.period, plan.version, int(time.time() // 300)])[:40]
        previous = commands.saved(actor, request_id)
        if previous is not None:
            continue  # An uncertain writer is inspected, never submitted twice.
        # Refresh after each prior charge; reviews bind the whole current source.
        source = read_workbook(actor, today)
        info = source.charge(plan, source.settings.period)
        if info.get("recorded"):
            continue
        body = {"operation": "scheduled", "id": plan.id, "month": source.settings.period,
                "settingsVersion": source.settings.version, "chargeVersion": info["version"]}
        try:
            checked = review(actor, body, snapshot=source)
        except (BillConflict, BillValidation):
            continue
        result = commands.command(actor, {**body, "reviewVersion": checked["reviewVersion"], "requestId": request_id})
        count += int(result.get("success", False))
        if result["state"] != "done":
            break
    return count


async def _loop():
    from bookiebot.sheets.routing import get_discord_user_config, APPLE_SHORTCUT_RELAY_USER_ID
    while True:
        owners = set()
        for actor, config in get_discord_user_config().items():
            if actor == APPLE_SHORTCUT_RELAY_USER_ID or config.budget_owner_key in owners:
                continue
            owners.add(config.budget_owner_key)
            try:
                await asyncio.to_thread(process_owner, actor)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Recurring bill processing needs verification")
        await asyncio.sleep(300)


def ensure_recurring_bill_loop() -> asyncio.Task:
    global _TASK
    if _TASK is None or _TASK.done():
        _TASK = asyncio.create_task(_loop())
    return _TASK
