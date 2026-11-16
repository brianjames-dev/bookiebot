import type { ReactNode, Ref } from "react"
import { MessageCircle } from "lucide-react"
import { SlidingSelection } from "./components/ui/motion"

export interface PortraitChatProps {
  onChat?: () => void; chatRef?: Ref<HTMLButtonElement>; chatOpen?: boolean; chatDisabled?: boolean
}

export function BookieBotPortrait({avatarUrl, onChat, chatRef, chatOpen, chatDisabled}: PortraitChatProps & {avatarUrl?: string}) {
  const portrait = avatarUrl ? <img className="bb-app-avatar" src={avatarUrl} alt="" /> : <span className="bb-wordmark-symbol" aria-hidden="true">b.</span>
  return onChat ? <button ref={chatRef} type="button" className="bb-chat-portrait" aria-label="Talk to BookieBot"
    aria-haspopup="dialog" aria-expanded={Boolean(chatOpen)} disabled={chatDisabled} onClick={onChat}>
    {portrait}<span className="bb-chat-portrait-badge" aria-hidden="true"><MessageCircle strokeWidth={1.8}/></span>
  </button> : portrait
}

export function ReportBrand({owner, avatarUrl, status, statusHidden = false, ...chat}: {
  owner: string; avatarUrl?: string; status: ReactNode; statusHidden?: boolean
} & PortraitChatProps) {
  return <div className="bb-report-brand">
    <BookieBotPortrait avatarUrl={avatarUrl} {...chat}/>
    <div className="bb-brand-copy">
      <span className="bb-wordmark">BookieBot{owner !== "BookieBot" && <span className="bb-report-owner"><span aria-hidden="true">•</span>{" "}{owner}</span>}</span>
      <div className="bb-brand-status" hidden={statusHidden}>{status}</div>
    </div>
  </div>
}

export function ReportHeader({ month, projected, onToggle, controls, disabled = false, hidden = false, showViewControl = true }: {
  month: ReactNode; projected: boolean; onToggle: () => void; controls?: ReactNode; disabled?: boolean; hidden?: boolean; showViewControl?: boolean
}) {
  return <header className="bb-page-header bb-report-header" hidden={hidden}>
    <h1 className="bb-report-context" id="bb-main-page-title">{typeof month === "string" ? month.replace(/\s+\d{4}\s*$/, "") : month}</h1>
    <div className="bb-header-actions" hidden={!showViewControl}>
      <SlidingSelection value={Number(projected)} className="bb-projection-control" role="group" aria-label="Report view" data-bb-tooltip-dismiss-trigger="projection">
        <button type="button" className="bb-metric-toggle" aria-pressed={!projected} disabled={disabled} onClick={() => { if (projected) onToggle() }}>Current</button>
        <button type="button" className="bb-metric-toggle" aria-pressed={projected} disabled={disabled} onClick={() => { if (!projected) onToggle() }}>Projected</button>
      </SlidingSelection>
    </div>
    {controls}
  </header>
}
