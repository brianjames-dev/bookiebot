"""Review/apply Brian's ESPP sheet setup using the repository's Apps Script."""
from __future__ import annotations

import argparse
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import sys

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def shifted_income_action(action: dict, first_row: int, added: int) -> dict:
    updated = json.loads(json.dumps(action))
    if action.get("worksheet") != "income" or action.get("metadata", {}).get("type") == "system_state":
        return updated
    if int(action.get("row", 0)) >= first_row:
        updated["row"] = int(action["row"]) + added
    for key in ("source_row", "income_header_row", "income_summary_row"):
        value = updated.get("metadata", {}).get(key, "0")
        if str(value).isdigit() and int(value) >= first_row:
            updated["metadata"][key] = str(int(value) + added)
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--month", default="October")
    parser.add_argument("--first-paycheck", default="2026-10-23")
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed changes; default is read-only")
    parser.add_argument("--backup", type=Path, default=Path("/private/tmp/bookiebot-espp-backup.json"))
    args = parser.parse_args()
    date.fromisoformat(args.first_paycheck)
    load_dotenv(args.env_file)
    from bookiebot.sheets.auth import get_gspread_client
    from bookiebot.sheets.routing import get_year_config
    from bookiebot.sheets.savings_plan import SETTINGS_TAB, SETTINGS_HEADERS

    client=get_gspread_client()
    config=get_year_config(args.year)
    book = client.open_by_key(config.brian_budget_spreadsheet_id)
    prepared = []
    backups = []
    settings = next((ws for ws in book.worksheets() if ws.title == SETTINGS_TAB), None)
    settings_rows = settings.get_all_values() if settings else None
    if settings_rows is not None and tuple(settings_rows[0][:4]) != SETTINGS_HEADERS:
        raise ValueError("Invalid ESPP Settings headers; no changes made")
    # Prepare both tabs completely before sending a mutation.
    for title in (args.month, "Template"):
        ws = book.worksheet(title)
        rows = ws.get_all_values()
        formulas = ws.get_all_values(value_render_option="FORMULA")
        payload = {"rows": rows, "year": args.year, "title": title, "firstPaycheckDate": args.first_paycheck}
        if settings_rows is not None:
            payload["settingsRows"] = settings_rows
        result = subprocess.run(["node", str(ROOT / "scripts/prepare_espp_sheet.cjs")], input=json.dumps(payload),
                                text=True, capture_output=True, check=True)
        requests = json.loads(result.stdout)
        def remap(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key == "sheetId":
                        value[key] = ws.id
                    else:
                        remap(item)
            elif isinstance(value, list):
                for item in value:
                    remap(item)
        remap(requests)
        prepared.extend(requests)
        if title==args.month:
            insertions=[r["insertDimension"]["range"] for r in requests if "insertDimension" in r]
            original_header=next(i+1 for i,row in enumerate(rows) if row[1:4]==["Date:","Source:","Amount:"])
        backups.append({"title": title, "sheetId": ws.id, "rows": formulas, "insertions":[r["insertDimension"]["range"] for r in requests if "insertDimension" in r]})
        print(f"{title}: prepared {len(requests)} requests; one bordered ESPP total, inline four-column enrollment, existing cash target cells.")
    # Coordinate-only changes for saved Undo and shared-income lineage. Read and
    # back up both workbooks before writing; financial amounts never change.
    shared=client.open_by_key(config.shared_expenses_spreadsheet_id)
    import calendar
    month_number=list(calendar.month_name).index(args.month)
    log=next((ws for ws in shared.worksheets() if ws.title==f"_BookieBot Action Log - {args.year}-{month_number:02}"),None)
    log_updates=[]; log_originals=[]
    if insertions:
        if log:
            for number,row in enumerate(log.get_all_values()[1:],2):
                if len(row)<=5 or row[2] not in {"676638528590970917","shortcut:brian"} or not row[5]:
                    continue
                action=json.loads(row[5]); updated=action
                for insertion in insertions:
                    updated=shifted_income_action(updated,insertion["startIndex"]+1,insertion["endIndex"]-insertion["startIndex"])
                if action!=updated:
                    log_originals.append({"range":f"F{number}","values":[[row[5]]]})
                    log_updates.append({"range":f"F{number}","values":[[json.dumps(updated)]]})
        ledger=next((ws for ws in book.worksheets() if ws.title=="Shared Reimbursements"),None)
        if ledger:
            rows=ledger.get_all_values(); columns=rows[0]
            from bookiebot.sheets.savings_plan import parse_date
            for number,row in enumerate(rows[1:],2):
                def field(name): return row[columns.index(name)] if columns.index(name)<len(row) else ""
                received=parse_date(field("expense_date"))
                if (field("source_worksheet")=="income" and received and received.year==args.year and received.month==month_number
                        and int(field("source_row") or 0)>0):
                    value=int(field("source_row"))
                    for insertion in insertions:
                        if value>=insertion["startIndex"]+1:
                            value+=insertion["endIndex"]-insertion["startIndex"]
                    if value==int(field("source_row")):
                        continue
                    prepared.append({"updateCells":{"range":{"sheetId":ledger.id,"startRowIndex":number-1,"endRowIndex":number,
                        "startColumnIndex":columns.index("source_row"),"endColumnIndex":columns.index("source_row")+1},
                        "rows":[{"values":[{"userEnteredValue":{"numberValue":value}}]}],"fields":"userEnteredValue"}})
    if settings:
        other=[ws.title for ws in book.worksheets() if ws.title not in {args.month,"Template",SETTINGS_TAB}]
        references=book.values_batch_get([f"'{title.replace(chr(39), chr(39)*2)}'!A1:ZZ" for title in other],params={"valueRenderOption":"FORMULA"})
        if any(SETTINGS_TAB in str(cell) for result in references.get("valueRanges",[]) for row in result.get("values",[]) for cell in row):
            raise ValueError("Other months still reference ESPP Settings; inspect before moving settings")
        prepared.append({"deleteSheet":{"sheetId":settings.id}})
    print(f"Preserving {len(log_updates)} saved income action references; removing the superseded settings tab if present.")
    if not args.apply:
        print("Read-only preview; rerun with --apply to install.")
        return
    with os.fdopen(os.open(args.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as backup:
        metadata = book.fetch_sheet_metadata(params={"includeGridData": True,
            "ranges": [args.month, "Template", *([SETTINGS_TAB] if settings else []), "Shared Reimbursements"]})
        json.dump({"spreadsheetId": book.id, "sheets": backups, "metadata": metadata, "sharedId":shared.id,"logTitle":log.title if log else None,"originalLogCells":log_originals}, backup)
    if log_updates:
        log.batch_update(log_updates,value_input_option="RAW")
    try:
        book.batch_update({"requests": prepared})
    except Exception:
        # On an uncertain response inspect the header before reverting references.
        # The personal workbook batch is atomic, including reimbursement rows.
        current=book.worksheet(args.month).get_all_values()
        header=next((i+1 for i,row in enumerate(current) if row[1:4]==["Date:","Source:","Amount:"]),None)
        if insertions and header==original_header and log_originals:
            log.batch_update(log_originals,value_input_option="RAW")
        raise
    print(f"Applied both tabs atomically. Original formulas saved to {args.backup}.")
    for title in (args.month, "Template"):
        ws = book.worksheet(title)
        print(title, [row[:5] for row in ws.get_all_values() if any("SpaceX ESPP this month" in value for value in row)])


if __name__ == "__main__":
    main()
