import { useRef, useState, type ComponentProps, type PointerEvent } from "react"
import { Glass, Tabbar, TabbarLink } from "konsta/react"
import { House, ListChecks, PiggyBank, ReceiptText, Users } from "lucide-react"
import { fitNavigationSelection, screenTitles, type MainScreen } from "./app-navigation"
import { useSlidingSelection } from "./components/ui/motion"

const screens = [
  { id: "overview", Icon: House }, { id: "transactions", Icon: ReceiptText },
  { id: "shared", Icon: Users }, { id: "savings", Icon: PiggyBank },
  { id: "reconcile", Icon: ListChecks },
] as const

// Keep native button semantics; Konsta otherwise assigns role="link".
function NavigationButton(props: ComponentProps<"button">) {
  return <button {...props} role={undefined} />
}

function selectionBounds(button: HTMLElement) {
  const content = button.firstElementChild as HTMLElement
  const pane = button.parentElement!
  const frame = pane.getBoundingClientRect()
  const style = getComputedStyle(pane)
  // Preserve subpixel positions, normalizing Konsta's touch/hover scale.
  const scaleX = frame.width / parseFloat(style.width) || 1
  const scaleY = frame.height / parseFloat(style.height) || 1
  const target = button.getBoundingClientRect()
  const stack = content.getBoundingClientRect()
  // Fit the icon/label stack with 6px padding, within the button's own track.
  return fitNavigationSelection({ x: (target.x - frame.x) / scaleX, y: (target.y - frame.y) / scaleY, width: target.width / scaleX, height: target.height / scaleY },
    { width: stack.width / scaleX, height: stack.height / scaleY })
}

export function AppNavigationBar({ active, current = active, compact, reconciliationVisible, hidden, onSelect }: {
  active: MainScreen
  current?: MainScreen | null
  compact: boolean
  reconciliationVisible: boolean
  hidden?: boolean
  onSelect: (screen: MainScreen) => void
}) {
  const [preview, setPreview] = useState<MainScreen | null>(null)
  const paneRef = useSlidingSelection(preview ?? active, selectionBounds)
  const pointer = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const tabs = reconciliationVisible ? screens : screens.slice(0, 4)
  const screenAt = (clientX: number): MainScreen | null => {
    const buttons = paneRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav-screen]")
    if (!buttons?.length) return null
    // Use the actual button edges, including the wider Transactions target.
    const button = [...buttons].find(button => clientX < button.getBoundingClientRect().right) ?? buttons[buttons.length - 1]
    return button.dataset.navScreen as MainScreen
  }
  const finishPointer = () => { pointer.current = null; setPreview(null) }
  const startPointer = (event: PointerEvent<HTMLElement>) => {
    suppressClick.current = false
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return
    pointer.current = event.pointerId
    setPreview(screenAt(event.clientX))
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  return <Tabbar top component="nav" icons labels className="bb-bottom-navigation" aria-label="Main navigation"
    data-compact={compact} data-tab-count={tabs.length} hidden={hidden}>
    <Glass ref={paneRef} className="bb-navigation-pane bb-sliding-selection"
      onPointerDown={startPointer}
      onPointerMove={event => { if (pointer.current === event.pointerId) setPreview(screenAt(event.clientX)) }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return
        const selected = screenAt(event.clientX)
        finishPointer()
        suppressClick.current = true
        if (selected) onSelect(selected)
      }}
      onPointerCancel={finishPointer} onLostPointerCapture={finishPointer}
      onClickCapture={event => {
        if (suppressClick.current && event.detail !== 0) {
          suppressClick.current = false
          event.preventDefault()
          event.stopPropagation()
        }
      }}>
      <span className="bb-selection-indicator bb-navigation-selection" aria-hidden="true" />
      {tabs.map(({ id, Icon }) => <TabbarLink key={id} component={NavigationButton} linkProps={{ type: "button" }} className="bb-navigation-link"
        active={active === id} data-state={(preview ?? active) === id ? "active" : "inactive"} data-nav-screen={id}
        aria-label={screenTitles[id]} aria-current={current === id ? "page" : undefined}
        label={screenTitles[id]} icon={<Icon size={23} strokeWidth={1.7} aria-hidden="true" />} onClick={() => onSelect(id)} />)}
    </Glass>
  </Tabbar>
}
