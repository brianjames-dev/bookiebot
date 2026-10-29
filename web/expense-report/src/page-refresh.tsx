import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { AppScreen } from "./app-navigation"

type RefreshHandler = { refresh: () => Promise<unknown>; disabled?: boolean }

/** Each mounted controller retains its drafts and owns its existing refresh. */
export class PageRefreshRegistry {
  private entries = new Map<string, { screen: AppScreen; current: () => RefreshHandler }>()
  private listeners = new Set<() => void>()
  private revision = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.revision
  changed = () => { this.revision++; this.listeners.forEach(listener => listener()) }
  set(id: string, screen: AppScreen, current: () => RefreshHandler) { this.entries.set(id, { screen, current }); this.changed() }
  remove(id: string) { this.entries.delete(id); this.changed() }
  private handlers(screen: AppScreen) { return [...this.entries.values()].filter(entry => entry.screen === screen).map(entry => entry.current()) }
  available(screen: AppScreen) {
    const handlers = this.handlers(screen)
    return handlers.length > 0 && handlers.every(handler => !handler.disabled)
  }
  async refresh(screen: AppScreen) {
    if (!this.available(screen)) return false
    const results = await Promise.allSettled(this.handlers(screen).map(handler => Promise.resolve().then(handler.refresh)))
    return results.every(result => result.status === "fulfilled" && result.value !== false)
  }
}

const PageRefreshContext = createContext<PageRefreshRegistry | null>(null)
export const usePageRefreshRegistry = () => useContext(PageRefreshContext)

export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new PageRefreshRegistry())
  return <PageRefreshContext.Provider value={registry}>{children}</PageRefreshContext.Provider>
}

export function usePageRefresh(screen: AppScreen | null, handler: RefreshHandler) {
  const registry = usePageRefreshRegistry(), id = useId(), current = useRef(handler)
  current.current = handler
  useLayoutEffect(() => {
    if (screen) registry?.set(id, screen, () => current.current)
    return () => registry?.remove(id)
  }, [registry, id, screen])
  useLayoutEffect(() => { registry?.changed() }, [registry, handler.disabled])
  return Boolean(registry)
}
