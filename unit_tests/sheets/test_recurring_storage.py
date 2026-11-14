from dataclasses import replace
from datetime import date
from types import SimpleNamespace
from copy import deepcopy
import calendar
import pytest

from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB, SETTINGS_LOG_TAB, fingerprint
from bookiebot.sheets.recurring_rows import encode, decode
from bookiebot.sheets.recurring_changes import prepare_change, BillSnapshot
from unit_tests.sheets.test_recurring import plan, form

B = "676638528590970917"
TODAY = date(2026, 11, 13)


class Transport:
    def __init__(self, rows, formulas=None):
        self.rows = deepcopy(rows)
        self.formulas = deepcopy(formulas or rows)
        self.names = []
        self.properties = {t: {"title": t, "sheetId": i + 1, "gridProperties": {"rowCount": 1000, "columnCount": 32}} for i, t in enumerate(rows)}
        self.sent = []

    def fetch_sheet_metadata(self, identity):
        return {"sheets": [{"properties": p} for p in self.properties.values()], "namedRanges": deepcopy(self.names)}

    def values_batch_get(self, identity, ranges, params):
        source = self.formulas if params["valueRenderOption"] == "FORMULA" else self.rows
        return {"valueRanges": [{"range": r + "!A1:AZ1000", "values": deepcopy(source[r.strip("'").replace("''", "'")])} for r in ranges]}

    def batch_update(self, identity, body):
        self.sent.append(deepcopy(body))
        for request in body["requests"]:
            if "addSheet" in request:
                p = request["addSheet"]["properties"]
                self.properties[p["title"]] = deepcopy(p)
                self.rows[p["title"]] = []
                self.formulas[p["title"]] = []
            if "addNamedRange" in request:
                item = deepcopy(request["addNamedRange"]["namedRange"])
                item.setdefault("namedRangeId", item["name"])
                self.names.append(item)
            if "updateNamedRange" in request:
                item = request["updateNamedRange"]["namedRange"]
                existing = next(n for n in self.names if n["namedRangeId"] == item["namedRangeId"])
                existing["range"] = deepcopy(item["range"])
            if "updateCells" in request:
                data = request["updateCells"]
                start = data["start"]
                title = next(t for t, p in self.properties.items() if p["sheetId"] == start["sheetId"])
                for i, row in enumerate(data["rows"], start["rowIndex"]):
                    for source in [self.rows, self.formulas]:
                        while len(source[title]) <= i:
                            source[title].append([])
                    for c, entry in enumerate(row["values"], start["columnIndex"]):
                        value = next(iter(entry["userEnteredValue"].values()))
                        for source in [self.rows, self.formulas]:
                            while len(source[title][i]) <= c:
                                source[title][i].append("")
                            source[title][i][c] = str(value)
                        if "formulaValue" in entry["userEnteredValue"]:
                            import re
                            from openpyxl.utils import column_index_from_string
                            match = re.fullmatch(r"='([^']+)'!([A-Z]+)(\d+)", str(value))
                            if match:
                                self.rows[title][i][c] = storage.cell(self.rows[match[1]], int(match[3]), column_index_from_string(match[2]))


def fixture(plans=None):
    plans = plans or [replace(plan(), id="loan_1234", pull_day=12, split_method="none", monthly_source=True, version="v1")]
    loan = plans[0]
    rows = {BILL_TAB: encode(plans, BILL_TAB, []), "Subscriptions": [],
        "October": [["", loan.source_label, "60.23"], ["", "(Needs) Subtotal:", "=SUM(C1:C1)"]],
        "November": [["", loan.source_label, "60.23"], ["", "(Needs) Subtotal:", '=TEXT(SUM(C1:C1),"$0.00")&SUM(C1:C1)']],
        "December": [["", loan.source_label, "60.23"], ["", "(Needs) Subtotal:", "=SUM(C1:C1)"]]}
    formulas = deepcopy(rows)
    for month in ["October", "November", "December"]:
        formulas[month][0][2] = "=SUMIF('_BookieBot Bill Schedule'!F:F,\"Student Loan\",'_BookieBot Bill Schedule'!J:J)"
    transport = Transport(rows, formulas)
    return SimpleNamespace(http_client=transport), loan


def update(source, loan, **changes):
    return {"operation": "update", "id": loan.id, "version": loan.version, "settingsVersion": source.settings.version,
            "bill": form(name=loan.name, splitMethod="none", amount="70.00", effectiveFrom="2026-12", **changes)}


def test_read_does_not_provision_and_reports_current_charge_minimum():
    client, loan = fixture()
    source = storage.read_workbook(B, TODAY, client=client)
    assert client.http_client.sent == []
    assert source.settings.earliest_months[loan.id] == "2026-12"
    assert source.charge(loan, "2026-11")["amountCents"] == 6023


