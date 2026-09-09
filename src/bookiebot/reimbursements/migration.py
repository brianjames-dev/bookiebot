"""Plan-first import of existing splits; financial projections are explicit.

Unpaid, uniquely verified source rows adopt gross-until-confirmed repayment.
Received historical splits remain read-only; importing them does not invent
counterpart expenses or assume that nobody recorded repayment manually.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date
import re
from typing import Any
from gspread.utils import a1_to_rowcol, absolute_range_name

from bookiebot.reimbursements.service import money_cents
from bookiebot.sheets.collaboration import (
    actor_key_for_owner, allocation_visible_amount, expense_person_for_owner,
    partner_owner_key, split_amounts,
)
from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.reimbursement_history import read_reimbursement_history, _expense_date, _validated_allocation
from bookiebot.sheets.routing import get_shared_expenses_spreadsheet_id, get_budget_spreadsheet_id_for_user


def verify_budget_links(client: Any, owner: str, when: date, category: str, *, person: str | None = None,
                        cache: dict[Any, Any] | None = None) -> None:
    """Reject frozen/unknown summary chains before changing a shared expense.

    The supported budget template imports one full-column SUMIF from the shared
    category. Merely seeing an equals sign would also accept a frozen =123.45 or
    an import of a stale total, so verify both links and the actual person.
    Cache only within the current projection/preflight, never across launches.
    """
    from bookiebot.reports.expense_breakdown import BUDGET_SHARED_CATEGORY_LABELS, _normalize_label
    from bookiebot.sheets.config import normalize_expense_category
    category = normalize_expense_category(category)
    config = get_category_columns.get(category)
    if config is None or owner not in {"brian", "hannah"}:
        raise ValueError("The linked budget category or owner could not be verified.")
    person = person or expense_person_for_owner(owner)
    cache = {} if cache is None else cache
    key = ("verified", owner, when.year, when.month, category, person)
    if key in cache:
        return
    actor = actor_key_for_owner(owner)
    if not actor:
        raise ValueError("The linked budget owner is not configured.")
    title = when.strftime("%B")
    source_id = get_shared_expenses_spreadsheet_id(when.year)
    budget_id = get_budget_spreadsheet_id_for_user(actor, when.year)

    def formulas(book_id: str) -> list[list[Any]]:
        rows_key = ("formula_rows", book_id, title)
        if rows_key not in cache:
            values_get = getattr(getattr(client, "http_client", None), "values_get", None)
            if callable(values_get):
                # The required tab is already known. Avoid two metadata reads
                # to open its book and resolve its worksheet before each read.
                result = values_get(book_id, absolute_range_name(title), params={"valueRenderOption": "FORMULA"})
                if not isinstance(result, dict):
                    raise ValueError("The linked budget formula response was incomplete.")
                reported = result.get("range")
                if not isinstance(reported, str) or "!" not in reported:
                    raise ValueError("The linked budget formula response was incomplete.")
                actual_title = reported.rsplit("!", 1)[0]
                if actual_title.startswith("'") and actual_title.endswith("'"):
                    actual_title = actual_title[1:-1].replace("''", "'")
                if actual_title != title:
                    raise ValueError("The linked budget formulas did not match the requested month.")
                rows = result.get("values", [])
                if not isinstance(rows, list) or any(not isinstance(row, list) or any(
                    not isinstance(cell, (str, int, float, bool)) for cell in row
                ) for row in rows):
                    raise ValueError("The linked budget formula values were incomplete.")
            else:
                # Repository adapters and isolated tests can expose Worksheet
                # reads without the gspread HTTP transport.
                rows = client.open_by_key(book_id).worksheet(title).get_all_values(value_render_option="FORMULA")
            cache[rows_key] = rows
        return cache[rows_key]

    labels = BUDGET_SHARED_CATEGORY_LABELS.get(category, ("Various Need Transactions",))
    labels = {_normalize_label(label) for label in labels}
    matches = [next((str(value).strip() for value in row[index + 1:index + 5] if str(value).strip()), "")
               for row in formulas(budget_id) for index, value in enumerate(row) if _normalize_label(str(value)) in labels]
    message = f"{owner.title()} {title} {when.year} {category}: the budget summary needs a verified live shared-expense formula before syncing."
    if len(matches) != 1:
        raise ValueError(message)
    imported = re.fullmatch(r'=\s*IMPORTRANGE\(\s*"([^"]+)"\s*[,;]\s*"([^"]+)"\s*\)\s*', matches[0], re.I)
    if not imported:
        raise ValueError(message)
    imported_id = imported[1].rstrip("/").split("/d/")[-1].split("/")[0]
    reference = re.fullmatch(r"(?:'([^']+)'|([A-Za-z]+))!\$?([A-Za-z]+)\$?(\d+)", imported[2])
    if imported_id != source_id or not reference or (reference[1] or reference[2]) != title:
        raise ValueError(message)
    row, column = a1_to_rowcol(reference[3] + reference[4])
    source_rows = formulas(source_id)
    formula = str(source_rows[row - 1][column - 1]).strip() if len(source_rows) >= row and len(source_rows[row - 1]) >= column else ""
    person_col, amount_col = config["columns"]["person"], config["columns"]["amount"]
    matched = re.fullmatch(
        rf'=\s*SUMIF\(\s*\$?{person_col}:\$?{person_col}\s*[,;]\s*"([^"]+)"\s*[,;]\s*\$?{amount_col}:\$?{amount_col}\s*\)\s*',
        formula, re.I)
    if not matched or matched[1].casefold() != person.casefold():
        raise ValueError(message)
    cache[key] = True


def plan_migration(client: Any, *, corrections: dict[str, dict[str, str]] | None = None,
                   existing_ids: set[str] | None = None) -> dict[str, Any]:
    corrections, existing_ids = corrections or {}, existing_ids or set()
    records: dict[str, tuple[Any, str, int, Any]] = {}
    originals: dict[str, Any] = {}
    issues: list[str] = []
    formula_cache: dict[Any, Any] = {}

    def remember(allocation: Any, original: Any, actor: str, year: int, worksheet: Any) -> None:
        identity = allocation.allocation_id
        if identity in records and (records[identity][0] != allocation or originals[identity] != original):
            issues.append(f"{identity}: conflicting copies across owner histories; review required")
            return
        records[identity] = allocation, actor, year, worksheet
        originals[identity] = original

    for owner in ("brian", "hannah"):
        actor = actor_key_for_owner(owner)
        if actor is None:
            raise ValueError("Both household owners must be configured before migration.")
        history = read_reimbursement_history(actor)
        history.require_complete()
        for record in history.records:
            allocation = record.allocation
            if allocation.status != "void":
                remember(allocation, allocation, actor, record.year, record.worksheet)
        for ledger in history.ledgers:
            for row in ledger.rows[1:]:
                padded = list(row) + [""] * 25
                if not any(str(value).strip() for value in row) or padded[19] == "void" or padded[0] in existing_ids:
                    continue
                try:
                    for index in (15, 17, 18, 20):
                        money_cents(padded[index])
                    allocation = _validated_allocation(padded)
                    if allocation is None:
                        raise ValueError("invalid saved allocation")
                except ValueError:
                    issues.append(f"{padded[0] or 'Unnamed allocation'}: invalid saved allocation; review required")
                    continue
                if allocation.owner_key == owner:
                    continue
                fix = corrections.get(allocation.allocation_id)
                if not fix or fix.get("payerOwner") != owner:
                    issues.append(f"{allocation.allocation_id}: payer ownership disagrees with its workbook; review required")
                    continue
                if allocation.received_amount:
                    issues.append(f"{allocation.allocation_id}: paid ownership correction requires a separate reviewed repair")
                    continue
                person = fix.get("payerPerson") or expense_person_for_owner(owner)
                original = allocation
                payer_share, partner_share = split_amounts(allocation.gross_amount, allocation.split_method, owner)
                allocation = replace(allocation, actor_key=actor, owner_key=owner, payer=owner.title(),
                    partner=partner_owner_key(owner).title(), payer_share=payer_share, partner_share=partner_share,
                    original_person=person, responsible_person=person, responsible_owner_key=owner,
                    item=fix.get("item", allocation.item))
                remember(allocation, original, actor, ledger.year, ledger.worksheet)
    payloads = []
    for identity, (allocation, actor, ledger_year, ledger) in records.items():
        if identity in existing_ids:
            continue
        try:
            payload = _plan_allocation(client, identity, allocation, originals[identity], actor, ledger_year, ledger,
                                       corrections.get(identity, {}), formula_cache)
            from bookiebot.reimbursements.store import _allocation_details
            _allocation_details(payload)
            payloads.append(payload)
        except Exception as exc:
            issues.append(f"{identity}: {exc}")
    return {"schema": 1, "allocations": payloads, "issues": issues,
            "note": "Cash-model imports update unpaid source expenses to gross. Received historical splits remain read-only."}


def _plan_allocation(client: Any, identity: str, allocation: Any, original: Any, actor: str,
                     ledger_year: int, ledger: Any, fix: dict[str, str], formula_cache: dict[Any, Any]) -> dict[str, Any]:
    spent_on = _expense_date(allocation.expense_date)
    if spent_on is None:
        raise ValueError("expense date could not be verified")
    paid_history = allocation.received_amount > 0
    owner = allocation.owner_key
    source_id = (get_shared_expenses_spreadsheet_id(spent_on.year) if allocation.source_worksheet == "expense"
                 else get_budget_spreadsheet_id_for_user(actor, spent_on.year))
    payload: dict[str, Any] = {"id": identity, "payerOwner": owner, "partnerOwner": partner_owner_key(owner),
        "payerPerson": allocation.original_person or expense_person_for_owner(owner),
        "item": allocation.item or allocation.source_category, "location": allocation.location,
        "expenseDate": spent_on.isoformat(), "category": allocation.source_category,
        "sourceWorksheet": allocation.source_worksheet, "sourceRow": allocation.source_row,
        "sourceActionId": allocation.source_action_id, "splitActionId": allocation.split_action_id,
        "sourceYear": spent_on.year, "sourceSpreadsheetId": source_id,
        "sourceSheetTitle": spent_on.strftime("%B"), "actorKey": actor,
        "ledgerSpreadsheetId": str(getattr(ledger, "spreadsheet_id", "")), "ledgerYear": ledger_year,
        "grossCents": money_cents(allocation.gross_amount), "payerShareCents": money_cents(allocation.payer_share),
        "partnerShareCents": money_cents(allocation.partner_share), "settledCents": money_cents(allocation.received_amount),
        "legacyReceivedAt": allocation.received_at, "method": allocation.split_method,
        "accounting": "legacy_net" if paid_history else "cash_v1"}
    if not paid_history:
        if allocation.source_worksheet == "expense":
            verify_budget_links(client, owner, spent_on, allocation.source_category, person=payload["payerPerson"], cache=formula_cache)
            verify_budget_links(client, partner_owner_key(owner), spent_on, allocation.source_category, cache=formula_cache)
        source = client.open_by_key(source_id).worksheet(spent_on.strftime("%B"))
        if allocation.source_worksheet == "expense":
            config = get_category_columns.get(allocation.source_category)
            if config is None:
                raise ValueError("unsupported source category")
            columns = {field: a1_to_rowcol(column + "1")[1] for field, column in config["columns"].items()}
        else:
            columns = {"item": 2, "amount": 3}
        rows = source.get_all_values()
        source_row = rows[allocation.source_row - 1] if 0 < allocation.source_row <= len(rows) else []
        values = {field: str(source_row[column - 1]) if len(source_row) >= column else "" for field, column in columns.items()}
        # Any corrected record must still be compared against its original
        # pre-correction ledger share, not the newly calculated payer share.
        expected_amount = money_cents(fix.get("expectedSourceAmount", allocation_visible_amount(original)))
        if money_cents(values["amount"]) != expected_amount:
            raise ValueError("current expense amount differs from the saved split")
        if allocation.source_worksheet == "expense":
            expected_person = fix.get("expectedSourcePerson", original.responsible_person or original.original_person or original.payer)
            expected_item = fix.get("expectedSourceItem", original.item)
            if not expected_person or values.get("person") != expected_person:
                raise ValueError("source person differs from the saved split")
            if "item" in columns and expected_item and values.get("item") != expected_item:
                raise ValueError("source item differs from the saved split")
            if "location" in columns and values.get("location") != original.location:
                raise ValueError("source location differs from the saved split")
            if _expense_date(values.get("date", "")) != spent_on:
                raise ValueError("source date differs from the saved split")
        elif values.get("item", "").strip().casefold() != (original.item or original.source_category).strip().casefold():
            raise ValueError("source bill label differs from the saved split")
        payload.update(sourceValues=values, sourceColumnMap=columns)
    return payload


def apply_migration(store: Any, plan: dict[str, Any], *, projector: Any = None) -> bool:
    if plan.get("schema") != 1 or plan.get("issues") or not isinstance(plan.get("allocations"), list):
        raise ValueError("Resolve every migration issue before applying the reviewed plan.")
    # Validate the entire plan before persisting the first allocation.
    from bookiebot.reimbursements.store import _allocation_details
    identities, sources = set(), set()
    for payload in plan["allocations"]:
        normalized = _allocation_details(payload)
        identity, source = normalized["id"], (normalized["sourceActionId"], normalized["sourceYear"])
        if identity in identities or source in sources:
            raise ValueError("The migration plan contains duplicate allocations or source expenses.")
        identities.add(identity)
        sources.add(source)
    for payload in plan["allocations"]:
        store.register_allocation(payload)
    from bookiebot.reimbursements.projection import sync_pending
    return sync_pending(store, projector)
