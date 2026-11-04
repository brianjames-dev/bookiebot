"""Plan-first Gas Location migration. Inputs/backups stay outside the repository.

Capture all affected native Sheets (formulas, values, formats and metadata), the
three database tables and bank/account evidence before planning. Stop app replicas
and confirm no running Apps Script job before --apply; leave writers stopped if
verification fails. A lost response is resumed from the same approved plan.
"""
from __future__ import annotations

import argparse
import calendar
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from bookiebot.sheets.gas_location_migration import (
    migrate_action, migrate_allocation, migrate_sheet_ref, recover_gas_locations,
    rewrite_import, shared_sheet_requests,
)
from bookiebot.sheets.config import GAS_LOCATION_LAYOUT, category_layout, expense_layout_metadata


def private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=str))
    path.chmod(0o600)


def cell_request(sheet_id: int, row: int, column: int, value: str) -> dict[str, Any]:
    return {"updateCells": {"start": {"sheetId": sheet_id, "rowIndex": row - 1, "columnIndex": column - 1},
                            "rows": [{"values": [{"userEnteredValue": {"stringValue": value}}]}], "fields": "userEnteredValue"}}


def read_capture(client: Any, capture: dict[str, Any], render: str, *, shifted: bool = False) -> dict[str, Any]:
    """One bounded batch per workbook, preserving API ragged rows and value types."""
    from openpyxl.utils import get_column_letter
    props = {s["properties"]["title"]:s["properties"] for s in capture["metadata"]["sheets"]}
    titles = list(capture["formulas"])
    ranges = []
    for title in titles:
        dimensions = props[title]["gridProperties"]
        legacy = title in {*calendar.month_name[1:],"Template"} and not expense_layout_metadata(category_layout(capture["rows"][title]))
        columns = dimensions["columnCount"] + (shifted and legacy)
        ranges.append(f"'{title.replace(chr(39),chr(39)*2)}'!A1:{get_column_letter(columns)}{dimensions['rowCount']}")
    response = client.http_client.values_batch_get(capture["id"],ranges,params={"valueRenderOption":render})["valueRanges"]
    if len(response) != len(titles):
        raise ValueError("A workbook snapshot is incomplete")
    return {title:row.get("values",[]) for title,row in zip(titles,response)}


def build_plan(captures: dict[str, Any], database: dict[str, Any], accounts: list[dict[str, Any]], year: int) -> dict[str, Any]:
    shared = captures["shared"]
    properties = {s["properties"]["title"]: s["properties"] for s in shared["metadata"]["sheets"]}
    titles = {t for t in shared["rows"] if t in {*calendar.month_name[1:], "Template"}}
    logs = {calendar.month_name[int(t[-2:])]: rows for t, rows in shared["rows"].items() if t.startswith(f"_BookieBot Action Log - {year}-")}
    recovery = recover_gas_locations(shared["rows"], logs, database["bank_transactions"], database["bank_reconciliation_items"], accounts)
    locations = {value["actionId"]: value["location"] for value in recovery}
    requests = []
    for title in sorted(titles):
        requests.extend(shared_sheet_requests(properties[title], shared["rows"][title], locations={value["row"]:value["location"] for value in recovery if value["title"] == title}))
    expected_logs = {}
    action_count = 0
    for title, rows in shared["rows"].items():
        if not title.startswith(f"_BookieBot Action Log - {year}-"):
            continue
        expected_logs[title] = deepcopy(rows)
        for index, row in enumerate(rows[1:], 2):
            if len(row) < 6 or not row[5]:
                continue
            original = json.loads(row[5])
            updated = migrate_action(original, location=locations.get(row[0], ""))
            if updated != original:
                encoded = json.dumps(updated)
                requests.append(cell_request(properties[title]["sheetId"], index, 6, encoded))
                expected_logs[title][index - 1][5] = encoded
                action_count += 1
    plan: dict[str, Any] = {"version": 1, "year": year, "sharedId": shared["id"], "titles": sorted(titles),
        "recovery": recovery, "books": [{"id": shared["id"], "requests": requests}], "expectedLogs": expected_logs, "db": [],
        "summary": {"tabs": len(titles), "gasLocations": len(recovery), "actionRecords": action_count, "imports": 0, "allocations": 0, "bankReferences": 0}}
    for owner in ("brian", "hannah"):
        capture = captures[owner]
        props = {s["properties"]["title"]:s["properties"] for s in capture["metadata"]["sheets"]}
        edits = []
        for title, rows in capture["formulas"].items():
            for row_number, row in enumerate(rows, 1):
                for col_number, value in enumerate(row, 1):
                    if not isinstance(value, str) or "IMPORTRANGE" not in value.upper():
                        continue
                    updated = rewrite_import(value, source_id=shared["id"])
                    if updated != value:
                        edits.append({"updateCells": {"start": {"sheetId": props[title]["sheetId"], "rowIndex": row_number-1, "columnIndex": col_number-1},
                            "rows": [{"values": [{"userEnteredValue": {"formulaValue": updated}}]}], "fields": "userEnteredValue"}})
                        plan["summary"]["imports"] += 1
        plan["books"].append({"id":capture["id"], "requests":edits})
    for record in database["app_reimbursement_allocations"]:
        original = record["payload_json"]
        updated = migrate_allocation(json.loads(original), shared_id=shared["id"], titles=titles, locations=locations)
        if updated != json.loads(original):
            plan["db"].append({"table":"app_reimbursement_allocations", "id":record["id"], "field":"payload_json", "before":original, "after":json.dumps(updated,sort_keys=True,separators=(",",":"))})
            plan["summary"]["allocations"] += 1
    months = {f"{year}-{list(calendar.month_name).index(t):02}" for t in titles if t != "Template"}
    for table, key in (("bank_reconciliation_items","id"),("bank_import_operations","operation_id")):
        for record in database[table]:
            old = record.get("matched_sheet_ref") or ""
            new = migrate_sheet_ref(old, months=months)
            if new != old:
                plan["db"].append({"table":table,"key":key,"id":record[key],"field":"matched_sheet_ref","before":old,"after":new})
                plan["summary"]["bankReferences"] += 1
    return plan


