from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

from gspread import WorksheetNotFound
import pytest

from bookiebot.reimbursements import mirror
from bookiebot.reimbursements.projection import ProjectionConflictError, _name
from bookiebot.sheets.collaboration import SHARED_REIMBURSEMENT_HEADERS as HEADERS
from unit_tests.reimbursements.test_projection import Book, allocation, event


class MirrorBook(Book):
    def __init__(self):
        super().__init__()
        self.created = 0
        self.creation_timeout = False

    def add_sheet(self, title, rows=None):
        sheet = super().add_sheet(title, rows)
        sheet.col_count = max(25, max((len(row) for row in sheet.rows), default=0))
        return sheet

    def worksheet(self, title):
        if title not in self.sheets:
            raise WorksheetNotFound(title)
        return self.sheets[title]

    def add_worksheet(self, title, rows, cols):
        self.created += 1
        sheet = self.add_sheet(title)
        sheet.row_count, sheet.col_count = rows, cols
        if self.creation_timeout:
            self.creation_timeout = False
            raise TimeoutError("Lost worksheet creation response")
        return sheet

    def batch_update(self, body):
        adapted = deepcopy(body)
        columns = []
        for request in adapted["requests"]:
            if "updateCells" in request:
                assert request["updateCells"]["fields"] in {"userEnteredValue", "userEnteredValue,note"}
                request["updateCells"]["fields"] = "userEnteredValue,note"
            if request.get("appendDimension", {}).get("dimension") == "COLUMNS":
                columns.append(request["appendDimension"])
        adapted["requests"] = [request for request in adapted["requests"] if request.get("appendDimension", {}).get("dimension") != "COLUMNS"]
        try:
            super().batch_update(adapted)
        finally:
            # This fake simulates the supported column extension in addition to
            # the projection fixture's atomic row/name/value operations.
            for request in columns:
                self.by_id(request["sheetId"]).col_count += request["length"]


def value(**updates):
    return allocation(sourceYear=2026, sourceActionId="source-1", splitActionId="split-1", method="income",
                      outstandingCents=16391, createdAt="2026-09-08T10:00:00Z", updatedAt="2026-09-08T11:00:00Z",
                      actorKey="shortcut:brian", **updates)


def old_row(identity="allocation-1", **fields):
    values = {"allocation_id": identity, "owner_key": "hannah", "payer": "Hannah", "partner": "Brian",
              "item": "T", "gross_amount": "464.72", "payer_share": "163.91", "partner_share": "300.81",
              "received_amount": "0.00", "status": "outstanding", **fields}
    return [values.get(name, "") for name in HEADERS]


@pytest.fixture
def setup(monkeypatch):
    books = {key: MirrorBook() for key in ["brian-2026", "hannah-2026", "shared-2026", "original-ledger"]}
    books["shared-2026"].add_sheet("September")
    monkeypatch.setattr(mirror, "get_budget_spreadsheet_id_for_user", lambda actor, year: f"{'hannah' if 'hannah' in str(actor) else 'brian'}-{year}")
    monkeypatch.setattr(mirror, "actor_key_for_owner", lambda owner: "shortcut:" + owner)
    client = SimpleNamespace(open_by_key=lambda key: books[key])
    return client, books


def mirrored(book, identity="allocation-1"):
    return book.values_get(_name("ledger", identity))["values"][0]


def test_creates_missing_sheet_once_and_retries_lost_creation(setup):
    client, books = setup
    book = books["brian-2026"]
    book.creation_timeout = True
    with pytest.raises(TimeoutError):
        mirror.mirror_allocation(client, value())
    mirror.mirror_allocation(client, value())
    mirror.mirror_allocation(client, value())
    assert book.created == 1
    assert book.worksheet("Shared Reimbursements").rows[0] == HEADERS
    assert mirrored(book)[0] == "allocation-1"
    assert len(book.worksheet("Shared Reimbursements").rows) == 2


