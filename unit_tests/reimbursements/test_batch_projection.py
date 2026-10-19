from copy import deepcopy
from types import SimpleNamespace

from gspread.exceptions import APIError
import pytest
from requests import Response

from bookiebot.reimbursements import batch_projection as batch, mirror, projection
from bookiebot.reimbursements.batch_projection import sync_received
from bookiebot.sheets import auth
from bookiebot.sheets.collaboration import SHARED_REIMBURSEMENT_HEADERS, expense_person_for_owner
from unit_tests.reimbursements.test_projection import Book
from unit_tests.reimbursements.test_store import store, access, payload, bulk_payment  # noqa: F401


class HTTP:
    def __init__(self, books):
        self.books = books
        self.calls = []
        self.corrupt = False

    def fetch_sheet_metadata(self, key, params):
        self.calls.append(('metadata', key))
        book = self.books[key]
        result = {'namedRanges': deepcopy(list(book.names.values()))}
        if params['fields'] != 'namedRanges':
            result['sheets'] = [{'properties': {'title': s.title, 'sheetId': s.id,
                'gridProperties': {'rowCount': s.row_count, 'columnCount': s.col_count}}} for s in book.sheets.values()]
        return result

    def values_batch_get(self, key, ranges, params):
        self.calls.append(('read', key))
        book = self.books[key]
        results = []
        for name in ranges:
            rows = book.values_get(name)['values'] if name in book.names else book.worksheet(name.strip("'")).get_all_values()
            if self.corrupt and name.startswith('BB_source_'):
                rows[0][2] = 'Edited after write'
            results.append({'range': name, 'values': rows})
        return {'valueRanges': results}

    def values_get(self, key, name, params):
        assert params == {'valueRenderOption': 'FORMULA'}
        self.calls.append(('formula', key))
        return {'range': name + '!A1:AN1000',
                'values': self.books[key].worksheet(name.strip("'")).get_all_values()}

    def batch_update(self, key, body):
        self.calls.append(('structure', key))
        self.books[key].batch_update(body)

    def values_batch_update(self, key, body):
        self.calls.append(('write', key))
        self.books[key].values_batch_update(body)


def prepare(store, monkeypatch, count=12, bill=False, *, verify_formulas=False, owner='brian'):
    from bookiebot.reimbursements import migration
    if not verify_formulas:
        monkeypatch.setattr(migration, 'verify_budget_links', lambda *_a, **_kw: None)
    books = {key: Book() for key in ('shared', 'brian', 'hannah')}
    source = books['shared'].add_sheet('January')
    for budget_owner in ('brian', 'hannah'):
        books[budget_owner].add_sheet('January')
        books[budget_owner].add_sheet('Shared Reimbursements', [SHARED_REIMBURSEMENT_HEADERS])
    budget_key = lambda actor, year: 'hannah' if str(actor) == '830984827904851969' else 'brian'
    monkeypatch.setattr(batch, 'get_budget_spreadsheet_id_for_user', budget_key)
    monkeypatch.setattr(mirror, 'get_budget_spreadsheet_id_for_user', budget_key)
    monkeypatch.setattr(projection, 'get_budget_spreadsheet_id_for_user', budget_key)
    monkeypatch.setattr(batch, 'get_shared_expenses_spreadsheet_id', lambda _year: 'shared')
    monkeypatch.setattr(projection, 'get_shared_expenses_spreadsheet_id', lambda _year: 'shared')
    monkeypatch.setattr(migration, 'get_budget_spreadsheet_id_for_user', budget_key)
    monkeypatch.setattr(migration, 'get_shared_expenses_spreadsheet_id', lambda _year: 'shared')
    if verify_formulas:
        for index, budget_owner in enumerate(('brian', 'hannah')):
            person = expense_person_for_owner(budget_owner)
            source.write(index, 1, [f'=SUMIF(AH:AH,"{person}",AF:AF)'])
            books[budget_owner].worksheet('January').write(0, 0, [
                'Various Need Transactions', f'=IMPORTRANGE("shared","January!B{index + 1}")'])
    http = HTTP(books)
    client = SimpleNamespace(http_client=http, open_by_key=lambda key: books[key])
    monkeypatch.setattr(auth, 'get_gspread_client', lambda: client)
    projector = projection.SheetsProjection(client)
    values = []
    for index in range(count):
        item = f'Expense {index}'
        fields = {'date': 30, 'item': 31, 'amount': 32, 'location': 33, 'person': 34}
        source_values = {'date': '1/3/2026', 'item': item, 'amount': '100', 'location': 'Shop', 'person': expense_person_for_owner(owner)}
        key, worksheet, category = 'shared', 'expense', 'need_expenses'
        sheet = source
        if bill is True or (bill == 'mixed' and index == 0):
            item, fields = 'PG&E', {'item': 2, 'amount': 3}
            source_values = {'item': item, 'amount': '100'}
            key, worksheet, category = owner, 'income', 'pg&e'
            sheet = books[owner].worksheet('January')
            books['hannah' if owner == 'brian' else 'brian'].worksheet('January').write(index + 2, 1, [item, 0])
        sheet.write(index + 2, min(fields.values()) - 1, list(source_values.values()))
        value = store.register_allocation(payload(item=item, category=category, sourceWorksheet=worksheet,
            payerOwner=owner, partnerOwner='hannah' if owner == 'brian' else 'brian', payerPerson=expense_person_for_owner(owner),
            sourceSpreadsheetId=key, sourceSheetTitle='January', sourceRow=index + 3,
            sourceColumnMap=fields, sourceValues=source_values, ledgerSpreadsheetId=owner, ledgerYear=2026))
        projector.source(value)
        mirror.mirror_allocation(client, value, projector=projector)
        store.mark_projected(value['id'], value['version'])
        values.append(value)
    http.calls.clear()
    return books, http, values


