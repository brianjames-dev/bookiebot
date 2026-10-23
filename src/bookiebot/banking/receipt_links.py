"""Read-only links from saved bank matches to canonical shared expenses."""
from __future__ import annotations

import calendar
import re
from typing import Any

from bookiebot.reimbursements import service as reimbursements
from bookiebot.sheets.auth import get_existing_personal_worksheet
from bookiebot.sheets.bills import list_bill_schedules
from bookiebot.sheets.routing import sheet_user_context


def matched_receipt_link(owner, actor, item, *, allocations: list[dict[str, Any]] | None = None):
    if (not reimbursements.enabled() or item is None or item.status not in {'matched', 'confirmed'}
            or item.transaction.pending or item.transaction.amount <= 0):
        return None
    rows = reimbursements.snapshot(owner)['allocations'] if allocations is None else allocations
    gross = round(item.transaction.amount * 100)
    eligible = [row for row in rows if row['payerOwner'] == owner and row['accounting'] == 'cash_v1'
                and row.get('lifecycle', 'active') == 'active' and row['grossCents'] == gross]
    if not eligible:
        return None
    refs = [part.strip() for part in (item.matched_sheet_ref or '').split(' + ')]
    def source_month(row):
        month_name = row.get('sourceSheetTitle')
        return (f"{row['sourceYear']}-{list(calendar.month_name).index(month_name):02d}"
                if month_name in list(calendar.month_name)[1:] else row['expenseDate'][:7])
    def physical(row):
        month = source_month(row)
        for ref in refs:
            match = re.fullmatch(r'(expense|income)!row (\d+)#cols=([\d,]+)#month=(\d{4}-\d{2})', ref)
            if (match and match[1] == row['sourceWorksheet'] and int(match[2]) == row['sourceRow']
                    and match[4] == month and str(row.get('sourceColumnMap', {}).get('amount')) in match[3].split(',')):
                return True
        return False
    # Stable action identity is preferred; physical evidence also covers saved
    # pre-split update ancestors without a new action-history/Sheets read.
    months = {match[1] for ref in refs if (match := re.search(r'#month=(\d{4}-\d{2})', ref))}
    found = [row for row in eligible if (item.matched_action_log_id
             and item.matched_action_log_id == row['sourceActionId']
             and source_month(row) in (months or {(item.transaction.date or item.transaction.authorized_date or '')[:7]})) or physical(row)]
    if not found:
        scheduled = [ref for ref in refs if re.fullmatch(r'_BookieBot Bill Schedule!A\d+:[A-Z]+\d+#pull=\d{4}-\d{2}', ref)]
        if scheduled:
            with sheet_user_context(actor):
                bills = list_bill_schedules(get_existing_personal_worksheet('_BookieBot Bill Schedule').get_all_values())
            normalize = lambda value: re.sub(r'[^a-z0-9]', '', value.lower())
            for ref in scheduled:
                source, month = ref.split('#pull=')
                bills_for_ref = [bill for bill in bills if bill.source_range == source]
                if len(bills_for_ref) != 1:
                    continue
                found.extend(row for row in eligible if row['sourceWorksheet'] == 'income'
                    and row['sourceYear'] == int(month[:4])
                    and (row.get('sourceSheetTitle') or calendar.month_name[int(row['expenseDate'][5:7])]) == calendar.month_name[int(month[5:7])]
                    and normalize(row['category']) == normalize(bills_for_ref[0].source_label))
    unique = {row['id']: row for row in found}
    if len(unique) != 1:
        return None  # Never guess by merchant name or amount alone.
    row = next(iter(unique.values()))
    return dict(allocationId=row['id'], partner=row['partnerOwner'].title(),
                bankAmountCents=gross, outstandingCents=row['outstandingCents'])
