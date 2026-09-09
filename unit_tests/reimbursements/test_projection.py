from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

from gspread import WorksheetNotFound
import pytest

from bookiebot.reimbursements import projection
from bookiebot.reimbursements.projection import ProjectionConflictError, SheetsProjection, sync_pending


class Sheet:
    def __init__(self, book, title, sheet_id, rows=None):
        self.book, self.title, self.id = book, title, sheet_id
        self.rows = deepcopy(rows or [])
        self.row_count = max(12, len(self.rows))
        self.col_count = max(40, max((len(row) for row in self.rows), default=0))

    def get_all_values(self):
        result = deepcopy(self.rows)
        if self.book.after_scan:
            hook, self.book.after_scan = self.book.after_scan, None
            hook(self)
        return result

    def write(self, row, first, values):
        while len(self.rows) <= row:
            self.rows.append([])
        target = self.rows[row]
        target.extend([""] * max(0, first + len(values) - len(target)))
        target[first:first + len(values)] = values

    def read(self, row, first, last):
        values = self.rows[row] if row < len(self.rows) else []
        return (values + [""] * max(0, last - len(values)))[first:last]

    def insert(self, row, first=0, last=40):
        # Google grid insertion moves the cells and their named ranges together.
        for index in range(len(self.rows), row, -1):
            self.write(index, first, self.read(index - 1, first, last))
        self.write(row, first, [""] * (last - first))
        for named in self.book.names.values():
            region = named["range"]
            if (region["sheetId"] == self.id and region["startColumnIndex"] >= first
                    and region["endColumnIndex"] <= last and region["startRowIndex"] >= row):
                region["startRowIndex"] += 1
                region["endRowIndex"] += 1


class Book:
    def __init__(self):
        self.sheets, self.names = {}, {}
        self.batch_calls, self.value_calls = [], []
        self.after_scan = self.after_read = self.before_batch = None
        self.timeout_after_batch = self.timeout_after_values = False

    def add_sheet(self, title, rows=None):
        sheet = Sheet(self, title, len(self.sheets) + 1, rows)
        self.sheets[title] = sheet
        return sheet

    def worksheet(self, title):
        if title not in self.sheets:
            raise WorksheetNotFound(title)
        return self.sheets[title]

    def add_worksheet(self, title, rows, cols):
        sheet = self.add_sheet(title)
        sheet.row_count, sheet.col_count = rows, cols
        return sheet

    def by_id(self, sheet_id):
        return next(sheet for sheet in self.sheets.values() if sheet.id == sheet_id)

    def fetch_sheet_metadata(self, params):
        assert params == {"fields": "namedRanges"}
        return {"namedRanges": deepcopy(list(self.names.values()))}

    def values_get(self, name):
        region = self.names[name]["range"]
        sheet = self.by_id(region["sheetId"])
        rows = [sheet.read(index, region["startColumnIndex"], region["endColumnIndex"])
                for index in range(region["startRowIndex"], region["endRowIndex"])]
        if self.after_read:
            hook, self.after_read = self.after_read, None
            hook(sheet, name)
        return {"values": rows}

    def batch_update(self, body):
        if self.before_batch:
            hook, self.before_batch = self.before_batch, None
            hook(self)
        self.batch_calls.append(deepcopy(body))
        # Validate name reservations before applying any insert/write, as the API
        # atomically validates a spreadsheets.batchUpdate request list.
        additions = [entry["addNamedRange"]["namedRange"]["name"] for entry in body["requests"] if "addNamedRange" in entry]
        if len(set(additions)) != len(additions) or set(additions) & set(self.names):
            raise RuntimeError("Duplicate named range; transaction rejected")
        for entry in body["requests"]:
            if "appendDimension" in entry:
                request = entry["appendDimension"]
                sheet = self.by_id(request["sheetId"])
                if request["dimension"] == "ROWS":
                    sheet.row_count += request["length"]
                else:
                    assert request["dimension"] == "COLUMNS"
                    sheet.col_count += request["length"]
            elif "insertRange" in entry:
                request = entry["insertRange"]
                assert request["shiftDimension"] == "ROWS"
                region = request["range"]
                assert region["endRowIndex"] == region["startRowIndex"] + 1
                self.by_id(region["sheetId"]).insert(region["startRowIndex"], region["startColumnIndex"], region["endColumnIndex"])
            elif "addNamedRange" in entry:
                named = deepcopy(entry["addNamedRange"]["namedRange"])
                self.names[named["name"]] = named
            elif "updateCells" in entry:
                request = entry["updateCells"]
                assert request["fields"] in {"userEnteredValue,note", "userEnteredValue"}
                start = request["start"]
                values = [next(iter(cell["userEnteredValue"].values())) for cell in request["rows"][0]["values"]]
                self.by_id(start["sheetId"]).write(start["rowIndex"], start["columnIndex"], values)
            else:
                raise AssertionError(entry)
        if self.timeout_after_batch:
            self.timeout_after_batch = False
            raise TimeoutError("Lost response after committed batch")

    def values_batch_update(self, body):
        assert body["valueInputOption"] == "RAW"
        self.value_calls.append(deepcopy(body))
        for entry in body["data"]:
            region = self.names[entry["range"]]["range"]
            assert region["endRowIndex"] == region["startRowIndex"] + 1
            self.by_id(region["sheetId"]).write(region["startRowIndex"], region["startColumnIndex"], entry["values"][0])
        if self.timeout_after_values:
            self.timeout_after_values = False
            raise TimeoutError("Lost response after committed values")


