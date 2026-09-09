import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import "./app-update-prompt.css"

export interface AppWorkStatus {
  label: string
  pending?: boolean
  uncertain?: boolean
  dirty?: boolean
  onDiscard?: () => void
}
export interface AppGuardedAction { kind: "update" | "signout"; onProceed: () => void | Promise<void> }
const EMPTY_WORK = { pending: false, uncertain: false, dirty: false }

/** Status and reset callbacks only; drafts and financial data stay in their controllers. */
export class AppWorkRegistry {
  private entries = new Map<string, AppWorkStatus>()
  private listeners = new Set<() => void>()
  private snapshot = EMPTY_WORK
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish() {
    const values = [...this.entries.values()]
    const next = { pending: values.some(value => value.pending), uncertain: values.some(value => value.uncertain), dirty: values.some(value => value.dirty) }
    if (next.pending === this.snapshot.pending && next.uncertain === this.snapshot.uncertain && next.dirty === this.snapshot.dirty) return
    this.snapshot = next
    this.listeners.forEach(listener => listener())
  }
  set(id: string, value: AppWorkStatus) { this.entries.set(id, value); this.publish() }
  remove(id: string) { this.entries.delete(id); this.publish() }
  canDiscard() { return [...this.entries.values()].filter(value => value.dirty).every(value => typeof value.onDiscard === "function") }
  discard() {
    if (this.snapshot.pending || this.snapshot.uncertain || !this.canDiscard()) return false
    for (const [id, value] of [...this.entries]) {
      if (!value.dirty) continue
      value.onDiscard!()
      const current = this.entries.get(id)
      if (current) this.set(id, { ...current, dirty: false })
    }
    return !this.snapshot.pending && !this.snapshot.uncertain
  }
}

interface GuardContextValue { registry: AppWorkRegistry; requestAction: (action: AppGuardedAction) => void }
const GuardContext = createContext<GuardContextValue | null>(null)
const noSubscribe = () => () => {}
const emptySnapshot = () => EMPTY_WORK

export function useAppWorkGuard() {
  const context = useContext(GuardContext)
  const status = useSyncExternalStore(context?.registry.subscribe ?? noSubscribe, context?.registry.getSnapshot ?? emptySnapshot, emptySnapshot)
  return { ...status, requestAction: context?.requestAction ?? ((action: AppGuardedAction) => { void action.onProceed() }) }
}

export function useAppWorkStatus(status: AppWorkStatus) {
  const context = useContext(GuardContext)
  const registry = context?.registry
  const id = useId()
  useLayoutEffect(() => { registry?.set(id, status) }, [registry, id, status.label, status.pending, status.uncertain, status.dirty, status.onDiscard])
  useLayoutEffect(() => () => registry?.remove(id), [registry, id])
  return useCallback((next: AppWorkStatus) => registry?.set(id, next), [registry, id])
}

export function AppWorkGuardProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new AppWorkRegistry())
  const status = useSyncExternalStore(registry.subscribe, registry.getSnapshot, emptySnapshot)
  const [action, setAction] = useState<AppGuardedAction | null>(null)
  const [error, setError] = useState("")
  const [acting, setActing] = useState(false)
  const executing = useRef(false)
  const mounted = useRef(true)
  const dialog = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const lastAction = useRef<AppGuardedAction | null>(null)
  if (action) lastAction.current = action
  const headingId = useId(), descriptionId = useId()
  const blocked = status.pending || status.uncertain
  useEffect(() => {
    mounted.current = true
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = registry.getSnapshot()
      if (!current.pending && !current.uncertain && !current.dirty) return
      event.preventDefault(); event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => { mounted.current = false; window.removeEventListener("beforeunload", beforeUnload) }
  }, [registry])
  const proceed = useCallback(async (next: AppGuardedAction) => {
    if (executing.current) return
    const current = registry.getSnapshot()
    if (current.pending || current.uncertain) { setAction(next); return }
    executing.current = true; setActing(true); setError("")
    try { await next.onProceed(); if (mounted.current) setAction(null) }
    catch { if (mounted.current) { setAction(next); setError("That action couldn’t finish. Your current work is still here.") } }
    finally { executing.current = false; if (mounted.current) setActing(false) }
  }, [registry])
  const requestAction = useCallback((next: AppGuardedAction) => {
    if (executing.current) return
    setError("")
    const current = registry.getSnapshot()
    if (current.pending || current.uncertain || current.dirty) setAction(next)
    else void proceed(next)
  }, [registry, proceed])
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (action) {
      delete element.dataset.closing
      if (!element.open) {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element.showModal()
      }
    } else if (element.open) {
      element.dataset.closing = "true"
      const timer = window.setTimeout(() => {
        element.close(); previousFocus.current?.focus({ preventScroll: true })
      }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 240)
      return () => window.clearTimeout(timer)
    }
  }, [action])
  const cancel = () => { if (!executing.current) setAction(null) }
  const actionWord = (action ?? lastAction.current)?.kind === "signout" ? "sign out" : "update"
  return <GuardContext.Provider value={{ registry, requestAction }}>{children}
    <dialog ref={dialog} className="bb-work-guard-dialog" aria-labelledby={headingId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); cancel() }}>
      <h2 id={headingId}>{blocked ? "Finish your current work" : status.dirty ? "Keep your changes?" : "Ready when you are"}</h2>
      <p id={descriptionId}>{status.uncertain
        ? `A financial change may already have saved. Resolve its status before you ${actionWord}.`
        : status.pending ? `Wait for the current request to finish before you ${actionWord}.`
          : status.dirty ? registry.canDiscard() ? `You have unsaved changes. Keep editing, or discard them and ${actionWord}.`
            : `Save or cancel your open changes before you ${actionWord}.`
          : `Your request has finished. You can ${actionWord} when you’re ready.`}</p>
      {error && <p role="alert">{error}</p>}
      <div className="bb-work-guard-actions">
        <button type="button" autoFocus disabled={acting} onClick={cancel}>Keep editing</button>
        {!blocked && registry.canDiscard() && <button type="button" disabled={acting} onClick={() => {
          if (!action || executing.current) return
          try { if (registry.discard()) void proceed(action) }
          catch { setError("Couldn’t discard these changes. Return to the open form and try again.") }
        }}>{status.dirty ? `Discard and ${actionWord}` : actionWord === "sign out" ? "Sign out" : "Update now"}</button>}
      </div>
    </dialog>
  </GuardContext.Provider>
}
