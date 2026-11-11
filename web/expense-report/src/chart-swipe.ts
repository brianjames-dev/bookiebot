import { useLayoutEffect, useRef, useState, type MouseEvent } from "react"

const GAP = 16
const SCROLL_IDLE_MS = 160

type Gesture = {
  id: number; x: number; y: number
  axis: "pending" | "horizontal" | "vertical"; moved: boolean
}

// Native overflow owns every drag, inertia and snap frame. JS only requests a
// page for external navigation and publishes the page after scrolling finishes.
export function useChartSwipe({ index, count, onSelect, onDragStart, ignoreTarget, layoutKey = false }: {
  index: number; count: number; onSelect: (index: number) => void; layoutKey?: boolean
  onDragStart: () => void; ignoreTarget: (target: EventTarget | null) => boolean
}) {
  const [indicatorIndex, setIndicatorIndex] = useState(index)
  const viewportRef = useRef<HTMLDivElement>(null)
  const options = useRef({ index, count, onSelect, onDragStart, ignoreTarget })
  const gesture = useRef<Gesture | null>(null)
  const suppressClickUntil = useRef(0)
  const navigate = useRef<(next: number, immediate?: boolean) => void>(() => {})
  const previousLayout = useRef(layoutKey)
  const layoutRestore = useRef<number | null>(null)
  useLayoutEffect(() => { options.current = { index, count, onSelect, onDragStart, ignoreTarget } })

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const readSize = () => viewport.getBoundingClientRect().width
    let size = readSize()
    let selected = -1
    let previewed = index
    let requested: number | null = null
    let touching = false
    let scrolling = false
    let idle: number | undefined
    const bounded = (next: number) => Math.max(0, Math.min(options.current.count - 1, next))
    const preview = (next: number) => {
      if (previewed === next) return
      previewed = next
      setIndicatorIndex(next)
    }
    const clearIdle = () => { window.clearTimeout(idle); idle = undefined }
    const begin = () => {
      if (scrolling) return
      scrolling = true
      viewport.dataset.settling = "true"
      viewport.dataset.dragging = "true"
      options.current.onDragStart()
    }
    const finish = () => {
      clearIdle()
      // Native re-snapping during resize may finish before ResizeObserver.
      // Preserve the committed page using the new stride before publishing.
      if (!readSize()) return
      if (readSize() !== size) { resize(); return }
      if (layoutRestore.current !== null && Math.abs(viewport.scrollLeft - layoutRestore.current * (size + GAP)) > 1) {
        navigate.current(layoutRestore.current, true)
        return
      }
      // An aborted smooth scroll can emit scrollend for an older request. Never
      // publish that intermediate page over the latest marker/keyboard choice.
      if (touching || (requested !== null && Math.abs(viewport.scrollLeft - requested * (size + GAP)) > 1)) return
      scrolling = false
      viewport.dataset.dragging = "false"
      viewport.dataset.settling = "false"
      requested = null
      const next = bounded(Math.round(viewport.scrollLeft / (size + GAP)))
      selected = next
      preview(next)
      if (next !== options.current.index) options.current.onSelect(next)
    }
    const scheduleIdle = () => {
      clearIdle()
      // Also cover older Safari and final scroll events delivered after
      // scrollend. This observes quiescence; it never drives scroll position,
      // snap timing or a per-frame React update.
      idle = window.setTimeout(finish, SCROLL_IDLE_MS)
    }
    const scroll = () => {
      begin()
      // Change the dash at the majority crossing, even while the finger is
      // down. This never commits selection or writes a native scroll offset.
      if (layoutRestore.current === null && requested === null && readSize() === size) preview(bounded(Math.round(viewport.scrollLeft / (size + GAP))))
      scheduleIdle()
    }
    navigate.current = (next, immediate = false) => {
      next = bounded(next)
      if (next === selected && !immediate) return
      selected = next
      preview(next)
      requested = next
      gesture.current = null
      touching = false
      clearIdle()
      const left = next * (size + GAP)
      viewport.dataset.settling = Math.abs(viewport.scrollLeft - left) > 1 ? "true" : "false"
      viewport.scrollTo({ left, behavior: immediate || media.matches ? "instant" : "smooth" })
      if (Math.abs(viewport.scrollLeft - left) <= 1) finish()
      else scheduleIdle()
    }
    const start = (event: TouchEvent) => {
      layoutRestore.current = null
      suppressClickUntil.current = 0
      touching = event.touches.length > 0
      // Re-grabbing is entirely native: do not read/rewrite the current offset
      // or cancel momentum with a competing scrollTo/transform animation.
      requested = null
      if (event.touches.length !== 1 || options.current.ignoreTarget(event.target)) { gesture.current = null; return }
      const touch = event.touches[0]
      gesture.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY, axis: "pending", moved: false }
    }
    const move = (event: TouchEvent) => {
      const current = gesture.current
      if (!current) return
      if (event.touches.length !== 1) {
        if (current.moved) suppressClickUntil.current = performance.now() + 750
        gesture.current = null
        return
      }
      const touch = event.touches[0]
      if (touch.identifier !== current.id) return
      const dx = touch.clientX - current.x, dy = touch.clientY - current.y
      if (Math.hypot(dx, dy) > 8) current.moved = true
      if (current.axis === "pending" && current.moved) {
        if (Math.abs(dy) > Math.abs(dx) * 1.15) current.axis = "vertical"
        else if (Math.abs(dx) > Math.abs(dy) * 1.15) current.axis = "horizontal"
      }
      if (current.axis !== "horizontal") return
      begin()
      // Keep Recharts from scrubbing nodes while Safari pans the scroller.
      // All touch listeners are passive: neither axis waits for/cancels JS.
      event.stopPropagation()
    }
    const end = (event: TouchEvent) => {
      touching = event.touches.length > 0
      const current = gesture.current
      if (current && !Array.from(event.touches).some(touch => touch.identifier === current.id)) {
        gesture.current = null
        if (current.moved) suppressClickUntil.current = performance.now() + 750
        if (current.axis === "horizontal") event.stopPropagation()
      }
      if (!touching) {
        scheduleIdle()
        // No scrolling (e.g. a canceled touch at an edge) produces no scrollend.
        if (Math.abs(viewport.scrollLeft - selected * (size + GAP)) <= 1) finish()
      }
    }
    const wheel = (event: WheelEvent) => { if (event.deltaX !== 0) { requested = null; layoutRestore.current = null } }
    const scrollEnd = (event: Event) => { if (event.target === viewport) finish() }
    const resize = () => {
      if (!readSize() || readSize() === size) return
      size = readSize()
      navigate.current(options.current.index, true)
    }
    const reduce = () => { if (media.matches) navigate.current(options.current.index, true) }
    const passive = { passive: true, capture: true }
    viewport.addEventListener("touchstart", start, passive)
    viewport.addEventListener("touchmove", move, passive)
    viewport.addEventListener("touchend", end, passive)
    viewport.addEventListener("touchcancel", end, passive)
    viewport.addEventListener("wheel", wheel, { passive: true })
    viewport.addEventListener("scroll", scroll, { passive: true })
    viewport.addEventListener("scrollend", scrollEnd)
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    media.addEventListener("change", reduce)
    navigate.current(options.current.index, true)
    return () => {
      clearIdle()
      observer.disconnect()
      media.removeEventListener("change", reduce)
      viewport.removeEventListener("touchstart", start, true)
      viewport.removeEventListener("touchmove", move, true)
      viewport.removeEventListener("touchend", end, true)
      viewport.removeEventListener("touchcancel", end, true)
      viewport.removeEventListener("wheel", wheel)
      viewport.removeEventListener("scroll", scroll)
      viewport.removeEventListener("scrollend", scrollEnd)
      navigate.current = () => {}
    }
  }, [])
  useLayoutEffect(() => {
    const changed = previousLayout.current !== layoutKey
    previousLayout.current = layoutKey
    layoutRestore.current = changed ? index : null
    // Folding changes the carousel's containing page as well as its viewport.
    // Restore the committed page before native resize/focus snapping can publish.
    navigate.current(index, changed)
  }, [index, count, layoutKey])

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.detail === 0 || (gesture.current?.axis !== "horizontal" && performance.now() >= suppressClickUntil.current)) return
    event.preventDefault()
    event.stopPropagation()
  }
  return { viewportRef, onClickCapture, indicatorIndex }
}
