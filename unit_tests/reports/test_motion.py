from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "web/expense-report/src"


@pytest.mark.parametrize("script", ["motion_test.cjs", "modal_motion_test.cjs"])
def test_disclosure_and_modal_motion_lifecycle(script):
    if not (ROOT / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the expense-report frontend dependencies to execute disclosure regression checks")
    subprocess.run(
        ["node", f"unit_tests/reports/{script}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def test_live_details_and_expanded_lists_use_the_shared_disclosure_content():
    source = (FRONTEND / "report-app.tsx").read_text()
    details = source.split("function DetailsPanel", 1)[1].split("function useModalPageScrollLock", 1)[0]
    hidden_list = source.split("function HiddenListPanel", 1)[1].split("function AmountTable", 1)[0]

    assert "<CollapsibleContent open={open}" in details
    assert "<CollapsibleContent open={expanded}" in hidden_list


def test_modal_exit_keeps_native_dialog_and_scroll_lock_until_motion_finishes():
    source = (FRONTEND / "report-app.tsx").read_text()
    modal = source.split("function ModalDetails", 1)[1].split("function ExpandRowsButton", 1)[0]
    close = modal.split("const close =", 1)[1].split("const modal =", 1)[0]
    cancel = modal.split("onCancel={", 1)[1].split("onClose=", 1)[0]
    transition = modal.split("onTransitionEnd={", 1)[1].split("bb-details-dialog-header", 1)[0]

    # Escape/close must request an exit, not let the browser remove the dialog
    # immediately. Native focus trapping and scroll lock last through that exit.
    assert 'const open = phase !== "closed"' in modal
    assert "useModalPageScrollLock(open)" in modal
    assert '"closing"' in close
    assert "dialog.close()" not in close
    assert "event.preventDefault()" in cancel
    assert "close()" in cancel
    assert 'phase === "closed" && dialog.open' in modal
    assert "event.target === event.currentTarget" in transition
    assert 'event.propertyName === "opacity"' in transition
    assert 'phase === "closing"' in transition
    # A fallback must release the dialog when CSS transitions are disabled.
    assert "window.setTimeout" in modal
    assert "window.clearTimeout" in modal
    assert "prefers-reduced-motion" in modal


def test_modal_surface_and_shade_animate_inside_a_stable_native_top_layer():
    styles = (FRONTEND / "styles.css").read_text()
    host = styles.split(".bb-details-dialog {", 1)[1].split("}", 1)[0]
    backdrop = styles.split(".bb-details-dialog::backdrop {", 1)[1].split("}", 1)[0]
    shade = styles.split(".bb-details-dialog-shade {", 1)[1].split("}", 1)[0]
    surface = styles.split(".bb-details-dialog-surface {", 1)[1].split("}", 1)[0]

    # Native top-layer/blur removal must not repaint a still-visible overlay.
    assert "transform:" not in host
    assert "transition:" not in host
    assert "background: transparent" in backdrop
    assert "backdrop-filter" not in backdrop
    assert "opacity var(--bb-motion-duration) var(--bb-motion-ease)" in shade
    assert "opacity var(--bb-motion-duration) var(--bb-motion-ease)" in surface


def test_line_coordinates_follow_disclosure_resize_without_a_second_animation():
    source = (FRONTEND / "report-app.tsx").read_text()
    for start, end in [
        ("function BillsUtilitiesChart(", "function billsUtilitiesEvents("),
        ("function BurnRateChart(", "function BurnRateInfoButton("),
    ]:
        chart = source.split(start, 1)[1].split(end, 1)[0]
        line = chart.split("<Line\n", 1)[1].split("/>", 1)[0]
        assert "isAnimationActive={false}" in line
        assert "animationDuration" not in line


def test_chart_tooltip_entry_reuses_exit_motion_without_resetting_retained_content():
    source = (FRONTEND / "components/ui/chart.tsx").read_text()
    styles = (FRONTEND / "styles.css").read_text()
    frame = source.split("const ChartTooltipMotionFrame", 1)[1].split("function ChartTooltipAutoDismissContent", 1)[0]
    lifecycle = source.split("function ChartTooltipAutoDismissContent", 1)[1].split("function chartTooltipSignature", 1)[0]
    frame_use = lifecycle.split("<ChartTooltipMotionFrame", 1)[1].split("</ChartTooltipMotionFrame>", 1)[0]

    # Each newly mounted frame starts hidden, with a cancellable paint boundary.
    # A retained frame must not restart its entrance when its data point changes.
    assert "React.useState(false)" in frame
    assert "window.requestAnimationFrame" in frame
    assert "window.cancelAnimationFrame" in frame
    assert "prefers-reduced-motion" in frame
    assert '!entered && "bb-chart-tooltip-frame-entering"' in frame
    assert ".bb-chart-tooltip-frame-entering,\n.bb-chart-tooltip-frame-dismissing {" in styles
    assert 'dismissing={phase === "dismissing"}' in frame_use
    assert "key=" not in frame_use
    assert "React.cloneElement(content, renderProps)" in frame_use
    assert 'if (!renderProps || phase === "hidden")' in lifecycle
