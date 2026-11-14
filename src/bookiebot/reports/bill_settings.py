"""Private Bills reviews; schedules remain in Sheets, claims are operational."""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import date, datetime, timezone
from functools import lru_cache
import json
import logging
import re
from typing import Any, cast

from bookiebot.reports.app_access import PostgresAppAccessStore, build_app_access_store
from bookiebot.sheets import undo
from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, SETTINGS_LOG_TAB, BillConflict, BillValidation, BillPlan, fingerprint, month_key, money_cents, selected
from bookiebot.sheets.recurring_changes import prepare_change
from bookiebot.sheets.recurring_storage import (
    WorkbookSnapshot, SheetBatch, LOG_HEADERS, read_workbook, configuration_batch, row_for, cell, _add_to_subtotal,
)
from bookiebot.sheets.recurring_charges import CHARGES_TAB, BillCharge, decode_charges, encode_charges, source_anchor
from bookiebot.sheets.routing import now_pacific, get_user_config
from bookiebot.sheets.repo import sheet_command_context

logger = logging.getLogger(__name__)


def split_preview(plan: BillPlan, amount: int, owner: str) -> dict[str, Any]:
    from bookiebot.sheets.collaboration import split_amounts, partner_owner_key, SplitMethod
    if plan.split_method == "none":
        payer, partner = amount, 0
    else:
        a, b = split_amounts(amount / 100, cast(SplitMethod, plan.split_method), owner,
            custom_payer_basis_points=plan.payer_basis_points if plan.split_method == "custom" else None)
        payer, partner = round(a * 100), round(b * 100)
    return {"method": plan.split_method, "payerCents": payer, "partnerCents": partner,
            "payerName": owner.title(), "partnerName": partner_owner_key(owner).title()}


def listing(actor: str) -> dict[str, Any]:
    today = now_pacific().date()
    snapshot = read_workbook(actor, today)
    from bookiebot.sheets.collaboration import split_amounts, partner_owner_key
    from bookiebot.reimbursements.service import enabled
    income_basis = round(split_amounts(100, "income", snapshot.owner)[0] * 100)
    import calendar
    from bookiebot.reports.bill_predictions import predict_bill
    from bookiebot.sheets.bills import bill_label_key
    from bookiebot.reports.expense_breakdown import BudgetMonth, _optional_previous_year_budget_history
    prior = _optional_previous_year_budget_history(actor, BudgetMonth(snapshot.year, today.month), client=snapshot.client)
    history = [(f"{item.month.year:04d}-{item.month.month:02d}", item.rows) for item in prior]
    history.extend((f"{snapshot.year:04d}-{number:02d}", snapshot.rows[title])
                   for number, title in enumerate(calendar.month_name) if number and title in snapshot.rows)

    def public(plan: BillPlan, period: str) -> dict[str, Any]:
        value = plan.public(period, as_of=today)
        info = snapshot.charge(plan, period)
        prediction = (predict_bill(plan.source_label, history, period, as_of=today,
            override_cents=plan.amount_cents, amount_column=4 if plan.category == "subscriptions_wants" else 3)
            if plan.kind == "variable" and plan.active and info.get("available")
            and not info.get("recorded") and not info.get("amountCents")
            and sum(bill_label_key(other.source_label) == bill_label_key(plan.source_label)
                    for other in selected(list(snapshot.settings.plans), period, include_inactive=True)) == 1 else None)
        value["prediction"] = prediction.public() if prediction else None
        return value

    return {"month": snapshot.settings.period, "today": today.isoformat(), "settingsVersion": snapshot.settings.version,
            "ownerName": snapshot.owner.title(), "partnerName": partner_owner_key(snapshot.owner).title(),
            "incomeBasisPoints": income_basis, "splitsEnabled": enabled(),
            "bills": [{**public(p, snapshot.settings.period),
                "nextChange": next((public(future, future.effective_from)
                    for future in sorted(snapshot.settings.plans, key=lambda value: value.effective_from)
                    if future.id == p.id and future.effective_from > snapshot.settings.period), None),
                "earliestEffectiveMonth": snapshot.settings.earliest_months.get(p.id, snapshot.settings.period) if p.pull_day else snapshot.settings.period,
                "charge": {k: v for k, v in snapshot.charge(p, snapshot.settings.period).items() if k not in {"row", "amountColumn", "sourceLabel"}}}
                for p in snapshot.settings.records()]}