def test_corrects_payer_and_all_generated_fields_preserving_custom_history(setup):
    client, books = setup
    book = books["original-ledger"]
    rows = [HEADERS + ["Private note"], old_row() + ["Keep this note"], old_row("void-old", status="void") + ["Keep void"], old_row("unrelated")]
    sheet = book.add_sheet("Shared Reimbursements", rows)
    mirror.mirror_allocation(client, value(ledgerSpreadsheetId="original-ledger", ledgerYear=2026))
    result = dict(zip(HEADERS, mirrored(book)))
    assert result["owner_key"] == "brian" and result["payer"] == "Brian (BofA)" and result["partner"] == "Hannah"
    assert result["payer_share"] == "300.81" and result["partner_share"] == "163.91"
    assert result["original_person"] == result["responsible_person"] == "Brian (BofA)"
    assert result["item"] == "Hannah's T" and result["gross_amount"] == "464.72"
    assert sheet.rows[0] == rows[0] and sheet.rows[1][25] == "Keep this note"
    assert sheet.rows[2:] == rows[2:]
    assert not books["hannah-2026"].sheets and not books["brian-2026"].sheets


@pytest.mark.parametrize("settled,status", [(5000, "outstanding"), (16391, "reimbursed"), (0, "outstanding")])
def test_partial_full_and_reversed_states_and_latest_confirmed_date(setup, settled, status):
    client, books = setup
    events = [event(amount=5000, date="2026-09-06"), event("later", date="2026-09-07"),
              event("pending", status="pending", date="2026-09-09"), event("reversed", status="reversed", date="2026-09-08")]
    mirror.mirror_allocation(client, value(settledCents=settled, events=events))
    result = dict(zip(HEADERS, mirrored(books["brian-2026"])))
    assert result["status"] == status and result["received_amount"] == f"{settled / 100:.2f}"
    assert result["received_at"] == ("2026-09-07" if settled else "")


def test_preserves_historical_received_date_without_invented_events(setup):
    client, books = setup
    mirror.mirror_allocation(client, value(accounting="legacy_net", settledCents=16391, legacyReceivedAt="2026-09-01T08:00:00-07:00"))
    assert mirrored(books["brian-2026"])[21] == "2026-09-01T08:00:00-07:00"


@pytest.mark.parametrize("phase", ["insert", "anchor", "values"])
def test_lost_response_retries_do_not_duplicate_or_add_received_money(setup, phase):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS] + ([] if phase == "insert" else [old_row()]))
    setattr(book, "timeout_after_values" if phase == "values" else "timeout_after_batch", True)
    with pytest.raises(TimeoutError):
        mirror.mirror_allocation(client, value(settledCents=5000, events=[event()]))
    mirror.mirror_allocation(client, value(settledCents=5000, events=[event()]))
    assert [row[0] for row in sheet.rows if row].count("allocation-1") == 1
    assert mirrored(book)[20] == "50.00"


def test_concurrent_append_is_shifted_with_its_custom_columns(setup):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS + ["Note"]])
    external = old_row("external") + ["Attached note"]
    book.after_scan = lambda target: target.write(1, 0, external)
    mirror.mirror_allocation(client, value())
    assert sheet.rows[1][0] == "allocation-1" and sheet.rows[2] == external
    assert sheet.rows[0][25] == "Note"


def test_competing_same_id_creation_is_atomically_rejected_and_retry_finds_winner(setup):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS])
    book.before_batch = lambda _book: mirror.mirror_allocation(client, value())
    with pytest.raises(RuntimeError, match="Duplicate named range"):
        mirror.mirror_allocation(client, value())
    mirror.mirror_allocation(client, value())
    assert len(sheet.rows) == 2 and sheet.rows[1][0] == "allocation-1"


def test_existing_anchor_tracks_row_insertion_before_update(setup):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS, old_row()])
    mirror.mirror_allocation(client, value())
    book.after_read = lambda target, _name: target.insert(1)
    mirror.mirror_allocation(client, value(settledCents=5000, events=[event()]))
    assert sheet.rows[1] == [""] * 40
    assert mirrored(book)[20] == "50.00" and sheet.rows[2][0] == "allocation-1"


def test_source_hint_uses_current_named_source_row(setup):
    client, books = setup
    source = books["shared-2026"]
    source.names[_name("source", "allocation-1")] = {"name": _name("source", "allocation-1"), "range": {
        "sheetId": 1, "startRowIndex": 8, "endRowIndex": 9, "startColumnIndex": 29, "endColumnIndex": 34}}
    mirror.mirror_allocation(client, value())
    assert mirrored(books["brian-2026"])[11] == "9"


