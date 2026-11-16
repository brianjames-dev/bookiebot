import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react"
import { Glass, Toolbar } from "konsta/react"
import { ChevronLeft, Settings } from "lucide-react"
import { BookieBotPortrait } from "./report-header"
import { GlassIcon } from "./glass-icon"
import { useGlassContact } from "./glass-contact"

function ToolSurface({ disabled, children, className="" }: { disabled: boolean; children: ReactNode; className?:string }) {
  const ref = useRef<HTMLDivElement>(null), pointer = useRef<number | null>(null)
  const contact = useGlassContact(ref)
  const release = () => { pointer.current = null; contact.release() }
  useLayoutEffect(() => { if (disabled) release() }, [disabled])
  return <Glass ref={ref} highlight={false} className={`bb-shell-toolbar-pane bb-glass-control ${className}`}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || pointer.current !== null) return
      pointer.current = event.pointerId; contact.start(event.clientX, event.clientY)
    }}
    onPointerMove={event => { if (pointer.current === event.pointerId) contact.move(event.clientX, event.clientY) }}
    onPointerUp={event => { if (pointer.current === event.pointerId) release() }}
    onPointerCancel={event => { if (pointer.current === event.pointerId) release() }}
    onPointerLeave={event => { if (pointer.current === event.pointerId) release() }}
    onKeyDown={event => { if (!disabled && !event.repeat && (event.key === " " || event.key === "Enter")) contact.start() }}
    onKeyUp={event => { if (event.key === " " || event.key === "Enter") release() }}
    onBlur={release}>{children}</Glass>
}

export function AppHeaderTools({ askRef, askOpen, settingsOpen, askDisabled, settingsDisabled, onAsk, onSettings, avatarUrl, showPortrait = false }: {
  askRef?: Ref<HTMLButtonElement>
  askOpen: boolean
  settingsOpen: boolean
  askDisabled: boolean
  settingsDisabled: boolean
  onAsk: () => void
  onSettings: () => void
  avatarUrl?: string
  showPortrait?: boolean
}) {
  return <Toolbar top className="bb-shell-header-actions" data-has-portrait={showPortrait || undefined} role="group" aria-label="BookieBot tools" innerClassName="bb-shell-toolbar-inner">
    {showPortrait && <BookieBotPortrait avatarUrl={avatarUrl} chatRef={askRef} chatOpen={askOpen} chatDisabled={askDisabled} onChat={onAsk}/>}
    <ToolSurface disabled={settingsDisabled}>
      <button type="button" className="bb-shell-icon" aria-label="Settings" aria-current={settingsOpen ? "page" : undefined} disabled={settingsDisabled} onClick={onSettings}>
        <GlassIcon selected={settingsOpen} outline={<Settings strokeWidth={1.7} />} solid={<svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z" /></svg>} />
      </button>
    </ToolSurface>
  </Toolbar>
}

export function AppHeaderBack({onBack, disabled, label}: {onBack:()=>void; disabled:boolean;label?:string}) {
  return <ToolSurface disabled={disabled} className={label?'bb-settings-title-pane':''}><button type="button" className={`bb-shell-icon${label?' bb-settings-back-capsule':''}`} aria-label="Back" disabled={disabled} onClick={onBack}><ChevronLeft strokeWidth={1.7} aria-hidden="true" />{label&&<span aria-hidden="true">{label}</span>}</button></ToolSurface>
}