def _amount_review(snapshot: WorkbookSnapshot, body: dict[str, Any], today: date) -> dict[str, Any]:
    allowed = {"operation", "id", "month", "amount", "settingsVersion", "chargeVersion", "reviewVersion", "requestId"}
    if set(body) - allowed or body.get("operation") not in {"amount", "adopt", "scheduled"}:
        raise BillValidation("Choose a bill amount action.")
    period = month_key(body.get("month"))
    if period != snapshot.settings.period:
        raise BillValidation("Enter this month's amount here. Edit recorded charges in Transactions.")
    if body.get("settingsVersion") != snapshot.settings.version:
        raise BillConflict("Bill settings changed. Refresh before entering an amount.")
    plan = next((p for p in selected(list(snapshot.settings.plans), period) if p.id == body.get("id")), None)
    if plan is None:
        raise BillConflict("This bill is unavailable in the selected month.")
    info = snapshot.charge(plan, period)
    if plan.kind == "variable" and not info.get("canConfirmAmount", True):
        raise BillValidation("Only this bill's payer can confirm its invoice amount.")
    if plan.kind == "variable" and plan.due_date(period) is None:
        raise BillValidation("Set this bill's payment day and billing months before confirming its amount.")
    if not info.get("available") or body.get("chargeVersion") != info.get("version"):
        raise BillConflict("This charge changed. Refresh before entering an amount.")
    if info.get("recorded"):
        raise BillConflict("This charge is already recorded. Open This month's bill in Bills to edit its amount or split.")
    operation = body["operation"]
    if operation == "scheduled":
        due = plan.due_date(period)
        if (plan.kind == "variable" or plan.split_method == "none" or not plan.amount_cents or not due
                or not plan.split_starts_on <= due.isoformat() <= today.isoformat() or plan.request_id == "baseline"):
            raise BillValidation("This bill has no new scheduled split to record.")
        title = now_pacific().strftime("%B")
        if info.get("amountCents", 0) and info["amountCents"] != plan.amount_cents:
            raise BillConflict("This amount was already entered. Open its existing split in Transactions.")
        amount, method = plan.amount_cents, plan.split_method
    elif operation == "adopt":
        due = plan.due_date(period)
        if not info.get("virtual") or not due or due > today or not plan.amount_cents:
            raise BillValidation("This scheduled charge is not ready to edit.")
        if info.get("row") is not None:
            raise BillConflict("A budget row already uses this subscription name. Check that source before making a separate charge editable.")
        amount = plan.amount_cents
        method = "none"  # Recurring defaults never rewrite an existing charge.
    else:
        amount = money_cents(body.get("amount")) or 0
        if plan.kind != "variable" or amount <= 0 or info.get("amountCents", 0) > 0:
            raise BillValidation("Enter a new variable bill amount, or edit the confirmed charge in Bills.")
        method = plan.split_method
    share = split_preview(plan, amount, snapshot.owner) if method != "none" else {"method": "none", "payerCents": amount, "partnerCents": 0}
    if method != "none":
        from bookiebot.reimbursements.service import enabled
        if not enabled():
            raise BillValidation("Shared splits are unavailable. Try again when Shared is connected.")
    from dataclasses import replace
    reviewed_plan = replace(plan, split_method=method)
    charge_date = plan.due_date(period) if operation in {"adopt", "scheduled"} else today
    assert charge_date is not None
    version = fingerprint([snapshot.owner, snapshot.settings.version, operation, asdict(reviewed_plan), info["version"], amount, share, charge_date.isoformat()])
    return {"plan": reviewed_plan, "info": info, "amount": amount, "date": charge_date.isoformat(),
            "review": {"operation": operation, "name": plan.name, "amountCents": amount, "month": period,
                       "date": charge_date.isoformat(), "paymentDate": info.get("date"), "share": share, "reviewVersion": version}}


def review(actor: str, body: dict[str, Any], *, snapshot: WorkbookSnapshot | None = None) -> dict[str, Any]:
    today = now_pacific().date()
    source = snapshot or read_workbook(actor, today)
    if body.get("operation") == "rollover":
        return _carry_review(source, body, today)["review"]
    if body.get("operation") == "project":
        return _projection_review(source, body, today)["review"]
    if body.get("operation") in {"amount", "adopt", "scheduled"}:
        return _amount_review(source, body, today)["review"]
    change = prepare_change(source.settings, body, today=today)
    from bookiebot.reimbursements.service import enabled
    if change.after.split_method != "none" and not enabled():
        raise BillValidation("Shared splits are unavailable. Try again when Shared is connected.")
    configuration_batch(source, change, "review-preview", fingerprint(body), "{}", today=today)
    return change.public()