def test_price_versions_and_historical_values_share_one_atomic_receipt_batch():
    client, loan = fixture()
    source = storage.read_workbook(B, TODAY, client=client)
    change = prepare_change(source.settings, update(source, loan), today=TODAY)
    batch = storage.configuration_batch(source, change, "request-1234567890", "fingerprint", '{"success":true}', today=TODAY)
    assert not client.http_client.sent
    batch.send()
    assert len(client.http_client.sent) == 1
    transport = client.http_client
    assert transport.rows["October"][0][2] == "60.23"
    assert transport.rows["November"][0][2] == "60.23"
    assert "SUMIF" not in transport.formulas["December"][0][2]
    assert transport.formulas["December"][0][2].startswith("='_BookieBot Bill Schedule'!")
    versions = decode(transport.rows[BILL_TAB], BILL_TAB)
    assert [(p.amount_cents, p.effective_until) for p in versions] == [(6023, "2026-12"), (7000, "9999-12")]
    assert transport.rows[SETTINGS_LOG_TAB][1][:2] == ["request-1234567890", "fingerprint"]
    bill_sheet = transport.properties[BILL_TAB]["sheetId"]
    pricecol = transport.rows[BILL_TAB][0].index("expected_amount")
    writes = [r["updateCells"] for r in transport.sent[0]["requests"] if "updateCells" in r and r["updateCells"]["start"]["sheetId"] == bill_sheet]
    assert writes[0]["rows"][-1]["values"][pricecol]["userEnteredValue"] == {"numberValue": 70.0}


def test_new_source_extends_every_percent_subtotal_sum_without_moving_old_rows():
    client, loan = fixture()
    source = storage.read_workbook(B, TODAY, client=client)
    body = {"operation": "create", "draftId": "new-bill-draft-1234", "settingsVersion": source.settings.version,
            "bill": form(name="Insurance", splitMethod="none", effectiveFrom="2026-11")}
    change = prepare_change(source.settings, body, today=TODAY)
    batch = storage.configuration_batch(source, change, "request-1234567890", "fingerprint", "{}", today=TODAY)
    batch.send()
    rows = client.http_client.rows["November"]
    assert rows[0][1] == loan.source_label
    assert rows[3][1] == "Insurance"
    assert rows[1][2].count("+SUM(C4)") == 2
    assert any(n["name"].endswith("_202611") for n in client.http_client.names)


def test_formula_like_bill_name_is_literal_never_executed():
    client, _ = fixture()
    source = storage.read_workbook(B, TODAY, client=client)
    body = {"operation": "create", "draftId": "new-bill-draft-1234", "settingsVersion": source.settings.version,
            "bill": form(name='=IMPORTDATA("https://example.invalid")', splitMethod="none", effectiveFrom="2026-12")}
    change = prepare_change(source.settings, body, today=TODAY)
    batch = storage.configuration_batch(source, change, "request-1234567890", "fingerprint", "{}", today=TODAY)
    values = [entry["userEnteredValue"] for req in batch.requests if "updateCells" in req for row in req["updateCells"]["rows"] for entry in row["values"]]
    assert {"stringValue": body["bill"]["name"]} in values
    assert {"formulaValue": body["bill"]["name"]} not in values


def test_extra_formula_columns_survive_price_versioning():
    client, loan = fixture()
    t = client.http_client
    t.rows[BILL_TAB][0].append("custom_formula")
    t.formulas[BILL_TAB][0].append("custom_formula")
    t.rows[BILL_TAB][1].append("120.46")
    t.formulas[BILL_TAB][1].append("=J2*2")
    source = storage.read_workbook(B, TODAY, client=client)
    change = prepare_change(source.settings, update(source, loan), today=TODAY)
    batch = storage.configuration_batch(source, change, "request-1234567890", "fingerprint", "{}", today=TODAY)
    values = [e["userEnteredValue"] for r in batch.requests if "updateCells" in r for row in r["updateCells"]["rows"] for e in row["values"]]
    assert {"formulaValue": "=J2*2"} in values


def test_future_literal_is_preserved_without_pushing_the_configuration_start():
    client, loan = fixture()
    client.http_client.rows["December"][0][2] = "80"
    client.http_client.formulas["December"][0][2] = "80"
    source = storage.read_workbook(B, TODAY, client=client)
    assert source.settings.earliest_months[loan.id] == "2026-12"
    change = prepare_change(source.settings, update(source, loan), today=TODAY)
    storage.configuration_batch(source, change, 'future-literal-123456', 'fp', '{}', today=TODAY).send()
    assert client.http_client.rows['December'][0][2] == '80'


