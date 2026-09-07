import { useEffect, useId, useRef, useState } from "react"
import { CollapsibleContent, SlidingSelection } from "./components/ui/motion"
import { FittedAmount } from "./components/ui/fitted-amount"
import type { ExpenseReportData } from "./types"
import "./report-history.css"

export interface ReportMonthCatalog {
  currentMonth: string
  months: { value: string; label: string }[]
  coverage: { status: "complete" | "partial" | "unavailable"; unavailableYears: number[] }
}

interface ComparisonPeriod {
  fromDate: string
  throughDate: string
  datedSpending: number
  datedIncome: number
  undatedSpending: number
  scheduledSpending: number
  unitemizedSpending: number
  expenseCount: number
  complete: boolean
}

interface ReportPeriodComparison {
  selectedMonth: string
  baselineMonth: string
  baselineKind: "previous-month" | "previous-year"
  throughDay: number
  shortMonthAdjusted: boolean
  selected: ComparisonPeriod | null
  baseline: ComparisonPeriod | null
  changeAmount: number | null
  changePercent: number | null
  status: "complete" | "partial" | "unavailable"
  coverageNote: string
}

export class HistorySessionExpired extends Error {}

export async function requestReportHistory<T>(url: string, controller: AbortController): Promise<T> {
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, {
      credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { "X-BookieBot-App": "1", Accept: "application/json" },
    })
    if (response.status === 401) throw new HistorySessionExpired()
    if (!response.ok) throw new Error("Report history is unavailable")
    return await response.json() as T
  } finally { clearTimeout(timer) }
}

export function reportMonthLabel(value: string | null) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return "This month"
  const [year, month] = value.split("-").map(Number)
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)))
}

