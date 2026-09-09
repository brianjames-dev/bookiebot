import { useEffect, useId, useRef, useState, type ReactNode } from "react"

/** A small disclosure, with ordinary button/tab behavior and a retained exit. */
export function ReportMenu({ children, label = "Report settings", disabled = false, closeOnSelect = false }: {
  children: ReactNode; label?: string; disabled?: boolean; closeOnSelect?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }))
    document.addEventListener("pointerdown", outside)
    // Safari can blur a tapped button to the body before delivering its click.
    // Dismiss on an actual outside focus target, not that intermediate blur.
    document.addEventListener("focusin", outside)
    document.addEventListener("keydown", escape)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])

  return (
    <div className="bb-report-menu" ref={root}>
      <button ref={trigger} className="bb-icon-button bb-report-menu-trigger" type="button"
        disabled={disabled} aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </button>
      <div id={id} ref={panel} className="bb-report-menu-panel" data-open={open} aria-hidden={!open}
        onClick={(event) => {
          if (closeOnSelect && event.target instanceof Element && event.target.closest("button:not(:disabled)")) {
            setOpen(false)
            trigger.current?.focus({ preventScroll: true })
          }
        }}
        inert={!open}>
        {children}
      </div>
    </div>
  )
}
