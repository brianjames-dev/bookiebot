"""Read-only combined bill/charge targets; canonical writers remain unchanged."""
from dataclasses import replace
from typing import Any

from bookiebot.sheets.recurring import BillConflict, BillValidation, BillPlan, fingerprint, selected
from bookiebot.sheets.recurring_storage import WorkbookSnapshot


def current_target(actor: str, source: WorkbookSnapshot, plan: BillPlan, *,
                   amount: int | None = None, method: str | None = None,
                   payer_cents: int | None = None, expected_version: str | None = None) -> dict[str, Any] | None:
    from bookiebot.reports.bill_settings import charge_transaction, split_preview, _amount_review
    period = source.settings.period
    info = source.charge(plan, period)
    from bookiebot.sheets.routing import now_pacific
    from bookiebot.reimbursements.service import MAX_CENTS
    today = source.as_of or now_pacific().date()
    hit = info.get("recorded") or info.get("date") and info["date"] <= today.isoformat() and (
        info.get("amountCents", 0) > 0 or info.get("virtual") and (info.get("billAmountCents") or 0) > 0)
    if not info.get("available") or not hit:
        return None
    virtual = bool(info.get("virtual"))
    if virtual:
        checked = _amount_review(source, {"operation": "adopt", "id": plan.id, "month": period,
            "settingsVersion": source.settings.version, "chargeVersion": info["version"]}, today)
        row = {"id": "", "month": period, "version": info["version"], "billPlanId": plan.id,
               "title": plan.name, "date": info["date"], "amountCents": checked["amount"],
               "split": "", "splitOptions": {}, "capabilities": {}, "reasons": {}}
    else:
        row = charge_transaction(actor, plan.id, period)["item"]
    if expected_version is not None and row["version"] != expected_version:
        raise BillConflict("This charge changed. Reload it before reviewing a change.")
    gross = row["amountCents"] if amount is None else amount
    if type(gross) is not int or not 0 < gross <= MAX_CENTS:
        raise BillValidation("Enter a positive bill amount in whole cents.")
    chosen = method if method is not None else plan.split_method
    if chosen not in {"none", "income", "equal", "custom", "fronted"}:
        raise BillValidation("Choose an available bill split.")
    proposed = replace(plan, split_method=chosen)
    share = split_preview(proposed, gross, source.owner)
    if chosen == "custom" and payer_cents is not None:
        if type(payer_cents) is not int or not 0 <= payer_cents <= gross:
            raise BillValidation("Enter a share between zero and the bill amount.")
        share.update(payerCents=payer_cents, partnerCents=gross-payer_cents)
    previous_method = row.get("split") or "none"
    previous_payer = row.get("splitOptions", {}).get("payerCents", row["amountCents"])
    changed_amount = gross != row["amountCents"]
    changed_split = chosen != previous_method or chosen != "none" and share["payerCents"] != previous_payer
    if not changed_amount and not changed_split:
        return None
    reason = "Fronted is unavailable for recorded bill payments." if chosen == "fronted" else ""
    if not virtual:
        required = (["update"] if changed_amount else []) + (["cancel_split" if chosen == "none" else "split"] if changed_split else [])
        reason = reason or next((row.get("reasons", {}).get(op) or "This recorded charge cannot be changed here."
                       for op in required if not row.get("capabilities", {}).get(op)), "")
        if row.get("repayment") and not row["repayment"].get("canEdit"):
            reason = row["repayment"].get("editReason") or "This split needs review in Shared."
    return {"id": plan.id, "month": period, "source": row, "adopt": virtual,
            "target": {"amountCents": gross, "method": chosen, **share},
            "amountChanged": changed_amount, "splitChanged": changed_split,
            "blockedReason": reason}


def configuration_target(actor: str, source: WorkbookSnapshot, change: Any) -> dict[str, Any] | None:
    if change.operation != "update" or change.after.effective_from != source.settings.period:
        return None
    prior = next((p for p in selected(list(source.settings.plans), source.settings.period) if p.id == change.after.id), None)
    if prior is None:
        return None
    # The old occurrence owns its identity/timing; only the explicitly reviewed
    # amount and split are optional current-charge targets.
    target_plan = replace(prior, split_method=change.after.split_method,
                          payer_basis_points=change.after.payer_basis_points)
    return current_target(actor, source, target_plan,
        amount=None if change.after.kind == "variable" else change.after.amount_cents)


def review_current(actor: str, source: WorkbookSnapshot, body: dict[str, Any]) -> dict[str, Any]:
    allowed = {"operation", "id", "month", "version", "amountCents", "method", "payerShareCents"}
    if set(body) - allowed or body.get("month") != source.settings.period or not isinstance(body.get("version"), str):
        raise BillValidation("Choose this month's recorded bill.")
    if body.get("method") != "custom" and "payerShareCents" in body:
        raise BillValidation("Only a custom split can change its share.")
    plan = next((p for p in source.settings.records() if p.id == body.get("id")), None)
    if plan is None:
        raise BillConflict("This bill is unavailable.")
    target = current_target(actor, source, plan, amount=body.get("amountCents"), method=body.get("method"),
                            payer_cents=body.get("payerShareCents"), expected_version=body["version"])
    if target is None:
        raise BillValidation("The recorded amount and split are unchanged.")
    if target["blockedReason"]:
        raise BillValidation(target["blockedReason"])
    return {"operation": "current", "currentChange": target,
            "reviewVersion": fingerprint([source.owner, source.settings.version, body, target])}
