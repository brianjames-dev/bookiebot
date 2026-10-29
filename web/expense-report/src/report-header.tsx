import type { ReactNode } from "react"
import { SlidingSelection } from "./components/ui/motion"

export function ReportBrand({owner, avatarUrl, status, statusHidden = false}: {
  owner: string; avatarUrl?: string; status: ReactNode; statusHidden?: boolean
}) {
  return <div className="bb-report-brand">
    {avatarUrl ? <img className="bb-app-avatar" src={avatarUrl} alt="" /> : <span className="bb-wordmark-symbol" aria-hidden="true">b.</span>}
    <div className="bb-brand-copy">
      <span className="bb-wordmark">BookieBot{owner !== "BookieBot" && <span className="bb-report-owner"><span aria-hidden="true">•</span>{" "}{owner}</span>}</span>
      <div className="bb-brand-status" hidden={statusHidden}>{status}</div>
    </div>
  </div>
}

export function ReportHeader({ month, projected, onToggle, controls, disabled = false, hidden = false }: {
  month: ReactNode; projected: boolean; onToggle: () => void; controls?: ReactNode; disabled?: boolean; hidden?: boolean
}) {
  return <header className="bb-page-header bb-report-header" hidden={hidden}>
    <h1 className="bb-report-context">{typeof month === "string" ? month.replace(/\s+\d{4}\s*$/, "") : month}</h1>
    <div className="bb-header-actions">
      <SlidingSelection value={Number(projected)} className="bb-projection-control" role="group" aria-label="Report view" data-bb-tooltip-dismiss-trigger="projection">
        <button type="button" className="bb-metric-toggle" aria-pressed={!projected} disabled={disabled} onClick={() => { if (projected) onToggle() }}>Current</button>
        <button type="button" className="bb-metric-toggle" aria-pressed={projected} disabled={disabled} onClick={() => { if (!projected) onToggle() }}>Projected</button>
      </SlidingSelection>
    </div>
    {controls}
  </header>
}