def test_eligible_current_month_is_not_skipped_by_prefilled_future_months():
    client, loan = fixture([replace(plan(), id='loan_1234', pull_day=22, monthly_source=True, version='v1')])
    client.http_client.rows['December'][0][2] = client.http_client.formulas['December'][0][2] = '80'
    source = storage.read_workbook(B, TODAY, client=client)
    assert source.settings.earliest_months.get(loan.id, '2026-11') == '2026-11'
    body = update(source, loan)
    body['bill']['effectiveFrom'] = '2026-11'
    change = prepare_change(source.settings, body, today=TODAY)
    storage.configuration_batch(source, change, 'eligible-month-123456', 'fp', '{}', today=TODAY).send()
    assert client.http_client.rows['November'][0][2] == '70.0'


@pytest.mark.parametrize('kind', ['fixed', 'variable', 'subscription'])
@pytest.mark.parametrize('from_wants', [False, True])
def test_future_literal_survives_category_move_instead_of_becoming_the_schedule_price(kind, from_wants):
    old_category = 'subscriptions_wants' if from_wants else 'static_bills_subscriptions_needs'
    new_category = 'static_bills_subscriptions_needs' if from_wants else 'subscriptions_wants'
    p = replace(plan(), id='literal_move_123', kind=kind, category=old_category,
        split_method='none', monthly_source=True, version='v1')
    client, _ = fixture([p])
    old_column, new_column = (4, 3) if from_wants else (3, 4)
    rows = [['', p.source_label, '' if from_wants else '80', '80' if from_wants else ''],
        ['', '(Needs) Subtotal:', '=SUM(C1:C1)'], ['', '(Wants) Subtotal:', '', '=SUM(D1:D1)']]
    for tables in (client.http_client.rows, client.http_client.formulas):
        tables['December'] = deepcopy(rows)
    source = storage.read_workbook(B, TODAY, client=client)
    body = update(source, p, type=kind, category=new_category)
    change = prepare_change(source.settings, body, today=TODAY)
    storage.configuration_batch(source, change, 'category-literal-123456', 'fp', '{}', today=TODAY).send()
    after = client.http_client.rows['December']
    assert float(after[0][old_column - 1]) == 0
    assert float(after[0][new_column - 1]) == 80
    assert not client.http_client.formulas['December'][0][new_column - 1].startswith('=')
    assert change.after.amount_cents == 7000


def test_confirmed_future_charge_keeps_its_source_protection():
    from bookiebot.sheets.recurring_charges import BillCharge, CHARGES_TAB, encode_charges, source_anchor
    client, loan = fixture()
    charge = BillCharge(loan.id, '2026-12', '2026-12-01', loan.source_label, loan.category,
        1, 1, 3, source_anchor(loan.id, '2026-12'), 6023, True, payer_owner='brian')
    for tables in (client.http_client.rows, client.http_client.formulas):
        tables[CHARGES_TAB] = encode_charges([charge], [])
    client.http_client.properties[CHARGES_TAB] = {'title':CHARGES_TAB, 'sheetId':99}
    source = storage.read_workbook(B, TODAY, client=client)
    assert source.settings.earliest_months[loan.id] == '2027-01'


def test_category_change_moves_only_an_unrecorded_source_and_does_not_duplicate_a_subtotal():
    from bookiebot.sheets.recurring_charges import source_anchor
    p = replace(plan(), id="xfinity_123", kind="subscription", source_tab=SUBSCRIPTION_TAB, source_label="Xfinity", name="Xfinity",
        amount_cents=1000, split_method="none", monthly_source=True, version="v1")
    rows = {SUBSCRIPTION_TAB: encode([p], SUBSCRIPTION_TAB, []), "Subscriptions": [], "December": [
        ["", "Xfinity", "10", ""], ["", "(Needs) Subtotal:", "=SUM(C1:C1)"], ["", "(Wants) Subtotal:", "", "=SUM(D1:D1)"]]}
    t = Transport(rows)
    t.formulas["December"][0][2] = "='_BookieBot Subscription Schedule'!C2"
    t.names = [{"name": source_anchor(p.id, "2026-12"), "namedRangeId": "anchor-1", "range": {
        "sheetId": t.properties["December"]["sheetId"], "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 1, "endColumnIndex": 3}}]
    source = storage.read_workbook(B, TODAY, client=SimpleNamespace(http_client=t))
    body = {"operation": "update", "id": p.id, "version": "v1", "settingsVersion": source.settings.version,
        "bill": form(type="subscription", name="Xfinity", amount="20", splitMethod="none", category="subscriptions_wants", effectiveFrom="2026-12")}
    change = prepare_change(source.settings, body, today=TODAY)
    storage.configuration_batch(source, change, "request-1234567890", "fingerprint", "{}", today=TODAY).send()
    assert t.rows["December"][0][2] == "0" and float(t.rows["December"][0][3]) == 20
    assert t.formulas["December"][2][3] == "=SUM(D1:D1)"
    assert t.names[0]["range"]["endColumnIndex"] == 4
