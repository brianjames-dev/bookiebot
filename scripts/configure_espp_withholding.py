"""Review/apply recorded ESPP on Brian's current month and internal Template.

No rows/columns are inserted and no transactions are created. Application and
live Apps Script deployment are separate actions, never performed here.
"""
from __future__ import annotations

import argparse
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))

from bookiebot.sheets.savings_plan import WITHHOLDING_HEADER, money, parse_date, read_savings_plan


def paycheck_row(rows: list[list[Any]], received: date, deposit: str, withheld: str) -> int:
    plan = read_savings_plan(rows)
    header = next(index for index, row in enumerate(rows) if row[1:4] == ['Date:', 'Source:', 'Amount:'])
    total = next(index for index, row in enumerate(rows) if 'Monthly Income:' in row)
    matches = [index for index in range(header + 1, total) if len(rows[index]) > 3
               and parse_date(rows[index][1]) == received and money(rows[index][3]) == money(deposit)
               and plan.for_paycheck(str(rows[index][2]), received)]
    if len(matches) != 1:
        raise ValueError('Expected one existing enrolled paycheck matching the date and deposit; no changes made.')
    index = matches[0]
    existing = rows[index][4] if len(rows[index]) > 4 else ''
    if str(existing).strip() and money(existing) != money(withheld):
        raise ValueError('The paycheck already has a different ESPP value; inspect before replacing it.')
    return index + 1


def prepared_requests(rows: list[list[Any]], *, year: int, title: str) -> list[dict[str, Any]]:
    result = subprocess.run(['node', str(ROOT / 'scripts/prepare_espp_sheet.cjs')],
        input=json.dumps({'rows': rows, 'year': year, 'title': title, 'recordedWithholding': True}),
        text=True, capture_output=True, check=True)
    requests = json.loads(result.stdout)
    if any(any(key in request for key in ('insertDimension', 'deleteDimension', 'addSheet', 'deleteSheet')) for request in requests):
        raise ValueError('This upgrade must not insert/remove rows, columns or tabs.')
    return requests


def remap_sheet(value: Any, sheet_id: int) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'sheetId':
                value[key] = sheet_id
            else:
                remap_sheet(item, sheet_id)
    elif isinstance(value, list):
        for item in value:
            remap_sheet(item, sheet_id)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--year', type=int, default=2026)
    parser.add_argument('--month', default='October')
    parser.add_argument('--paycheck-date', type=date.fromisoformat, required=True)
    parser.add_argument('--deposit', required=True)
    parser.add_argument('--withheld', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    if money(args.withheld) <= 0 or money(args.deposit) <= 0:
        parser.error('The confirmed deposit and deduction must be positive.')
    from dotenv import load_dotenv
    load_dotenv(args.env_file)
    from bookiebot.sheets.auth import get_gspread_client
    from bookiebot.sheets.routing import get_year_config
    from bookiebot.reports.expense_breakdown import _income_entries, _calculate_month_savings, BudgetMonth

    book = get_gspread_client().open_by_key(get_year_config(args.year).brian_budget_spreadsheet_id)
    changes, snapshots = [], []
    target_row = None
    for title in (args.month, 'Template'):
        worksheet = book.worksheet(title)
        rows = worksheet.get_all_values()
        requests = prepared_requests(rows, year=args.year, title=title)
        remap_sheet(requests, worksheet.id)
        if title == args.month:
            target_row = paycheck_row(rows, args.paycheck_date, args.deposit, args.withheld)
            requests.append({'updateCells': {'range': {'sheetId': worksheet.id, 'startRowIndex': target_row - 1,
                'endRowIndex': target_row, 'startColumnIndex': 4, 'endColumnIndex': 5},
                'rows': [{'values': [{'userEnteredValue': {'numberValue': float(money(args.withheld))}}]}], 'fields': 'userEnteredValue'}})
        changes.extend(requests)
        snapshots.append({'title': title, 'sheetId': worksheet.id, 'values': rows,
                          'formulas': worksheet.get_all_values(value_render_option='FORMULA')})
    print(f'Prepared {len(changes)} requests: reuse E income cells, automatic ESPP/cash targets; no structural changes.')
    print(f'Existing paycheck: {args.month}!E{target_row} = ${money(args.withheld)}; bank deposit unchanged.')
    if not args.apply:
        print('Read-only preview; add --apply --backup <new-private-file> to apply.')
        return
    if args.backup is None:
        parser.error('--apply requires --backup')
    metadata = book.fetch_sheet_metadata(params={'includeGridData': True, 'ranges': [args.month, 'Template']})
    with os.fdopen(os.open(args.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump({'spreadsheetId': book.id, 'sheets': snapshots, 'metadata': metadata}, stream)
    # A final read prevents replacing inputs changed since preflight.
    for snapshot in snapshots:
        if book.worksheet(snapshot['title']).get_all_values(value_render_option='FORMULA') != snapshot['formulas']:
            raise ValueError('Sheet changed during preflight; inspect before applying.')
    book.batch_update({'requests': changes})
    for snapshot in snapshots:
        worksheet = book.worksheet(snapshot['title'])
        rows = worksheet.get_all_values()
        original = snapshot['values']
        header = next(index for index, row in enumerate(rows) if row[1:4] == ['Date:', 'Source:', 'Amount:'])
        total = next(index for index, row in enumerate(rows) if 'Monthly Income:' in row)
        assert rows[header][4] == WITHHOLDING_HEADER
        assert [row[1:4] for row in rows[header+1:total]] == [row[1:4] for row in original[header+1:total]]
        cash = next(row for row in rows if any('monthly savings contribution' in str(value).lower() for value in row))
        old_cash = next(row for row in original if any('monthly savings contribution' in str(value).lower() for value in row))
        assert cash[4] == old_cash[4], 'Actual cash saved must not change.'
        if snapshot['title'] == args.month:
            entries, deposited = _income_entries(rows)
            expected = _calculate_month_savings(read_savings_plan(rows), deposited, entries, BudgetMonth(args.year, args.paycheck_date.month))
            total_line = next(row for row in rows if 'SpaceX ESPP this month' in row)
            assert money(total_line[3]) == money(expected['esppContribution']) == money(args.withheld)
            assert money(cash[2].split('=')[-1]) == money(expected['cashIdeal'])
            assert money(cash[3].split('=')[-1]) == money(expected['cashMinimum'])
            print(json.dumps({'confirmedESPP': expected['esppContribution'], 'cashIdeal': expected['cashIdeal'],
                              'cashMinimum': expected['cashMinimum'], 'totalSavingsGoal': expected['totalSavingsGoal']}))
    print('Native readback agrees with the corrected app calculation; paycheck rows and actual cash saved preserved.')


if __name__ == '__main__':
    main()
