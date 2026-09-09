import { useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react"

export function CollapsibleContent({
  open,
  children,
  id,
}: {
  open: boolean
  children: ReactNode
  id?: string
}) {
  return (
    <div
      id={id}
      className="bb-details-content"
      data-state={open ? "open" : "closed"}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="bb-details-content-inner">{children}</div>
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
export function useSlidingSelection(value: string | number) {
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
      host.style.setProperty("--bb-selection-x", `${selected.offsetLeft}px`)
      host.style.setProperty("--bb-selection-y", `${selected.offsetTop}px`)
      host.style.setProperty("--bb-selection-width", `${selected.offsetWidth}px`)
      host.style.setProperty("--bb-selection-height", `${selected.offsetHeight}px`)
      if (!host.dataset.selectionReady) {
        readyFrame = requestAnimationFrame(() => { host.dataset.selectionReady = "true" })
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    host.querySelectorAll("button").forEach((button) => observer.observe(button))
    return () => {
      observer.disconnect()
      cancelAnimationFrame(readyFrame)
    }
  }, [value])
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
