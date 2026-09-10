from pathlib import Path
import subprocess
import pytest


@pytest.mark.parametrize('script', ['report_activity_test.cjs', 'fixed_bill_presentation_test.cjs'])
def test_report_activity_drilldowns_and_source_distinctions(script):
    root = Path(__file__).resolve().parents[2]
    if not (root / 'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install frontend dependencies for executed UI checks')
    subprocess.run(['node', f'unit_tests/reports/{script}'], cwd=root, check=True, capture_output=True, text=True)