def verify_shared(client: Any, plan: dict[str, Any], capture: dict[str, Any]) -> None:
    from openpyxl.utils import column_index_from_string
    current = read_capture(client,capture,"FORMATTED_VALUE",shifted=True)
    recovery = {(r["title"],r["row"]):r["location"] for r in plan["recovery"]}
    for title in plan["titles"]:
        rows = current[title]
        layout = category_layout(rows)
        if expense_layout_metadata(layout).get("expense_layout") != GAS_LOCATION_LAYOUT:
            raise ValueError(f"{title}: Gas Location header was not published")
        old = capture["rows"][title]
        # Every original purchase field, including blanks, must remain identical
        # at its translated coordinate. Never compare rounded monthly totals alone.
        old_layout = category_layout(old)
        delta = 0 if expense_layout_metadata(old_layout) else 1
        for category, config in old_layout.items():
            for index, old_row in enumerate(old[2:],3):
                for field, col in config["columns"].items():
                    before_col = column_index_from_string(col)-1
                    after_col = column_index_from_string(layout[category]["columns"][field])-1
                    before = old_row[before_col] if before_col < len(old_row) else ""
                    after = rows[index-1][after_col] if index <= len(rows) and after_col < len(rows[index-1]) else ""
                    if before != after:
                        raise ValueError(f"{title}: an original {category}/{field} value differs at row {index}")
        for (month,row), location in recovery.items():
            if month == title and rows[row-1][9] != location:
                raise ValueError(f"{title}: recovered location did not verify at row {row}")
        # Compare each native category's summary outputs, not just the grand total.
        for row_number, old_row in enumerate(capture["formulas"][title],1):
            for col, formula in enumerate(old_row,1):
                if isinstance(formula,str) and formula.lstrip().upper().startswith("=SUMIF("):
                    shifted = col + (delta if col >= 10 else 0)
                    before = old[row_number-1][col-1] if col <= len(old[row_number-1]) else ""
                    after = rows[row_number-1][shifted-1] if shifted <= len(rows[row_number-1]) else ""
                    if before != after:
                        raise ValueError(f"{title}: a category SUMIF changed after insertion")
    for title, expected in plan["expectedLogs"].items():
        if current[title] != expected:
            raise ValueError(f"{title}: action-log readback differs")


