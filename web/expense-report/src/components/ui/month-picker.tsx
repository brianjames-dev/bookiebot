import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Popover } from "konsta/react"
import "./month-picker.css"

export type MonthPickerOption = { value: string; label: string }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const validMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

/** A catalog-backed month grid. Choosing a year never requests another report. */
export function MonthPicker({ label, value, options, onSelect, disabled = false, triggerLabel, variant = "compact" }: {
  label: string
  value: string
  options: MonthPickerOption[]
  onSelect: (value: string) => void
  disabled?: boolean
  triggerLabel?: string
  variant?: "title" | "compact"
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const months = new Map(options.filter(option => validMonth(option.value)).map(option => [option.value, option]))
  const years = [...new Set([...months.keys()].map(month => Number(month.slice(0, 4))))].sort((a, b) => a - b)
  const selectedYear = Number(value.slice(0, 4))
  const initialYear = years.includes(selectedYear) ? selectedYear : years[years.length - 1] ?? selectedYear
  const [year, setYear] = useState(initialYear)
  const shownYear = years.includes(year) ? year : initialYear
  const yearIndex = years.indexOf(shownYear)

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }

  useEffect(() => { setOpen(false) }, [value, disabled])
  useLayoutEffect(() => {
    if (!open) return
    // Konsta measures body height, which can exceed the visible viewport on
    // a scrolling report. Keep its floating surface inside the phone viewport.
    const contain = () => {
      const element = popover.current
      const anchor = trigger.current?.getBoundingClientRect()
      if (!element || !anchor) return
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft ?? 0) + 16
      const topEdge = (viewport?.offsetTop ?? 0) + 16
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 32
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 32
      const above = anchor.bottom + 8 + element.offsetHeight > bottomEdge
      const desiredTop = above ? anchor.top - element.offsetHeight - 8 : anchor.bottom + 8
      element.style.setProperty("--bb-month-left", `${Math.max(leftEdge, Math.min(anchor.left, rightEdge - element.offsetWidth))}px`)
      element.style.setProperty("--bb-month-top", `${Math.max(topEdge, Math.min(desiredTop, bottomEdge - element.offsetHeight))}px`)
      element.style.setProperty("--bb-month-origin", above ? "center bottom" : "center top")
    }
    contain()
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(contain) : null
    if (popover.current) observer?.observe(popover.current)
    window.addEventListener("resize", contain)
    window.visualViewport?.addEventListener("resize", contain)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", contain)
      window.visualViewport?.removeEventListener("resize", contain)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const contains = (target: EventTarget | null) => target instanceof Node
      && (panel.current?.contains(target) || trigger.current?.contains(target))
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!contains(event.target)) close()
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close(true)
    }
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) close()
    }
    const screenChange = () => close()
    const frame = requestAnimationFrame(() => {
      const selected = panel.current?.querySelector<HTMLButtonElement>('[data-month][aria-pressed="true"]')
      ;(selected ?? panel.current?.querySelector<HTMLButtonElement>("[data-month]:not(:disabled)"))?.focus({ preventScroll: true })
    })
    document.addEventListener("pointerdown", outside)
    document.addEventListener("focusin", outside)
    document.addEventListener("keydown", escape)
    document.addEventListener("scroll", scroll, true)
    window.addEventListener("bookiebot:screen-change", screenChange)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
      document.removeEventListener("keydown", escape)
      document.removeEventListener("scroll", scroll, true)
      window.removeEventListener("bookiebot:screen-change", screenChange)
    }
  }, [open])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.dataset.month) return
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("[data-month]") ?? [])]
    const index = buttons.indexOf(event.target)
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 } as Record<string, number>)[event.key]
    if (!step && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    let next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + step
    const direction = event.key === "End" ? -1 : event.key === "Home" ? 1 : step
    while (next >= 0 && next < buttons.length && buttons[next].disabled) next += direction
    buttons[next]?.focus({ preventScroll: true })
  }

  return <span className={`bb-month-control bb-month-control-${variant}`}>
    <button ref={trigger} type="button" className="bb-month-trigger" aria-label={label} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={id} disabled={disabled || !months.size}
      onClick={() => { setYear(initialYear); setOpen(current => !current) }}>
      <span>{triggerLabel ?? months.get(value)?.label ?? value}</span>
      <svg className="bb-month-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {typeof document !== "undefined" && createPortal(
      <Popover ref={popover} className="bb-month-popover" opened={open} target={trigger} backdrop={false}
        role="dialog" aria-label={label} aria-hidden={!open} id={id} inert={!open}>
        <div ref={panel} className="bb-month-panel" onKeyDown={moveFocus}>
          <div className="bb-month-year">
            <button type="button" aria-label="Previous year" disabled={yearIndex <= 0}
              onClick={() => setYear(years[yearIndex - 1])}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>
            </button>
            <strong aria-live="polite">{shownYear}</strong>
            <button type="button" aria-label="Next year" disabled={yearIndex < 0 || yearIndex >= years.length - 1}
              onClick={() => setYear(years[yearIndex + 1])}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
            </button>
          </div>
          <div className="bb-month-grid" role="group" aria-label={`Months in ${shownYear}`}>
            {MONTHS.map((month, index) => {
              const key = `${shownYear}-${String(index + 1).padStart(2, "0")}`
              const option = months.get(key)
              return <button key={key} type="button" data-month={key} aria-pressed={value === key}
                aria-label={option?.label ?? `${month} ${shownYear}, unavailable`} disabled={!option}
                onClick={() => { close(true); onSelect(key) }}>{month}</button>
            })}
          </div>
        </div>
      </Popover>, document.body)}
  </span>
}
