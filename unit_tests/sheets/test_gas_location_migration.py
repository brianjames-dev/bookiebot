from copy import deepcopy
import json

import pytest

from bookiebot.sheets.gas_location_migration import migrate_action, migrate_allocation, migrate_sheet_ref, rewrite_import, shared_sheet_requests, recover_gas_locations
from unit_tests.sheets.test_gas_location import sheet_rows


def action(**updates):
    return {"worksheet": "expense", "kind": "clear_cells", "row": 3, "columns": [8, 9, 10],
            "new_values": ["11/3/2026", "42.25", "Brian (BofA)"], "previous_values": ["", "", ""],
            "description": "Gas", "metadata": {"type": "expense", "category": "gas"}, **updates}


def test_history_preserves_money_person_and_all_undo_coordinates():
    source = action()
    actual = migrate_action(source, location="Chevron")
    assert actual["new_values"] == ["11/3/2026", "42.25", "Chevron", "Brian (BofA)"]
    assert actual["columns"] == [8, 9, 10, 11]
    assert actual["previous_values"] == ["", "", "", ""]
    assert source == action()
    assert migrate_action(actual) == actual


def test_partial_update_and_move_compaction_snapshots_keep_alignment():
    update = action(kind="restore_cells", columns=[9], previous_values=["40"], metadata={"category":"gas","display_fields":json.dumps(["date","amount","person"])})
    result = migrate_action(update, location="Shell")
    assert result["columns"] == [9] and result["previous_values"] == ["40"]
    assert result["new_values"][2:] == ["Shell", "Brian (BofA)"]
    assert json.loads(result["metadata"]["display_fields"]) == ["date", "amount", "location", "person"]
    moved = action(kind="move_expense",columns=[14,15,16,17,18],new_values=["11/3/2026","Fuel","42.25","Shell","Brian (BofA)"],previous_values=[""]*5,
                   metadata={"category":"food","source_category":"gas","source_columns":"[8,9,10]","source_values":json.dumps(update["new_values"]),"source_category_columns":"[8,9,10]","source_category_snapshot":json.dumps([update["new_values"]])})
    result = migrate_action(moved)
    assert result["columns"] == [15,16,17,18,19]
    assert result["new_values"] == moved["new_values"]
    assert json.loads(result["metadata"]["source_columns"]) == [8,9,10,11]
    assert json.loads(result["metadata"]["source_category_snapshot"])[0] == ["11/3/2026","42.25","","Brian (BofA)"]


def test_projection_migration_is_coordinate_only_and_idempotent():
    payload={"id":"stable","sourceWorksheet":"expense","sourceSpreadsheetId":"shared","sourceSheetTitle":"November", "sourceColumnMap":{"date":8,"amount":9,"person":10},
             "sourceValues":{"date":"11/3/2026","amount":"42.25","person":"Brian (BofA)"},"category":"gas","location":"Chevron","grossCents":4225,"settledCents":1000,"lifecycle":"active"}
    old=deepcopy(payload);payload["sourceRevision"]={"before":old,"operation":"edit_split","version":3}
    result=migrate_allocation(payload,shared_id="shared",titles={"November"})
    assert result["sourceColumnMap"] == {"date":8,"amount":9,"location":10,"person":11}
    assert result["sourceValues"]["location"] == "Chevron"
    assert result["sourceRevision"]["before"]["sourceColumnMap"] == result["sourceColumnMap"]
    assert (result["grossCents"],result["settledCents"],result["lifecycle"]) == (4225,1000,"active")
    assert migrate_allocation(result,shared_id="shared",titles={"November"}) == result
    assert migrate_allocation(payload,shared_id="different",titles={"November"}) == payload


def test_bank_reservations_shift_only_grounded_months_and_expense_blocks():
    source="expense!row 3#cols=8,9,10#month=2026-11 + subscription:fixture + income!row 5#cols=2,3,4#month=2026-11"
    actual=migrate_sheet_ref(source,months={"2026-11"})
    assert actual.startswith("expense!row 3#cols=8,9,10,11#month=2026-11")
    assert actual.split(" + ")[1:] == source.split(" + ")[1:]
    assert migrate_sheet_ref(actual,months={"2026-11"}) == actual
    assert migrate_sheet_ref(source,months={"2026-10"}) == source


@pytest.mark.parametrize("old,new", [("F4","F4"),("L4","M4"),("T5","U5"),("AB3","AC3"),("AJ5","AK5")])
def test_quoted_imports_follow_only_the_exact_source(old,new):
    formula=f'=IMPORTRANGE("https://docs.google.com/spreadsheets/d/shared/edit", "\'November\'!{old}")'
    actual=rewrite_import(formula,source_id="shared")
    assert actual == formula.replace("!"+old,"!"+new)
    assert rewrite_import(actual,source_id="shared") == actual
    assert rewrite_import(formula,source_id="another") == formula


