import { createContext, useContext, type ReactNode } from "react"
import type { useReportViewPreferences } from "./report-view-preferences"

export type AppScreen = "overview" | "transactions" | "shared" | "savings" | "reconcile" | "settings"
export type MainScreen = Exclude<AppScreen, "settings">
export const screenTitles: Record<AppScreen, string> = {
  overview: "Overview", transactions: "Transactions", shared: "Shared", savings: "Savings", reconcile: "Reconcile", settings: "Settings",
}
export function screenForReportSource(source: string): MainScreen {
  return source === "reimbursements" ? "shared" : "overview"
}
export interface AppNavigation {
  screen: AppScreen
  selectScreen: (screen: AppScreen) => void
  preferences: ReturnType<typeof useReportViewPreferences>
  sourceRequest: { section: string; id: number } | null
  consumeSource?: (id: number) => void
}
export const AppNavigationContext = createContext<AppNavigation | null>(null)
export const useAppNavigation = () => useContext(AppNavigationContext)

export interface NavigationBounds { x: number; y: number; width: number; height: number }
type NavigationSize = Pick<NavigationBounds, "width" | "height">
export function fitNavigationSelection(tabs: { button: NavigationBounds; content: NavigationSize }[], selected: number, pane: NavigationSize): NavigationBounds {
  // A concentric capsule fills the tab track, with the same small glass rim
  // around every selection. Share its dimensions across all four/five tabs.
  const inset = 4 + Math.max(0, Math.min(1, (pane.height - 44) / 16))
  const width = Math.min(Math.max(...tabs.map(tab => tab.button.width)) + inset * 2,
    ...tabs.map(({ button }) => 2 * Math.min(button.x + button.width / 2, pane.width - button.x - button.width / 2) - inset * 2))
  const height = pane.height - inset * 2
  const { button } = tabs[selected]
  return { x: button.x + (button.width - width) / 2, y: button.y + (button.height - height) / 2, width, height }
}

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
