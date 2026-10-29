import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react"

export function CollapsibleContent({
  open,
  children,
  id,
  lazy = false,
}: {
  open: boolean
  children: ReactNode
  id?: string
  lazy?: boolean
}) {
  const [retained, setRetained] = useState(open)
  useEffect(() => {
    if (!lazy) return
    if (open) {
      setRetained(true)
      return
    }
    if (!retained) return
    // Keep rows through the exit transition, then release the hidden subtree.
    // The timer also covers interrupted/no-transition and reduced-motion exits.
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320
    const timer = window.setTimeout(() => setRetained(false), duration)
    return () => window.clearTimeout(timer)
  }, [lazy, open, retained])

  return (
    <div
      id={id}
      className="bb-details-content"
      data-state={open ? "open" : "closed"}
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={lazy ? event => {
        if (!open && event.target === event.currentTarget && event.propertyName === "grid-template-rows") setRetained(false)
      } : undefined}
    >
      <div className="bb-details-content-inner">{!lazy || open || retained ? children : null}</div>
    </div>
  )
}

export function AnimatedDisclosure({ summary, children, open: controlledOpen, onOpenChange }: {
  summary: ReactNode
  children: ReactNode
} & ({ open: boolean; onOpenChange: (open: boolean) => void } | { open?: undefined; onOpenChange?: undefined })) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const contentId = useId()
  return (
    <div className="bb-reimbursement-entry" data-state={open ? "open" : "closed"}>
      <button
        type="button"
        className="bb-reimbursement-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange ? onOpenChange(!open) : setLocalOpen((current) => !current)}
      >
        {summary}
      </button>
      <CollapsibleContent open={open} id={contentId}>{children}</CollapsibleContent>
    </div>
  )
}

// Measure actual button widths so the same moving indicator supports both short
// filters and variable-width chart names, including after a responsive resize.
export function useSlidingSelection(value: string | number, measureSelection?: (selected: HTMLElement) => { x: number; y: number; width: number; height: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    let readyFrame = 0
    const measure = () => {
      const selected = host.querySelector<HTMLElement>(
        ':scope > button[data-state="active"], :scope > button[aria-pressed="true"], :scope > button[aria-selected="true"]',
      )
      if (!selected || !selected.offsetWidth) return
      const bounds = measureSelection?.(selected) ?? { x: selected.offsetLeft, y: selected.offsetTop, width: selected.offsetWidth, height: selected.offsetHeight }
      host.style.setProperty("--bb-selection-x", `${bounds.x}px`)
      host.style.setProperty("--bb-selection-y", `${bounds.y}px`)
      host.style.setProperty("--bb-selection-width", `${bounds.width}px`)
      host.style.setProperty("--bb-selection-height", `${bounds.height}px`)
      if (!host.dataset.selectionReady) {
        readyFrame = requestAnimationFrame(() => { host.dataset.selectionReady = "true" })
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    host.querySelectorAll("button").forEach((button) => {
      observer.observe(button)
      if (measureSelection && button.firstElementChild) observer.observe(button.firstElementChild)
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(readyFrame)
    }
  }, [value, measureSelection])
  return ref
}

export function SelectionIndicator() {
  return <span className="bb-selection-indicator" aria-hidden="true" />
}

export function SlidingSelection({
  value,
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: string | number }) {
  const ref = useSlidingSelection(value)
  return (
    <div ref={ref} className={`bb-sliding-selection ${className}`} {...props}>
      <SelectionIndicator />
      {children}
    </div>
  )
}
