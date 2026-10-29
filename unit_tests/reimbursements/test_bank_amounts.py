"""Synthetic bank corrections: receipts stay independent of full-bank matching."""
import pytest
from types import SimpleNamespace

from bookiebot.banking.shared_amounts import apply_shared_amount, shared_amount_review, SharedAmountRejected
from bookiebot.reimbursements import projection, service
from bookiebot.reimbursements.store import ReimbursementConflictError, ReimbursementValidationError
from unit_tests.reimbursements.test_service import setup, split, selected, BRIAN  # noqa: F401
from unit_tests.reimbursements.test_projection import receipt_row
from unit_tests.reimbursements.test_projection import Book
from unit_tests.reimbursements.test_store import access, payment, command  # noqa: F401


def paid(setup):
    assert split(setup, method="equal", payer_share=232.36, partner_share=232.36)[0]
    value = setup.store.snapshot("brian")["allocations"][0]
    result = service.command("brian", payment(value, 6188))
    return setup.store.get_allocation(value["id"]), result["events"][0]


def test_bank_correction_preserves_confirmed_receipt_projection_and_reversal(setup):
    value, event = paid(setup)
    old_events = setup.store.snapshot("brian")["events"]
    old_receipt = receipt_row(setup.book, event["id"])
    logged = selected(setup)
    plan = shared_amount_review("brian", logged, 50000, 3810)
    assert plan["receivedCents"] == 6188 and plan["remainingCents"] == 18812
    assert apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    result = setup.store.get_allocation(value["id"])
    assert result["grossCents"] == 50000 and result["settledCents"] == 6188
    assert result["version"] == result["projectedVersion"] == value["version"] + 1
    assert result["payerShareCents"] == result["partnerShareCents"] == 25000
    assert setup.sheet.read(2, 31, 32) == [438.12]
    assert receipt_row(setup.book, event["id"]) == old_receipt
    assert setup.store.snapshot("brian")["events"] == old_events
    # Replaying a lost response cannot change the ledger twice.
    assert apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    assert setup.store.get_allocation(value["id"])["version"] == result["version"]
    service.command("brian", command("reverse", eventId=event["id"]))
    assert setup.sheet.read(2, 31, 32) == [500.0]
    assert receipt_row(setup.book, event["id"])[2] == 0


def test_saved_bank_correction_recovers_projection_without_new_revision_or_receipt(setup, monkeypatch):
    value, event = paid(setup)
    logged = selected(setup)
    plan = shared_amount_review("brian", logged, 50000, 3810)
    real = projection.sync_pending
    monkeypatch.setattr(projection, "sync_pending", lambda *a, **kw: False)
    assert not apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    saved = setup.store.get_allocation(value["id"])
    assert saved["version"] > saved["projectedVersion"]
    recovery = shared_amount_review("brian", selected(setup), 50000, 3810)
    assert recovery["recovery"] and recovery["token"] == plan["token"]
    monkeypatch.setattr(projection, "sync_pending", real)
    assert apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    final = setup.store.get_allocation(value["id"])
    assert final["version"] == final["projectedVersion"] == saved["version"]
    assert len(setup.store.snapshot("brian")["events"]) == 1
    assert receipt_row(setup.book, event["id"])[2] == 61.88


def test_bank_correction_recovers_after_source_write_response_is_lost(setup):
    value, _ = paid(setup)
    logged = selected(setup)
    plan = shared_amount_review("brian", logged, 50000, 3810)
    setup.book.timeout_after_values = True
    assert not apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    saved = setup.store.get_allocation(value["id"])
    assert setup.sheet.read(2, 31, 32) == [438.12]
    assert apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    assert setup.store.get_allocation(value["id"])["version"] == saved["version"]
    assert len(setup.store.snapshot("brian")["events"]) == 1


def test_exact_bank_match_needs_no_amount_review_even_with_pending_report(setup):
    value, _ = paid(setup)
    service.command('hannah', payment(value, 100, 'report_payment'))
    before = setup.store.snapshot('brian')
    assert shared_amount_review('brian', selected(setup), value['grossCents'], 3810) is None
    assert setup.store.snapshot('brian') == before