export function useReportMonthCatalog(enabled: boolean, onExpired: () => void, reportMonth?: string) {
  const [catalog, setCatalog] = useState<ReportMonthCatalog | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [revision, reload] = useState(0)
  const expired = useRef(onExpired)
  expired.current = onExpired
  // Only an automatic current-month rollover needs a new catalog. Historical
  // selection changes use the existing picker options and the server validates.
  const current = useRef(reportMonth)
  useEffect(() => {
    if (reportMonth && current.current && reportMonth > current.current) reload((value) => value + 1)
    if (reportMonth && (!current.current || reportMonth > current.current)) current.current = reportMonth
  }, [reportMonth])
  useEffect(() => {
    if (!enabled) { setCatalog(null); setError(false); setLoading(false); return }
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    requestReportHistory<ReportMonthCatalog>("/app/expenses/months", controller).then((result) => {
      if (!/^\d{4}-\d{2}$/.test(result.currentMonth) || !Array.isArray(result.months)
        || !result.months.every((item) => /^\d{4}-\d{2}$/.test(item.value) && typeof item.label === "string")
        || !result.coverage) throw new Error("Invalid month catalog")
      if (active) setCatalog(result)
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof HistorySessionExpired) expired.current()
      else setError(true)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [enabled, revision])
  return { catalog, loading, error, refresh: () => reload((value) => value + 1) }
}

export function MonthHistoryControl({ monthLabel, selectedMonth, catalog, loading, error, onSelect, onRetry, disabled = false }: {
  monthLabel: string
  selectedMonth: string | null
  catalog: ReportMonthCatalog | null
  loading: boolean
  error: boolean
  onSelect: (value: string | null) => void
  onRetry: () => void
  disabled?: boolean
}) {
  const options = catalog?.months.filter((month) => month.value !== catalog.currentMonth) ?? []
  if (selectedMonth && !options.some((item) => item.value === selectedMonth)) {
    options.unshift({ value: selectedMonth, label: reportMonthLabel(selectedMonth) })
  }
  const partial = catalog && catalog.coverage.status !== "complete"
  return <span className="bb-month-history">
    <span className="bb-month-picker">
      <span aria-hidden="true">{monthLabel}<span className="bb-month-chevron">⌄</span></span>
      <select aria-label="Report month" value={selectedMonth ?? ""} disabled={disabled || (loading && !catalog)}
        onChange={(event) => onSelect(event.target.value || null)}>
        <option value="">{catalog ? `${reportMonthLabel(catalog.currentMonth)} · Current` : "This month"}</option>
        {options.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
      </select>
    </span>
    {selectedMonth && <button className="bb-history-current" type="button" disabled={disabled} onClick={() => onSelect(null)}>This month</button>}
    {(error || partial) && <span className="bb-history-catalog-status" role="status">
      {error ? "History couldn’t load." : "Some history is unavailable."} <button type="button" disabled={loading || disabled} onClick={onRetry}>Retry</button>
    </span>}
  </span>
}

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)

export function ReportComparison({ report, onExpired }: { report: ExpenseReportData; onExpired: () => void }) {
  const [open, setOpen] = useState(false)
  const [baseline, setBaseline] = useState<"previous-month" | "previous-year">("previous-month")
  const [comparison, setComparison] = useState<ReportPeriodComparison | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [revision, reload] = useState(0)
  const expired = useRef(onExpired)
  expired.current = onExpired
  const id = useId()
  const selectedMonth = `${report.year}-${String(report.month).padStart(2, "0")}`
  useEffect(() => {
    if (!open) return
    let active = true
    const controller = new AbortController()
    setComparison(null)
    setLoading(true)
    setError(false)
    requestReportHistory<ReportPeriodComparison>(`/app/expenses/comparison?month=${selectedMonth}&baseline=${baseline}`, controller).then((result) => {
      if (result.selectedMonth !== selectedMonth || result.baselineKind !== baseline || typeof result.coverageNote !== "string") {
        throw new Error("Comparison did not match the selected report")
      }
      if (active) setComparison(result)
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof HistorySessionExpired) expired.current()
      else setError(true)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [open, baseline, report, selectedMonth, revision])

  return <section className="bb-report-comparison" aria-label="Spending comparison">
    <button type="button" className="bb-comparison-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      <span>Compare spending</span><span className="bb-disclosure-mark" aria-hidden="true" />
    </button>
    <CollapsibleContent open={open} id={id}>
      <div className="bb-comparison-content">
        <SlidingSelection value={baseline} className="bb-comparison-options" aria-label="Comparison period">
          <button type="button" aria-pressed={baseline === "previous-month"} onClick={() => setBaseline("previous-month")}>Last month</button>
          <button type="button" aria-pressed={baseline === "previous-year"} onClick={() => setBaseline("previous-year")}>Last year</button>
        </SlidingSelection>
        <div role="status" aria-live="polite" aria-busy={loading}>
          {loading && <p className="bb-comparison-note">Comparing matching days…</p>}
          {error && <p className="bb-comparison-note">Couldn’t load the comparison. <button type="button" onClick={() => reload((value) => value + 1)}>Try again</button></p>}
          {!loading && !error && comparison && <>
            <p className="bb-comparison-note">Dated recorded spending · days 1–{comparison.throughDay}</p>
            {comparison.baseline && comparison.selected && <>
              <div className="bb-comparison-values">
                <div><span>{reportMonthLabel(comparison.selectedMonth)}</span><FittedAmount className="bb-comparison-amount">{money(comparison.selected.datedSpending)}</FittedAmount></div>
                <div><span>{reportMonthLabel(comparison.baselineMonth)}</span><FittedAmount className="bb-comparison-amount">{money(comparison.baseline.datedSpending)}</FittedAmount></div>
              </div>
              {comparison.changeAmount !== null && <p className="bb-comparison-change">
                {comparison.changeAmount === 0 ? "The same spending" : `${money(Math.abs(comparison.changeAmount))} ${comparison.changeAmount < 0 ? "less" : "more"}`}
                {comparison.changePercent !== null && comparison.changePercent !== 0 ? ` (${Math.abs(comparison.changePercent)}%)` : ""}
              </p>}
            </>}
            <p className="bb-comparison-note">{comparison.coverageNote}</p>
            {comparison.status === "partial" && comparison.selected && comparison.baseline && <p className="bb-comparison-note">
              Without dates: {money(comparison.selected.undatedSpending)} / {money(comparison.baseline.undatedSpending)}.
              Scheduled subscriptions excluded: {money(comparison.selected.scheduledSpending)} / {money(comparison.baseline.scheduledSpending)}.
              {(comparison.selected.unitemizedSpending !== 0 || comparison.baseline.unitemizedSpending !== 0)
                && <> Sheet amounts outside dated records: {money(comparison.selected.unitemizedSpending)} / {money(comparison.baseline.unitemizedSpending)}.</>}
            </p>}
          </>}
        </div>
      </div>
    </CollapsibleContent>
  </section>
}