def _carry_review(source: WorkbookSnapshot, body: dict[str, Any], today: date) -> dict[str, Any]:
    from bookiebot.sheets.recurring_rows import managed, decode
    from bookiebot.sheets.routing import MissingYearConfigError
    if set(body) - {"operation", "settingsVersion", "reviewVersion", "requestId"} or body.get("settingsVersion") != source.settings.version:
        raise BillConflict("The new year's bill source changed. Refresh before continuing.")
    try:
        previous = read_workbook(source.actor, date(today.year - 1, 12, 31))
    except MissingYearConfigError as exc:
        raise BillValidation("No earlier recurring bill settings need carrying forward.") from exc
    tables = {t: previous.formulas[t] for t in (BILL_TAB, SUBSCRIPTION_TAB)
              if not managed(source.rows.get(t, [])) and managed(previous.rows.get(t, []))}
    if not tables:
        raise BillValidation("Recurring bills are already ready for this year.")
    plans = [p for p in source.settings.plans if p.source_tab not in tables]
    for title in tables:
        plans.extend(decode(previous.rows[title], title))
    return {"tables": tables, "plans": plans, "review": {"operation": "rollover", "year": today.year,
        "reviewVersion": fingerprint([source.owner, source.settings.version, previous.settings.version, tables])}}


def carry_year(actor: str, source: WorkbookSnapshot, commands: BillCommands) -> bool:
    """Fallback for installations whose external rollover script is older."""
    body = {"operation": "rollover", "settingsVersion": source.settings.version}
    try:
        checked = _carry_review(source, body, now_pacific().date())["review"]
    except BillValidation:
        return False
    request_id = commands.preparation_request_id(source.owner, "bill-year-" + fingerprint([source.owner, source.year, checked["reviewVersion"]])[:40])
    result = commands.command(actor, {**body, "reviewVersion": checked["reviewVersion"], "requestId": request_id})
    return bool(result.get("success"))


def _projection_review(source: WorkbookSnapshot, body: dict[str, Any], today: date) -> dict[str, Any]:
    from bookiebot.sheets.recurring_storage import project_sources
    if set(body) - {"operation", "settingsVersion", "reviewVersion", "requestId"} or body.get("settingsVersion") != source.settings.version:
        raise BillConflict("Bill sources changed. Refresh before preparing this month.")
    batch = SheetBatch(source)
    project_sources(batch, list(source.settings.plans), {t: source.rows.get(t, []) for t in (BILL_TAB, SUBSCRIPTION_TAB)},
                    start_month=source.settings.period, today=today, update_existing=False)
    return {"batch": batch, "review": {"operation": "project", "reviewVersion": fingerprint([source.owner, source.settings.version, batch.requests])}}


def prepare_month(actor: str, source: WorkbookSnapshot, commands: BillCommands) -> bool:
    checked = _projection_review(source, {"operation": "project", "settingsVersion": source.settings.version}, now_pacific().date())
    if not checked["batch"].requests:
        return False
    request_id = commands.preparation_request_id(source.owner, "bill-month-" + checked["review"]["reviewVersion"][:40])
    result = commands.command(actor, {"operation": "project", "settingsVersion": source.settings.version,
        "requestId": request_id, "reviewVersion": checked["review"]["reviewVersion"]})
    return bool(result.get("success"))


