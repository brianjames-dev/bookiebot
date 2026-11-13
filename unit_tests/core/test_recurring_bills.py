from dataclasses import replace
from datetime import datetime
from unittest.mock import Mock
import pytest

from bookiebot.core import recurring_bills
from bookiebot.reports import bill_settings as bills
from bookiebot.sheets.recurring import BILL_TAB
from bookiebot.sheets.recurring_rows import encode
from unit_tests.reports.test_bill_settings import saved as saved, B
from unit_tests.reports.test_goals_store import access as access


def setup(saved, monkeypatch, *, cutoff="2026-11-12"):
    monkeypatch.setattr(recurring_bills, "now_pacific", lambda: datetime(2026, 11, 13, 12))
    monkeypatch.setattr(bills, "build_commands", lambda: saved.commands)
    monkeypatch.setattr("bookiebot.reimbursements.service.enabled", lambda: True)
    plan = replace(saved.loan, split_method="income", request_id="confirmed-bill-settings", split_starts_on=cutoff)
    saved.client.http_client.rows[BILL_TAB] = saved.client.http_client.formulas[BILL_TAB] = encode([plan], BILL_TAB, [])
    record = Mock(return_value={"success": True, "detail": "Recorded."})
    monkeypatch.setattr(bills, "record_charge", record)
    return record


def test_due_authorized_default_posts_one_canonical_charge_even_after_formula_is_frozen(saved, monkeypatch):
    record = setup(saved, monkeypatch)
    assert recurring_bills.process_owner(B) == 1
    assert record.call_count == 1
    assert record.call_args.args[1]["plan"].split_method == "income"
    assert record.call_args.args[1]["date"] == "2026-11-12"
    assert recurring_bills.process_owner(B) == 0
    assert record.call_count == 1


def test_new_default_does_not_split_an_existing_elapsed_charge(saved, monkeypatch):
    record = setup(saved, monkeypatch, cutoff="2026-11-14")
    assert recurring_bills.process_owner(B) == 0
    record.assert_not_called()


def test_lost_split_outcome_cannot_duplicate_or_rewrite_charge(saved, monkeypatch):
    record = setup(saved, monkeypatch)
    record.side_effect = TimeoutError("lost canonical response")
    recurring_bills.process_owner(B)
    recurring_bills.process_owner(B)
    assert record.call_count == 1
    assert saved.commands.pending("brian") is None
    import json
    with saved.commands.access.connect() as db:
        records = db.execute("SELECT request_id,command_json FROM app_bill_commands").fetchall()
    request_id = next(r["request_id"] for r in records if json.loads(r["command_json"])["operation"] == "scheduled")
    result = saved.commands.saved(B, request_id)
    assert result["state"] == "done" and result["splitPending"]
    recurring_bills.process_owner(B)
    assert record.call_count == 1


def test_background_preparation_never_recreates_a_cleared_existing_amount(saved, monkeypatch):
    record = setup(saved, monkeypatch)
    p = replace(saved.loan, split_method="none", request_id="configured", split_starts_on="2026-11-12")
    t = saved.client.http_client
    t.rows[BILL_TAB] = t.formulas[BILL_TAB] = encode([p], BILL_TAB, [])
    t.rows["November"][0][2] = "0"
    t.formulas["November"][0][2] = "0"
    recurring_bills.process_owner(B)
    recurring_bills.process_owner(B)
    assert t.rows["November"][0][2] == "0"
    record.assert_not_called()
