import { memo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type PointerEvent } from "react"
import { Glass, Tabbar, TabbarLink } from "konsta/react"
import { ClipboardCheck, House, PiggyBank, ReceiptText, Users } from "lucide-react"
import { screenTitles, type AppNavigationStore, type MainScreen } from "./app-navigation"
import { useNavigationLens } from "./navigation-lens"
import { GlassIcon } from "./glass-icon"

const screens = [
  { id: "overview", Icon: House }, { id: "transactions", Icon: ReceiptText },
  { id: "shared", Icon: Users }, { id: "savings", Icon: PiggyBank },
  { id: "reconcile", Icon: ClipboardCheck },
] as const

// Solid counterparts preserve the outline icons' silhouettes. Even-odd cutouts
// keep their details transparent over the glass rather than painting a backdrop.
function NavigationIcon({ id, selected }: { id: MainScreen; selected: boolean }) {
  const Icon = screens.find(screen => screen.id === id)!.Icon
  return <GlassIcon selected={selected} outline={<Icon strokeWidth={1.7} data-variant="outline" />} solid={<svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd" data-variant="filled">
    {id === "overview" && <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 13v8h4v-8z" />}
    {id === "transactions" && <path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1zM7.5 7.2v1.6h7V7.2zM7.5 11.2v1.6h9v-1.6zM7.5 15.2v1.6h6v-1.6z" />}
    {id === "shared" && <>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 19a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2H2zM16 3.128a4 4 0 0 1 0 7.744zM18 15.13A4 4 0 0 1 22 19v2h-4v-2a6 6 0 0 0-1.2-3.6z" />
    </>}
    {id === "savings" && <>
      <path d="M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1zM16.9 10a.9.9 0 1 0-1.8 0 .9.9 0 1 0 1.8 0M9 7v1.4h4.5V7z" />
      <path d="M2 8v1a2 2 0 0 0 2 2h1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>}
    {id === "reconcile" && <path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1M6 4h.5v1a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 17.5 5V4h.5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M8.4 13.4l2.6 2.6 4.6-4.6 1.1 1.1-5.7 5.7-3.7-3.7z" />}
  </svg>} />
}

// Keep native button semantics; Konsta otherwise assigns role="link".
function NavigationButton(props: ComponentProps<"button">) {
  return <button {...props} role={undefined} />
}

export const AppNavigationDock = memo(function AppNavigationDock({ navigation, expanded, ...props }: {
  navigation: AppNavigationStore
  expanded: boolean
  reconciliationVisible: boolean
  hidden: boolean
  disabled: boolean
  onSelect: (screen: MainScreen) => void
}) {
  const selected = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  return <AppNavigationBar {...props} active={selected.main} current={selected.screen === "settings" ? null : selected.screen}
    compact={selected.compact && !expanded} />
})

export function AppNavigationBar({ active, current = active, compact, reconciliationVisible, hidden, disabled = false, onSelect }: {
  active: MainScreen
  current?: MainScreen | null
  compact: boolean
  reconciliationVisible: boolean
  hidden?: boolean
  disabled?: boolean
  onSelect: (screen: MainScreen) => void
}) {
  const [preview, setPreview] = useState<MainScreen | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const lens = useNavigationLens(paneRef, preview ?? active)
  const pointer = useRef<{ id: number; x: number; y: number; selected: MainScreen | null } | null>(null)
  const suppressClick = useRef(false)
  const tabs = reconciliationVisible ? screens : screens.slice(0, 4)
  const screenAt = (clientX: number): MainScreen | null => {
    const buttons = paneRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav-screen]")
    if (!buttons?.length) return null
    // Hit-test actual equal-width targets, including their outer edges.
    const button = [...buttons].find(button => clientX < button.getBoundingClientRect().right) ?? buttons[buttons.length - 1]
    return button.dataset.navScreen as MainScreen
  }
  const finishPointer = () => {
    if (!pointer.current) return
    pointer.current = null; setPreview(null); lens.release()
  }
  const startPointer = (event: PointerEvent<HTMLElement>) => {
    suppressClick.current = false
    if (disabled) return
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return
    const target = (event.target as Element).closest("button[data-nav-screen]") as HTMLElement | null
    const selected = (target?.dataset.navScreen as MainScreen | undefined) ?? screenAt(event.clientX)
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, selected }
    setPreview(selected)
    lens.start(event.clientX, event.clientY)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  return <Tabbar top component="nav" icons className="bb-bottom-navigation" aria-label="Main navigation"
    data-compact={compact} data-tab-count={tabs.length} hidden={hidden}>
    <Glass ref={paneRef} highlight={false} className="bb-navigation-pane bb-glass-control"
      style={{ "--bb-nav-count": tabs.length, "--bb-nav-position": Math.max(0, tabs.findIndex(tab => tab.id === (preview ?? active))) / tabs.length } as CSSProperties}
      onPointerDown={startPointer}
      onPointerMove={event => {
        const current = pointer.current
        if (!current || current.id !== event.pointerId || (current.x === event.clientX && current.y === event.clientY)) return
        if (current.x !== event.clientX) current.selected = screenAt(event.clientX)
        current.x = event.clientX; current.y = event.clientY
        lens.move(event.clientX, event.clientY)
        setPreview(current.selected)
      }}
      onPointerUp={event => {
        const current = pointer.current
        if (!current || current.id !== event.pointerId) return
        // Glass can scale while pressed. A stationary tap keeps its original
        // target; only real finger travel changes the preview/release choice.
        const selected = current.x === event.clientX ? current.selected : screenAt(event.clientX)
        finishPointer()
        suppressClick.current = true
        if (selected && !disabled) onSelect(selected)
      }}
      onPointerCancel={finishPointer} onLostPointerCapture={finishPointer}
      onClickCapture={event => {
        if (suppressClick.current && event.detail !== 0) {
          suppressClick.current = false
          event.preventDefault()
          event.stopPropagation()
        }
      }}>
      <span className="bb-navigation-cursor" aria-hidden="true"><span className="bb-selection-indicator bb-navigation-selection"><span className="bb-navigation-lens-surface" /></span></span>
      {tabs.map(({ id }) => <TabbarLink key={id} component={NavigationButton} linkProps={{ type: "button", disabled }} className="bb-navigation-link"
        active={active === id} data-state={(preview ?? active) === id ? "active" : "inactive"} data-nav-screen={id}
        aria-label={screenTitles[id]} aria-current={current === id ? "page" : undefined}
        icon={<NavigationIcon id={id} selected={active === id} />} onClick={() => { if (!disabled) onSelect(id) }} />)}
    </Glass>
  </Tabbar>
}