@pytest.mark.parametrize('count', [1, 80])
def test_bulk_receipts_batch_calls_by_workbook_not_by_expense(store, monkeypatch, count):
    books, http, values = prepare(store, monkeypatch, count)
    body = bulk_payment(store)
    body['date'] = '2026-01-04'
    result = store.command('brian', body)
    ids = {value['id'] for value in values}
    assert sync_received(store, ids)
    assert len([call for call in http.calls if call[0] == 'write']) == 2
    assert len([call for call in http.calls if call[0] == 'structure']) == 1
    assert len([call for call in http.calls if call[0] == 'read']) == 4
    assert len([call for call in http.calls if call[0] == 'metadata']) == 4
    assert len(store.snapshot('brian')['events']) == count
    assert all(a['projectedVersion'] == a['version'] for a in store.snapshot('brian')['allocations'])
    for value in values:
        region = books['shared'].names[projection._name('amount', value['id'])]['range']
        assert books['shared'].by_id(region['sheetId']).read(region['startRowIndex'], 31, 32) == [60]
    calls = list(http.calls)
    assert store.command('brian', body) == result
    assert sync_received(store, ids)
    assert http.calls == calls


def test_batch_pge_alias_updates_both_personal_budget_cells(store, monkeypatch):
    books, _http, values = prepare(store, monkeypatch, 1, bill=True)
    store.command('brian', bulk_payment(store))
    assert sync_received(store, {values[0]['id']})
    assert books['brian'].worksheet('January').read(2, 1, 3) == ['PG&E', 60]
    assert books['hannah'].worksheet('January').read(2, 1, 3) == ['PG&E', 40]


def test_mixed_bulk_receipts_project_bill_and_shared_expenses_in_one_batch(store, monkeypatch):
    books, http, values = prepare(store, monkeypatch, 7, bill='mixed')
    body = bulk_payment(store)
    body['date'] = '2026-01-04'
    store.command('brian', body)
    assert sync_received(store, {value['id'] for value in values})
    assert books['brian'].worksheet('January').read(2, 1, 3) == ['PG&E', 60]
    assert books['hannah'].worksheet('January').read(2, 1, 3) == ['PG&E', 40]
    assert len([call for call in http.calls if call[0] == 'write']) == 4
    assert all(a['projectedVersion'] == a['version'] for a in store.snapshot('brian')['allocations'])


@pytest.mark.parametrize('phase', ['anchors', 'values', 'verification', 'mirror'])
def test_bulk_receipts_recover_lost_writes_without_new_receipts(store, monkeypatch, phase):
    books, http, values = prepare(store, monkeypatch, 3)
    body = bulk_payment(store)
    body['date'] = '2026-01-04'
    store.command('brian', body)
    if phase == 'anchors':
        books['shared'].timeout_after_batch = True
    elif phase == 'values':
        books['shared'].timeout_after_values = True
    elif phase == 'mirror':
        books['brian'].timeout_after_values = True
    else:
        http.corrupt = True
    ids = {value['id'] for value in values}
    assert not sync_received(store, ids)
    assert store.pending_bulk_projection_ids() == ids
    assert any(a['projectedVersion'] != a['version'] for a in store.snapshot('brian')['allocations'])
    http.corrupt = False
    store.command('brian', body)
    assert sync_received(store, ids)
    assert len(store.snapshot('brian')['events']) == 3
    assert store.pending_bulk_projection_ids() == set()
    assert sum(name.startswith('BB_receipt_') and not name.startswith('BB_receipt_amount_') for name in books['shared'].names) == 3


def test_changed_source_blocks_all_writes_before_financial_projection(store, monkeypatch):
    books, http, values = prepare(store, monkeypatch, 3)
    store.command('brian', bulk_payment(store))
    books['shared'].worksheet('January').write(4, 31, [999])
    assert not sync_received(store, {value['id'] for value in values})
    assert not [call for call in http.calls if call[0] in ('write', 'structure')]