def test_general_revision_entry_cannot_bypass_explicit_bank_review(setup):
    value, _ = paid(setup)
    with pytest.raises(ReimbursementValidationError, match='reviewed bank amount'):
        setup.store.revise_allocation('brian', value['id'], value['version'], {'grossCents': 50000}, operation='bank_amount')


def test_shared_bill_bank_correction_keeps_literal_bill_and_existing_partner_payment(setup, monkeypatch):
    from bookiebot.sheets import auth
    setup.logged.action.worksheet = 'income'
    setup.logged.action.metadata['category'] = 'rent'
    setup.sheet.write(2, 1, ['Rent payment (due 1st)', 464.72])
    assert split(setup, fields={'item': 2, 'amount': 3}, values={'item': 'Rent payment (due 1st)', 'amount': '464.72'})[0]
    value = setup.store.snapshot('brian')['allocations'][0]
    partner = Book()
    partner.add_sheet('January').write(2, 1, ['Rent', 0])
    monkeypatch.setattr(projection, 'get_budget_spreadsheet_id_for_user', lambda *_a: 'partner')
    monkeypatch.setattr(auth, 'get_gspread_client', lambda: SimpleNamespace(open_by_key=lambda key: partner if key == 'partner' else setup.book))
    assert not service.command('brian', payment(value, 6188))['projectionPending']
    logged = selected(setup)
    plan = shared_amount_review('brian', logged, 50000, 3810)
    assert plan['method'] == 'income' and plan['receivedCents'] == 6188
    assert apply_shared_amount('brian', logged, 50000, 3810, plan['token'])
    assert setup.sheet.read(2, 1, 3) == ['Rent payment (due 1st)', 438.12]
    assert partner.sheets['January'].read(2, 1, 3) == ['Rent', 61.88]


@pytest.mark.parametrize("problem", ["stale", "token", "owner", "overpaid", "pending", "cleared"])
def test_bank_review_guards_do_not_save_corrections(setup, problem):
    value, _ = paid(setup)
    logged = selected(setup)
    plan = shared_amount_review("brian", logged, 50000, 3810)
    if problem == "stale":
        service.command("brian", payment(value, 100))
    elif problem == "pending":
        service.command("hannah", payment(value, 100, "report_payment"))
    elif problem == "cleared":
        service.command("brian", command("reset", expectedState=setup.store.snapshot("brian")["resetState"]))
    baseline = setup.store.snapshot("brian")
    with pytest.raises((SharedAmountRejected, ReimbursementConflictError, ReimbursementValidationError)):
        apply_shared_amount("hannah" if problem == "owner" else "brian", logged,
            10000 if problem == "overpaid" else 50000, 3810, "wrong" if problem == "token" else plan["token"])
    assert setup.store.snapshot("brian") == baseline


@pytest.mark.parametrize("operation", ["update", "move", "split", "delete", "cancel"])
def test_ordinary_recent_actions_still_require_repayment_reversal(setup, operation):
    paid(setup)
    baseline = setup.store.snapshot("brian")
    ok, message = service.mutate_recent_action(BRIAN, selected(setup), operation,
        updates={"amount": "500.00"}, destination_category="food", split_method="income")
    assert not ok and "confirmed repayments" in message
    assert setup.store.snapshot("brian") == baseline


@pytest.mark.parametrize("method,extra", [("income", {}), ("fronted", {}),
    ("custom", {"custom_payer_ratio": [1000, 46472]})])
def test_bank_corrections_preserve_saved_split_method_and_exact_ratio(setup, method, extra):
    from bookiebot.sheets.collaboration import split_amounts
    payer, partner = split_amounts(464.72, method, "brian", **extra)
    assert split(setup, method=method, payer_share=payer, partner_share=partner, **extra)[0]
    logged = selected(setup)
    plan = shared_amount_review("brian", logged, 50000, 3810)
    assert apply_shared_amount("brian", logged, 50000, 3810, plan["token"])
    result = setup.store.snapshot("brian")["allocations"][0]
    assert result["method"] == method
    assert [result["payerShareCents"], result["partnerShareCents"]] == [round(x * 100) for x in split_amounts(500, method, "brian", **extra)]
