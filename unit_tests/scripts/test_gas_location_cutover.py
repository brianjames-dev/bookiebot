from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from scripts.migrate_gas_location import apply_plan, build_plan
from unit_tests.sheets.test_gas_location import sheet_rows


def trim(rows):
    result=deepcopy(rows)
    for row in result:
        while row and row[-1]=="":row.pop()
    while result and not result[-1]:result.pop()
    return result


@pytest.fixture
def migration(monkeypatch):
    from bookiebot.sheets import auth
    import psycopg
    rows=sheet_rows()[:3];rows[2][7:10]=["11/3/2026","$42.25","Brian (BofA)"]
    shared=trim(rows)
    captures={}
    for index,owner in enumerate(("shared","brian","hannah"),1):
        values=shared if owner=="shared" else [[f'=IMPORTRANGE("shared", "November!L{4 if owner=="brian" else 5}")']]
        captures[owner]={"id":owner,"rows":{"November":deepcopy(values)},"formulas":{"November":deepcopy(values)},
                         "metadata":{"sheets":[{"properties":{"title":"November","sheetId":index,"gridProperties":{"rowCount":60,"columnCount":40}}}]}}
    database={"bank_transactions":[],"bank_reconciliation_items":[],"bank_import_operations":[],"app_reimbursement_allocations":[]}
    plan=build_plan(captures,database,[],2026)
    current={key:deepcopy(capture["formulas"]) for key,capture in captures.items()}
    calls=[];fail_once=set()
    def read(key,ranges,params):
        return {"valueRanges":[{"values":deepcopy(current[key][r.split("!")[0].strip("'")])} for r in ranges]}
    def write(key,body):
        calls.append(key)
        for request in body["requests"]:
            if "insertDimension" in request:
                for row in current[key]["November"]:
                    while len(row)<9:row.append("")
                    row.insert(9,"")
            if "updateCells" in request:
                edit=request["updateCells"];position=edit["start"];r,c=position["rowIndex"],position["columnIndex"]
                while len(current[key]["November"])<=r:current[key]["November"].append([])
                row=current[key]["November"][r]
                while len(row)<=c:row.append("")
                value=edit["rows"][0]["values"][0]["userEnteredValue"]
                row[c]=value.get("formulaValue",value.get("stringValue"))
        current[key]["November"]=trim(current[key]["November"])
        if key in fail_once:
            fail_once.remove(key)
            raise TimeoutError("committed response lost")
    client=SimpleNamespace(http_client=SimpleNamespace(values_batch_get=read),open_by_key=lambda key:SimpleNamespace(batch_update=lambda body:write(key,body)))
    db=Mock();db.__enter__=Mock(return_value=db);db.__exit__=Mock(return_value=False)
    db.execute.return_value.fetchone.return_value={"n":0}
    monkeypatch.setenv("DATABASE_PUBLIC_URL","postgresql://isolated-fixture")
    monkeypatch.setattr(psycopg,"connect",lambda *a,**kw:db)
    monkeypatch.setattr(auth,"get_gspread_client",lambda:client)
    return SimpleNamespace(captures=captures,current=current,plan=plan,calls=calls,fail_once=fail_once,db=db)


def test_every_workbook_is_checked_before_first_mutation(migration):
    migration.current["hannah"]["November"][0][0]="changed outside this task"
    with pytest.raises(ValueError,match="content changed"):
        apply_plan(migration.plan,migration.captures,None)
    assert migration.calls==[]
    migration.db.commit.assert_not_called()


def test_lost_response_resumes_same_plan_without_inserting_another_column(migration):
    migration.fail_once.add("brian")
    with pytest.raises(TimeoutError):apply_plan(migration.plan,migration.captures,None)
    migration.db.commit.assert_not_called()
    assert migration.calls==["shared","brian"]
    apply_plan(migration.plan,migration.captures,None)
    assert migration.calls.count("shared")==1
    assert migration.current["shared"]["November"][1][7:11]==["Date:","Amount:","Location","Person:"]
    assert migration.current["shared"]["November"][2][7:11]==["11/3/2026","$42.25","","Brian (BofA)"]
    assert migration.current["hannah"]["November"][0][0].endswith('November!M5")')
    migration.db.commit.assert_called_once()