@pytest.mark.parametrize("drift", ["duplicate", "scan_insertion", "anchor_identity", "anchor_width", "header"])
def test_ambiguous_identity_or_schema_fails_closed_before_row_write(setup, drift):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS, old_row()])
    if drift.startswith("anchor"):
        mirror.mirror_allocation(client, value())
        book.value_calls.clear()
        if drift == "anchor_identity": sheet.rows[1][0] = "unrelated"
        else: book.names[_name("ledger", "allocation-1")]["range"]["endColumnIndex"] = 24
    elif drift == "duplicate": sheet.rows.append(old_row())
    elif drift == "scan_insertion": book.after_scan = lambda target: target.insert(1)
    else: sheet.rows[0][0] = "Unknown ID"
    with pytest.raises(ProjectionConflictError):
        mirror.mirror_allocation(client, value(settledCents=5000, events=[event()]))
    assert not book.value_calls
    assert all(row[20] != "50.00" for row in sheet.rows if len(row) > 20)


def test_compatible_legacy_headers_expand_and_custom_columns_survive(setup):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS[:22], old_row()[:22]])
    sheet.col_count = 22
    mirror.mirror_allocation(client, value())
    assert sheet.col_count == 25 and sheet.rows[0] == HEADERS
    assert mirrored(book)[22:] == ["brian", "Brian (BofA)", "Brian (BofA)"]


def test_conflicting_legacy_extra_headers_are_not_overwritten(setup):
    client, books = setup
    book = books["brian-2026"]
    sheet = book.add_sheet("Shared Reimbursements", [HEADERS[:22] + ["Do not overwrite"]])
    before = deepcopy(sheet.rows)
    with pytest.raises(ProjectionConflictError, match="custom headers"):
        mirror.mirror_allocation(client, value())
    assert sheet.rows == before and not book.value_calls and not book.batch_calls


def test_sync_pending_waits_for_mirror_then_retries_without_duplicate_expenses(setup, monkeypatch):
    from bookiebot.reimbursements import migration, projection

    client, books = setup
    monkeypatch.setattr(migration, "verify_budget_links", lambda *args, **kwargs: None)
    monkeypatch.setattr(projection, "get_shared_expenses_spreadsheet_id", lambda year: f"shared-{year}")
    shared = books["shared-2026"]
    source = shared.worksheet("September")
    source.write(2, 29, ["9/8/2026", "T", 163.91, "Gameday", "Hannah"])
    ledger = books["brian-2026"]
    ledger.add_sheet("Shared Reimbursements", [HEADERS])
    ledger.timeout_after_batch = True
    pending = [value(settledCents=5000, events=[event()])]
    marked = []

    def mark(identity, version):
        # Completion must follow both financial projection and generated view.
        assert source.read(2, 31, 32) == [414.72]
        assert mirrored(ledger)[20] == "50.00"
        assert shared.values_get(_name("receipt", "receipt-1"))["values"][0][2] == 50
        marked.append((identity, version))
        pending.clear()
        return True

    store = SimpleNamespace(access=object(), pending_projections=lambda: list(pending), mark_projected=mark)
    projector = projection.SheetsProjection(client)
    assert projection.sync_pending(store, projector) is False
    assert not marked and len(pending) == 1
    assert projection.sync_pending(store, projector) is True
    assert marked == [("allocation-1", 1)] and not pending
    assert sum("insertRange" in request for body in shared.batch_calls for request in body["requests"]) == 1
    assert sum("insertRange" in request for body in ledger.batch_calls for request in body["requests"]) == 1


def test_sync_pending_mirrors_legacy_without_rewriting_historical_expenses(setup):
    from bookiebot.reimbursements.projection import SheetsProjection, sync_pending

    client, books = setup
    shared = books["shared-2026"]
    source = shared.worksheet("September")
    source.write(2, 29, ["9/8/2026", "T", 300.81, "Gameday", "Brian (BofA)"])
    before = deepcopy(source.rows)
    record = value(accounting="legacy_net", settledCents=16391, legacyReceivedAt="2026-09-08")
    marked = []
    store = SimpleNamespace(access=object(), pending_projections=lambda: [record],
                            mark_projected=lambda identity, version: marked.append((identity, version)) or True)
    assert sync_pending(store, SheetsProjection(client)) is True
    assert source.rows == before and not shared.batch_calls and not shared.value_calls
    assert mirrored(books["brian-2026"])[19:22] == ["reimbursed", "163.91", "2026-09-08"]
    assert marked == [("allocation-1", 1)]
