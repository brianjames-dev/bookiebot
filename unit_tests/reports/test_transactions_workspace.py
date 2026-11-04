"""Canonical read-model aggregation for the approved recorded daily workspace."""
import json
import os
from pathlib import Path
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
    output=os.environ.get('BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES')
    if output and isinstance(saved.access,tx.PostgresAppAccessStore) is False:
        Path(output).write_text(json.dumps({'month':saved.month,'results':results,'sources':[tx.public_row(value) for value in sources]}))
