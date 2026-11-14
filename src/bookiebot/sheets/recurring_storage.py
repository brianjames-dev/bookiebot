"""Owner-scoped, effective-dated bill settings and atomic Sheets projections.

Reads never provision tabs. All configuration/history/source-formula changes
share one Sheets batch with the saved request receipt.
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any

from gspread.utils import absolute_range_name

from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, SETTINGS_LOG_TAB, BillConflict, BillPlan, fingerprint, selected
from bookiebot.sheets.recurring_changes import BillSnapshot, BillChange
from bookiebot.sheets.recurring_charges import CHARGES_TAB, BillCharge, decode_charges, following_month, source_anchor
from bookiebot.sheets.recurring_rows import decode, encode, header, legacy_plans, managed
from bookiebot.sheets.bills import bill_label_key
from bookiebot.sheets.bill_payment_evidence import settled_bill_dates, BillDates
from bookiebot.sheets.routing import get_budget_spreadsheet_id_for_user, get_user_config, now_pacific

LOG_HEADERS = ["request_id", "fingerprint", "result_json", "created_at"]


def repository_managed() -> bool:
    from bookiebot.sheets.repo import get_sheets_repo
    repo = get_sheets_repo()
    for method in ("find_bill_schedule_sheet", "find_subscription_schedule_sheet"):
        worksheet = getattr(repo, method, lambda: None)()
        if worksheet is not None and managed(worksheet.get_all_values()):
            return True
    return False


def cell(rows: list[list[str]], row: int, column: int) -> str:
    return str(rows[row - 1][column - 1]) if 0 < row <= len(rows) and 0 < column <= len(rows[row - 1]) else ""


def row_for(rows: list[list[str]], label: str) -> int | None:
    matches = [i for i, row in enumerate(rows, 1) if cell([row], 1, 2).strip().casefold() == label.strip().casefold()]
    if len(matches) > 1:
        raise BillConflict(f"{label} has more than one budget source. Check its rows before saving.")
    return matches[0] if matches else None


def numeric(value: str) -> float:
    from decimal import Decimal
    text = value.strip().replace("$", "").replace(",", "")
    return float(Decimal(text)) if text else 0.0


@dataclass
class WorkbookSnapshot:
    actor: str
    owner: str
    year: int
    spreadsheet_id: str
    client: Any
    properties: dict[str, dict[str, Any]]
    named_ranges: list[dict[str, Any]]
    rows: dict[str, list[list[str]]]
    formulas: dict[str, list[list[str]]]
    settings: BillSnapshot
    recorded_plans: set[tuple[str, str]] = field(default_factory=set)
    settled_dates: BillDates = field(default_factory=dict)
    allocations: list[dict[str, Any]] = field(default_factory=list)
    as_of: date | None = None

    def bill_allocations(self, plan: BillPlan, month: str) -> list[dict[str, Any]]:
        def matches(value: dict[str, Any]) -> bool:
            if value.get("sourceWorksheet") != "income" or value.get("lifecycle", "active") != "active":
                return False
            period = f"{value['sourceYear']:04d}-{list(calendar.month_name).index(value['sourceSheetTitle']):02d}" if value.get("sourceSheetTitle") in calendar.month_name[1:] else ""
            if not period or period > month:
                return False
            if value.get("payerOwner") == self.owner:
                return (value.get("billPlanId") == plan.id if value.get("billPlanId") else
                    bill_label_key(value.get("sourceValues", {}).get("item") or value.get("item") or value["category"]) == bill_label_key(plan.source_label))
            return value.get("partnerOwner") == self.owner and bill_label_key(value.get("partnerSourceLabel") or value["category"]) == bill_label_key(plan.source_label)
        values = [a for a in self.allocations if matches(a)]
        latest = max(((a['sourceYear'], list(calendar.month_name).index(a['sourceSheetTitle'])) for a in values), default=None)
        return [a for a in values if (a['sourceYear'], list(calendar.month_name).index(a['sourceSheetTitle'])) == latest]

    def responsible_owner(self, plan: BillPlan, month: str) -> str | None:
        roles = {a["payerOwner"] for a in self.bill_allocations(plan, month)}
        charge = next((c for c in decode_charges(self.rows.get(CHARGES_TAB, [])) if c.plan_id == plan.id and c.month == month), None)
        if charge and charge.payer_owner:
            roles.add(charge.payer_owner)
        return next(iter(roles)) if len(roles) == 1 else None if roles else self.owner

    def charge(self, plan: BillPlan, month: str) -> dict[str, Any]:
        title = calendar.month_name[int(month[5:])]
        if int(month[:4]) != self.year or title not in self.rows or not plan.effective_from <= month < plan.effective_until:
            return {"available": False, "month": month}
        charge = next((c for c in decode_charges(self.rows.get(CHARGES_TAB, [])) if c.plan_id == plan.id and c.month == month), None)
        label = charge.source_label if charge else plan.source_label
        row = row_for(self.rows[title], label)
        column = charge.amount_column if charge else 4 if plan.category == "subscriptions_wants" else 3
        value = cell(self.rows[title], row or 0, column)
        due = self.settled_dates.get((month, bill_label_key(label))) or plan.due_date(month)
        when = (due.isoformat() if due else None) if plan.kind == "variable" else charge.charge_date if charge else due.isoformat() if due else None
        recorded = bool(charge and charge.recorded) or (plan.id, month) in self.recorded_plans
        amount = round(numeric(value) * 100)
        known = recorded or amount > 0
        related = [a for a in self.bill_allocations(plan, month) if a['sourceYear'] == self.year and a['sourceSheetTitle'] == title]
        gross = related[0].get('grossCents') if len(related) == 1 and related[0]['payerOwner'] == self.owner else amount
        return {"available": True, "month": month, "row": row, "amountColumn": column,
                "amountCents": amount, "billAmountCents": gross, "date": when,
                "status": "paid" if known and when and when <= (self.as_of or now_pacific().date()).isoformat() else "confirmed" if known else "unconfirmed",
                "paymentPolicy": "autopay", "canConfirmAmount": self.responsible_owner(plan, month) == self.owner,
                "splitPending": bool(charge and charge.recorded and charge.payer_owner == self.owner and plan.split_method != "none" and not related),
                "recorded": recorded, "sourceLabel": label,
                "virtual": not plan.monthly_source and not charge,
                "version": fingerprint([plan.version, month, charge, row, value, cell(self.formulas[title], row or 0, column)] if charge is None
                    else [plan.version, month, charge.__dict__, row, value, cell(self.formulas[title], row or 0, column)])}


def read_workbook(actor: str, today: date, *, client: Any = None) -> WorkbookSnapshot:
    from bookiebot.sheets.auth import get_gspread_client
    client = client or get_gspread_client()
    owner = get_user_config(actor).budget_owner_key
    identity = get_budget_spreadsheet_id_for_user(actor, today.year)
    transport = client.http_client
    metadata = transport.fetch_sheet_metadata(identity)
    props = {s["properties"]["title"]: s["properties"] for s in metadata["sheets"]}
    titles = [t for t in [BILL_TAB, SUBSCRIPTION_TAB, CHARGES_TAB, SETTINGS_LOG_TAB, "Subscriptions", "Template", *calendar.month_name[1:]] if t in props]
    ranges = [absolute_range_name(t) for t in titles]
    loaded = []
    for render in ("FORMATTED_VALUE", "FORMULA"):
        result = transport.values_batch_get(identity, ranges, params={"valueRenderOption": render})
        values = result.get("valueRanges")
        if not isinstance(values, list) or len(values) != len(titles):
            raise BillConflict("Bill settings could not be read completely. Try refreshing.")
        tables = {}
        for title, value in zip(titles, values):
            actual = str(value.get("range", "")).rsplit("!", 1)[0].strip("'").replace("''", "'")
            if actual != title:
                raise BillConflict("The bill source changed while reading. Refresh Settings.")
            tables[title] = [[str(c) for c in row] for row in value.get("values", [])]
        loaded.append(tables)
    rows, formulas = loaded
    bills = decode(rows[BILL_TAB], BILL_TAB) if managed(rows.get(BILL_TAB, [])) else legacy_plans(owner, rows.get(BILL_TAB, []), [])
    subs = decode(rows[SUBSCRIPTION_TAB], SUBSCRIPTION_TAB) if managed(rows.get(SUBSCRIPTION_TAB, [])) else legacy_plans(owner, [], rows.get("Subscriptions", []))
    plans = bills + subs
    if {p.id for p in bills} & {p.id for p in subs}:
        raise BillConflict("A bill identity appears in both schedules.")
    period = today.strftime("%Y-%m")
    snapshot = WorkbookSnapshot(actor, owner, today.year, identity, client, props, metadata.get("namedRanges", []), rows, formulas,
        BillSnapshot(owner, tuple(plans), fingerprint([owner, identity, rows, formulas, metadata.get("namedRanges", [])]), period, {}))
    minimums = {}
    from bookiebot.reimbursements import service as reimbursements
    ledger = reimbursements.build_reimbursement_store().snapshot(owner, include_inactive=True) if reimbursements.enabled() else {}
    allocations = ledger.get("allocations", [])
    snapshot.allocations, snapshot.as_of = allocations, today
    snapshot.settled_dates = settled_bill_dates(allocations, ledger.get("events", []), owner=owner, as_of=today)
    if allocations:
        snapshot.settings = replace(snapshot.settings, version=fingerprint([snapshot.settings.version,
            [(a["id"], a["version"]) for a in allocations]]))
    for plan in snapshot.settings.records():
        for number in range(today.month, 13):
            charge_month = f"{today.year:04d}-{number:02d}"
            candidate = next((p for p in selected(plans, charge_month, include_inactive=True) if p.id == plan.id), None)
            if candidate is None:
                continue
            info = snapshot.charge(candidate, charge_month)
            due = candidate.due_date(charge_month)
            title = calendar.month_name[number]
            manual_value = info.get("amountCents", 0) > 0 and not cell(formulas.get(title, []), info.get("row") or 0, info.get("amountColumn", 3)).startswith("=")
            recorded_split = any(a["payerOwner"] == owner and a.get("lifecycle", "active") == "active"
                and a["sourceYear"] == today.year and a["sourceWorksheet"] == "income"
                and a.get("sourceSheetTitle") == title and (a.get("billPlanId") == plan.id if a.get("billPlanId")
                    else bill_label_key(a.get("sourceValues", {}).get("item") or a.get("item") or a["category"]) == bill_label_key(candidate.source_label))
                for a in allocations)
            if recorded_split or (charge_month, bill_label_key(candidate.source_label)) in snapshot.settled_dates:
                snapshot.recorded_plans.add((plan.id, charge_month))
            if info.get("recorded") or recorded_split or manual_value or due and due <= today and (info.get("amountCents", 0) > 0 or info.get("virtual") and (candidate.amount_cents or 0) > 0):
                minimums[plan.id] = following_month(charge_month)
    snapshot.settings.earliest_months.update(minimums)
    return snapshot


class SheetBatch:
    def __init__(self, snapshot: WorkbookSnapshot):
        self.snapshot = snapshot
        self.requests: list[dict[str, Any]] = []
        self.properties = {title: dict(value) for title, value in snapshot.properties.items()}
        self.names = {n["name"]: n for n in snapshot.named_ranges}

    def sheet(self, title: str, *, hidden: bool = False, columns: int = 32, rows: int = 1000) -> int:
        if title not in self.properties:
            identity = max([0, *(int(p["sheetId"]) for p in self.properties.values())]) + 1
            properties = {"sheetId": identity, "title": title, "hidden": hidden, "gridProperties": {"rowCount": rows, "columnCount": columns}}
            self.requests.append({"addSheet": {"properties": properties}})
            self.properties[title] = properties
        prop = self.properties[title]
        grid = prop.get("gridProperties", {})
        if grid.get("rowCount", 0) < rows or grid.get("columnCount", 0) < columns:
            self.requests.append({"updateSheetProperties": {"properties": {"sheetId": prop["sheetId"], "gridProperties": {
                "rowCount": max(rows, grid.get("rowCount", 0)), "columnCount": max(columns, grid.get("columnCount", 0))}}, "fields": "gridProperties.rowCount,gridProperties.columnCount"}})
        if hidden and not prop.get("hidden"):
            self.requests.append({"updateSheetProperties": {"properties": {"sheetId": prop["sheetId"], "hidden": True}, "fields": "hidden"}})
        return int(prop["sheetId"])

    def values(self, title: str, row: int, column: int, values: list[list[Any]], *, formulas: bool = False, hidden: bool = False,
               trusted_formulas: set[tuple[int, int]] | None = None):
        width = max((len(r) for r in values), default=1)
        identity = self.sheet(title, hidden=hidden, rows=row + len(values), columns=column + width)
        def unchanged(r: int, c: int, v: Any) -> bool:
            original = cell(self.snapshot.formulas.get(title, []), r, c)
            if original == str(v):
                return True
            if isinstance(v, (int, float)) and not original.startswith("="):
                try:
                    return bool(original.strip()) and numeric(original) == v
                except Exception:
                    return False
            return False
        if values and all(unchanged(row + i, column + j, v) for i, line in enumerate(values) for j, v in enumerate(line)):
            return
        def value(v: Any, r: int, c: int) -> dict[str, Any]:
            key = "formulaValue" if (formulas or (r, c) in (trusted_formulas or set())) and isinstance(v, str) and v.startswith("=") else "numberValue" if isinstance(v, (float, int)) else "stringValue"
            return {"userEnteredValue": {key: v}}
        self.requests.append({"updateCells": {"start": {"sheetId": identity, "rowIndex": row - 1, "columnIndex": column - 1},
            "rows": [{"values": [value(v, row + i, column + j) for j, v in enumerate(line)]} for i, line in enumerate(values)], "fields": "userEnteredValue"}})

    def table(self, title: str, rows: list[list[str]]):
        old = self.snapshot.rows.get(title, [])
        width = max((len(r) for r in rows + old), default=1)
        padded = [(rows[i] if i < len(rows) else []) + [""] * (width - len(rows[i]) if i < len(rows) else width)
                  for i in range(max(len(rows), len(old)))]
        from bookiebot.sheets.recurring_rows import BILL_HEADERS, SUB_HEADERS
        from bookiebot.sheets.recurring import VERSION_HEADERS
        from bookiebot.sheets.recurring_charges import CHARGE_HEADERS
        known = set(CHARGE_HEADERS if title == CHARGES_TAB else (*BILL_HEADERS, *SUB_HEADERS, *VERSION_HEADERS))
        names = header(rows)
        # Extra source columns are not editable by an app request. Preserve
        # their existing formulas; app-editable names/notes remain literals.
        trusted = {(r + 1, c + 1) for r, line in enumerate(padded) for c, v in enumerate(line)
                   if r > 0 and (c >= len(names) or names[c] not in known) and v.startswith("=")}
        # Price references must evaluate to numbers so Google Sheets' SUM
        # includes them. Other editable strings remain literal, formula-safe.
        money_columns = {i for i, name in enumerate(names) if name in {"amount", "expected_amount", "initial_amount"}}
        typed: list[list[Any]] = [[numeric(v) if r > 0 and c in money_columns and str(v).strip() else v
                                  for c, v in enumerate(line)] for r, line in enumerate(padded)]
        self.values(title, 1, 1, typed, hidden=True, trusted_formulas=trusted)

    def anchor(self, title: str, row: int, column: int, plan_id: str, period: str):
        name = source_anchor(plan_id, period)
        target = {"sheetId": self.sheet(title, rows=row, columns=column), "startRowIndex": row - 1, "endRowIndex": row,
                  "startColumnIndex": 1, "endColumnIndex": max(3, column)}
        if name in self.names:
            if self.names[name]["range"] != target:
                old = self.names[name]["range"]
                if any(old.get(k) != target[k] for k in ("sheetId", "startRowIndex", "endRowIndex", "startColumnIndex")):
                    raise BillConflict("The saved bill anchor moved. Refresh before saving.")
                self.requests.append({"updateNamedRange": {"namedRange": {
                    "namedRangeId": self.names[name]["namedRangeId"], "range": target}, "fields": "range"}})
        else:
            self.requests.append({"addNamedRange": {"namedRange": {"name": name, "range": target}}})
            self.names[name] = {"name": name, "range": target}

    def send(self):
        if self.requests:
            return self.snapshot.client.http_client.batch_update(self.snapshot.spreadsheet_id, {"requests": self.requests})


def _add_to_subtotal(batch: SheetBatch, title: str, formulas: list[list[str]], column: int, references: list[str]):
    if not references:
        return
    wanted = "(Wants) Subtotal:" if column == 4 else "(Needs) Subtotal:"
    matches = [(r, c) for r, row in enumerate(formulas, 1) for c, value in enumerate(row, 1) if value == wanted]
    if len(matches) != 1:
        raise BillConflict(f"The {title} budget subtotal could not be identified. No bill was changed.")
    row, labelcol = matches[0]
    original = cell(formulas, row, column)
    # Existing percent/text subtotal formulas repeat the same SUM. Extend each
    # occurrence, preserving the actual budget's denominator and formatting.
    import re
    letter = "D" if column == 4 else "C"
    spans = [(int(m[1]), int(m[2] or m[1])) for m in re.finditer(rf"(?<![A-Za-z0-9_]){letter}\$?(\d+)(?::{letter}\$?(\d+))?", original)]
    references = [ref for ref in references if not any(start <= int(ref[1:]) <= end for start, end in spans)]
    if not references:
        return
    pattern = rf"SUM\({letter}\$?\d+:{letter}\$?\d+\)"
    sums = set(re.findall(pattern, original, flags=re.IGNORECASE))
    if len(sums) != 1:
        raise BillConflict(f"The {title} subtotal formula needs review before adding a bill.")
    match = next(iter(sums))
    replacement = f"({match}+SUM({','.join(references)}))"
    batch.values(title, row, column, [[original.replace(match, replacement)]], formulas=True)


def configuration_batch(snapshot: WorkbookSnapshot, change: BillChange, request_id: str, request_fingerprint: str,
                        result_json: str, *, today: date) -> SheetBatch:
    plans = change.rows(request_id)
    tab = change.after.source_tab
    original = snapshot.formulas.get(tab, [])
    encoded = encode(plans, tab, original)
    batch = SheetBatch(snapshot)
    batch.table(tab, encoded)
    tables = {t: encoded if t == tab else snapshot.rows.get(t, []) for t in (BILL_TAB, SUBSCRIPTION_TAB)}
    project_sources(batch, plans, tables, start_month=change.after.effective_from, today=today)
    batch.values(SETTINGS_LOG_TAB, 1, 1, [LOG_HEADERS], hidden=True)
    logrow = max(2, len(snapshot.rows.get(SETTINGS_LOG_TAB, [])) + 1)
    batch.values(SETTINGS_LOG_TAB, logrow, 1, [[request_id, request_fingerprint, result_json, today.isoformat()]], hidden=True)
    return batch


def _price_references(tables: dict[str, list[list[str]]]) -> dict[str, str]:
    price_refs = {}
    for source, rows in tables.items():
        if not managed(rows):
            continue
        names = header(rows)
        pricecol = names.index("amount" if source == SUBSCRIPTION_TAB else "expected_amount")
        from openpyxl.utils import get_column_letter
        for r, raw in enumerate(rows[1:], 2):
            price_refs[raw[names.index("version")]] = f"'{source}'!{get_column_letter(pricecol + 1)}{r}"
    return price_refs


def project_subscription_summaries(batch: SheetBatch, plans: list[BillPlan], tables: dict[str, list[list[str]]], *,
                                   start_month: str, update_existing: bool = True,
                                   charges: list[BillCharge] | None = None, only_month: str | None = None) -> set[str]:
    """Keep virtual summaries and adopted monthly sources mutually exclusive.

    This deliberately does not allocate physical rows: charge adoption already
    owns its appended row in the same atomic batch.
    """
    snapshot = batch.snapshot
    if not managed(tables.get(SUBSCRIPTION_TAB, [])):
        return set()
    price_refs = _price_references(tables)
    adopted = {(c.plan_id, c.month) for c in (charges if charges is not None else decode_charges(snapshot.rows.get(CHARGES_TAB, [])))}
    handled = set()
    for number in range(1, 13):
        title, period = calendar.month_name[number], f"{snapshot.year:04d}-{number:02d}"
        if title not in snapshot.rows or only_month and period != only_month or not update_existing and period < start_month:
            continue
        rows, formulas = snapshot.rows[title], snapshot.formulas[title]
        current = selected(plans, period, include_inactive=True)
        for r, line in enumerate(formulas, 1):
            for col, formula in enumerate(line, 1):
                label = cell(rows, r, 2).casefold()
                expected_column = 4 if label == "subscriptions (wants)" else 3
                if not ((formula.startswith("=") and ("Subscriptions!" in formula or SUBSCRIPTION_TAB in formula)
                         or formula in {"0", "=SUM(0)"})
                        and col == expected_column and label in {"subscriptions (needs)", "static bills & subscriptions (needs)", "subscriptions (wants)"}):
                    continue
                category = "subscriptions_wants" if "wants" in label else "static_bills_subscriptions_needs"
                if period < max(start_month, snapshot.settings.period):
                    batch.values(title, r, col, [[numeric(cell(rows, r, col))]])
                else:
                    virtual = [p for p in current if not p.monthly_source and p.active and p.category == category
                               and p.due_date(period) and (p.id, period) not in adopted]
                    if not all(p.version in price_refs for p in virtual):
                        raise BillConflict("The subscription summary needs refreshed price references before saving.")
                    refs = [price_refs[p.version] for p in virtual]
                    batch.values(title, r, col, [["=SUM(" + ",".join(refs or ["0"]) + ")"]], formulas=True)
                    handled.add(category)
    return handled


def project_sources(batch: SheetBatch, plans: list[BillPlan], tables: dict[str, list[list[str]]], *, start_month: str, today: date,
                    update_existing: bool = True):
    """Project authorized plans into existing months; never create a month tab."""
    snapshot = batch.snapshot
    price_refs = _price_references(tables)
    # Baseline versions in the other, unenrolled source stay unchanged.
    for number in range(1, 13):
        title, period = calendar.month_name[number], f"{snapshot.year:04d}-{number:02d}"
        if title not in snapshot.rows:
            continue
        rows, formulas = snapshot.rows[title], snapshot.formulas[title]
        current = selected(plans, period, include_inactive=True)
        append_row = max(len(rows), len(formulas)) + 2
        extras: dict[int, list[str]] = {3: [], 4: []}
        for plan in current:
            row = row_for(rows, plan.source_label)
            existed = row is not None
            column = 4 if plan.category == "subscriptions_wants" else 3
            if not plan.monthly_source:
                continue
            prior = next((p for p in selected(list(snapshot.settings.plans), period, include_inactive=True) if p.id == plan.id), None)
            if row and period >= start_month and (prior is None or not prior.monthly_source):
                raise BillConflict(f"{plan.source_label} is already a budget row. Use a different bill name before adding a separate source.")
            if row and period < start_month:
                # A legacy SUMIF over all price versions would change history.
                if update_existing and (BILL_TAB in cell(formulas, row, column) or SUBSCRIPTION_TAB in cell(formulas, row, column)):
                    batch.values(title, row, column, [[numeric(cell(rows, row, column))]])
                continue
            due = plan.due_date(period)
            if row is None and plan.active and due and period >= max(start_month, snapshot.settings.period):
                row, append_row = append_row, append_row + 1
                batch.values(title, row, 2, [[plan.source_label]])
                extras[column].append(f"{'D' if column == 4 else 'C'}{row}")
            if row is None:
                continue
            if existed and not update_existing:
                batch.anchor(title, row, column, plan.id, period)
                # Older rollover scripts clone the original SUMIF/price link.
                # Rebind that calculated source to this period's saved version;
                # preserve literal edits, deletions and recorded repayments.
                original_formula = cell(formulas, row, column)
                if (original_formula.startswith("=") and (BILL_TAB in original_formula or SUBSCRIPTION_TAB in original_formula)
                        and not snapshot.charge(plan, period).get("recorded")):
                    if plan.kind == "variable":
                        batch.values(title, row, column, [[""]])
                    elif plan.version in price_refs:
                        batch.values(title, row, column, [["=" + price_refs[plan.version] if plan.active and plan.due_date(period) else 0]], formulas=True)
                continue  # Never regenerate a cleared/edited existing charge.
            old_column = 4 if prior and prior.category == "subscriptions_wants" else 3
            if prior and old_column != column and period >= start_month:
                if snapshot.settings.earliest_months.get(plan.id, period) > period:
                    raise BillConflict("An existing charge keeps its budget category. Choose a later starting month.")
                target = cell(rows, row, column)
                if target and numeric(target) != 0:
                    raise BillConflict("The new budget column already contains an amount. Check that row before moving the bill.")
                batch.values(title, row, old_column, [[0]])
                extras[column].append(f"{'D' if column == 4 else 'C'}{row}")
            batch.anchor(title, row, column, plan.id, period)
            formula = cell(formulas, row, column)
            protected = period < snapshot.settings.period or (period == snapshot.settings.period and snapshot.settings.earliest_months.get(plan.id, period) > period)
            if protected:
                if BILL_TAB in formula or SUBSCRIPTION_TAB in formula:
                    batch.values(title, row, column, [[numeric(cell(rows, row, column))]])
                continue
            if (plan.kind == "variable" and formula.startswith("=") and (BILL_TAB in formula or SUBSCRIPTION_TAB in formula)
                    and not snapshot.charge(plan, period).get("recorded")):
                # A saved estimate must not survive conversion (or an older
                # rollover clone) as automatic cash. Keep literal actuals and
                # recorded charge/split sources authoritative.
                batch.values(title, row, column, [[""]])
            elif plan.kind != "variable" and plan.version in price_refs and (not formula or formula.startswith("=") or numeric(cell(rows, row, column)) == 0):
                batch.values(title, row, column, [["=" + price_refs[plan.version] if plan.active and due else 0]], formulas=True)
        for column, refs in extras.items():
            _add_to_subtotal(batch, title, formulas, column, refs)
    project_subscription_summaries(batch, plans, tables, start_month=start_month, update_existing=update_existing)
