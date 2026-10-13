"""Layout migrations preserve saved income action lineage."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('configure_espp', Path(__file__).resolve().parents[2] / 'scripts/configure_espp.py')
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_inline_migration_shifts_income_coordinates_only():
    action = {'worksheet': 'income', 'row': 12, 'kind': 'restore_row',
              'previous_values': ['', '10/9/2026', 'xAI', '4555.68'],
              'metadata': {'source_row': '12', 'income_header_row': '7', 'income_summary_row': '13',
                           'income_row_properties': '{"cells":[{},{},{}]}', 'other': '7'}}
    result = module.shifted_income_action(action, 7, 1)
    assert result['row'] == 13
    assert {key: result['metadata'][key] for key in ('source_row', 'income_header_row', 'income_summary_row')} == {
        'source_row': '13', 'income_header_row': '8', 'income_summary_row': '14'}
    assert result['previous_values'] == action['previous_values']
    assert result['metadata']['income_row_properties'] == action['metadata']['income_row_properties']
    assert result['metadata']['other'] == '7'
    assert action['row'] == 12
    assert module.shifted_income_action({'worksheet': 'expense', 'row': 12}, 7, 1)['row'] == 12