def allocation(**updates):
    return {
        "id": "allocation-1", "version": 1, "payerOwner": "brian", "partnerOwner": "hannah",
        "payerPerson": "Brian (BofA)", "item": "Hannah's T", "location": "Gameday", "expenseDate": "2026-09-08",
        "category": "need_expenses", "accounting": "cash_v1", "grossCents": 46472, "payerShareCents": 30081,
        "partnerShareCents": 16391, "settledCents": 0, "sourceSpreadsheetId": "shared-2026",
        "sourceSheetTitle": "September", "sourceWorksheet": "expense", "sourceRow": 3,
        "sourceValues": {"date": "9/8/2026", "item": "T", "amount": "163.91", "location": "Gameday", "person": "Hannah"},
        "sourceColumnMap": {"date": 30, "item": 31, "amount": 32, "location": 33, "person": 34}, "events": [], **updates,
    }


def event(identity="receipt-1", amount=5000, **updates):
    return {"id": identity, "allocationId": "allocation-1", "amountCents": amount, "date": "2026-09-08",
            "kind": "receive", "status": "confirmed", "createdAt": "2026-09-08T10:00:00Z",
            "confirmedAt": "2026-09-08T10:00:00Z", "reversedAt": "", **updates}


@pytest.fixture
def setup(monkeypatch):
    from bookiebot.reimbursements import migration
    monkeypatch.setattr(migration, "verify_budget_links", lambda *args, **kwargs: None)
    books = {"shared-2026": Book(), "shared-2027": Book()}
    source = books["shared-2026"].add_sheet("September")
    source.write(2, 29, ["9/8/2026", "T", 163.91, "Gameday", "Hannah"])
    books["shared-2027"].add_sheet("January")
    monkeypatch.setattr(projection, "get_shared_expenses_spreadsheet_id", lambda year: f"shared-{year}")
    projector = SheetsProjection(SimpleNamespace(open_by_key=lambda key: books[key]))
    return projector, books, source


def receipt_row(book, identity="receipt-1"):
    return book.values_get(projection._name("receipt", identity))["values"][0]