def test_shared_refresh_recovers_bulk_receipts_through_the_same_batch_path(store, monkeypatch):
    from bookiebot.reimbursements import service
    books, http, values = prepare(store, monkeypatch, 3)
    body = bulk_payment(store)
    body['date'] = '2026-01-04'
    store.command('brian', body)
    monkeypatch.setattr(service, 'build_reimbursement_store', lambda: store)
    monkeypatch.setattr(projection, 'sync_pending', lambda *_a, **_kw: pytest.fail('Use durable bulk recovery, not a per-row replay'))
    result = service.snapshot('brian', retry_projection=True)
    assert result['projectionPending'] is False
    assert len([call for call in http.calls if call[0] == 'write']) == 2
    assert all(a['projectedVersion'] == a['version'] for a in result['allocations'])


@pytest.mark.parametrize('owner', ['brian', 'hannah'])
@pytest.mark.parametrize('count', [1, 5, 80])
def test_full_bulk_command_verifies_both_budget_links_with_bounded_calls(store, monkeypatch, owner, count):
    from collections import Counter
    from bookiebot.reimbursements import service

    books, http, _values = prepare(store, monkeypatch, count, verify_formulas=True, owner=owner)
    monkeypatch.setattr(service, 'build_reimbursement_store', lambda: store)
    body = bulk_payment(store, owner)
    body['date'] = '2026-01-04'
    result = service.command(owner, body)

    assert result['projectionPending'] is False
    assert all(a['outstandingCents'] == 0 and a['settledCents'] == 4000
               and a['version'] == a['projectedVersion'] for a in result['allocations'])
    assert len(result['events']) == count
    assert Counter(kind for kind, _key in http.calls) == {
        'formula': 3, 'metadata': 4, 'read': 4, 'structure': 1, 'write': 2,
    }, 'The full command uses 11 reads / 3 writes, including real cached budget-link verification'
    assert {key for kind, key in http.calls if kind == 'formula'} == {'brian', 'hannah', 'shared'}

    # Follow both verified IMPORTRANGE -> SUMIF chains over the resulting source
    # and repayment rows. The fake transport does not run Google's formula engine.
    partner = 'hannah' if owner == 'brian' else 'brian'
    rows = books['shared'].worksheet('January').get_all_values()
    totals = {person: sum(round(float(row[31]) * 100) for row in rows
                          if len(row) > 33 and row[33] == expense_person_for_owner(person))
              for person in (owner, partner)}
    assert totals == {owner: 6000 * count, partner: 4000 * count}
    mirror_rows = books[owner].worksheet('Shared Reimbursements').get_all_values()[1:]
    status = SHARED_REIMBURSEMENT_HEADERS.index('status')
    assert len(mirror_rows) == count and all(row[status] == 'reimbursed' for row in mirror_rows)

    before = list(http.calls)
    replay = service.command(owner, body)
    assert replay['projectionPending'] is False
    assert len(replay['events']) == count
    assert http.calls == before, 'A repeated receipt command performs no additional Sheets requests'


@pytest.mark.parametrize(('method', 'key', 'occurrence'), [
    ('values_get', 'brian', 1),
    ('fetch_sheet_metadata', 'shared', 1),
    ('batch_update', 'shared', 1),
    ('values_batch_update', 'shared', 1),
    ('values_batch_get', 'shared', 2),
    ('values_batch_update', 'brian', 1),
    ('values_batch_get', 'brian', 2),
])
def test_google_429_retains_receipts_and_refresh_recovers_without_duplicates(store, monkeypatch, method, key, occurrence):
    from bookiebot.reimbursements import service

    books, http, _values = prepare(store, monkeypatch, 5, verify_formulas=True)
    monkeypatch.setattr(service, 'build_reimbursement_store', lambda: store)
    original, attempts = getattr(http, method), 0

    def limited(book_key, *args, **kwargs):
        nonlocal attempts
        if book_key == key:
            attempts += 1
            if attempts == occurrence:
                response = Response()
                response.status_code = 429
                response._content = b'{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}'
                raise APIError(response)
        return original(book_key, *args, **kwargs)

    monkeypatch.setattr(http, method, limited)
    body = bulk_payment(store)
    body['date'] = '2026-01-04'
    result = service.command('brian', body)
    assert result['projectionPending'] is True
    assert attempts == occurrence, 'A quota error must stop this attempt rather than hammer Google'
    assert len(result['events']) == 5
    assert all(a['outstandingCents'] == 0 and a['settledCents'] == 4000 for a in result['allocations'])
    assert len(store.pending_bulk_projection_ids()) == 5

    recovered = service.snapshot('brian', retry_projection=True)
    assert recovered['projectionPending'] is False
    assert not store.pending_bulk_projection_ids()
    assert len(recovered['events']) == 5
    assert all(a['version'] == a['projectedVersion'] for a in recovered['allocations'])
    assert sum(name.startswith('BB_receipt_') and not name.startswith('BB_receipt_amount_')
               for name in books['shared'].names) == 5
    for person, expected in [('brian', 30000), ('hannah', 20000)]:
        assert sum(round(float(row[31]) * 100) for row in books['shared'].worksheet('January').get_all_values()
                   if len(row) > 33 and row[33] == expense_person_for_owner(person)) == expected
