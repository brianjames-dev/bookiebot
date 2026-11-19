from pathlib import Path
import subprocess


def test_savings_resource_response_order_and_recovery():
    result = subprocess.run(['node','unit_tests/reports/savings_resource_ui_test.cjs'],cwd=Path(__file__).resolve().parents[2],check=True,capture_output=True,text=True)
    assert 'PASS' in result.stdout


def test_savings_investments_use_current_history_and_isolate_owners():
    result = subprocess.run(['node','unit_tests/reports/savings_investments_ui_test.cjs'],cwd=Path(__file__).resolve().parents[2],check=True,capture_output=True,text=True)
    assert 'PASS' in result.stdout
