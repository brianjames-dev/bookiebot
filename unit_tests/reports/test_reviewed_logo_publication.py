"""Reviewed artwork must reach the runtime catalog without unrelated changes."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return json.loads((ROOT / path).read_text())


def test_latest_reviewed_logos_are_the_exact_published_assets():
    publication = read('docs/logo-review/publications/2026-11-02-reviewed-logos.json')
    expected = {'company:pge', 'company:peacock', 'company:spotify', 'company:state-farm',
                'merchant:usps', 'merchant:walmart', 'merchant:trader-joes',
                'merchant:whole-foods', 'merchant:safeway', 'merchant:panda-express', 'merchant:amazon'}
    assert {item['key'] for item in publication['changes']} == expected
    assert publication['approval']['channel'] == 'chat' and publication['approval']['context']
    for change in publication['changes']:
        batch = read(change['batch'])
        reviewed = next(item for item in batch['items'] if item['key'] == change['key'])
        latest = reviewed['candidates'][-1]
        assert reviewed['status'] == 'approved'
        assert latest['sha256'] == reviewed['approvedSha256'] == change['sha256']
        candidate = ROOT / change['candidate']
        assert candidate == (ROOT / change['batch']).parent / latest['asset']
        data = candidate.read_bytes()
        assert data == (ROOT / change['asset']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == change['sha256']
        kind, id = change['key'].split(':')
        runtime = next(item for item in read(f'web/expense-report/src/{kind}-logos.json') if item['id'] == id)
        assert Path(change['asset']).name == runtime['asset']
        assert runtime['asset'] != change['previous']['asset']
        assert (ROOT / 'src/bookiebot/reports/assets' / change['previous']['asset']).is_file()
        if kind == 'merchant':
            assert runtime['inset'] == 0
            assert runtime['background'] == change['background']
        else:
            assert runtime['preparedCircle'] is True


def test_publication_preserves_other_catalog_art_and_only_adds_named_starbucks_alias():
    changed = {item['key'] for item in read('docs/logo-review/publications/2026-11-02-reviewed-logos.json')['changes']}
    snapshot = read('docs/logo-review/batches/2026-11-02-first-refinement/inventory.json')
    catalogs = {kind: {item['id']: item for item in read(f'web/expense-report/src/{kind}-logos.json')}
                for kind in ['company', 'merchant']}
    assert len(snapshot['items']) == sum(map(len, catalogs.values())) == 247
    for item in snapshot['items']:
        active = catalogs[item['kind']][item['id']]
        aliases = [*item['aliases'], 'Starbucks Coffee Company'] if item['key'] == 'merchant:starbucks' else item['aliases']
        assert active['aliases'] == aliases
        assert active['name'] == item['name']
        if item['key'] not in changed:
            assert active['asset'] == Path(item['asset']).name
            data = (ROOT / item['asset']).read_bytes()
            assert hashlib.sha256(data).hexdigest() == item['sha256']
            if item['kind'] == 'merchant':
                assert active['inset'] == item['inset'] and active['background'] == item['background']
