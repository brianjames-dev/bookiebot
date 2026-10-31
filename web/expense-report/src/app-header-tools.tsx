import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react"
import { Glass, Toolbar } from "konsta/react"
import { MessageCircle, Settings } from "lucide-react"
import { GlassIcon } from "./glass-icon"
import { useGlassContact } from "./glass-contact"

function ToolSurface({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), pointer = useRef<number | null>(null)
  const contact = useGlassContact(ref)
  const release = () => { pointer.current = null; contact.release() }
  useLayoutEffect(() => { if (disabled) release() }, [disabled])
  return <Glass ref={ref} highlight={false} className="bb-shell-toolbar-pane bb-glass-control"
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

export function AppHeaderTools({ askRef, askOpen, settingsOpen, askDisabled, settingsDisabled, onAsk, onSettings }: {
  askRef?: Ref<HTMLButtonElement>
  askOpen: boolean
  settingsOpen: boolean
  askDisabled: boolean
  settingsDisabled: boolean
  onAsk: () => void
  onSettings: () => void
}) {
  return <Toolbar top className="bb-shell-header-actions" role="group" aria-label="BookieBot tools" innerClassName="bb-shell-toolbar-inner">
    <ToolSurface disabled={askDisabled}>
      <button ref={askRef} type="button" className="bb-shell-icon" aria-label="Ask BookieBot" aria-haspopup="dialog" aria-expanded={askOpen} disabled={askDisabled} onClick={onAsk}>
        <GlassIcon selected={askOpen} outline={<MessageCircle strokeWidth={1.7} />} solid={<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719Z" /></svg>} />
      </button>
    </ToolSurface>
    <ToolSurface disabled={settingsDisabled}>
      <button type="button" className="bb-shell-icon" aria-label="Settings" aria-current={settingsOpen ? "page" : undefined} disabled={settingsDisabled} onClick={onSettings}>
        <GlassIcon selected={settingsOpen} outline={<Settings strokeWidth={1.7} />} solid={<svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z" /></svg>} />
      </button>
    </ToolSurface>
  </Toolbar>
}
