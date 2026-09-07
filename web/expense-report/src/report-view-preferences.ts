import { useMemo, useState } from "react"

export type PreferredReportMode = "current" | "projected"
export type PreferredChart = "category" | "burn-rate" | "calendar" | "bills"
export interface ReportViewPreferences { mode: PreferredReportMode; chartId: PreferredChart }
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">
const charts: readonly string[] = ["category", "burn-rate", "calendar", "bills"]

export function reportPreferenceKey(owner: string) {
  return `bookiebot-report-view:v1:${encodeURIComponent(owner.trim().toLowerCase())}`
}

function browserStorage(): PreferenceStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage } catch { return null }
}

export function loadReportViewPreferences(owner: string, hasBurnRate: boolean, storage = browserStorage()): ReportViewPreferences {
  const defaults: ReportViewPreferences = { mode: "current", chartId: hasBurnRate ? "burn-rate" : "category" }
  try {
    const saved = JSON.parse(storage?.getItem(reportPreferenceKey(owner)) || "null")
    if (!saved || typeof saved !== "object" || saved.version !== 1) return defaults
    return {
      mode: saved.mode === "current" || saved.mode === "projected" ? saved.mode : defaults.mode,
      chartId: charts.includes(saved.chartId) ? saved.chartId : defaults.chartId,
    }
  } catch { return defaults }
}

export function saveReportViewPreferences(owner: string, preferences: ReportViewPreferences, storage = browserStorage()) {
  try {
    // Store only these two presentation choices, never any report data.
    storage?.setItem(reportPreferenceKey(owner), JSON.stringify({ version: 1, mode: preferences.mode, chartId: preferences.chartId }))
  } catch { /* Private browsing/storage limits must not break report controls. */ }
}

export function availablePreferredChart(chart: PreferredChart, hasBurnRate: boolean): PreferredChart {
  return chart === "burn-rate" && !hasBurnRate ? "category" : chart
}

export function useReportViewPreferences(owner: string, hasBurnRate: boolean, enabled = true) {
  const key = reportPreferenceKey(owner)
  // The initial read is scoped by identity. Remembering a chart that is absent
  // this month must not erase the preference for months where it is available.
  const initial = useMemo(() => enabled ? loadReportViewPreferences(owner, hasBurnRate) : {
    mode: "current" as const, chartId: hasBurnRate ? "burn-rate" as const : "category" as const,
  }, [key, enabled])
  const [choices, setChoices] = useState<Record<string, ReportViewPreferences>>({})
  const preferences = choices[key] ?? initial
  const choose = (next: Partial<ReportViewPreferences>) => {
    const updated = { ...preferences, ...next }
    setChoices((current) => ({ ...current, [key]: updated }))
    if (enabled) saveReportViewPreferences(owner, updated)
  }
  return {
    mode: preferences.mode,
    chartId: availablePreferredChart(preferences.chartId, hasBurnRate),
    setMode: (mode: PreferredReportMode) => choose({ mode }),
    setChartId: (chartId: PreferredChart) => choose({ chartId }),
  }
}
