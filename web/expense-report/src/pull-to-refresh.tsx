import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"
import { screenTitles, type AppScreen } from "./app-navigation"
import { usePageRefreshRegistry } from "./page-refresh"
import "./pull-to-refresh.css"

// Finger travel is resisted; 144px of downward travel fills the 72px indicator.
export const PULL_REFRESH_THRESHOLD = 72
const PULL_REFRESH_HOLD = 64
export function pullRefreshDistance(travel: number) { return Math.min(96, Math.max(0, travel) / 2) }
type Phase = "idle" | "pulling" | "armed" | "refreshing" | "done" | "settling" | "error"
type Gesture = { x: number; y: number; lastY: number; scrollY: number; identifier: number; captured: boolean }

function pageIsBlocked() {
  return Boolean(document.querySelector("dialog[open], [role='dialog'][aria-modal='true']") || document.documentElement.dataset.bbModalScrollLock === "true")
}

function excludedTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return true
  if (target.closest("button,a,input,textarea,select,[contenteditable=true],[role=slider],[role=tablist],.bb-bottom-navigation")) return true
  // An inner scroller owns its own gesture, even when it has reached its edge.
  for (let element: Element | null = target; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
    const style = window.getComputedStyle(element)
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) return true
  }
  return false
}

export function PullToRefresh({ screen, blocked = false }: { screen: AppScreen; blocked?: boolean }) {
  const registry = usePageRefreshRegistry()!
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const [phase, setPhase] = useState<Phase>("idle"), [distance, setDistance] = useState(0)
  const [nativeOverscroll, setNativeOverscroll] = useState(0)
  const [message, setMessage] = useState("")
  const state = useRef({ screen, blocked }), gesture = useRef<Gesture | null>(null), pulled = useRef(0)
  const running = useRef(false), mounted = useRef(false), timer = useRef<number | undefined>(undefined)
  const refreshScreen = useRef<AppScreen | null>(null)
  const spacer = useRef<HTMLDivElement>(null)
  state.current = { screen, blocked }
  const available = !blocked && registry.available(screen)
  const reset = () => { gesture.current = null; pulled.current = 0; setDistance(0); if (!running.current) setPhase("idle") }
  const refresh = async () => {
    const selected = state.current.screen
    if (running.current || state.current.blocked || pageIsBlocked() || !registry.available(selected)) return
    running.current = true; refreshScreen.current = selected; window.clearTimeout(timer.current)
    gesture.current = null; pulled.current = 0; setNativeOverscroll(Math.max(0, -window.scrollY)); setDistance(PULL_REFRESH_HOLD); setPhase("refreshing"); setMessage("")
    const success = await registry.refresh(selected)
    running.current = false
    if (!mounted.current) return
    if (state.current.screen !== selected) { reset(); return }
    setPhase(success ? "done" : "error")
    setMessage(success ? `${screenTitles[selected]} refreshed` : `Couldn’t refresh ${screenTitles[selected]}. Pull down to try again.`)
    timer.current = window.setTimeout(() => {
      if (!success) { reset(); return }
      // Keep the successful glyph while the page and indicator ease home.
      setDistance(0); setPhase("settling")
      timer.current = window.setTimeout(reset, 320)
    }, success ? 900 : 4000)
  }
  const actions = useRef({ reset, refresh }); actions.current = { reset, refresh }

  useEffect(() => {
    mounted.current = true
    document.documentElement.classList.add("bb-pull-refresh-enabled")
    let frame = 0
    const paint = () => {
      frame = 0
      setNativeOverscroll(Math.max(0, -window.scrollY))
      if (!gesture.current || running.current) return
      setDistance(pulled.current)
      setPhase(pulled.current >= PULL_REFRESH_THRESHOLD ? "armed" : pulled.current > 0 ? "pulling" : "idle")
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const start = (event: TouchEvent) => {
      if (running.current || state.current.blocked || !registry.available(state.current.screen) || event.touches.length !== 1
        || pageIsBlocked() || excludedTarget(event.target)) return
      window.clearTimeout(timer.current)
      const touch = event.touches[0]
      gesture.current = { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, scrollY: Math.max(0, window.scrollY), identifier: touch.identifier, captured: false }
      pulled.current = 0
    }
    const move = (event: TouchEvent) => {
      const current = gesture.current
      if (!current) return
      if (event.touches.length !== 1 || state.current.blocked || pageIsBlocked() || !registry.available(state.current.screen)) { actions.current.reset(); return }
      const touch = event.touches[0]
      if (touch.identifier !== current.identifier) { actions.current.reset(); return }
      current.lastY = touch.clientY
      if (window.scrollY > 1) {
        // Observe normal scrolling without claiming it. The same finger may
        // continue past the top; no lift/retry is required at the boundary.
        current.x = touch.clientX; current.y = touch.clientY; current.scrollY = window.scrollY; current.captured = false
        pulled.current = 0; schedule(); return
      }
      if (current.scrollY > 1) {
        current.y += Math.min(current.scrollY, Math.max(0, touch.clientY - current.y))
        current.scrollY = 0
      }
      const dx = touch.clientX - current.x, dy = touch.clientY - current.y
      if (!current.captured) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        if (dy <= 0) { current.x = touch.clientX; current.y = touch.clientY; pulled.current = 0; schedule(); return }
        if (Math.abs(dx) >= dy) { actions.current.reset(); return }
        current.captured = true
      }
      pulled.current = pullRefreshDistance(dy)
      schedule()
    }
    const scroll = () => {
      const current = gesture.current
      if (current && !current.captured && current.scrollY > 1 && window.scrollY <= 1) {
        current.y = current.lastY; current.scrollY = 0
      }
      schedule()
    }
    const end = (event: TouchEvent) => {
      if (!gesture.current) return
      const release = [...event.changedTouches].find(touch => touch.identifier === gesture.current?.identifier)
      if (!release || event.touches.length) { actions.current.reset(); return }
      // Recheck the release position: retreating below the threshold cancels.
      const distance = gesture.current.captured ? pullRefreshDistance(release.clientY - gesture.current.y) : 0
      if (distance >= PULL_REFRESH_THRESHOLD && window.scrollY <= 1) void actions.current.refresh()
      else actions.current.reset()
    }
    const cancel = () => { if (gesture.current) actions.current.reset() }
    document.addEventListener("touchstart", start, { passive: true })
    document.addEventListener("touchmove", move, { passive: true })
    document.addEventListener("touchend", end, { passive: true })
    document.addEventListener("touchcancel", cancel, { passive: true })
    window.addEventListener("scroll", scroll, { passive: true })
    window.addEventListener("pagehide", cancel)
    return () => {
      mounted.current = false; window.clearTimeout(timer.current); gesture.current = null
      cancelAnimationFrame(frame)
      document.documentElement.classList.remove("bb-pull-refresh-enabled")
      document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move)
      document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", cancel); window.removeEventListener("pagehide", cancel)
      window.removeEventListener("scroll", scroll)
    }
  }, [registry])
  useEffect(() => { window.clearTimeout(timer.current); gesture.current = null; pulled.current = 0; setDistance(0); setMessage(""); if (!running.current) setPhase("idle") }, [screen, blocked])

  const visible = !blocked && (phase !== "refreshing" || refreshScreen.current === screen) && (distance > 0 || phase === "refreshing" || phase === "done" || phase === "error")
  // Native rubber banding owns the page while the finger is down. Only reserve
  // the loading/result space after release, subtracting Safari's remaining
  // bounce so the two motions never add up and stretch the page twice.
  const tracking = phase === "pulling" || phase === "armed"
  const offset = visible && !tracking ? Math.max(0, Math.min(distance, PULL_REFRESH_THRESHOLD) - nativeOverscroll) : 0
  useLayoutEffect(() => {
    const shell = spacer.current?.closest<HTMLElement>(".bb-app-shell")
    if (!shell) return
    // Fixed header tools follow the same offset as the in-flow brand/content.
    shell.style.setProperty("--bb-pull-offset", `${offset}px`)
    shell.dataset.pullPhase = phase
  }, [offset, phase])
  useLayoutEffect(() => () => {
    const shell = spacer.current?.closest<HTMLElement>(".bb-app-shell")
    shell?.style.removeProperty("--bb-pull-offset")
    if (shell) delete shell.dataset.pullPhase
  }, [])
  const progress = Math.round(Math.min(1, distance / PULL_REFRESH_THRESHOLD) * 100)
  return <>
    <div ref={spacer} className="bb-pull-refresh-space" data-phase={phase} data-native-bounce={nativeOverscroll > 0} aria-hidden="true" style={{ height: offset }} />
    <div className="bb-pull-refresh" data-phase={phase} data-visible={visible} style={{ "--bb-pull-distance": `${visible ? Math.min(distance, PULL_REFRESH_THRESHOLD) : 0}px` } as CSSProperties}>
    <button type="button" className="bb-pull-refresh-button" aria-label={`Refresh ${screenTitles[screen]}`} title={`Refresh ${screenTitles[screen]}`} disabled={!available || running.current}
      aria-busy={phase === "refreshing"} onClick={() => void refresh()}>
      <span className="bb-pull-spinner" aria-hidden="true"><svg viewBox="0 0 32 32">
        <circle className="bb-pull-progress" cx="16" cy="16" r="12" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - progress} />
      </svg></span>
      <svg className="bb-pull-glyph" viewBox="0 0 32 32" aria-hidden="true"><circle className="bb-pull-track" cx="16" cy="16" r="12" />
        <path className="bb-pull-arrow" d="M16 10v12m-5-5 5 5 5-5" />
        <path className="bb-pull-check" d="m9 16 5 5 9-10" pathLength="1" />
        <path className="bb-pull-error" d="m11 11 10 10m0-10L11 21" /></svg>
    </button>
    {(phase === "pulling" || phase === "armed") && <span className="sr-only" role="progressbar" aria-label="Pull to refresh" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} />}
    <span className="sr-only" role="status" aria-live="polite">{phase === "armed" ? "Release to refresh" : phase === "refreshing" ? `Refreshing ${screenTitles[refreshScreen.current ?? screen]}` : message}</span>
    </div>
  </>
}
