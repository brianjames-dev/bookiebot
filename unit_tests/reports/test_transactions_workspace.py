"""Canonical read-model aggregation for the approved recorded daily workspace."""
import json
import os
import pytest
from pathlib import Path
from unittest.mock import Mock
from bookiebot.reports import transactions as tx
from unit_tests.reports.test_transactions import saved, access, row, B  # shared isolated fixtures


def test_workspace_filters_aggregate_recorded_rows_and_export_browser_samples(saved, monkeypatch):
    base = row(saved)
    fixtures = [
        (3, 'Food', 'Starbucks Coffee Company', 'Coffee', 845),
        (3, 'Food', 'Chipotle', 'Lunch', 1865),
        (3, 'Grocery', 'Whole Foods', 'Weekly groceries', 6842),
        (3, 'Shopping', 'Target', 'Household supplies', 4218),
        (2, 'Grocery', "Trader Joe's", 'Groceries', 5476),
    ] + [(1, 'Gas' if i % 2 else 'Shopping', 'Shell' if i % 2 else 'Amazon', f'Fixture purchase {i}', 100+i) for i in range(45)]
    keys = {'Food':'food','Grocery':'grocery','Shopping':'shopping','Gas':'gas'}
    sources = []
    for index,(day,category,merchant,item,amount) in enumerate(fixtures):
        date=f'{saved.month}-{day:02d}'
        sources.append({**base,'id':f'{saved.month}:workspace-{index}','version':f'fixture-version-{index}',
            'date':date,'title':item,'location':merchant,'category':keys[category],'categoryLabel':category,
            'amountCents':amount,'split':'equal' if index in {2,4} else '',
            'splitOptions':{**base['splitOptions'],'incomePayerCents':round(amount*156/241),
                            **({'payerCents':(amount+1)//2} if index in {2,4} else {})},
            'fields':{**base['fields'],'date':date,'item':item,'location':merchant,'amount':f'{amount/100:.2f}'}})
    sources += [{**base,'id':f'{saved.month}:income','kind':'income','amountCents':300000,'category':'','categoryLabel':'Income'},
                {**base,'id':f'{saved.month}:savings','kind':'savings','amountCents':50000,'category':'','categoryLabel':'Savings'}]
    monkeypatch.setattr(tx,'load_transactions',lambda *a,**k:sources)
    query={'month':saved.month,'view':'daily','scope':'spending'}
    variants={'all':{},'page2':{'offset':'40'},'needs':{'bucket':'needs'},'wants':{'bucket':'wants'},'shared':{'split':'shared'},
              'food':{'category':'food'},'search':{'search':'star'},'empty':{'search':'missing-fixture'},
              'income':{'scope':'','kind':'income'},'savings':{'scope':'','kind':'savings'}}
    results={key:tx.listing(B,{**query,**extra}) for key,extra in variants.items()}
    assert len(results['all']['items'])==40 and results['all']['total']==50
    assert len(results['page2']['items'])==10 and results['page2']['nextOffset'] is None
    assert results['all']['days']==results['page2']['days']
    assert results['all']['snapshotVersion']==results['page2']['snapshotVersion']
    assert results['all']['days'][-1]['count']==45
    assert results['shared']['totalAmountCents']==12318
    assert results['search']['totalAmountCents']==845
    assert results['income']['totalAmountCents']==300000
    assert results['savings']['totalAmountCents']==50000
    assert results['all']['totalAmountCents']==sum(value[-1] for value in fixtures)
    selected_day = tx.listing(B, {**query, 'day': f'{saved.month}-01'})
    assert selected_day['total'] == 45 and len(selected_day['items']) == 40
    assert all(value['date'] == f'{saved.month}-01' for value in selected_day['items'])
    last_day_page = tx.listing(B, {**query, 'day': f'{saved.month}-01', 'offset': '40'})
    assert len(last_day_page['items']) == 5 and last_day_page['nextOffset'] is None
    assert selected_day['days'] == results['all']['days']
    assert selected_day['totalAmountCents'] == results['all']['totalAmountCents']
    assert selected_day['snapshotVersion'] == results['all']['snapshotVersion']
    empty_day = tx.listing(B, {**query, 'day': f'{saved.month}-20'})
    assert empty_day['items'] == [] and empty_day['total'] == 0
    with pytest.raises(tx.TransactionValidation, match='valid transaction date'):
        tx.listing(B, {**query, 'day': '2026-02-30'})
    output=os.environ.get('BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES')
    if output and isinstance(saved.access,tx.PostgresAppAccessStore) is False:
        Path(output).write_text(json.dumps({'month':saved.month,'results':results,'sources':[tx.public_row(value) for value in sources]}))


def test_day_filter_reads_another_month_without_changing_period(saved, monkeypatch):
    base = row(saved)
    other_month = '2025-12'
    period_rows = [{**base, 'id': saved.month + ':period', 'version': 'period-v1',
                    'date': saved.month + '-20', 'amountCents': 9000, 'displayAmountCents': 6000}]
    other_rows = [{**base, 'id': f'{other_month}:day-{i}', 'month': other_month,
                   'date': other_month + '-15', 'version': f'day-v1-{i}',
                   'amountCents': 200, 'displayAmountCents': 100} for i in range(45)]
    other_rows.append({**other_rows[0], 'id': other_month + ':undated', 'date': ''})
    reader = Mock(side_effect=lambda actor, month, **kwargs:
                  period_rows + other_rows if month == 'all' else period_rows if month == saved.month else other_rows)
    monkeypatch.setattr(tx, 'load_transactions', reader)
    query = {'month': saved.month, 'view': 'daily', 'scope': 'spending'}
    original = tx.listing(B, query)
    selected = tx.listing(B, {**query, 'day': other_month + '-15'})
    assert selected['month'] == saved.month
    assert selected['days'] == original['days']
    assert selected['totalAmountCents'] == original['totalAmountCents'] == 6000
    assert selected['listDays'][0]['count'] == 45 and selected['listDays'][0]['totalCents'] == 4500
    assert selected['total'] == 45 and len(selected['items']) == 40
    assert all(value['month'] == other_month and value['date'] == other_month + '-15' for value in selected['items'])
    page = tx.listing(B, {**query, 'day': other_month + '-15', 'offset': '40'})
    assert len(page['items']) == 5 and page['nextOffset'] is None
    assert page['snapshotVersion'] == selected['snapshotVersion']
    assert page['listDays'] == selected['listDays']
    other_rows[0]['version'] = 'day-v2'
    assert tx.listing(B, {**query, 'day': other_month + '-15'})['snapshotVersion'] != selected['snapshotVersion']
    assert tx.listing(B, query)['snapshotVersion'] == original['snapshotVersion']
    for period in [saved.month, 'all']:
        undated = tx.listing(B, {**query, 'month': period, 'day': other_month + ':undated'})
        assert [value['id'] for value in undated['items']] == [other_month + ':undated']
    reader.reset_mock()
    with pytest.raises(tx.TransactionValidation, match='valid transaction date'):
        tx.listing(B, {**query, 'day': '2026-13:undated'})
    reader.assert_not_called()
    restored = tx.listing(B, query)
    assert restored == original
