import { useRef, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowRightLeft, Bell, ChevronRight, Contrast, Info, LayoutGrid, ReceiptText, UserRound, UsersRound } from "lucide-react"
import "./settings-directory.css"

export const settingsSections = {
  account: { title: "Account", icon: UserRound, tone: "blue" },
  household: { title: "Household", icon: UsersRound, tone: "blue" },
  bills: { title: "Bills", icon: ReceiptText, tone: "sage" },
  transfers: { title: "Transfers", icon: ArrowRightLeft, tone: "sage" },
  appearance: { title: "Appearance", icon: Contrast, tone: "violet" },
  notifications: { title: "Notifications", icon: Bell, tone: "amber" },
  widgets: { title: "Widgets", icon: LayoutGrid, tone: "blue" },
  about: { title: "About & updates", icon: Info, tone: "violet" },
} as const

export type SettingsSection = keyof typeof settingsSections

const groups: { label: string; sections: SettingsSection[] }[] = [
  { label: "Your account", sections: ["account", "household"] },
  { label: "Budget", sections: ["bills", "transfers"] },
  { label: "App", sections: ["appearance", "notifications", "widgets", "about"] },
]
const minSidebar = 28
const maxSidebar = 48

export const SettingsInitial = ({ owner }: { owner: string }) =>
  <span className="bb-settings-initial" aria-hidden="true">{Array.from(owner.trim())[0]?.toLocaleUpperCase()}</span>

export function SettingsDetailHeading({ section, title = settingsSections[section].title }: { section: SettingsSection; title?: string }) {
  const { icon: Icon, tone } = settingsSections[section]
  return <h2 className="bb-settings-detail-heading" tabIndex={-1}>
    <span className="bb-settings-category-icon" data-tone={tone}><Icon aria-hidden="true" /></span>{title}
  </h2>
}

export function SettingsDirectory({ wide, active, section, owner, dark, householdEnabled, blocked, onSelect, children }: {
  wide: boolean; active: boolean; section: SettingsSection | null; owner: string; dark: boolean
  householdEnabled: boolean; blocked: boolean; onSelect: (section: SettingsSection) => void; children: ReactNode
}) {
  const workspace = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ id: number; startX: number; startWidth: number } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(39)
  const resize = (value: number) => setSidebarWidth(Math.round(Math.max(minSidebar, Math.min(maxSidebar, value))))

  return <div ref={workspace} className="bb-settings-workspace" hidden={!active}
    style={{ "--bb-settings-sidebar-width": `${sidebarWidth}%` } as CSSProperties}>
    <div className="bb-settings-sidebar" hidden={!wide && section !== null} role={wide ? undefined : "main"} aria-label={wide ? undefined : "Settings"}>
      <nav className="bb-settings-index" aria-label="Settings categories">
        {groups.map(({ label, sections }) => <section key={label} className="bb-settings-index-group" aria-label={label}>
          {label !== "Your account" && <h2>{label}</h2>}
          <ul>{sections.filter(key => key !== "household" || householdEnabled).map(key => {
            const { title, icon: Icon, tone } = settingsSections[key]
            return <li key={key}>
              <button type="button" className="bb-settings-category" data-settings-section={key}
                aria-label={title} aria-current={wide && section === key ? "page" : undefined}
                disabled={blocked && key !== section} onClick={() => onSelect(key)}>
                {key === "account" ? <SettingsInitial owner={owner} /> : <span className="bb-settings-category-icon" data-tone={tone}><Icon aria-hidden="true" /></span>}
                <span className="bb-settings-category-name">
                  {key === "account" ? <><strong>{owner}</strong><small>BookieBot account</small></> : title}
                </span>
                {key === "appearance" && <small className="bb-settings-category-value">{dark ? "Dark" : "Light"}</small>}
                <ChevronRight className="bb-settings-category-chevron" aria-hidden="true" />
              </button>
            </li>
          })}</ul>
        </section>)}
      </nav>
    </div>
    {wide && <div className="bb-settings-divider" role="separator" tabIndex={0}
      aria-label="Settings sidebar width" aria-controls="bb-settings-detail" aria-orientation="vertical"
      aria-valuemin={minSidebar} aria-valuemax={maxSidebar} aria-valuenow={sidebarWidth} aria-valuetext={`${sidebarWidth}%`}
      onPointerDown={event => {
        if (event.button !== 0 || pointer.current) return
        event.preventDefault()
        event.currentTarget.blur()
        pointer.current = { id: event.pointerId, startX: event.clientX, startWidth: sidebarWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const start = pointer.current, width = workspace.current?.clientWidth
        if (start?.id === event.pointerId && width) resize(start.startWidth + (event.clientX - start.startX) / width * 100)
      }}
      onLostPointerCapture={() => { pointer.current = null }}
      onKeyDown={event => {
        const sizes: Record<string, number> = { ArrowLeft: sidebarWidth - 2, ArrowRight: sidebarWidth + 2, Home: minSidebar, End: maxSidebar }
        if (!Object.prototype.hasOwnProperty.call(sizes, event.key)) return
        event.preventDefault()
        resize(sizes[event.key])
      }} />}
    <div className="bb-settings-detail" id="bb-settings-detail" hidden={section === null}>{children}</div>
  </div>
}
