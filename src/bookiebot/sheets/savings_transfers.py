"""Immutable personal savings-transfer rules; due occurrences are read-only.

The same occurrence funds Saved and its optional goal. No bank movement,
expense, income, midnight writer or second goal-contribution ledger is involved.
"""
from __future__ import annotations

import calendar
from dataclasses import asdict, dataclass
from datetime import date, timedelta
import json
import re
from typing import Any, Iterable

from bookiebot.sheets.recurring import BillConflict, BillValidation, fingerprint

TRANSFER_TAB = '_BookieBot Savings Transfers'
# Lifetime schedules live with the owners' original app configuration, not
# whichever annual workbook happens to be current after January rollover.
TRANSFER_STORAGE_YEAR = 2026
TRANSFER_EPOCH = date(2026, 11, 15)
HEADERS = ['transfer_id', 'revision', 'definition_json']
FREQUENCIES = {'once', 'monthly', 'quarterly', 'yearly'}


def iso_date(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise BillValidation('Choose a valid transfer date.')
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise BillValidation('Choose a valid transfer date.') from exc
    if not 2000 <= parsed.year <= 2200:
        raise BillValidation('Choose a transfer date between 2000 and 2200.')
    return value


@dataclass(frozen=True)
class Transfer:
    id: str
    revision: int
    name: str
    amount_cents: int
    frequency: str
    starts_on: str
    effective_from: str
    goal_id: str = ''
    from_account: str = ''
    to_account: str = ''
    active: bool = True

    def public(self) -> dict[str, Any]:
        return {'id': self.id, 'revision': self.revision, 'name': self.name, 'amountCents': self.amount_cents,
                'frequency': self.frequency, 'startsOn': self.starts_on, 'effectiveFrom': self.effective_from,
                'goalId': self.goal_id, 'fromAccount': self.from_account, 'toAccount': self.to_account,
                'active': self.active}


def decode(rows: list[list[str]]) -> list[Transfer]:
    if not rows or not any(rows[0]):
        return []
    if rows[0] != HEADERS:
        raise BillConflict('The savings transfer table needs verification before continuing.')
    result: list[Transfer] = []
    seen: set[tuple[str, int]] = set()
    for row in rows[1:]:
        if not any(row):
            continue
        try:
            transfer = Transfer(**json.loads(row[2]))
            if (row[0] != transfer.id or int(row[1]) != transfer.revision
                    or not re.fullmatch(r'[A-Za-z0-9_-]{8,80}', transfer.id)
                    or type(transfer.revision) is not int or transfer.revision < 1
                    or type(transfer.amount_cents) is not int or not 1 <= transfer.amount_cents <= 10_000_000_000
                    or transfer.frequency not in FREQUENCIES or type(transfer.active) is not bool
                    or not iso_date(transfer.starts_on) or not iso_date(transfer.effective_from)
                    or any(not isinstance(v, str) or len(v) > limit or any(ord(c) < 32 for c in v)
                           for v, limit in [(transfer.name, 80), (transfer.goal_id, 80),
                                            (transfer.from_account, 80), (transfer.to_account, 80)])
                    or not transfer.name.strip() or (transfer.id, transfer.revision) in seen):
                raise ValueError('invalid transfer')
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            raise BillConflict('A saved transfer needs verification. No transfer was changed.') from exc
        seen.add((transfer.id, transfer.revision))
        result.append(transfer)
    return result


def encode(transfers: Iterable[Transfer]) -> list[list[str]]:
    return [HEADERS, *[[t.id, str(t.revision), json.dumps(asdict(t), sort_keys=True, separators=(',', ':'))]
                      for t in sorted(transfers, key=lambda t: (t.id, t.revision))]]


def current(transfers: Iterable[Transfer]) -> list[Transfer]:
    result: dict[str, Transfer] = {}
    for value in transfers:
        if value.id not in result or value.revision > result[value.id].revision:
            result[value.id] = value
    return sorted(result.values(), key=lambda t: (not t.active, t.name.casefold(), t.id))


def occurrences(transfers: Iterable[Transfer], start: date, end: date) -> list[dict[str, Any]]:
    if end < start:
        return []
    groups: dict[str, list[Transfer]] = {}
    for transfer in transfers:
        groups.setdefault(transfer.id, []).append(transfer)
    result: list[dict[str, Any]] = []
    for identity, values in groups.items():
        ordered = sorted(values, key=lambda t: (t.effective_from, t.revision))
        for index, transfer in enumerate(ordered):
            if not transfer.active:
                continue
            first = date.fromisoformat(transfer.starts_on)
            lower = max(start, first, date.fromisoformat(transfer.effective_from))
            upper = min(end, date.fromisoformat(ordered[index + 1].effective_from) - timedelta(days=1)) if index + 1 < len(ordered) else end
            if upper < lower:
                continue
            if transfer.frequency == 'once':
                dates = [first] if lower <= first <= upper else []
            else:
                step = {'monthly': 1, 'quarterly': 3, 'yearly': 12}[transfer.frequency]
                offset = max(0, (lower.year - first.year) * 12 + lower.month - first.month)
                offset += (-offset) % step
                dates = []
                while True:
                    year, month0 = divmod(first.year * 12 + first.month - 1 + offset, 12)
                    when = date(year, month0 + 1, min(first.day, calendar.monthrange(year, month0 + 1)[1]))
                    if when > upper:
                        break
                    if when >= lower:
                        dates.append(when)
                    offset += step
            for when in dates:
                result.append({'id': f'transfer-{identity}-{when.isoformat()}', 'transferId': identity,
                               'date': when.isoformat(), 'name': transfer.name, 'amountCents': transfer.amount_cents,
                               'goalId': transfer.goal_id, 'fromAccount': transfer.from_account,
                               'toAccount': transfer.to_account, 'readOnly': True})
    return sorted(result, key=lambda item: (item['date'], item['id']))


def storage_book(actor: str, today: date) -> tuple[int, str]:
    """Lifetime plans stay in the original app-year personal workbook.

    Annual reports/rollovers keep reading this same hidden configuration; they
    never fork goal allocations into independent annual copies.
    """
    from bookiebot.sheets.routing import get_budget_spreadsheet_id_for_user
    return TRANSFER_STORAGE_YEAR, get_budget_spreadsheet_id_for_user(actor, TRANSFER_STORAGE_YEAR)


def read_all(actor: str, *, client: Any = None, today: date | None = None) -> list[Transfer]:
    from bookiebot.sheets.auth import get_gspread_client
    from bookiebot.sheets.routing import now_pacific
    from bookiebot.reports.worksheet_reads import read_workbook_tabs
    today = today or now_pacific().date()
    gc = client or get_gspread_client()
    _, identity = storage_book(actor, today)
    return decode(read_workbook_tabs(gc, identity, [TRANSFER_TAB]).get(TRANSFER_TAB, []))


def read_source(actor: str, *, client: Any = None):
    """Minimal financial snapshot for the shared atomic Sheets batch writer."""
    from gspread.utils import absolute_range_name
    from bookiebot.sheets.auth import get_gspread_client
    from bookiebot.sheets.routing import get_user_config, now_pacific
    from bookiebot.sheets.recurring import SETTINGS_LOG_TAB
    from bookiebot.sheets.recurring_changes import BillSnapshot
    from bookiebot.sheets.recurring_storage import WorkbookSnapshot
    today = now_pacific().date()
    year, identity = storage_book(actor, today)
    owner = get_user_config(actor).budget_owner_key
    gc = client or get_gspread_client()
    metadata = gc.http_client.fetch_sheet_metadata(identity)
    properties = {s['properties']['title']: s['properties'] for s in metadata['sheets']}
    titles = [t for t in (TRANSFER_TAB, SETTINGS_LOG_TAB) if t in properties]
    rows = {}
    if titles:
        data = gc.http_client.values_batch_get(identity, [absolute_range_name(t) for t in titles], params={'valueRenderOption': 'FORMULA'})
        if len(data.get('valueRanges', [])) != len(titles):
            raise BillConflict('Transfers could not be read completely.')
        for title, value in zip(titles, data['valueRanges']):
            actual = str(value.get('range', '')).rsplit('!', 1)[0].strip("'").replace("''", "'")
            if actual != title:
                raise BillConflict('The transfer source changed while reading.')
            rows[title] = [[str(v) for v in row] for row in value.get('values', [])]
    decode(rows.get(TRANSFER_TAB, []))
    return WorkbookSnapshot(actor, owner, year, identity, gc, properties, metadata.get('namedRanges', []), rows, rows,
        BillSnapshot(owner, (), fingerprint(rows), today.strftime('%Y-%m'), {}))


def version(transfers: Iterable[Transfer]) -> str:
    return fingerprint(encode(transfers))
