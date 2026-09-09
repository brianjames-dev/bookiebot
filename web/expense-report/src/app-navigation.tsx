import { createContext, useContext, type ReactNode } from "react"
import type { useReportViewPreferences } from "./report-view-preferences"

export type AppScreen = "overview" | "spending" | "shared" | "savings" | "settings"
export type MainScreen = Exclude<AppScreen, "settings">
export const screenTitles: Record<AppScreen, string> = {
  overview: "Overview", spending: "Spending", shared: "Shared", savings: "Savings", settings: "Settings",
}
export function screenForReportSource(source: string): MainScreen {
  return source === "reimbursements" ? "shared" : source === "activity" ? "spending" : "overview"
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
