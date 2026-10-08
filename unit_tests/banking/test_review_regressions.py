"""Live October failures: side-by-side row claims and completed-import Undo."""
from pathlib import Path

import pytest

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.reconciliation import action_log_candidate_by_id
from bookiebot.banking.service import BankingService
from bookiebot.banking.store import BankStore
from bookiebot.sheets.undo import LoggedAction, UndoAction
import bookiebot.banking.service as banking


@pytest.mark.parametrize('category,columns,values,amount', [
    ('grocery', [1, 2, 3, 4], ['10/6/2026', '72.27', "Oliver's Market", 'Brian (BofA)'], 72.27),
    ('grocery', [1, 2, 3, 4], ['10/6/2026', '72.27', '111', 'Brian (BofA)'], 72.27),
    ('gas', [8, 9, 10], ['10/6/2026', '45.67', 'Brian (BofA)'], 45.67),
    ('shopping', [22, 23, 24, 25, 26], ['10/6/2026', '123', '1.00', 'City', 'Brian (BofA)'], 1.00),
])
def test_amount_and_cell_identity_use_the_purchase_category(category, columns, values, amount):
    logged = LoggedAction('purchase', '2026-10-06', 'actor', UndoAction(
        worksheet='expense', kind='clear_cells', row=4, columns=columns,
        previous_values=[], new_values=values, metadata={'type': 'expense', 'category': category},
        description=f'{category} expense ${amount}',
    ))
    candidate = action_log_candidate_by_id(logged)
    assert candidate is not None and candidate.amount == amount
    assert candidate.sheet_ref == f"expense!row 4#cols={','.join(map(str, columns))}#month=2026-10"


@pytest.fixture
def reviews(tmp_path, monkeypatch):
    config = BankingConfig(plaid_client_id='client', plaid_secret='secret', plaid_env='sandbox',
        token_encryption_key='test', sqlite_path=Path('unused'))
    store = BankStore(tmp_path / 'bank.sqlite3', TokenCipher('test'))
    store.initialize()
    service = BankingService(config=config, store=store, plaid=PlaidClient(config))
    monkeypatch.setattr(banking, '_scheduled_pulls_for_transactions', lambda *args, **kwargs: [])
    purchase = LoggedAction('grocery-action', '2026-10-06', 'actor', UndoAction(
        worksheet='expense', kind='clear_cells', row=4, columns=[1, 2, 3, 4],
        previous_values=[], new_values=['10/6/2026', '72.27', "Oliver's Market", 'Brian (BofA)'],
        metadata={'type': 'expense', 'category': 'grocery'}, description='grocery expense $72.27',
    ))
    monkeypatch.setattr(banking, 'read_active_logged_actions', lambda _: [purchase])
    monkeypatch.setattr(banking, '_read_current_logged_actions', lambda _: [purchase])
    def seed(identity, amount):
        store.upsert_transactions([{'transaction_id': identity, 'date': '2026-10-07',
            'name': "Oliver's Market", 'amount': amount, 'pending': False}], 'brian')
        transaction = next(tx for tx in store.recent_transactions('brian') if tx.provider_transaction_id == identity)
        return store.upsert_reconciliation_item(owner_key='brian', transaction=transaction,
            classification='expense', status='needs_review', confidence=0)
    return service, store, purchase, seed


def test_fresh_grocery_match_succeeds_despite_legacy_food_reservation(reviews, monkeypatch):
    service, store, purchase, seed = reviews
    food = seed('food-bank', 19.11)
    assert store.confirm_reconciliation_item('brian', food.id, matched_action_log_id='food-action',
        matched_sheet_ref='expense!row 4#month=2026-10')
    grocery = seed('grocery-bank', 72.27)
    current, candidates, _ = service.reconciliation_match_candidates('brian', grocery.id, actor_key='actor')
    assert [candidate.action_id for candidate in candidates] == [purchase.id]
    update = []
    monkeypatch.setattr(banking, 'update_recent_action', lambda *args, **kwargs: update.append(kwargs))
    result, candidate, status = service.confirm_reconciliation_action_match(
        'brian', grocery.id, actor_key='actor', action_id=purchase.id, expected_item=current,
    )
    assert status == 'matched' and result.status == 'confirmed'
    assert result.matched_sheet_ref == candidate.sheet_ref
    assert update == []


def test_unchanged_unavailable_match_is_not_reported_as_changed(reviews):
    service, store, purchase, seed = reviews
    first = seed('first-bank', 72.27)
    assert store.confirm_reconciliation_item('brian', first.id, matched_action_log_id='another-action',
        matched_sheet_ref='expense!row 4#cols=1,2,3,4#month=2026-10')
    second = seed('second-bank', 72.27)
    result, _, status = service.confirm_reconciliation_action_match(
        'brian', second.id, actor_key='actor', action_id=purchase.id, expected_item=second,
    )
    assert result == second and status == 'match_unavailable'


def test_legacy_row_only_revert_reference_cannot_pick_between_categories():
    from dataclasses import replace
    food = LoggedAction('food', '2026-10-06', 'actor', UndoAction(
        worksheet='expense', kind='clear_cells', row=4, columns=[14, 15, 16, 17, 18],
        previous_values=[], new_values=['10/6/2026', 'Taco', '19.11', 'Shop', 'Brian (BofA)'],
        metadata={'type': 'expense', 'category': 'food'}, description='Food',
    ))
    shopping = replace(food, id='shopping', action=replace(food.action,
        columns=[22, 23, 24, 25, 26], metadata={'type': 'expense', 'category': 'shopping'}))
    assert banking._find_action_for_sheet_ref([food, shopping], 'expense!row 4#month=2026-10') is None
    assert banking._find_action_for_sheet_ref([food, shopping],
        'expense!row 4#cols=14,15,16,17,18#month=2026-10') == food