def apply_plan(plan: dict[str, Any], captures: dict[str, Any], env_file: Path | None) -> None:
    from dotenv import load_dotenv
    import psycopg
    from psycopg import sql
    from psycopg.rows import dict_row
    load_dotenv(env_file)
    from bookiebot.sheets.auth import get_gspread_client
    client = get_gspread_client()
    with psycopg.connect(os.environ["DATABASE_PUBLIC_URL"],row_factory=dict_row) as db:
        db.execute("SELECT pg_advisory_xact_lock(84392517)")
        if db.execute("SELECT COUNT(*) AS n FROM app_transaction_commands WHERE state != 'done'").fetchone()["n"]:
            raise ValueError("A transaction command is not complete; no migration writes made")
        if db.execute("SELECT COUNT(*) AS n FROM app_reimbursement_allocations WHERE version != projected_version").fetchone()["n"]:
            raise ValueError("Reimbursements are still syncing; no migration writes made")
        if db.execute("SELECT COUNT(*) AS n FROM bank_import_operations WHERE status != 'completed'").fetchone()["n"]:
            raise ValueError("A bank import needs recovery; no migration writes made")
        for update in plan["db"]:
            query=sql.SQL("SELECT {} AS value FROM {} WHERE {}=%s FOR UPDATE").format(sql.Identifier(update["field"]),sql.Identifier(update["table"]),sql.Identifier(update.get("key","id")))
            row = db.execute(query,(update["id"],)).fetchone()
            if row is None or row["value"] not in {update["before"],update["after"]}:
                raise ValueError("Saved database evidence changed; create a fresh reviewed plan")
        # Check every workbook before writing to any of them.
        ready = []
        for target in plan["books"]:
            if not target["requests"]:
                continue
            book=client.open_by_key(target["id"])
            capture=next(c for c in captures.values() if c["id"]==target["id"])
            actual_rows = read_capture(client,capture,"FORMULA")
            if target["id"]==plan["sharedId"]:
                already = all(expense_layout_metadata(category_layout(actual_rows[t])).get("expense_layout")==GAS_LOCATION_LAYOUT for t in plan["titles"])
                if already:
                    verify_shared(client,plan,capture)
                    continue
            # Whole-workbook batches are atomic. Check original inputs immediately
            # before the first mutation; a resume accepts only verified results.
            for title, expected in capture["formulas"].items():
                actual=actual_rows[title]
                if actual != expected:
                    # A personal workbook may have committed in an earlier retry.
                    if target["id"]!=plan["sharedId"] and [[rewrite_import(value,source_id=plan["sharedId"]) if isinstance(value,str) else value for value in row] for row in expected] == actual:
                        continue
                    raise ValueError(f"{title}: sheet content changed since backup; no more migration writes made")
            ready.append((book,target))
        for book,target in ready:
            book.batch_update({"requests":target["requests"]})
        verify_shared(client,plan,captures["shared"])
        for owner in ("brian","hannah"):
            capture=captures[owner]
            current=read_capture(client,capture,"FORMULA")
            for title,expected in capture["formulas"].items():
                actual=current[title]
                wanted=[[rewrite_import(value,source_id=plan["sharedId"]) if isinstance(value,str) else value for value in row] for row in expected]
                if actual != wanted:
                    raise ValueError(f"{owner}/{title}: personal import readback differs")
        for update in plan["db"]:
            query=sql.SQL("UPDATE {} SET {}=%s WHERE {}=%s AND {}=%s").format(sql.Identifier(update["table"]),sql.Identifier(update["field"]),sql.Identifier(update.get("key","id")),sql.Identifier(update["field"]))
            db.execute(query,(update["after"],update["id"],update["before"]))
        db.commit()


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture",type=Path,required=True)
    parser.add_argument("--year",type=int,default=2026)
    parser.add_argument("--env-file",type=Path)
    parser.add_argument("--apply",action="store_true")
    parser.add_argument("--writers-stopped",action="store_true")
    args=parser.parse_args()
    captures={name:json.loads((args.capture/(name+f"-{args.year}.json")).read_text()) for name in ("shared","brian","hannah")}
    database=json.loads((args.capture/"db.json").read_text())
    accounts=json.loads((args.capture/"bank-accounts.json").read_text())
    path=args.capture/"migration-plan.json"
    if args.apply:
        if not args.writers_stopped:
            parser.error("--apply requires verified stopped app replicas and no running Apps Script job")
        plan=json.loads(path.read_text())
        apply_plan(plan,captures,args.env_file)
        private_json(args.capture/"verified.json",plan["summary"])
    else:
        plan=build_plan(captures,database,accounts,args.year)
        private_json(path,plan)
    print(json.dumps({"mode":"verified" if args.apply else "plan",**plan["summary"]}))


if __name__ == "__main__":
    main()