def test_migration_repairs_approved_payer_gross_and_item_without_new_receipts(setup):
    projector, books, source = setup
    projector.project(allocation())
    assert source.read(2, 29, 34) == ["9/8/2026", "Hannah's T", 464.72, "Gameday", "Brian (BofA)"]
    assert len(books["shared-2026"].names) == 4
    projector.project(allocation())
    assert len(books["shared-2026"].batch_calls) == 1


def test_source_and_receipt_reuse_full_row_amounts_with_two_value_reads_each(setup, monkeypatch):
    projector, books, source = setup
    book = books["shared-2026"]
    reads = []
    original = book.values_get
    def read(name):
        reads.append(name)
        return original(name)
    monkeypatch.setattr(book, "values_get", read)
    projector.source(allocation())
    assert reads == [projection._name("source", "allocation-1")] * 2
    assert source.read(2, 31, 32) == [464.72]
    reads.clear()
    projector.receipt(allocation(), event())
    assert reads == [projection._name("receipt", "receipt-1")] * 2


@pytest.mark.parametrize("field", ["amount", "person"])
def test_full_row_post_write_verification_detects_receipt_tampering(setup, monkeypatch, field):
    projector, books, _source = setup
    book = books["shared-2026"]
    write = book.values_batch_update
    def tamper(body):
        write(body)
        region = book.names[projection._name("receipt", "receipt-1")]["range"]
        first = region["startColumnIndex"]
        book.by_id(region["sheetId"]).write(region["startRowIndex"], first + (2 if field == "amount" else 4),
                                            [49 if field == "amount" else "Wrong person"])
    monkeypatch.setattr(book, "values_batch_update", tamper)
    with pytest.raises(ProjectionConflictError, match="could not be verified"):
        projector.receipt(allocation(), event())


def test_all_source_and_backdated_receipt_summary_links_are_checked_before_any_write(setup, monkeypatch):
    from bookiebot.reimbursements import migration
    projector, books, source = setup
    calls = []
    def guard(client, owner, when, category, **kwargs):
        calls.append((owner, when.isoformat(), category))
        if when.year == 2027:
            raise ValueError("Frozen repayment month")
    monkeypatch.setattr(migration, "verify_budget_links", guard)
    with pytest.raises(ValueError, match="Frozen"):
        projector.project(allocation(events=[event(date="2027-01-03")], settledCents=5000))
    assert calls == [("brian", "2026-09-01", "need_expenses"), ("hannah", "2026-09-01", "need_expenses"),
                     ("hannah", "2027-01-03", "need_expenses")]
    assert all(not book.batch_calls and not book.value_calls for book in books.values())
    assert source.read(2, 31, 32) == [163.91]


def test_readonly_history_and_unconfirmed_reports_do_not_require_receipt_budget_links(setup, monkeypatch):
    from bookiebot.reimbursements import migration
    projector, books, _source = setup
    calls = []
    monkeypatch.setattr(migration, "verify_budget_links", lambda *args, **kwargs: calls.append(args[1]))
    projector.project(allocation(accounting="legacy_net", events=[event()]))
    assert calls == [] and all(not book.batch_calls for book in books.values())
    projector.project(allocation(events=[event(status="pending", confirmedAt="")]))
    assert calls == ["brian", "hannah"]


@pytest.mark.parametrize("lost_phase", ["anchors", "source_write", "receipt_create", "receipt_write"])
def test_lost_responses_replay_absolute_targets_without_duplicate_receipts(setup, lost_phase):
    projector, books, source = setup
    book = books["shared-2026"]
    value = allocation(events=[event()], settledCents=5000)
    if lost_phase in {"anchors", "source_write"}:
        target = allocation()
        setattr(book, "timeout_after_batch" if lost_phase == "anchors" else "timeout_after_values", True)
        with pytest.raises(TimeoutError):
            projector.source(target)
        projector.source(target)
    else:
        setattr(book, "timeout_after_batch" if lost_phase == "receipt_create" else "timeout_after_values", True)
        with pytest.raises(TimeoutError):
            projector.receipt(value, value["events"][0])
    projector.project(value)
    projector.project(value)
    assert source.read(2, 31, 32) == [414.72]
    assert receipt_row(book) == ["2026-09-08", "Reimbursement · Hannah's T", 50.0, "Reimbursement to Brian · Gameday", "Hannah"]
    assert sum("insertRange" in request for body in book.batch_calls for request in body["requests"]) == 1


