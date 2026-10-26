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
    undo_body={**result["undo"],"operation":"undo"}
    undone=confirm(saved,undo_body,"isolated-undo-0000001")
    assert undone["success"],undone
    columns=list(undo._category_columns("shopping").values())
    for i,values in enumerate(original,1):
        assert [tx.cell(repo.expense._rows,i,c) for c in columns]==[tx.cell(original,i,c) for c in columns]
    assert saved.repos[saved.month].expense._rows==current


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
