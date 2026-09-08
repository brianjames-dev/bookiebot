import { useEffect, useId, useMemo, useRef, useState } from "react"
import { CollapsibleContent } from "./components/ui/motion"
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
  baselineKind: "previous-month" | "previous-year" | "selected-month"
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
class HistorySourceBusy extends Error {}

export async function requestReportHistory<T>(url: string, controller: AbortController, timeout = 30000): Promise<T> {
  const timer = setTimeout(() => controller.abort(), timeout)
  let abort: () => void = () => {}
  try {
    // Release the UI request slot independently of the browser transport. An
    // aborted fetch/body can remain suspended while a phone loses connectivity.
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error("Report history request interrupted"))
      controller.signal.addEventListener("abort", abort, { once: true })
      if (controller.signal.aborted) { abort(); return }
      fetch(url, {
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { "X-BookieBot-App": "1", Accept: "application/json" },
      }).then(async (response) => {
        if (response.status === 401) throw new HistorySessionExpired()
        if (!response.ok) {
          const detail = await response.json().catch(() => null)
          if (detail?.code === "sheets_rate_limited") throw new HistorySourceBusy()
          throw new Error("Report history is unavailable")
        }
        return await response.json() as T
      }).then(resolve, reject)
    })
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener("abort", abort)
  }
}

export function reportMonthLabel(value: string | null) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/Los_Angeles" }).format(new Date())
  }
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
        <option value="">{reportMonthLabel(catalog?.currentMonth ?? null)}</option>
        {options.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
      </select>
    </span>
    {(error || partial) && <span className="bb-history-catalog-status" role="status">
      {error ? "History couldn’t load." : "Some history is unavailable."} <button type="button" disabled={loading || disabled} onClick={onRetry}>Retry</button>
    </span>}
  </span>
}

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)

function ComparisonResult({ comparison }: { comparison: ReportPeriodComparison }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const { selected, baseline } = comparison
  if (!selected || !baseline) return <p className="bb-comparison-note">{comparison.coverageNote}</p>

  const excluded = [
    { label: "Without dates", selected: selected.undatedSpending, baseline: baseline.undatedSpending },
    { label: "Scheduled subscriptions", selected: selected.scheduledSpending, baseline: baseline.scheduledSpending },
    { label: "Sheet adjustments", selected: selected.unitemizedSpending, baseline: baseline.unitemizedSpending },
  ].filter((row) => row.selected !== 0 || row.baseline !== 0)
  const change = comparison.changeAmount
  return <>
    <p className="bb-comparison-note bb-comparison-period">Recorded spending · days 1–{comparison.throughDay}</p>
    <div className="bb-comparison-values">
      <div><span>{reportMonthLabel(comparison.selectedMonth)}</span><FittedAmount className="bb-comparison-amount">{money(selected.datedSpending)}</FittedAmount></div>
      <div><span>{reportMonthLabel(comparison.baselineMonth)}</span><FittedAmount className="bb-comparison-amount">{money(baseline.datedSpending)}</FittedAmount></div>
    </div>
    <div className="bb-comparison-footer">
      {change !== null && <p className="bb-comparison-change">
        {change === 0 ? "Same spending" : <><strong>{money(Math.abs(change))}</strong> {change < 0 ? "less" : "more"}</>}
        {comparison.changePercent !== null && comparison.changePercent !== 0 && <span className="bb-comparison-percent"> · {Math.abs(comparison.changePercent)}%</span>}
      </p>}
      <button type="button" className="bb-comparison-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId}
        onClick={() => setDetailsOpen((value) => !value)}>
        Details<span className="bb-disclosure-mark" aria-hidden="true" />
      </button>
    </div>
    <CollapsibleContent open={detailsOpen} id={detailsId}>
      <div className="bb-comparison-details">
        <p className="bb-comparison-note">{comparison.coverageNote}</p>
        {excluded.length > 0 && <table className="bb-comparison-exclusions">
          <caption>Excluded amounts</caption>
          <thead><tr><th scope="col">Type</th><th scope="col">{reportMonthLabel(comparison.selectedMonth)}</th><th scope="col">{reportMonthLabel(comparison.baselineMonth)}</th></tr></thead>
          <tbody>{excluded.map((row) => <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td><FittedAmount className="bb-comparison-excluded-amount">{money(row.selected)}</FittedAmount></td>
            <td><FittedAmount className="bb-comparison-excluded-amount">{money(row.baseline)}</FittedAmount></td>
          </tr>)}</tbody>
        </table>}
      </div>
    </CollapsibleContent>
  </>
}