def test_receipt_reservation_preserves_a_concurrent_category_append_and_other_columns(setup):
    projector, books, source = setup
    book = books["shared-2026"]
    source.write(3, 13, ["9/8/2026", "Lunch", 15, "Cafe", "Brian (BofA)"])
    external = ["9/8/2026", "Doctor", 40, "Clinic", "Hannah"]
    book.after_scan = lambda sheet: sheet.write(3, 29, external)
    projector.receipt(allocation(), event())
    assert source.read(3, 29, 34) == receipt_row(book)
    assert source.read(4, 29, 34) == external
    assert source.read(3, 13, 18) == ["9/8/2026", "Lunch", 15, "Cafe", "Brian (BofA)"]


def test_named_source_and_receipt_ranges_follow_row_insertion_between_reads_and_writes(setup):
    projector, books, source = setup
    value = allocation(events=[event()], settledCents=5000)
    projector.project(value)
    book = books["shared-2026"]
    book.after_read = lambda sheet, _name: sheet.insert(2)
    projector.source(value)
    assert source.read(2, 29, 34) == [""] * 5
    assert source.read(3, 31, 32) == [414.72]
    assert receipt_row(book)[2] == 50
    book.after_read = lambda sheet, _name: sheet.insert(2)
    projector.receipt(value, value["events"][0])
    assert source.read(4, 31, 32) == [414.72]
    assert receipt_row(book)[2] == 50


def test_source_insertion_after_unanchored_scan_fails_closed(setup):
    projector, books, source = setup
    book = books["shared-2026"]
    book.after_scan = lambda sheet: sheet.insert(2)
    with pytest.raises(ProjectionConflictError, match="description or owner changed"):
        projector.source(allocation())
    assert source.read(3, 29, 34) == ["9/8/2026", "T", 163.91, "Gameday", "Hannah"]
    assert not book.value_calls


@pytest.mark.parametrize("changed", ["duplicate", "item", "person", "amount"])
def test_unanchored_edited_or_ambiguous_source_never_changes_money(setup, changed):
    projector, books, source = setup
    if changed == "duplicate":
        source.write(3, 29, source.read(2, 29, 34))
    else:
        column = {"item": 30, "person": 33, "amount": 31}[changed]
        source.write(2, column, [999 if changed == "amount" else "Changed"])
    with pytest.raises(ProjectionConflictError, match="no longer matches uniquely"):
        projector.source(allocation())
    assert not books["shared-2026"].batch_calls
    assert not books["shared-2026"].value_calls


@pytest.mark.parametrize("change", ["person", "item", "amount", "amount_anchor", "delete_item_anchor", "wide_anchor"])
def test_anchored_source_edits_or_detached_names_fail_closed(setup, change):
    projector, books, source = setup
    projector.source(allocation())
    book = books["shared-2026"]
    if change in {"person", "item", "amount"}:
        source.write(2, {"person": 33, "item": 30, "amount": 31}[change], [123 if change == "amount" else "Edited"])
    elif change == "amount_anchor":
        target = book.names[projection._name("amount", "allocation-1")]["range"]
        target["startRowIndex"], target["endRowIndex"] = 3, 4
        source.write(3, 31, [464.72])
    elif change == "delete_item_anchor":
        del book.names[projection._name("item", "allocation-1")]
    else:
        book.names[projection._name("source", "allocation-1")]["range"]["endRowIndex"] += 1
    previous_writes = len(book.value_calls)
    with pytest.raises(ProjectionConflictError):
        projector.source(allocation())
    assert len(book.value_calls) == previous_writes


