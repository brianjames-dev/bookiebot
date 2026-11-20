"""Correct the withdrawal date of one existing physical bill occurrence."""
import calendar
import json
from dataclasses import replace
from datetime import date
from typing import Any

from bookiebot.sheets.recurring import BillConflict, BillValidation, SETTINGS_LOG_TAB, fingerprint, selected
from bookiebot.sheets.recurring_charges import CHARGES_TAB, BillCharge, decode_charges, encode_charges, source_anchor
from bookiebot.sheets.recurring_storage import LOG_HEADERS, SheetBatch, WorkbookSnapshot
from bookiebot.sheets.routing import now_pacific


def prepare_date(source: WorkbookSnapshot, body: dict[str, Any], today: date):
    period = source.settings.period
    if (set(body) - {"operation", "id", "month", "paymentDate", "chargeVersion", "requestId", "reviewVersion"}
            or body.get("month") != period or period != today.strftime("%Y-%m")):
        raise BillValidation("Choose this month’s recorded bill.")
    proposed = body.get("paymentDate")
    try:
        if not isinstance(proposed, str):
            raise ValueError
        when = date.fromisoformat(proposed)
        if when.isoformat() != proposed or when.strftime("%Y-%m") != period:
            raise ValueError
    except ValueError:
        raise BillValidation("Choose a payment date within this month.") from None
    plan = next((p for p in selected(list(source.settings.plans), period) if p.id == body.get("id")), None)
    if plan is None:
        raise BillConflict("This bill is unavailable in the current month.")
    info = source.charge(plan, period)
    if plan.id in source.delegated_payers or not info.get("canEditPaymentDate"):
        raise BillValidation("Only the payer can change the date of an existing bill charge.")
    if body.get("chargeVersion") != info["version"]:
        raise BillConflict("This bill charge changed. Refresh Bills and review it again.")
    if proposed == info.get("date"):
        raise BillValidation("Choose a different payment date.")

    raw = source.rows.get(CHARGES_TAB, [])
    charges = decode_charges(raw)
    prior = next((c for c in charges if c.plan_id == plan.id and c.month == period), None)
    title = calendar.month_name[int(period[5:])]
    sheet = source.properties[title]["sheetId"]
    if prior:
        if prior.worksheet_id != sheet or prior.virtual:
            raise BillConflict("This bill charge’s original source needs review.")
        charges[charges.index(prior)] = replace(prior, payment_date=proposed)
    else:
        # Older physical charges may only have the budget row and action log.
        # Add the date to that existing plan/month identity without touching it.
        entered = info.get("date") or proposed
        initial = info.get("billAmountCents")
        charges.append(BillCharge(plan.id, period, entered, info["sourceLabel"], plan.category, sheet,
            info["row"], info["amountColumn"], source_anchor(plan.id, period),
            info["amountCents"] if initial is None else initial, True, payer_owner=source.owner, payment_date=proposed))
    review = {"operation": "payment-date", "name": plan.name, "month": period,
              "previousDate": info.get("date"), "date": proposed,
              "reviewVersion": fingerprint([source.owner, plan.id, info["version"], info.get("date"), proposed])}
    return review, encode_charges(charges, raw)


def date_batch(source: WorkbookSnapshot, rows: list[list[str]], request_id: str, digest: str):
    result = {"state": "done", "success": True, "detail": "Payment date updated."}
    batch = SheetBatch(source)
    batch.table(CHARGES_TAB, rows)
    batch.values(SETTINGS_LOG_TAB, 1, 1, [LOG_HEADERS], hidden=True)
    batch.values(SETTINGS_LOG_TAB, max(2, len(source.rows.get(SETTINGS_LOG_TAB, [])) + 1), 1,
                 [[request_id, digest, json.dumps(result), now_pacific().isoformat()]], hidden=True)
    return batch, result
