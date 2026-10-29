import type { ReactNode } from "react"
import { SlidingSelection } from "./components/ui/motion"

export function ReportHeader({ month, projected, onToggle, controls, disabled = false, hidden = false }: {
  month: ReactNode; projected: boolean; onToggle: () => void; controls: ReactNode; disabled?: boolean; hidden?: boolean
}) {
  return <header className="bb-page-header bb-report-header" hidden={hidden}>
    <h1 className="bb-report-context">{month}</h1>
    <div className="bb-header-actions">
      <SlidingSelection value={Number(projected)} className="bb-projection-control" role="group" aria-label="Report view" data-bb-tooltip-dismiss-trigger="projection">
        <button type="button" className="bb-metric-toggle" aria-pressed={!projected} disabled={disabled} onClick={() => { if (projected) onToggle() }}>Current</button>
        <button type="button" className="bb-metric-toggle" aria-pressed={projected} disabled={disabled} onClick={() => { if (!projected) onToggle() }}>Projected</button>
      </SlidingSelection>
    </div>
    {controls}
  </header>
}
