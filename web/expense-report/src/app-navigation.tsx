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
  // Size once for the largest stack. Keep that same capsule inside the glass
  // even at the first/last tab, rather than clamping it to unequal tab tracks.
  const width = Math.min(Math.max(...tabs.map(tab => tab.content.width)) + 12,
    ...tabs.map(({ button }) => 2 * Math.min(button.x + button.width / 2, pane.width - button.x - button.width / 2) - 4))
  const height = Math.min(Math.max(...tabs.map(tab => tab.content.height)) + 12,
    ...tabs.map(({ button }) => 2 * Math.min(button.y + button.height / 2, pane.height - button.y - button.height / 2) - 8))
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