def test_confirmation_order_and_confirmed_reversal_replay_previous_source_targets(setup):
    projector, books, source = setup
    first = event("first", 3000, kind="report_payment", status="pending", confirmedAt="")
    second = event("second", 2000, createdAt="2026-09-08T11:00:00Z", confirmedAt="2026-09-08T11:00:00Z")
    value = allocation(events=[first, second], settledCents=2000)
    projector.project(value)
    assert source.read(2, 31, 32) == [444.72]
    first.update(status="confirmed", confirmedAt="2026-09-08T12:00:00Z")
    value["settledCents"] = 5000
    projector.project(value)
    assert source.read(2, 31, 32) == [414.72]
    second.update(status="reversed", reversedAt="2026-09-08T13:00:00Z")
    value["settledCents"] = 3000
    projector.project(value)
    assert source.read(2, 31, 32) == [434.72]
    assert receipt_row(books["shared-2026"], "second")[2] == 0
    assert receipt_row(books["shared-2026"], "first")[2] == 30


def test_pending_and_reversed_unconfirmed_payments_do_not_create_cash_entries(setup):
    projector, books, source = setup
    value = allocation(events=[event(status="pending", confirmedAt="")])
    projector.project(value)
    value["events"][0].update(status="reversed", reversedAt="2026-09-08T11:00:00Z")
    projector.project(value)
    assert source.read(2, 31, 32) == [464.72]
    assert not any(name.startswith("BB_receipt_") for name in books["shared-2026"].names)


def test_unconfirmed_reversal_is_not_accepted_as_a_historical_source_amount(setup):
    projector, books, source = setup
    projector.source(allocation())
    source.write(2, 31, [414.72])
    value = allocation(events=[event(status="reversed", confirmedAt="", reversedAt="2026-09-08T11:00:00Z")])
    previous = len(books["shared-2026"].value_calls)
    with pytest.raises(ProjectionConflictError, match="edited outside"):
        projector.source(value)
    assert len(books["shared-2026"].value_calls) == previous


@pytest.mark.parametrize("change", ["item", "person", "amount", "amount_anchor", "missing_anchor"])
def test_edited_receipt_identity_amount_or_anchor_is_not_overwritten(setup, change):
    projector, books, source = setup
    value, payment = allocation(), event()
    projector.receipt(value, payment)
    book = books["shared-2026"]
    region = book.names[projection._name("receipt", payment["id"])]["range"]
    if change in {"item", "person", "amount"}:
        source.write(region["startRowIndex"], {"item": 30, "person": 33, "amount": 31}[change],
                     [999 if change == "amount" else "Edited"])
    elif change == "missing_anchor":
        del book.names[projection._name("receipt_amount", payment["id"])]
    else:
        amount_region = book.names[projection._name("receipt_amount", payment["id"])]["range"]
        amount_region["startRowIndex"], amount_region["endRowIndex"] = 8, 9
        source.write(8, 31, [50])
    previous = len(book.value_calls)
    with pytest.raises(ProjectionConflictError):
        projector.receipt(value, payment)
    assert len(book.value_calls) == previous


def test_personal_bill_source_keeps_original_label_and_explicit_sheet_title(setup):
    projector, books, _source = setup
    book = books["shared-2026"]
    sheet = book.add_sheet("Historical Budget")
    sheet.write(7, 1, ["Rent payment (due 1st)", 120])
    value = allocation(sourceWorksheet="income", sourceSheetTitle="Historical Budget", sourceRow=8,
                       category="rent", item="rent", grossCents=20000, payerShareCents=12000,
                       partnerShareCents=8000, sourceColumnMap={"item": 2, "amount": 3},
                       sourceValues={"item": "Rent payment (due 1st)", "amount": "120"})
    projector.source(value)
    assert sheet.read(7, 1, 3) == ["Rent payment (due 1st)", 200]
    assert projection._name("item", value["id"]) not in book.names
    projector.source(value)
    assert sheet.read(7, 1, 3) == ["Rent payment (due 1st)", 200]