def test_native_insertion_only_writes_the_new_location_column():
    props={"sheetId":17,"gridProperties":{"rowCount":60,"columnCount":40}}
    requests=shared_sheet_requests(props,sheet_rows(),locations={3:"=Literal station"})
    assert requests[0]["insertDimension"]["range"] == {"sheetId":17,"dimension":"COLUMNS","startIndex":9,"endIndex":10}
    writes=[r["updateCells"] for r in requests if "updateCells" in r]
    assert all(w["start"]["columnIndex"]==9 for w in writes)
    assert writes[1]["rows"][0]["values"][0]["userEnteredValue"] == {"stringValue":"=Literal station"}
    assert requests[2] == {"setDataValidation":{"range":{"sheetId":17,"startRowIndex":1,"endRowIndex":60,"startColumnIndex":9,"endColumnIndex":10}}}
    assert shared_sheet_requests(props,sheet_rows(migrated=True)) == []


def recovery_fixture():
    rows=sheet_rows()
    rows[2][7:10]=["11/3/2026","$42.25","Brian (BofA)"]
    log=[["id","created_at","user_key","status","undone_at","action_json"],
         ["exact-action","2026-11-03T12:00:00Z","676638528590970917","active","",json.dumps(action())]]
    bank={"id":3,"account_id":"owned-account","amount":42.25,"date":"2026-11-04","authorized_date":"2026-11-03","merchant_name":"Chevron","pending":False,"removed_at":None}
    link={"id":7,"matched_action_log_id":"exact-action","status":"matched","classification":"expense","owner_key":"brian","bank_transaction_id":3}
    return {"sheets":{"November":rows},"logs":{"November":log},"transactions":[bank],"reconciliations":[link],"accounts":[{"id":"owned-account","owner_key":"brian"}]}


def test_recovery_requires_saved_exact_link_and_independent_purchase_identity():
    fixture=recovery_fixture();before=deepcopy(fixture)
    assert recover_gas_locations(**fixture)==[{"title":"November","row":3,"actionId":"exact-action","bankTransactionId":3,"reconciliationId":7,"location":"Chevron"}]
    assert fixture==before
    # A second, incorrect saved link cannot override the eligible purchase.
    fixture["transactions"].append({**fixture["transactions"][0],"id":4,"authorized_date":"2026-11-05","date":"2026-11-06","merchant_name":"Coffee shop"})
    fixture["reconciliations"].append({**fixture["reconciliations"][0],"id":8,"bank_transaction_id":4})
    assert recover_gas_locations(**fixture)[0]["location"]=="Chevron"


def test_location_logged_during_compatible_deployment_is_not_dropped_at_cutover():
    fixture=recovery_fixture()
    saved=action();saved["metadata"]["supplied_location"]="Shell"
    fixture["logs"]["November"][1][5]=json.dumps(saved)
    fixture["transactions"]=[];fixture["reconciliations"]=[]
    result=recover_gas_locations(**fixture)
    assert result==[{"title":"November","row":3,"actionId":"exact-action","location":"Shell","source":"saved_action_input"}]
    payload={"sourceWorksheet":"expense","sourceSpreadsheetId":"shared","sourceSheetTitle":"November", "sourceActionId":"exact-action", "category":"gas","location":"", "sourceColumnMap":{"date":8,"amount":9,"person":10},"sourceValues":{"date":"11/3/2026","amount":"42.25","person":"Brian (BofA)"}}
    updated=migrate_allocation(payload,shared_id="shared",titles={"November"},locations={"exact-action":"Shell"})
    assert updated["location"]==updated["sourceValues"]["location"]=="Shell"


@pytest.mark.parametrize("problem",["pending","removed","amount","date","account_owner","source_owner","source_amount","source_date","deleted","unlinked","duplicate_row","conflicting_merchant"])
def test_recovery_never_guesses_or_recreates_missing_sources(problem):
    f=recovery_fixture();bank=f["transactions"][0]
    if problem=="pending":bank["pending"]=True
    elif problem=="removed":bank["removed_at"]="2026-11-05"
    elif problem=="amount":bank["amount"]=42.26
    elif problem=="date":bank.update(date="2026-11-05",authorized_date=None)
    elif problem=="account_owner":f["accounts"][0]["owner_key"]="hannah"
    elif problem=="source_owner":f["sheets"]["November"][2][9]="Hannah"
    elif problem=="source_amount":f["sheets"]["November"][2][8]="$42.26"
    elif problem=="source_date":f["sheets"]["November"][2][7]="11/2/2026"
    elif problem=="deleted":f["logs"]["November"][1][3]="undone"
    elif problem=="unlinked":f["reconciliations"][0]["matched_action_log_id"]="another-action"
    elif problem=="duplicate_row":f["sheets"]["November"][3]=deepcopy(f["sheets"]["November"][2])
    else:
        f["transactions"].append({**bank,"id":4,"merchant_name":"Different merchant"})
        f["reconciliations"].append({**f["reconciliations"][0],"id":8,"bank_transaction_id":4})
    assert recover_gas_locations(**f)==[]
