import subprocess
from pathlib import Path

import pytest


def test_metric_measurement_copy_cannot_widen_the_document():
    styles = (Path(__file__).resolve().parents[2] / "web/expense-report/src/styles.css").read_text()
    measurement_box = styles.split(".bb-fitted-amount-measure-box {", 1)[1].split("}", 1)[0]
    assert "inset: 0;" in measurement_box
    assert "overflow: hidden;" in measurement_box
    # Only the invisible measurement copy is clipped; the real value is fitted.
    for selector in (".bb-fitted-amount {", ".bb-fitted-amount-text {"):
        assert "overflow:" not in styles.split(selector, 1)[1].split("}", 1)[0]


def test_metric_amounts_refit_complete_values_for_container_font_and_zoom_changes():
    frontend = Path(__file__).resolve().parents[2] / "web/expense-report"
    if not (frontend / "node_modules/typescript").exists():
        pytest.skip("Install expense-report npm dependencies to execute the frontend fitting regression")
    subprocess.run(
        ["node", "unit_tests/reports/metric_fitting_test.cjs"],
        check=True,
        capture_output=True,
        text=True,
    )
