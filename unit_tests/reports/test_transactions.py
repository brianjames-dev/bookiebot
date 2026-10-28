"""Recorded transaction acceptance against isolated sheets and durable local commands."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from bookiebot.reports import transactions as tx
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.sheets import undo
from bookiebot.sheets.repo import sheets_repository_context, get_sheets_repo
from bookiebot.sheets.routing import now_pacific, sheet_user_context
from unit_tests.support.sheets_repo_stub import SheetsRepoStub
from unit_tests.reports.test_goals_store import access as access

B = "676638528590970917"
H = "830984827904851969"


@pytest.fixture
def saved(tmp_path, monkeypatch, access):
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    tx._CACHE.clear()
    month = now_pacific().strftime("%Y-%m")
    previous = (now_pacific().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    repos = {month: SheetsRepoStub(expense_rows=[[],[]],income_rows=[["","Date","Source","Amount"],["","10/20/2026","Fixture payroll","1000"],["","Monthly Income:","1000"]]), previous: SheetsRepoStub(expense_rows=[[],[]])}
    action_ids = {}
    for period, repo in repos.items():
        with repo.patched():
            columns = undo._category_columns("shopping")
            for row, person in [(3,"Brian (BofA)"),(4,"Brian (AL)"),(5,"Hannah")]:
                fields = {"date":period+"-20","item":f"Fixture cable {row}","amount":f"${row}.00","location":"Fixture store","person":person}
                for field,col in columns.items(): repo.expense.update_cell(row,col,fields[field])
                action_id = undo.record_undo_action(H if person=="Hannah" else B,undo.UndoAction(worksheet="expense",kind="clear_cells",row=row,
                    columns=list(columns.values()),previous_values=[""]*len(columns),new_values=list(fields.values()),metadata={"type":"expense","category":"shopping"},description=fields["item"]))
                action_ids[period,row] = action_id
    def tabs(_gc,book,titles):
        result={}
        for title in titles:
            for period,repo in repos.items():
                if title == "_BookieBot Action Log - "+period and book=="shared": result[title]=deepcopy(repo.action_log._rows)
                if title == tx.calendar.month_name[int(period[-2:])]: result[title]=deepcopy((repo.expense if book=="shared" else repo.income)._rows)
        return result
    monkeypatch.setattr(tx,"get_gspread_client",lambda:SimpleNamespace())
    monkeypatch.setattr(tx,"read_workbook_tabs",tabs)
    monkeypatch.setattr(tx,"get_shared_expenses_spreadsheet_id",lambda year:"shared")
    monkeypatch.setattr(tx,"get_budget_spreadsheet_id_for_user",lambda actor,year:"personal")
    monkeypatch.setattr(tx,"configured_reimbursement_workbooks",lambda actor,year:{now_pacific().year:"personal"})
    monkeypatch.setattr(undo,"_sync_reconciliation_after_action_mutation",Mock())
    @contextmanager
    def scope(actor,period):
        with sheet_user_context(actor), sheets_repository_context(repos[period]): yield
    monkeypatch.setattr(tx,"transaction_context",scope)
    access.initialize()
    commands=tx.TransactionCommands(access);commands.initialize()
    yield SimpleNamespace(month=month,previous=previous,repos=repos,ids=action_ids,commands=commands,access=access)
    tx._CACHE.clear()


def row(saved,period=None):
    return next(r for r in tx.listing(B,{"month":period or saved.month})["items"] if "cable 3" in r["title"])


def body(saved,operation="update",period=None,**kwargs):
    value=row(saved,period)
    return {"id":value["id"],"month":value["month"],"version":value["version"],"operation":operation,**({"updates":{"amount":1234}} if operation=="update" else {}),**kwargs}


def confirm(saved,value,request_id="isolated-request-0000001"):
    preview=tx.review(B,value)["review"]
    return saved.commands.command(B,{**value,"version":preview["item"]["version"],"reviewVersion":preview["reviewVersion"],"requestId":request_id})


def test_list_uses_owner_recorded_sources_deduplicates_and_searches_filters(saved):
    result=tx.listing(B,{"month":saved.month})
    assert len(result["items"])==3  # two purchases plus manually recorded income
    assert all(r["person"]!="Hannah" for r in result["items"])
    assert tx.listing(B,{"month":saved.month,"search":"fixture cable 3","category":"shopping","person":"Brian (BofA)"})["total"]==1
    assert tx.listing(B,{"month":saved.month,"kind":"income"})["total"]==1
    assert tx.listing(B,{"month":"all","kind":"expense"})["total"]==4
    assert not tx.listing(B,{"month":saved.month,"search":"not present"})["items"]
    assert all(not any(k.startswith("_") for k in r) for r in result["items"])


@pytest.mark.parametrize("operation,extra",[("update",{}),("move",{"destination":"food"}),("delete",{})])
def test_review_cancel_is_readonly_and_commands_preserve_undo_in_exact_month(saved,operation,extra):
    repo=saved.repos[saved.previous]
    original=deepcopy(repo.expense._rows)
    current=deepcopy(saved.repos[saved.month].expense._rows)
    value=body(saved,operation,saved.previous,**extra)
    log_before=deepcopy(repo.action_log._rows)
    preview=tx.review(B,value)
    assert preview["review"]["reviewVersion"]
    assert repo.expense._rows==original and repo.action_log._rows==log_before
    result=confirm(saved,value)
    assert result["success"],result
    assert result["undo"]
    summary=result["summary"]
    assert summary["operation"]==operation and summary["title"]=="Fixture cable 3"
    assert summary["before"]["amount"]=="$3.00"
    assert not any(key.startswith("_") for key in summary)
    if operation=="update":
        assert summary["after"]["amount"]=="12.34"
    elif operation=="move":
        assert summary["destination"]=="food"
    assert saved.commands.saved("brian","isolated-request-0000001")["summary"]==summary
    undo_body={**result["undo"],"operation":"undo"}
    undone=confirm(saved,undo_body,"isolated-undo-0000001")
    assert undone["success"],undone
    assert undone["summary"]["operation"]=="undo"
    columns=list(undo._category_columns("shopping").values())
    for i,values in enumerate(original,1):
        assert [tx.cell(repo.expense._rows,i,c) for c in columns]==[tx.cell(original,i,c) for c in columns]
    assert saved.repos[saved.month].expense._rows==current


@pytest.mark.parametrize("operation,extra",[("update",{"updates":{"amount":1234,"item":"Revised fixture"}}),("move",{"destination":"food"})])
def test_undo_review_explains_current_and_restored_details_without_changing_undo(saved,monkeypatch,operation,extra):
    result=confirm(saved,body(saved,operation,saved.previous,**extra))
    assert result["success"],result
    value={**result["undo"],"operation":"undo"}
    repo=saved.repos[saved.previous]
    cells,log=deepcopy(repo.expense._rows),deepcopy(repo.action_log._rows)
    preview=tx.review(B,value)["review"]
    assert repo.expense._rows==cells and repo.action_log._rows==log
    with pytest.raises(tx.TransactionConflict):
        tx.review(H,value)
    restoration=preview["restoration"]
    assert restoration["operation"]==operation
    assert restoration["restoredCategory"]=="Shopping"
    assert preview["after"]["amount"]=="$3.00"
    assert preview["after"]["item"]=="Fixture cable 3"
    if operation=="update":
        assert restoration["current"]["amount"]=="$12.34"
        assert restoration["current"]["item"]=="Revised fixture"
        assert restoration["currentCategory"]=="Shopping"
    else:
        assert restoration["currentCategory"]=="Food"
        assert restoration["current"]["amount"]=="$3.00"
    assert not any(key.startswith("_") for key in preview["item"])
    assert "restoration" not in preview["item"]
    writer=Mock(wraps=undo.undo_logged_action)
    monkeypatch.setattr(undo,"undo_logged_action",writer)
    command={**value,"version":preview["item"]["version"],"reviewVersion":preview["reviewVersion"],"requestId":"isolated-undo-details-0001"}
    undone=saved.commands.command(B,command)
    assert undone["success"],undone
    assert undone["summary"]["restoration"]==restoration
    assert saved.commands.saved("brian",command["requestId"])==undone
    assert saved.commands.saved("hannah",command["requestId"]) is None
    assert saved.commands.command(B,command)==undone
    writer.assert_called_once()
    restored=next(r for r in tx.listing(B,{"month":saved.previous})["items"] if r["title"]=="Fixture cable 3")
    assert restored["category"]=="shopping" and restored["amountCents"]==300


@pytest.mark.parametrize("operation,extra",[("update",{}),("move",{"destination":"food"})])
def test_changed_current_details_invalidate_the_undo_review_before_any_writer(saved,monkeypatch,operation,extra):
    result=confirm(saved,body(saved,operation,**extra))
    value={**result["undo"],"operation":"undo"}
    preview=tx.review(B,value)["review"]
    category=preview["item"]["category"]
    repo=saved.repos[saved.month]
    with tx.transaction_context(B,saved.month):
        logged=undo._find_log_row(result["undo"]["id"].split(":",1)[1])[2]
    repo.expense.update_cell(logged.action.row,undo._category_columns(category)["amount"],"$99.00")
    cells,log=deepcopy(repo.expense._rows),deepcopy(repo.action_log._rows)
    writer=Mock()
    monkeypatch.setattr(undo,"undo_logged_action",writer)
    rejected=saved.commands.command(B,{**value,"version":preview["item"]["version"],"reviewVersion":preview["reviewVersion"],"requestId":"isolated-stale-undo-0001"})
    assert not rejected["success"] and rejected["state"]=="done"
    writer.assert_not_called()
    assert repo.expense._rows==cells and repo.action_log._rows==log


def test_lost_response_replay_and_command_fingerprint_never_repeat_writer(saved,monkeypatch):
    value=body(saved)
    preview=tx.review(B,value)["review"]
    command={**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000001"}
    writer=Mock(wraps=undo.update_recent_action);monkeypatch.setattr(undo,"update_recent_action",writer)
    result=saved.commands.command(B,command)
    assert result["success"]
    assert saved.commands.command(B,command)==result
    assert saved.commands.saved("brian",command["requestId"])["success"]
    writer.assert_called_once()
    with pytest.raises(tx.TransactionConflict): saved.commands.command(B,{**command,"updates":{"amount":999}})
    assert saved.commands.saved("hannah",command["requestId"]) is None


def test_changed_source_or_forged_foreign_id_cannot_write(saved):
    value=body(saved);preview=tx.review(B,value)["review"]
    repo=saved.repos[saved.month]
    repo.expense.update_cell(3,undo._category_columns("shopping")["amount"],"$88.00")
    before=deepcopy(repo.expense._rows)
    result=saved.commands.command(B,{**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000001"})
    assert not result["success"] and ("changed" in result["detail"] or "no longer available" in result["detail"])
    assert repo.expense._rows==before
    foreign={**value,"id":saved.month+":"+saved.ids[saved.month,5]}
    with pytest.raises(tx.TransactionConflict): tx.review(B,foreign)


@pytest.mark.parametrize("updates",[{"date":"2020-01-01"},{"item":"=IMPORTDATA(\"bad\")"},{"amount":True},{"amount":-1},{"amount":1.5},{"person":"Unknown"}])
def test_invalid_fields_and_formula_text_fail_before_write(saved,updates):
    before=deepcopy(saved.repos[saved.month].expense._rows)
    with pytest.raises(tx.TransactionValidation): tx.review(B,body(saved,updates=updates))
    assert saved.repos[saved.month].expense._rows==before


def test_missing_manual_source_is_adopted_only_on_explicit_confirmation(saved):
    repo=saved.repos[saved.month]
    repo.action_log._rows=[undo._LOG_HEADERS]
    value=body(saved)
    assert repo.action_log._rows==[undo._LOG_HEADERS]
    tx.review(B,value)
    assert repo.action_log._rows==[undo._LOG_HEADERS]
    result=confirm(saved,value)
    assert result["success"] and result["undo"]
    assert tx.cell(repo.expense._rows,3,undo._category_columns("shopping")["amount"])=="$12.34"


def test_generated_receipts_are_visible_but_cannot_be_edited(saved):
    repo=saved.repos[saved.month]
    repo.expense.update_cell(3,undo._category_columns("shopping")["item"],"Reimbursement · Fixture purchase")
    value=next(r for r in tx.listing(B,{"month":saved.month})["items"] if r["title"].startswith("Reimbursement"))
    assert not any(value["capabilities"].values())
    with pytest.raises(tx.TransactionValidation): tx.review(B,{**value,"operation":"delete"})


def test_failure_before_writer_is_retryable_but_unknown_write_blocks_new_commands(saved,monkeypatch):
    value=body(saved);preview=tx.review(B,value)["review"]
    original=tx.review
    monkeypatch.setattr(tx,"review",Mock(side_effect=TimeoutError("read timed out")))
    result=saved.commands.command(B,{**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000001"})
    assert result["state"]=="done" and "Nothing was changed" in result["detail"]
    monkeypatch.setattr(tx,"review",original)
    writer=Mock(side_effect=TimeoutError("unknown write result"));monkeypatch.setattr(undo,"update_recent_action",writer)
    command={**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000002"}
    assert saved.commands.command(B,command)["state"]=="uncertain"
    assert saved.commands.command(B,command)["state"]=="uncertain"
    writer.assert_called_once()
    with pytest.raises(tx.TransactionConflict): saved.commands.command(B,{**command,"requestId":"isolated-request-0000003"})


def test_context_is_worker_local_and_always_restored(saved):
    original=get_sheets_repo()
    with sheets_repository_context(saved.repos[saved.month]):
        assert get_sheets_repo() is saved.repos[saved.month]
    assert get_sheets_repo() is original


def test_concurrent_duplicate_commands_claim_once_and_persist_across_instances(saved,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    value=body(saved);preview=tx.review(B,value)["review"]
    command={**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000001"}
    barrier=Barrier(2)
    writer=Mock(wraps=undo.update_recent_action);monkeypatch.setattr(undo,"update_recent_action",writer)
    def run():
        barrier.wait(timeout=10)
        return tx.TransactionCommands(saved.access).command(B,command)
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda _:run(),range(2)))
    assert any(result.get("success") for result in results)
    assert all(result["state"] in {"running","done"} for result in results)
    assert tx.TransactionCommands(saved.access).command(B,command)["success"]
    writer.assert_called_once()


def test_one_batched_read_per_workbook_is_reused_for_search_and_filter(saved,monkeypatch):
    reader=Mock(wraps=tx.read_workbook_tabs);monkeypatch.setattr(tx,"read_workbook_tabs",reader)
    tx.listing(B,{"month":saved.month})
    tx.listing(B,{"month":saved.month,"search":"cable","person":"Brian (AL)"})
    assert reader.call_count==2
    assert all("Subscriptions" not in call.args[2] for call in reader.call_args_list)
    saved.repos[saved.month].expense.update_cell(3,undo._category_columns("shopping")["amount"],"$9.00")
    fresh=tx.listing(B,{"month":saved.month,"fresh":"1","search":"cable 3"})
    assert fresh["items"][0]["amountCents"]==900 and reader.call_count==4
    assert tx.listing(B,{"month":saved.month,"search":"cable 3"})["items"][0]["amountCents"]==900
    assert reader.call_count==4


def test_unavailable_history_never_becomes_an_empty_success(saved,monkeypatch):
    monkeypatch.setattr(tx,"read_workbook_tabs",Mock(side_effect=TimeoutError("fixture unavailable")))
    with pytest.raises(TimeoutError):tx.listing(B,{"month":saved.month})
    assert not tx._CACHE


def test_explicit_historical_source_year_does_not_change_clock_or_other_workers(saved):
    from datetime import date
    from bookiebot.sheets.repo import scoped_sheet_period
    repo=saved.repos[saved.month]
    repo.period=SimpleNamespace(year=2025,month=1)
    with sheets_repository_context(repo):
        assert undo._source_year()==2025
        assert scoped_sheet_period().month==1
        assert now_pacific().year==2026
    assert undo._source_year()==now_pacific().year


from unit_tests.reimbursements.test_service import setup as canonical, split as canonical_split, VALUES, FIELDS


def test_split_creation_uses_the_explicit_historical_workbook(canonical):
    from datetime import date
    from bookiebot.reimbursements import service
    with sheets_repository_context(SimpleNamespace(period=SimpleNamespace(year=2025,month=1))):
        result=service.record_split(B,canonical.logged,canonical.sheet,FIELDS,{**VALUES,"date":"1/3/2025"},
            "Brian (BofA)","income",464.72,300.81,163.91,expense_date=date(2025,1,3))
    assert result[0],result
    allocation=canonical.store.find_by_source(canonical.logged.id,2025)
    assert allocation and allocation["sourceYear"]==2025 and allocation["sourceSheetTitle"]=="January"
    assert not canonical.store.snapshot("brian")["events"]


@pytest.mark.parametrize("settlement",["pending","received"])
def test_app_updates_reuse_canonical_repayment_guards_without_recording_receipts(canonical,saved,monkeypatch,settlement):
    from unit_tests.reimbursements.test_store import payment
    from bookiebot.reimbursements import service
    # The two fixtures deliberately use different local grids. Canonical writes
    # route through its real isolated projector/store, never a production client.
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED","true")
    assert canonical_split(canonical)[0]
    allocation=canonical.store.snapshot("brian")["allocations"][0]
    service.command("hannah" if settlement=="pending" else "brian",payment(allocation,1000,"report_payment" if settlement=="pending" else "receive"))
    logged=undo.LoggedAction(id=canonical.logged.id,created_at="2026-01-03",user_key=B,action=canonical.logged.action)
    current=undo._canonical_action(logged)
    public=tx._public(B,"2026-01",current,[])
    monkeypatch.setattr(tx,"load_transactions",lambda *args,**kwargs:[public])
    monkeypatch.setattr(undo,"select_recent_action",lambda *args,**kwargs:current)
    monkeypatch.setattr(undo,"_read_log",lambda:[])
    before=canonical.store.snapshot("brian")
    command={"id":public["id"],"month":"2026-01","version":public["version"],"operation":"update","updates":{"amount":50000}}
    result=confirm(saved,command)
    assert not result["success"] and result["state"]=="done"
    assert canonical.store.snapshot("brian")==before


def test_persistent_undo_and_request_lineage_survive_reload(saved):
    value=body(saved)
    result=confirm(saved,value)
    again=tx.TransactionCommands(saved.access)
    assert again.overview("brian",saved.month)["undo"]==result["undo"]
    assert again.overview("hannah",saved.month)=={}
    with tx.transaction_context(B,saved.month):
        record=undo._find_log_row(result["undo"]["id"].split(":",1)[1])
        assert record[2].action.metadata["app_request_id"]=="isolated-request-0000001"
    assert confirm(saved,{**result["undo"],"operation":"undo"},"isolated-undo-0000001")["success"]
    assert "undo" not in again.overview("brian",saved.month)


def test_another_session_can_find_frozen_unresolved_confirmation_without_resubmitting(saved,monkeypatch):
    value=body(saved);preview=tx.review(B,value)["review"]
    command={**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000001"}
    writer=Mock(side_effect=TimeoutError("fixture unknown result"));monkeypatch.setattr(undo,"update_recent_action",writer)
    assert saved.commands.command(B,command)["state"]=="uncertain"
    assert tx.TransactionCommands(saved.access).overview("brian","all")["pendingCommand"]==command
    assert saved.commands.saved("brian",command["requestId"])["state"]=="uncertain"
    writer.assert_called_once()


def test_legacy_failure_message_is_not_permission_to_repeat_a_possible_writer(saved,monkeypatch):
    value=body(saved);preview=tx.review(B,value)["review"]
    command={**value,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-request-0000001"}
    writer=Mock(return_value=(False,"Something went wrong while saving that split. The original amount was left in place."))
    monkeypatch.setattr(undo,"update_recent_action",writer)
    result=saved.commands.command(B,command)
    assert result["state"]=="uncertain" and "could not verify" in result["detail"]
    assert "original amount was left" not in result["detail"]
    assert saved.commands.command(B,command)==result
    writer.assert_called_once()


def test_transactions_amount_review_and_update_preserve_custom_reimbursement_percentage(canonical, saved, monkeypatch):
    from bookiebot.reimbursements import service
    from unit_tests.reimbursements.test_store import command as ledger_command
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    saved.repos["2026-01"] = SheetsRepoStub()
    assert canonical_split(canonical)[0]
    allocation = canonical.store.snapshot("brian")["allocations"][0]
    service.command("brian", ledger_command("edit_split", allocationId=allocation["id"], version=allocation["version"],
                                            grossCents=allocation["grossCents"], payerBasisPoints=3333))
    logged = undo.LoggedAction(id=canonical.logged.id, created_at="2026-01-03", user_key=B, action=canonical.logged.action)
    current = undo._canonical_action(logged)
    public = tx._public(B, "2026-01", current, [])
    monkeypatch.setattr(tx, "load_transactions", lambda *args, **kwargs: [public])
    monkeypatch.setattr(undo, "select_recent_action", lambda *args, **kwargs: current)
    monkeypatch.setattr(undo, "_read_log_data", lambda **kwargs: SimpleNamespace(records=[]))
    change = {"id": public["id"], "month": "2026-01", "version": public["version"],
              "operation": "update", "updates": {"amount": 12345}}
    preview = tx.review(B, change)["review"]
    assert preview["share"] == {"method": "custom", "payerCents": 4115, "partnerCents": 8230,
                               "payerBasisPoints": 3333, "payerName": "Brian", "partnerName": "Hannah"}
    result = confirm(saved, change)
    assert result["success"], result
    corrected = canonical.store.get_allocation(allocation["id"])
    assert corrected["customPayerBasisPoints"] == 3333
    assert (corrected["grossCents"], corrected["payerShareCents"], corrected["partnerShareCents"]) == (12345, 4115, 8230)
    assert canonical.store.snapshot("brian")["events"] == []


def custom_source(canonical,saved,monkeypatch):
    from dataclasses import replace
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED","true")
    saved.repos["2026-01"]=SheetsRepoStub()
    logged=undo.LoggedAction(canonical.logged.id,"2026-01-03",B,replace(canonical.logged.action,
        metadata={**canonical.logged.action.metadata,"type":"expense"}))
    rows=[[],[],[""]*29+list(VALUES.values())]
    monkeypatch.setattr(undo,"_worksheet",lambda *args:canonical.sheet)
    monkeypatch.setattr(undo,"_read_log_data",lambda **kwargs:SimpleNamespace(records=[]))
    monkeypatch.setattr(undo,"select_recent_action",lambda *args,**kwargs:logged)
    public=tx._public(B,"2026-01",logged,rows)
    monkeypatch.setattr(tx,"load_transactions",lambda *args,**kwargs:[public])
    return logged,rows,public


def test_transaction_custom_split_creation_edit_replay_and_exact_ratio_preload(canonical,saved,monkeypatch):
    logged,rows,public=custom_source(canonical,saved,monkeypatch)
    assert public["splitOptions"]=={"custom":True,"payerName":"Brian","partnerName":"Hannah","payerBasisPoints":5000}
    change={"id":public["id"],"month":"2026-01","version":public["version"],"operation":"split","method":"custom","payerBasisPoints":3333}
    cells=deepcopy(canonical.sheet.rows)
    history=deepcopy(canonical.history)
    preview=tx.review(B,change)["review"]
    assert preview["share"]=={"method":"custom","payerCents":15489,"partnerCents":30983,
                              "payerBasisPoints":3333,"payerName":"Brian","partnerName":"Hannah"}
    assert canonical.sheet.rows==cells and canonical.history==history and canonical.store.snapshot("brian")["allocations"]==[]
    writer=Mock(wraps=undo.split_recent_action);monkeypatch.setattr(undo,"split_recent_action",writer)
    command={**change,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-custom-create-01"}
    result=saved.commands.command(B,command)
    assert result["success"],result
    assert result["summary"]["share"]==preview["share"]
    assert saved.commands.command(B,command)==result
    writer.assert_called_once()
    with pytest.raises(tx.TransactionConflict):
        saved.commands.command(B,{**command,"payerBasisPoints":3334})
    assert "undo" not in result  # Canonical shared corrections retain their separate reversal rules.
    current=undo._canonical_action(logged)
    public=tx._public(B,"2026-01",current,rows)
    assert public["split"]=="custom" and public["splitOptions"]["payerBasisPoints"]==3333
    monkeypatch.setattr(tx,"load_transactions",lambda *args,**kwargs:[public])
    monkeypatch.setattr(undo,"select_recent_action",lambda *args,**kwargs:current)
    changed={**change,"version":public["version"],"payerBasisPoints":6667}
    before=canonical.store.snapshot("brian")
    tx.review(B,changed)
    assert canonical.store.snapshot("brian")==before
    updated=confirm(saved,changed,"isolated-custom-edit-0001")
    assert updated["success"],updated
    allocation=canonical.store.snapshot("brian")["allocations"][0]
    assert (allocation["grossCents"],allocation["payerShareCents"],allocation["partnerShareCents"],allocation["customPayerBasisPoints"])==(46472,30983,15489,6667)
    assert canonical.store.snapshot("brian")["events"]==[]
    assert canonical.sheet.read(2,31,32)==[464.72]


@pytest.mark.parametrize("basis",[None,True,False,-1,10001,3333.3,"3333"])
def test_custom_split_review_rejects_invalid_percentages_before_any_mutation(canonical,saved,monkeypatch,basis):
    _,_,public=custom_source(canonical,saved,monkeypatch)
    before=canonical.store.snapshot("brian")
    history=deepcopy(canonical.history)
    with pytest.raises(tx.TransactionValidation):
        tx.review(B,{"id":public["id"],"month":"2026-01","version":public["version"],"operation":"split","method":"custom","payerBasisPoints":basis})
    assert canonical.store.snapshot("brian")==before and canonical.history==history


def test_custom_percentage_change_requires_a_new_review_and_legacy_splits_stay_guarded(canonical,saved,monkeypatch):
    _,_,public=custom_source(canonical,saved,monkeypatch)
    change={"id":public["id"],"month":"2026-01","version":public["version"],"operation":"split","method":"custom","payerBasisPoints":3333}
    preview=tx.review(B,change)["review"]
    writer=Mock();monkeypatch.setattr(undo,"split_recent_action",writer)
    before=canonical.store.snapshot("brian")
    rejected=saved.commands.command(B,{**change,"payerBasisPoints":6667,"reviewVersion":preview["reviewVersion"],"requestId":"isolated-custom-stale-001"})
    assert not rejected["success"] and rejected["state"]=="done"
    writer.assert_not_called()
    assert canonical.store.snapshot("brian")==before
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED","false")
    public["splitOptions"]["custom"]=False
    with pytest.raises(tx.TransactionValidation):
        tx.review(B,change)
