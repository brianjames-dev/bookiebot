import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"
import { screenTitles, type AppScreen } from "./app-navigation"
import { usePageRefreshRegistry } from "./page-refresh"
import "./pull-to-refresh.css"

// Finger travel is resisted; 144px of downward travel fills the 72px indicator.
export const PULL_REFRESH_THRESHOLD = 72
export function pullRefreshDistance(travel: number) { return Math.min(96, Math.max(0, travel) / 2) }
type Phase = "idle" | "pulling" | "armed" | "refreshing" | "done" | "error"
type Gesture = { x: number; y: number; identifier: number; captured: boolean }

function pageIsBlocked() {
  return Boolean(document.querySelector("dialog[open], [role='dialog'][aria-modal='true']") || document.documentElement.dataset.bbModalScrollLock === "true")
}

function excludedTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return true
  if (target.closest("button,a,input,textarea,select,[contenteditable=true],[role=slider],[role=tablist],.bb-bottom-navigation")) return true
  // An inner scroller owns its own gesture, even when it has reached its edge.
  for (let element: Element | null = target; element && element !== document.body; element = element.parentElement) {
    const style = window.getComputedStyle(element)
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) return true
  }
  return false
}

export function PullToRefresh({ screen, blocked = false }: { screen: AppScreen; blocked?: boolean }) {
  const registry = usePageRefreshRegistry()!
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const [phase, setPhase] = useState<Phase>("idle"), [distance, setDistance] = useState(0)
  const [message, setMessage] = useState("")
  const state = useRef({ screen, blocked }), gesture = useRef<Gesture | null>(null), pulled = useRef(0)
  const running = useRef(false), mounted = useRef(false), timer = useRef<number | undefined>(undefined)
  const refreshScreen = useRef<AppScreen | null>(null)
  state.current = { screen, blocked }
  const available = !blocked && registry.available(screen)
  const reset = () => { gesture.current = null; pulled.current = 0; setDistance(0); if (!running.current) setPhase("idle") }
  const refresh = async () => {
    const selected = state.current.screen
    if (running.current || state.current.blocked || pageIsBlocked() || !registry.available(selected)) return
    running.current = true; refreshScreen.current = selected; window.clearTimeout(timer.current)
    gesture.current = null; pulled.current = 0; setDistance(PULL_REFRESH_THRESHOLD); setPhase("refreshing"); setMessage("")
    const success = await registry.refresh(selected)
    running.current = false
    if (!mounted.current) return
    if (state.current.screen !== selected) { reset(); return }
    setPhase(success ? "done" : "error")
    setMessage(success ? `${screenTitles[selected]} refreshed` : `Couldn’t refresh ${screenTitles[selected]}. Pull down to try again.`)
    timer.current = window.setTimeout(reset, success ? 900 : 4000)
  }
  const actions = useRef({ reset, refresh }); actions.current = { reset, refresh }

  useEffect(() => {
    mounted.current = true
    document.documentElement.classList.add("bb-pull-refresh-enabled")
    const start = (event: TouchEvent) => {
      if (running.current || state.current.blocked || !registry.available(state.current.screen) || event.touches.length !== 1
        || window.scrollY > 1 || pageIsBlocked() || excludedTarget(event.target)) return
      window.clearTimeout(timer.current)
      const touch = event.touches[0]
      gesture.current = { x: touch.clientX, y: touch.clientY, identifier: touch.identifier, captured: false }
      pulled.current = 0
    }
    const move = (event: TouchEvent) => {
      const current = gesture.current
      if (!current) return
      if (event.touches.length !== 1 || window.scrollY > 1 || state.current.blocked || pageIsBlocked() || !registry.available(state.current.screen)) { actions.current.reset(); return }
      const touch = event.touches[0]
      if (touch.identifier !== current.identifier) { actions.current.reset(); return }
      const dx = touch.clientX - current.x, dy = touch.clientY - current.y
      if (!current.captured) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        if (dy <= 0 || Math.abs(dx) >= dy || window.scrollY > 1) { actions.current.reset(); return }
        current.captured = true
      }
      if (!event.cancelable) { actions.current.reset(); return }
      event.preventDefault()
      pulled.current = pullRefreshDistance(dy)
      setDistance(pulled.current); setPhase(pulled.current >= PULL_REFRESH_THRESHOLD ? "armed" : "pulling")
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
    document.addEventListener("touchmove", move, { passive: false })
    document.addEventListener("touchend", end)
    document.addEventListener("touchcancel", cancel)
    window.addEventListener("pagehide", cancel)
    return () => {
      mounted.current = false; window.clearTimeout(timer.current); gesture.current = null
      document.documentElement.classList.remove("bb-pull-refresh-enabled")
      document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move)
      document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", cancel); window.removeEventListener("pagehide", cancel)
    }
  }, [registry])
  useEffect(() => { window.clearTimeout(timer.current); gesture.current = null; pulled.current = 0; setDistance(0); setMessage(""); if (!running.current) setPhase("idle") }, [screen, blocked])

  const visible = !blocked && (phase !== "refreshing" || refreshScreen.current === screen) && (distance > 0 || phase === "refreshing" || phase === "done" || phase === "error")
  const progress = Math.round(Math.min(1, distance / PULL_REFRESH_THRESHOLD) * 100)
  const label = phase === "refreshing" ? "Refreshing…" : phase === "armed" ? "Release to refresh" : phase === "done" ? "Updated" : phase === "error" ? "Try again" : "Pull down to refresh"
  return <>
    <div className="bb-pull-refresh-space" data-phase={phase} aria-hidden="true" style={{ height: visible ? Math.min(distance, PULL_REFRESH_THRESHOLD) : 0 }} />
    <div className="bb-pull-refresh" data-phase={phase} data-visible={visible} style={{ "--bb-pull-distance": `${Math.min(distance, PULL_REFRESH_THRESHOLD)}px` } as CSSProperties}>
    <button type="button" className="bb-pull-refresh-button" aria-label={`Refresh ${screenTitles[screen]}`} disabled={!available || running.current}
      aria-busy={phase === "refreshing"} onClick={() => void refresh()}>
      <svg viewBox="0 0 32 32" aria-hidden="true"><circle className="bb-pull-track" cx="16" cy="16" r="12" />
        <circle className="bb-pull-progress" cx="16" cy="16" r="12" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - progress} />
        <path className="bb-pull-arrow" d={phase === "done" ? "m11 16 3.5 3.5L22 12" : "M16 10v12m-5-5 5 5 5-5"} /></svg>
      <span className="bb-pull-refresh-label">{label}</span>
    </button>
    {(phase === "pulling" || phase === "armed") && <span className="sr-only" role="progressbar" aria-label="Pull to refresh" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} />}
    <span className="sr-only" role="status" aria-live="polite">{phase === "armed" ? "Release to refresh" : phase === "refreshing" ? `Refreshing ${screenTitles[refreshScreen.current ?? screen]}` : message}</span>
    </div>
  </>
}
