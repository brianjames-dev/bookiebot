import { createContext, useContext, type ReactNode } from "react"
import type { useReportViewPreferences } from "./report-view-preferences"

export type AppScreen = "overview" | "transactions" | "shared" | "savings" | "reconcile" | "settings"
export type MainScreen = Exclude<AppScreen, "settings">
// Chrome subscribes independently of the page tree. An accepted navigation
// updates it synchronously; rendering/loading that page can run as a transition.
export class AppNavigationStore {
  private snapshot: { screen: AppScreen; main: MainScreen; compact: boolean }
  private listeners = new Set<() => void>()
  constructor(screen: AppScreen = "overview") {
    this.snapshot = { screen, main: screen === "settings" ? "overview" : screen, compact: false }
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  select(screen: AppScreen, lastMain = this.snapshot.main) {
    const main = screen === "settings" ? lastMain : screen
    if (screen === this.snapshot.screen && main === this.snapshot.main) return
    this.snapshot = { screen, main, compact: false }
    this.listeners.forEach(listener => listener())
  }
  setCompact(compact: boolean) {
    if (compact === this.snapshot.compact) return
    this.snapshot = { ...this.snapshot, compact }
    this.listeners.forEach(listener => listener())
  }
}
export const screenTitles: Record<AppScreen, string> = {
  overview: "Overview", transactions: "Transactions", shared: "Shared", savings: "Savings", reconcile: "Reconcile", settings: "Settings",
}
export function screenForReportSource(source: string): MainScreen {
  return source === "reimbursements" ? "shared" : source === "activity" ? "transactions" : "overview"
}
export interface AppNavigation {
  screen: AppScreen
  duoLandscape?: boolean
  selectScreen: (screen: AppScreen) => void
  preferences: ReturnType<typeof useReportViewPreferences>
  sourceRequest: { section: string; id: number } | null
  consumeSource?: (id: number) => void
}
export const AppNavigationContext = createContext<AppNavigation | null>(null)
export const useAppNavigation = () => useContext(AppNavigationContext)

// Hidden panels remain mounted: their controls, charts and drafts keep identity.
export function ReportScreen({ name, children }: { name: MainScreen; children: ReactNode }) {
  const navigation = useAppNavigation()
  if (!navigation) return <>{children}</>
  return <section className="bb-report-screen bb-main" aria-label={screenTitles[name]} hidden={navigation.screen !== name}>{children}</section>
}

export interface ScrollNavigationState { lastY: number; travel: number; compact: boolean }
export function nextScrollNavigation(state: ScrollNavigationState, scrollY: number, maxY: number): ScrollNavigationState {
  const y = Math.max(0, Math.min(scrollY, Math.max(0, maxY)))
  const delta = y - state.lastY
  if (y < 24) return { lastY: y, travel: 0, compact: false }
  if (Math.abs(delta) < 1) return { ...state, lastY: y }
  const travel = Math.sign(delta) === Math.sign(state.travel) ? state.travel + delta : delta
  if (travel > 36) return { lastY: y, travel: 0, compact: true }
  if (travel < -18) return { lastY: y, travel: 0, compact: false }
  return { ...state, lastY: y, travel }
}