def charge_batch(snapshot: WorkbookSnapshot, checked: dict[str, Any], request_id: str) -> tuple[SheetBatch, BillCharge]:
    plan, info = checked["plan"], checked["info"]
    period, amount = info["month"], checked["amount"]
    title = now_pacific().strftime("%B")
    rows, formulas = snapshot.rows[title], snapshot.formulas[title]
    row, column = info["row"], info["amountColumn"]
    batch = SheetBatch(snapshot)
    if row is None:
        row = max(len(rows), len(formulas)) + 2
        batch.values(title, row, 2, [[plan.source_label]])
        _add_to_subtotal(batch, title, formulas, column, [f"{'D' if column == 4 else 'C'}{row}"])
    batch.anchor(title, row, column, plan.id, period)
    batch.values(title, row, column, [[amount / 100]])
    charge = BillCharge(plan.id, period, checked["date"], plan.source_label, plan.category,
        snapshot.properties[title]["sheetId"], row, column, source_anchor(plan.id, period), amount, True, "", request_id,
        now_pacific().isoformat(), snapshot.owner)
    existing = decode_charges(snapshot.rows.get(CHARGES_TAB, []))
    batch.table(CHARGES_TAB, encode_charges([*existing, charge], snapshot.rows.get(CHARGES_TAB, [])))
    if not plan.monthly_source:
        from bookiebot.sheets.recurring_rows import encode, managed
        from bookiebot.sheets.recurring_storage import project_subscription_summaries
        plans = list(snapshot.settings.plans)
        tables = {t: snapshot.rows.get(t, []) for t in (BILL_TAB, SUBSCRIPTION_TAB)}
        if not managed(tables[SUBSCRIPTION_TAB]):
            # Explicit adoption enrolls the complete legacy subscription
            # baseline. Inspection/review never provisions or writes it.
            tables[SUBSCRIPTION_TAB] = encode(plans, SUBSCRIPTION_TAB, snapshot.formulas.get(SUBSCRIPTION_TAB, []))
            batch.table(SUBSCRIPTION_TAB, tables[SUBSCRIPTION_TAB])
        handled = project_subscription_summaries(batch, plans, tables, start_month=period,
            charges=[*existing, charge], only_month=period)
        if plan.category not in handled:
            raise BillConflict("The subscription summary could not be identified. No charge was changed.")
    return batch, charge


def record_charge(actor: str, checked: dict[str, Any], charge: BillCharge, request_id: str) -> dict[str, Any]:
    """Use the canonical split writer after a confirmed, anchored source save."""
    from bookiebot.reports.transactions import transaction_context
    from bookiebot.sheets.repo import get_sheets_repo
    from bookiebot.reimbursements import service
    from bookiebot.sheets.collaboration import expense_person_for_owner
    plan = checked["plan"]
    with transaction_context(actor, charge.month), sheet_command_context(request_id):
        action = undo.UndoAction(worksheet="income", kind="restore_cells", row=charge.source_row, columns=[charge.amount_column], previous_values=[""], new_values=[f"{checked['amount'] / 100:.2f}"],
            metadata={"type": "payment", "category": plan.source_label, "exact_source_label": plan.source_label,
                      "bill_plan_id": plan.id, "bill_category": plan.category, "bill_display_name": plan.name, "bill_charge_date": charge.charge_date}, description=plan.name)
        action_id = undo.record_undo_action(actor, action)
        if not action_id:
            raise RuntimeError("The saved charge needs action-history verification")
        if plan.split_method != "none":
            shares = checked["review"]["share"]
            logged = undo.LoggedAction(action_id, now_pacific().isoformat(), actor, action)
            success, detail = service.record_split(actor, logged, get_sheets_repo().income_sheet(), {"amount": charge.amount_column},
                {"amount": f"{checked['amount'] / 100:.2f}"}, expense_person_for_owner(charge.payer_owner), plan.split_method,
                checked["amount"] / 100, shares["payerCents"] / 100, shares["partnerCents"] / 100,
                expense_date=date.fromisoformat(charge.charge_date),
                **({"custom_payer_basis_points": plan.payer_basis_points} if plan.split_method == "custom" else {}))
            if not success:
                return {"success": True, "detail": "Amount confirmed. Reopen this month's bill in Bills to review its split.", "splitPending": True}
        return {"success": True, "detail": "Bill amount confirmed." if plan.kind == "variable" else "Charge recorded.", "transaction": {"month": charge.month, "id": charge.month + ":" + action_id}}


