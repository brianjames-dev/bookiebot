import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Panel } from "konsta/react"
import { ReportQuestions } from "./report-questions"
import type { QuestionMode } from "./report-question-client"
import "./ask-bookiebot-panel.css"

export interface AskBookieBotPanelProps {
  open: boolean
  onClose: () => void
  month: string
  mode: QuestionMode
  onShowSource?: (section: string) => void
  openerRef?: RefObject<HTMLElement | null>
}

/** The wrapper stays mounted: dismissing it never disposes the question client. */
export function AskBookieBotPanel({ open, onClose, month, mode, onShowSource, openerRef }: AskBookieBotPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const requestedOpen = useRef(open)
  requestedOpen.current = open
  const pendingSource = useRef<string | null>(null)
  const closeTimer = useRef(0)
  const [present, setPresent] = useState(false)
  const [visible, setVisible] = useState(false)
  const titleId = useId()
  const contextId = useId()
  const monthLabel = /^\d{4}-\d{2}$/.test(month)
    ? new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : month

  const finishClose = () => {
    if (requestedOpen.current || !dialogRef.current?.open) return
    window.clearTimeout(closeTimer.current)
    dialogRef.current.close()
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
    returnFocus.current = null
    setPresent(false)
  }

  useLayoutEffect(() => { pendingSource.current = null }, [month, mode])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    let frame = 0
    if (open) {
      pendingSource.current = null
      if (!dialog.open) {
        returnFocus.current = openerRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
        // Native showModal autofocus must target the stationary host. Focusing
        // an offscreen sliding heading first makes WebKit scroll the dialog
        // horizontally, then jump back when the transition ends.
        dialog.setAttribute("autofocus", "")
        dialog.showModal()
        titleRef.current?.focus({ preventScroll: true })
        setPresent(true)
        // Establish the closed pose only on a fresh presentation. A reopen
        // during exit reverses the current CSS transition without a frame reset.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => setVisible(true))
        })
      } else {
        setVisible(true)
      }
    } else {
      setVisible(false)
      // Normal completion comes from the surface's transform transitionend.
      // The buffered fallback also covers no-motion, interrupted or hidden tabs.
      if (dialog.open) closeTimer.current = window.setTimeout(finishClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320)
    }
    return () => { cancelAnimationFrame(frame); window.clearTimeout(closeTimer.current) }
  }, [open])

  useLayoutEffect(() => {
    if (!present) return
    const dialog = dialogRef.current
    if (!dialog) return
    const root = document.documentElement
    const body = document.body
    const previous = { overflow: root.style.overflow, padding: body.style.paddingRight,
      lock: root.dataset.bbModalScrollLock }
    const scrollX = window.scrollX, scrollY = window.scrollY
    const scrollbar = Math.max(window.innerWidth - root.clientWidth, 0)
    const padding = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0
    // Lock the root without fixing/repositioning the page or its chart layers.
    root.dataset.bbModalScrollLock = "true"
    root.style.setProperty("--bb-viewport-scrollbar-width", `${scrollbar}px`)
    if (scrollbar) body.style.paddingRight = `${padding + scrollbar}px`
    root.style.overflow = "hidden"
    const viewport = window.visualViewport
    const resize = () => {
      dialog.style.setProperty("--bb-ask-viewport-height", `${viewport?.height ?? window.innerHeight}px`)
      dialog.style.setProperty("--bb-ask-viewport-top", `${viewport?.offsetTop ?? 0}px`)
    }
    resize()
    viewport?.addEventListener("resize", resize)
    viewport?.addEventListener("scroll", resize)
    window.addEventListener("resize", resize)
    const containTouch = (event: TouchEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".bb-ask-panel-body")) event.preventDefault()
    }
    dialog.addEventListener("touchmove", containTouch, { passive: false })
    return () => {
      viewport?.removeEventListener("resize", resize)
      viewport?.removeEventListener("scroll", resize)
      window.removeEventListener("resize", resize)
      dialog.removeEventListener("touchmove", containTouch)
      body.style.paddingRight = previous.padding
      root.style.overflow = previous.overflow
      if (previous.lock === undefined) delete root.dataset.bbModalScrollLock
      else root.dataset.bbModalScrollLock = previous.lock
      root.style.setProperty("--bb-viewport-scrollbar-width", `${Math.max(window.innerWidth - root.clientWidth, 0)}px`)
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY)
    }
  }, [present])

  useLayoutEffect(() => {
    // Restore the page lock first, then navigate. Switching screens behind a
    // moving panel repaints the backdrop and can overwrite saved scroll offsets.
    if (present || !pendingSource.current) return
    const source = pendingSource.current
    pendingSource.current = null
    onShowSource?.(source)
  }, [present, onShowSource])

  if (typeof document === "undefined") return null
  return createPortal(
    <dialog ref={dialogRef} tabIndex={-1} className="bb-ask-dialog" data-open={visible ? "true" : "false"}
      aria-labelledby={titleId} aria-describedby={contextId}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return
        // Safari's system keyboard setting can otherwise leave the modal at
        // its last control. Keep the boundary explicit without changing keys
        // inside native text fields and selects.
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length && !element.closest("[inert]"))
        const index = controls.indexOf(document.activeElement as HTMLElement)
        if (index === -1 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
          event.preventDefault()
          const next = event.shiftKey ? controls[controls.length - 1] : controls[0]
          if (next) next.focus()
          else titleRef.current?.focus({ preventScroll: true })
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="bb-ask-panel-shade" aria-hidden="true" onClick={onClose} />
      <Panel ref={surfaceRef} floating side="right" opened={visible} backdrop={false} className="bb-ask-panel-surface"
        onTransitionEnd={(event: React.TransitionEvent<HTMLDivElement>) => {
          if (event.target === surfaceRef.current && event.propertyName === "transform") finishClose()
        }}>
        <header className="bb-ask-panel-header">
          <div><h2 id={titleId} ref={titleRef} tabIndex={-1}>Ask BookieBot</h2>
            <p id={contextId}>{monthLabel} <span aria-hidden="true">·</span> {mode === "current" ? "Current" : "Projected"}</p></div>
          <button type="button" className="bb-ask-panel-close" aria-label="Close Ask BookieBot" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="bb-ask-panel-body">
          <ReportQuestions embedded month={month} mode={mode} onShowSource={onShowSource ? (source) => {
            pendingSource.current = source
            onClose()
          } : undefined} />
        </div>
      </Panel>
    </dialog>, document.body,
  )
}