export function ReportComparison({ report, onExpired, catalog, catalogLoading = false, catalogError = false, onCatalogRetry, refreshing = false }: {
  report: ExpenseReportData
  onExpired: () => void
  catalog?: ReportMonthCatalog | null
  catalogLoading?: boolean
  catalogError?: boolean
  onCatalogRetry?: () => void
  refreshing?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [chosenMonth, setChosenMonth] = useState<string | null>(null)
  const [comparison, setComparison] = useState<ReportPeriodComparison | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [revision, reload] = useState(0)
  const expired = useRef(onExpired)
  expired.current = onExpired
  const id = useId()
  const selectedMonth = `${report.year}-${String(report.month).padStart(2, "0")}`
  const previousMonth = `${report.month === 1 ? report.year - 1 : report.year}-${String(report.month === 1 ? 12 : report.month - 1).padStart(2, "0")}`
  const baseline = chosenMonth && chosenMonth !== selectedMonth ? chosenMonth : previousMonth
  const options = (catalog?.months ?? []).filter((month) => month.value !== selectedMonth && month.value !== previousMonth)
  // Results belong only to this displayed report. A fresh report invalidates
  // them; tab changes and disclosure motion do not discard useful live reads.
  // Keep one request in flight so quick selection changes cannot fill the
  // server's bounded queue with builds that the phone has already abandoned.
  const requests = useMemo(() => ({
    active: false,
    results: new Map<string, { result?: ReportPeriodComparison; failed?: boolean; message?: string }>(),
    pending: null as { controller: AbortController } | null,
  }), [report])
  useEffect(() => {
    requests.active = true
    return () => {
      requests.active = false
      requests.pending?.controller.abort()
      requests.pending = null
      requests.results.clear()
    }
  }, [requests])
  const refreshCycle = useRef(false)
  useEffect(() => {
    if (!refreshing && !refreshCycle.current) return
    refreshCycle.current = refreshing
    // A refresh is also an explicit recovery attempt. Clear failures on both
    // edges so a comparison that fails while refresh is busy gets one retry
    // when it finishes, including when the original report remains stale.
    for (const [month, saved] of requests.results) {
      if (saved.failed) requests.results.delete(month)
    }
  }, [refreshing, requests])
  useEffect(() => {
    if (!open) return
    const saved = requests.results.get(baseline)
    setComparison(saved?.result ?? null)
    setLoading(!saved)
    setError(saved?.failed ? saved.message ?? "Couldn’t load the comparison." : "")
    if (saved || requests.pending || refreshing) return
    const pending = { controller: new AbortController() }
    requests.pending = pending
    requestReportHistory<ReportPeriodComparison>(`/app/expenses/comparison?month=${selectedMonth}&compare_month=${baseline}`, pending.controller, 60000).then((result) => {
      if (result.selectedMonth !== selectedMonth || result.baselineMonth !== baseline || typeof result.coverageNote !== "string") {
        throw new Error("Comparison did not match the selected report")
      }
      if (requests.active && requests.pending === pending) requests.results.set(baseline, { result })
    }).catch((reason) => {
      if (!requests.active || requests.pending !== pending) return
      if (reason instanceof HistorySessionExpired) expired.current()
      // Session expiry is terminal even if the parent has not unmounted yet.
      requests.results.set(baseline, { failed: true, message: reason instanceof HistorySourceBusy
        ? "Google Sheets is temporarily busy. Wait about a minute, then try again."
        : "Couldn’t load the comparison." })
    }).finally(() => {
      if (requests.active && requests.pending === pending) {
        requests.pending = null
        reload((value) => value + 1)
      }
    })
  }, [open, baseline, requests, selectedMonth, revision, refreshing])

  return <section className="bb-report-comparison" aria-label="Spending comparison">
    <button type="button" className="bb-comparison-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      <span>Compare spending</span><span className="bb-disclosure-mark" aria-hidden="true" />
    </button>
    <CollapsibleContent open={open} id={id}>
      <div className="bb-comparison-content">
        <label className="bb-comparison-picker">
          <span>Compare with</span>
          <select aria-label="Comparison month" value={baseline} onChange={(event) => setChosenMonth(event.target.value)}>
            <option value={previousMonth}>{reportMonthLabel(previousMonth)}</option>
            {options.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
          </select>
        </label>
        {catalogLoading && !catalog && <p className="bb-comparison-note">Loading other months…</p>}
        {(catalogError || (catalog && catalog.coverage.status !== "complete")) && <p className="bb-comparison-note">
          Some comparison months couldn’t be checked. {onCatalogRetry && <button type="button" disabled={catalogLoading} onClick={onCatalogRetry}>Retry months</button>}
        </p>}
        <div role="status" aria-live="polite" aria-busy={loading}>
          {loading && <p className="bb-comparison-note">{refreshing && !requests.pending ? "Waiting for the refreshed report…" : "Comparing matching days…"}</p>}
          {error && <p className="bb-comparison-note">{error} <button type="button" onClick={() => { requests.results.delete(baseline); reload((value) => value + 1) }}>Try again</button></p>}
          {!loading && !error && comparison && <ComparisonResult key={`${comparison.selectedMonth}:${comparison.baselineMonth}`} comparison={comparison} />}
        </div>
      </div>
    </CollapsibleContent>
  </section>
}