class BillCommands:
    def __init__(self, access: Any):
        self.access = access

    def initialize(self):
        from bookiebot.reports.financial_commands import initialize_commands
        initialize_commands(self.access)

    def saved(self, actor: str, request_id: str) -> dict[str, Any] | None:
        owner = get_user_config(actor).budget_owner_key
        with self.access.connect() as db:
            record = db.execute("SELECT * FROM app_bill_commands WHERE owner_key=? AND request_id=?", (owner, request_id)).fetchone()
        if not record:
            return None
        result = {"state": record["state"], **json.loads(record["result_json"])}
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(record["created_at"])).total_seconds()
        if record["state"] == "uncertain" or record["state"] == "running" and age >= 120:
            snapshot = read_workbook(actor, now_pacific().date())
            rows = snapshot.rows.get("_BookieBot Bill Settings Log", [])
            receipt = next((r for r in rows[1:] if r and r[0] == request_id), None)
            if receipt and len(receipt) >= 3 and receipt[1] == record["fingerprint"]:
                result = {"state": "done", **json.loads(receipt[2])}
                self._finish(owner, request_id, result)
            else:
                charge = next((c for c in decode_charges(snapshot.rows.get(CHARGES_TAB, [])) if c.request_id == request_id), None)
                if charge:
                    result = {"state": "done", "success": True, "splitPending": True,
                              "detail": "Amount recorded. Open the charge in Transactions to check its split."}
                    self._finish(owner, request_id, result)
        return result

    def pending(self, owner: str):
        with self.access.connect() as db:
            record = db.execute("SELECT command_json FROM app_bill_commands WHERE owner_key=? AND state!='done' ORDER BY created_at DESC", (owner,)).fetchone()
        return json.loads(record["command_json"]) if record else None

    def blocked(self, owner: str) -> bool:
        with self.access.connect() as db:
            return any(db.execute(f"SELECT request_id FROM {table} WHERE owner_key=? AND state!='done'", (owner,)).fetchone()
                       for table in ("app_transaction_commands", "app_bill_commands"))

    def preparation_request_id(self, owner: str, base: str) -> str:
        """Retry only proven no-write preparation failures, retaining every claim.

        The normal owner claim in command() still serializes concurrent workers.
        Running/unknown outcomes keep their identity until receipt recovery.
        """
        with self.access.connect() as db:
            records = db.execute("SELECT request_id,state,result_json FROM app_bill_commands WHERE owner_key=? AND (request_id=? OR request_id LIKE ?)",
                                 (owner, base, base + "-retry-%")).fetchall()
        attempts = {0 if r["request_id"] == base else int(r["request_id"][len(base) + 7:]): r for r in records
                    if r["request_id"] == base or re.fullmatch(re.escape(base) + r"-retry-\d+", r["request_id"])}
        if not attempts:
            return base
        number = max(attempts)
        latest = attempts[number]
        if latest["state"] == "done" and json.loads(latest["result_json"]).get("success") is False:
            return f"{base}-retry-{number + 1}"
        return latest["request_id"]

    def _finish(self, owner: str, request_id: str, result: dict[str, Any]):
        with self.access.connect(write=True) as db:
            db.execute("UPDATE app_bill_commands SET state=?,result_json=? WHERE owner_key=? AND request_id=?",
                       (result["state"], json.dumps(result), owner, request_id))

    def command(self, actor: str, body: dict[str, Any]) -> dict[str, Any]:
        owner = get_user_config(actor).budget_owner_key
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise BillValidation("Start a fresh bill review.")
        digest = fingerprint(body)
        with self.access.connect(write=True) as db:
            db.execute("INSERT INTO app_transaction_owners VALUES (?) ON CONFLICT(owner_key) DO NOTHING", (owner,))
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute("SELECT owner_key FROM app_transaction_owners WHERE owner_key=? FOR UPDATE", (owner,))
            old = db.execute("SELECT fingerprint,state,result_json FROM app_bill_commands WHERE owner_key=? AND request_id=?", (owner, request_id)).fetchone()
            if old:
                if old["fingerprint"] != digest:
                    raise BillConflict("This saved request belongs to different bill details.")
                return {"state": old["state"], **json.loads(old["result_json"])}
            if db.execute("SELECT request_id FROM app_bill_commands WHERE owner_key=? AND state!='done'", (owner,)).fetchone():
                raise BillConflict("Check the saved status of your previous bill change first.")
            if db.execute("SELECT request_id FROM app_transaction_commands WHERE owner_key=? AND state!='done'", (owner,)).fetchone():
                raise BillConflict("Check the saved status of your prior Transactions change first.")
            db.execute("INSERT INTO app_bill_commands VALUES (?,?,?,'running','{}',?,?)", (owner, request_id, digest, json.dumps(body), datetime.now(timezone.utc).isoformat()))
        started = False
        batch_committed = False
        try:
            from bookiebot.reimbursements.service import build_reimbursement_store
            from bookiebot.reimbursements.projection import projection_lock
            with undo._RECENT_MUTATION_LOCK:
                with projection_lock(build_reimbursement_store()):
                    source = read_workbook(actor, now_pacific().date())
                    carry = _carry_review(source, body, now_pacific().date()) if body.get("operation") == "rollover" else None
                    projection = _projection_review(source, body, now_pacific().date()) if body.get("operation") == "project" else None
                    checked_review = carry["review"] if carry else projection["review"] if projection else review(actor, body, snapshot=source)
                    if checked_review["reviewVersion"] != body.get("reviewVersion"):
                        raise BillConflict("The bill review changed. Review it again before saving.")
                    if projection:
                        batch = projection["batch"]
                        result = {"state": "done", "success": True, "detail": "This month's recurring bills are ready."}
                        batch.values(SETTINGS_LOG_TAB, 1, 1, [LOG_HEADERS], hidden=True)
                        batch.values(SETTINGS_LOG_TAB, max(2, len(source.rows.get(SETTINGS_LOG_TAB, [])) + 1), 1,
                            [[request_id, digest, json.dumps(result), now_pacific().isoformat()]], hidden=True)
                        started = True
                        batch.send()
                        batch_committed = True
                    elif carry:
                        from bookiebot.sheets.recurring_storage import project_sources
                        batch = SheetBatch(source)
                        for title, rows in carry["tables"].items():
                            batch.table(title, rows)
                        tables = {t: carry["tables"].get(t, source.rows.get(t, [])) for t in (BILL_TAB, SUBSCRIPTION_TAB)}
                        batch.snapshot = replace(source, settings=replace(source.settings, plans=tuple(carry["plans"])))
                        project_sources(batch, carry["plans"], tables, start_month=source.settings.period, today=now_pacific().date(), update_existing=False)
                        result = {"state": "done", "success": True, "detail": f"Recurring bills are ready for {source.year}."}
                        batch.values(SETTINGS_LOG_TAB, 1, 1, [LOG_HEADERS], hidden=True)
                        batch.values(SETTINGS_LOG_TAB, max(2, len(source.rows.get(SETTINGS_LOG_TAB, [])) + 1), 1,
                            [[request_id, digest, json.dumps(result), now_pacific().isoformat()]], hidden=True)
                        started = True
                        batch.send()
                        batch_committed = True
                    elif body.get("operation") in {"amount", "adopt", "scheduled"}:
                        checked = _amount_review(source, body, now_pacific().date())
                        batch, charge = charge_batch(source, checked, request_id)
                        started = True
                        batch.send()
                        batch_committed = True
                    else:
                        change = prepare_change(source.settings, body, today=now_pacific().date())
                        result = {"state": "done", "success": True, "detail": f"Bill {'stopped' if change.operation == 'delete' else 'saved'} from {change.after.effective_from}."}
                        batch = configuration_batch(source, change, request_id, digest, json.dumps(result), today=now_pacific().date())
                        started = True
                        batch.send()
                        batch_committed = True
                if body.get("operation") in {"amount", "adopt", "scheduled"}:
                    result = {"state": "done", **record_charge(actor, checked, charge, request_id)}
        except (BillConflict, BillValidation) as exc:
            result = {"state": "uncertain" if started else "done", "success": False, "detail": str(exc)}
        except Exception as exc:
            from gspread.exceptions import APIError
            if (started and not batch_committed and isinstance(exc, APIError)
                    and exc.response.status_code in {400, 401, 403, 404, 409, 412, 413, 422, 429}):
                started = False  # The atomic batch was explicitly rejected.
            logger.exception("Bill change needs verification", extra={"request_id": request_id})
            result = {"state": "uncertain" if started else "done", "success": False,
                "detail": "Check saved status before repeating this change." if started else "Couldn't prepare the bill change. Nothing was changed."}
        self._finish(owner, request_id, result)
        from bookiebot.reports.transactions import _CACHE, _CACHE_LOCK
        with _CACHE_LOCK:
            for key in list(_CACHE):
                if key[0] == actor:
                    _CACHE.pop(key)
        return result


@lru_cache(maxsize=8)
def _commands(access: Any) -> BillCommands:
    result = BillCommands(access)
    result.initialize()
    return result


def build_commands() -> BillCommands:
    return _commands(build_app_access_store())


def charge_transaction(actor: str, identity: str, period: str) -> dict[str, Any]:
    from bookiebot.reports.transactions import load_transactions, public_row
    snapshot = read_workbook(actor, now_pacific().date())
    plan = next((p for p in snapshot.settings.plans if p.id == identity and p.effective_from <= month_key(period) < p.effective_until), None)
    if not plan:
        raise BillConflict("This bill is unavailable in that month.")
    matches = [r for r in load_transactions(actor, period, fresh=True, include_scheduled=True) if r.get("billPlanId") == plan.id
               or r.get("kind") == "payment" and r["fields"].get("item", r.get("title")) == plan.source_label]
    if len(matches) != 1:
        raise BillConflict("This charge is not recorded yet. Refresh Bills to check its amount.")
    return {"transaction": {"month": period, "id": matches[0]["id"], "date": matches[0]["date"]},
            "item": public_row(matches[0])}
