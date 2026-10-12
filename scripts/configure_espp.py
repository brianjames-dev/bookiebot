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

    book = get_gspread_client().open_by_key(get_year_config(args.year).brian_budget_spreadsheet_id)
    prepared = []
    backups = []
    # Prepare both tabs completely before sending a mutation.
    for title in (args.month, "Template"):
        ws = book.worksheet(title)
        rows = ws.get_all_values()
        formulas = ws.get_all_values(value_render_option="FORMULA")
        result = subprocess.run(["node", str(ROOT / "scripts/prepare_espp_sheet.cjs")],
                                input=json.dumps({"rows": rows, "year": args.year, "title": title,
                                                  "firstPaycheckDate": args.first_paycheck}),
                                text=True, capture_output=True, check=True)
        requests = json.loads(result.stdout)
        if ws.col_count < 12:
            prepared.append({"updateSheetProperties": {"properties": {"sheetId": ws.id, "gridProperties": {"columnCount": 12}},
                                                       "fields": "gridProperties.columnCount"}})
        for request in requests:
            operation = next(iter(request.values()))
            for key in ("range", "source", "destination"):
                if key in operation:
                    operation[key]["sheetId"] = ws.id
        prepared.extend(requests)
        backups.append({"title": title, "sheetId": ws.id, "rows": formulas})
        print(f"{title}: prepared {len(requests)} requests; xAI, first paycheck {args.first_paycheck}, 5% ESPP / 15% ideal / 7.5% minimum; other income 20% cash.")
    if not args.apply:
        print("Read-only preview; rerun with --apply to install.")
        return
    with os.fdopen(os.open(args.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as backup:
        json.dump({"spreadsheetId": book.id, "sheets": backups}, backup)
    book.batch_update({"requests": prepared})
    print(f"Applied both tabs atomically. Original formulas saved to {args.backup}.")
    for title in (args.month, "Template"):
        ws = book.worksheet(title)
        print(title, ws.get("G4:L5"), [row[6:8] for row in ws.get_all_values() if len(row)>6 and row[6]])


if __name__ == "__main__":
    main()
