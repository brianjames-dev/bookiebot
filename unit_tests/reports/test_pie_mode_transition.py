from pathlib import Path
import shutil
import subprocess

import pytest


def test_category_pie_focus_uses_the_slice_stroke_without_a_selection_box():
    root = Path(__file__).resolve().parents[2]
    styles = (root / "web/expense-report/src/styles.css").read_text()
    chart_focus = styles.split('.bb-chart-box svg [role="button"]:focus-visible {', 1)[1].split("}", 1)[0]
    pie_focus = styles.split('.bb-category-chart-box svg [role="button"]:focus-visible {', 1)[1].split("}", 1)[0]

    # Safari may retain :focus-visible for touch and after restoring dialog
    # focus. Its SVG outline is rectangular; a sector stroke follows the data.
    assert "outline: none !important;" in pie_focus
    assert "stroke:hsl(var(--foreground));" in chart_focus
    assert "stroke-width:3px;" in chart_focus


def test_category_pie_survives_mode_and_filter_transitions():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/react-test-renderer").exists():
        pytest.skip("Install the report frontend dependencies for UI contracts")
    subprocess.run(
        ["node", str(Path(__file__).with_name("pie_mode_transition_test.cjs"))],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


def test_category_mix_native_scope_and_full_width_layout():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/react-test-renderer").exists():
        pytest.skip("Install the report frontend dependencies for UI contracts")
    subprocess.run(
        ["node", str(Path(__file__).with_name("category_mix_layout_test.cjs"))],
        cwd=root, check=True, capture_output=True, text=True,
    )


def test_original_chart_animations_reuse_shapes_on_animation_frames():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/react-test-renderer").exists():
        pytest.skip("Install the report frontend dependencies for UI contracts")
    subprocess.run(
        ["node", str(Path(__file__).with_name("chart_animation_work_test.cjs"))],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize("script", ["category_mix_contour_test.cjs", "category_mix_worker_test.cjs"])
def test_refined_flow_fits_live_category_rows_and_keeps_stems_separate(script):
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the report frontend dependencies for geometry contracts")
    subprocess.run(["node", str(Path(__file__).with_name(script))],
                   cwd=root, check=True, capture_output=True, text=True)