def test_amount_only_source_cannot_choose_an_unrelated_matching_cell(setup):
    projector, books, _source = setup
    with pytest.raises(ProjectionConflictError, match="verified source row"):
        projector.source(allocation(sourceColumnMap={"amount": 32}, sourceValues={"amount": "163.91"}))
    assert not books["shared-2026"].batch_calls


def test_reversal_before_first_projection_creates_no_receipt_row(setup):
    projector, books, source = setup
    value = allocation(events=[event(status="reversed", reversedAt="2026-09-08T11:00:00Z")])
    projector.project(value)
    assert source.read(2, 31, 32) == [464.72]
    assert not any(name.startswith("BB_receipt_") for name in books["shared-2026"].names)


def test_cross_year_receipt_uses_payment_month_and_partner_expense_not_income(setup):
    projector, books, source = setup
    value = allocation(events=[event(date="2027-01-04")], settledCents=5000)
    projector.project(value)
    assert source.read(2, 31, 32) == [414.72]
    assert receipt_row(books["shared-2027"])[0] == "2027-01-04"
    assert receipt_row(books["shared-2027"])[4] == "Hannah"


def test_equal_opposite_offsets_project_each_debt_once_and_reverse_together(setup):
    projector, books, source = setup
    source.write(4, 29, ["9/8/2026", "Parking", 100, "Garage", "Hannah"])
    first = allocation(events=[event("offset-brian", 5000, kind="offset")], settledCents=5000)
    second = allocation(id="allocation-2", payerOwner="hannah", partnerOwner="brian", payerPerson="Hannah",
                        item="Parking", location="Garage", grossCents=10000, payerShareCents=5000, partnerShareCents=5000,
                        sourceRow=5, sourceValues={"date": "9/8/2026", "item": "Parking", "amount": "100", "location": "Garage", "person": "Hannah"},
                        events=[event("offset-hannah", 5000, kind="offset", allocationId="allocation-2")], settledCents=5000)
    for value in (first, second):
        projector.project(value)
    book = books["shared-2026"]
    assert receipt_row(book, "offset-brian")[1:5] == ["Offset · Hannah's T", 50, "Offset to Brian · Gameday", "Hannah"]
    assert receipt_row(book, "offset-hannah")[1:5] == ["Offset · Parking", 50, "Offset to Hannah · Garage", "Brian (BofA)"]
    assert source.read(2, 31, 32) == [414.72]
    assert source.read(4, 31, 32) == [50]
    for value in (first, second):
        value["events"][0].update(status="reversed", reversedAt="2026-09-08T11:00:00Z")
        value["settledCents"] = 0
        projector.project(value)
    assert source.read(2, 31, 32) == [464.72]
    assert source.read(4, 31, 32) == [100]
    assert receipt_row(book, "offset-brian")[2] == receipt_row(book, "offset-hannah")[2] == 0


def test_legacy_net_remains_read_only_even_with_settlement_events(setup):
    projector, books, source = setup
    projector.project(allocation(accounting="legacy_net", events=[event()], settledCents=5000))
    assert source.read(2, 31, 32) == [163.91]
    assert not books["shared-2026"].batch_calls
    assert not books["shared-2026"].value_calls


def test_sync_pending_does_not_mark_stale_or_failed_projection_complete():
    values = [allocation(id="stale"), allocation(id="failed"), allocation(id="complete")]
    marked = []
    store = SimpleNamespace(access=object(), pending_projections=lambda: values,
                            mark_projected=lambda identity, version: marked.append((identity, version)) or identity != "stale")
    def project(value):
        if value["id"] == "failed":
            raise TimeoutError("Still pending")
    assert sync_pending(store, SimpleNamespace(project=project)) is False
    assert marked == [("stale", 1), ("complete", 1)]
