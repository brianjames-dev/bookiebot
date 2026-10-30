import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDownRight, ArrowLeftRight, ChevronDown } from "lucide-react"
import { FittedAmount } from "./components/ui/fitted-amount"
import { MonthPicker } from "./components/ui/month-picker"
import type { ExpenseReportData } from "./types"
import { useAppNavigation } from "./app-navigation"
import "./report-history.css"

export interface ReportMonthCatalog {
  currentMonth: string
  months: { value: string; label: string }[]
  coverage: { status: "complete" | "partial" | "unavailable"; unavailableYears: number[]; code?: "source_timeout" }
}

interface ComparisonPeriod {
  fromDate: string
  throughDate: string
  spending: number
  complete: boolean
}

interface ReportPeriodComparison {
  selectedMonth: string
  baselineMonth: string
  baselineKind: "previous-month" | "previous-year" | "selected-month"
  mode: "current" | "projected"
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
class HistorySourceTimeout extends Error {}
class HistoryRequestTimeout extends Error {}

function historyErrorMessage(reason: unknown, subject: "History" | "The comparison") {
  if (reason instanceof HistorySourceBusy) return "Google Sheets is temporarily busy. Wait about a minute, then try again."
  if (reason instanceof HistorySourceTimeout) return "Google Sheets took too long to respond. Try again shortly."
  if (reason instanceof HistoryRequestTimeout) return `${subject} is taking longer than expected. Try again.`
  return subject === "History" ? "History couldn’t load right now." : "Couldn’t load the comparison."
}

export async function requestReportHistory<T>(url: string, controller: AbortController, timeout = 30000): Promise<T> {
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
  let abort: () => void = () => {}
  try {
    // Release the UI request slot independently of the browser transport. An
    // aborted fetch/body can remain suspended while a phone loses connectivity.
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(timedOut ? new HistoryRequestTimeout() : new Error("Report history request interrupted"))
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
          if (detail?.code === "source_timeout") throw new HistorySourceTimeout()
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

export function useReportMonthCatalog(enabled: boolean, onExpired: () => void, reportMonth?: string, successfulReport?: ExpenseReportData | null) {
  const [catalog, setCatalog] = useState<ReportMonthCatalog | null>(null)
  const [error, setError] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [revision, reload] = useState(0)
  const expired = useRef(onExpired)
  expired.current = onExpired
  // Only an automatic current-month rollover needs a new catalog. Historical
  // selection changes use the existing picker options and the server validates.
  const current = useRef(reportMonth)
  const lastSuccess = useRef(successfulReport)
  const recoveryPending = useRef(false)
  useEffect(() => {
    if (reportMonth && current.current && reportMonth > current.current) reload((value) => value + 1)
    if (reportMonth && (!current.current || reportMonth > current.current)) current.current = reportMonth
  }, [reportMonth])
  useEffect(() => {
    if (successfulReport && successfulReport !== lastSuccess.current) recoveryPending.current = true
    lastSuccess.current = successfulReport
    if (!enabled) { recoveryPending.current = false; return }
    if (!recoveryPending.current || loading) return
    // One successful report can recover a failed catalog once. Wait for an
    // existing catalog read and consume the attempt before starting another.
    recoveryPending.current = false
    if (error || (catalog && catalog.coverage.status !== "complete")) reload((value) => value + 1)
  }, [successfulReport, enabled, loading, error, catalog])
  useEffect(() => {
    if (!enabled) { setCatalog(null); setError(false); setErrorMessage(""); setLoading(false); return }
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    setErrorMessage("")
    requestReportHistory<ReportMonthCatalog>("/app/expenses/months", controller).then((result) => {
      if (!/^\d{4}-\d{2}$/.test(result.currentMonth) || !Array.isArray(result.months)
        || !result.months.every((item) => /^\d{4}-\d{2}$/.test(item.value) && typeof item.label === "string")
        || !result.coverage) throw new Error("Invalid month catalog")
      if (active) setCatalog(result)
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof HistorySessionExpired) expired.current()
      else { setError(true); setErrorMessage(historyErrorMessage(reason, "History")) }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [enabled, revision])
  return { catalog, loading, error, errorMessage, refresh: () => reload((value) => value + 1) }
}

export function MonthHistoryControl({ monthLabel, selectedMonth, catalog, loading, error, errorMessage, onSelect, onRetry, disabled = false }: {
  monthLabel: string
  selectedMonth: string | null
  catalog: ReportMonthCatalog | null
  loading: boolean
  error: boolean
  errorMessage?: string
  onSelect: (value: string | null) => void
  onRetry: () => void
  disabled?: boolean
}) {
  const currentParts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", timeZone: "America/Los_Angeles" }).formatToParts(new Date())
  const currentMonth = catalog?.currentMonth ?? `${currentParts.find(part => part.type === "year")?.value}-${currentParts.find(part => part.type === "month")?.value}`
  const options = [{ value: currentMonth, label: reportMonthLabel(currentMonth) }, ...(catalog?.months.filter((month) => month.value !== currentMonth) ?? [])]
  if (selectedMonth && !options.some((item) => item.value === selectedMonth)) {
    options.unshift({ value: selectedMonth, label: reportMonthLabel(selectedMonth) })
  }
  const partial = catalog && catalog.coverage.status !== "complete"
  return <span className="bb-month-history">
    <MonthPicker label="Report month" value={selectedMonth ?? currentMonth} triggerLabel={monthLabel.replace(/\s+\d{4}\s*$/, "")} triggerDescription={monthLabel} variant="title"
      options={options} disabled={disabled || (loading && !catalog)}
      onSelect={(value) => onSelect(value === currentMonth ? null : value)} />
    {(error || partial) && <span className="bb-history-catalog-status" role="status">
      {error ? errorMessage || "History couldn’t load." : catalog?.coverage.code === "source_timeout"
        ? "Some history couldn’t be checked because Google Sheets timed out." : "Some history is unavailable."} <button type="button" disabled={loading || disabled} onClick={onRetry}>Retry</button>
    </span>}
  </span>
}

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)

// Measure the full-width body independently of the animated shell. Its width
// stays fixed throughout the morph so text never reflows on every animation frame.
function useComparisonFrame(open: boolean) {
  const slot = useRef<HTMLElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const expanded = useRef(open)
  const fit = useRef<() => void>(() => {})
  expanded.current = open
  useLayoutEffect(() => {
    const host = slot.current, frame = card.current, content = body.current, button = toggle.current
    if (!host || !frame || !content || !button) return
    const group = button.querySelector<HTMLElement>(".bb-comparison-toggle-group")!
    const measure = () => {
      const available = host.clientWidth
      // An inactive app tab has no geometry. ResizeObserver refits it on return.
      if (!available) return
      content.style.width = `${Math.max(0, available - 2)}px`
      // Add the 20px chevron, 12px gap, two 16px insets and 2px border.
      const compact = Math.min(available, Math.ceil(group.getBoundingClientRect().width + 66))
      frame.style.width = `${expanded.current ? available : compact}px`
      frame.style.height = `${expanded.current ? content.offsetHeight + 2 : 48}px`
    }
    fit.current = measure
    measure()
    const ready = requestAnimationFrame(() => { frame.dataset.ready = "true" })
    // The content's intrinsic height also changes for results and errors.
    // Observing it (rather than the animated frame) avoids feedback and snapping.
    let lastWidth = host.clientWidth
    let measureFrame = 0
    // Write outside observer delivery so a new shell height cannot cause a loop.
    const scheduleMeasure = () => {
      if (!measureFrame) measureFrame = requestAnimationFrame(() => { measureFrame = 0; measure() })
    }
    const observer = new ResizeObserver((entries) => {
      const width = host.clientWidth
      if (width !== lastWidth || entries.some((entry) => entry.target === content)) {
        lastWidth = width
        scheduleMeasure()
      }
    })
    observer.observe(host)
    observer.observe(content)
    document.fonts?.addEventListener("loadingdone", scheduleMeasure)
    return () => {
      cancelAnimationFrame(ready)
      cancelAnimationFrame(measureFrame)
      observer.disconnect()
      document.fonts?.removeEventListener("loadingdone", scheduleMeasure)
      fit.current = () => {}
    }
  }, [])
  useLayoutEffect(() => {
    if (!open && body.current?.contains(document.activeElement)) toggle.current?.focus({ preventScroll: true })
    fit.current()
  }, [open])
  return { slot, card, body, toggle }
}

export function ReportComparison({ report, onExpired, catalog, catalogLoading = false, catalogError = false, catalogErrorMessage, onCatalogRetry, refreshing = false }: {
  report: ExpenseReportData
  onExpired: () => void
  catalog?: ReportMonthCatalog | null
  catalogLoading?: boolean
  catalogError?: boolean
  catalogErrorMessage?: string
  onCatalogRetry?: () => void
  refreshing?: boolean
}) {
  const mode = useAppNavigation()?.preferences.mode ?? "current"
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
  const resultKey = `${baseline}:${mode}`
  const options = [{ value: previousMonth, label: reportMonthLabel(previousMonth) },
    ...(catalog?.months ?? []).filter((month) => month.value !== selectedMonth && month.value !== previousMonth)]
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
    const saved = requests.results.get(resultKey)
    setComparison(saved?.result ?? null)
    setLoading(!saved)
    setError(saved?.failed ? saved.message ?? "Couldn’t load the comparison." : "")
    if (saved || requests.pending || refreshing) return
    const pending = { controller: new AbortController() }
    requests.pending = pending
    requestReportHistory<ReportPeriodComparison>(`/app/expenses/comparison?month=${selectedMonth}&compare_month=${baseline}&mode=${mode}`, pending.controller, 60000).then((result) => {
      if (result.selectedMonth !== selectedMonth || result.baselineMonth !== baseline || result.mode !== mode || typeof result.coverageNote !== "string") {
        throw new Error("Comparison did not match the selected report")
      }
      if (requests.active && requests.pending === pending) requests.results.set(resultKey, { result })
    }).catch((reason) => {
      if (!requests.active || requests.pending !== pending) return
      if (reason instanceof HistorySessionExpired) expired.current()
      // Session expiry is terminal even if the parent has not unmounted yet.
      requests.results.set(resultKey, { failed: true, message: historyErrorMessage(reason, "The comparison") })
    }).finally(() => {
      if (requests.active && requests.pending === pending) {
        requests.pending = null
        reload((value) => value + 1)
      }
    })
  }, [open, baseline, mode, resultKey, requests, selectedMonth, revision, refreshing])

  const frame = useComparisonFrame(open)
  const ready = !loading && !error && comparison?.selectedMonth === selectedMonth && comparison.baselineMonth === baseline && comparison.mode === mode ? comparison : null
  const amounts = ready?.selected && ready.baseline ? [ready.selected.spending, ready.baseline.spending] : null
  const change = amounts ? ready!.changeAmount : null
  const direction = change === null || change === 0 ? "same" : change < 0 ? "less" : "more"
  const maximum = amounts ? Math.max(0, ...amounts) : 0
  const monthName = (value: string) => value.startsWith(`${report.year}-`) ? reportMonthLabel(value).replace(/\s+\d{4}$/, "") : reportMonthLabel(value)

  return <section ref={frame.slot} className="bb-report-comparison" aria-label="Spending comparison">
    <div ref={frame.card} className="bb-comparison-card" data-open={open} data-direction={direction}>
      <button ref={frame.toggle} type="button" className="bb-comparison-toggle" aria-label={open ? "Collapse comparison" : "Compare spending"}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        <span className="bb-comparison-toggle-group" aria-hidden={open}>
          <span className="bb-comparison-icon" aria-hidden="true"><ArrowLeftRight size={18} /></span>
          <span className="bb-comparison-copy">
            <span className="bb-comparison-title">Compare spending</span>
            <span className="bb-comparison-caption">A month-to-month view</span>
          </span>
        </span>
        <span className="bb-comparison-chevron" aria-hidden="true"><ChevronDown size={18} /></span>
      </button>
      <div className="bb-comparison-viewport" id={id} aria-hidden={!open} inert={!open}>
        <div ref={frame.body} className="bb-comparison-content">
          <div className="bb-comparison-hero" role="status" aria-live="polite" aria-busy={loading}>
            {loading && <p className="bb-comparison-note">{refreshing && !requests.pending ? "Waiting for the refreshed report…" : "Comparing matching days…"}</p>}
            {error && <p className="bb-comparison-note">{error} <button type="button" onClick={() => { requests.results.delete(resultKey); reload((value) => value + 1) }}>Try again</button></p>}
            {ready && !amounts && <p className="bb-comparison-note">{ready.coverageNote}</p>}
            {change !== null && <div className="bb-comparison-change">
              <div className="bb-comparison-hero-main">
                <FittedAmount className="bb-comparison-difference">{money(Math.abs(change))}</FittedAmount>
                {ready!.changePercent !== null && <span className="bb-comparison-percent">
                  {change !== 0 && <ArrowDownRight size={16} aria-hidden="true" />}{Math.abs(ready!.changePercent)}%
                </span>}
              </div>
              <p className="bb-comparison-direction">{change === 0 ? "Same spending" : `${direction} spending`}</p>
            </div>}
          </div>
          <div className={amounts ? "bb-comparison-months bb-comparison-values" : "bb-comparison-months"} aria-label={`${mode === "projected" ? "Projected" : "Current"} Spent by month`}>
            {[selectedMonth, baseline].map((month, index) => <div className="bb-comparison-month-row" data-baseline={index === 1} key={index}>
              <div className="bb-comparison-month-head">
                {index === 0 ? <span className="bb-comparison-month-name" aria-label={reportMonthLabel(month)}>{monthName(month)}</span>
                  : <MonthPicker label="Comparison month" value={baseline} options={options} onSelect={setChosenMonth}
                    triggerLabel={monthName(baseline)} triggerDescription={reportMonthLabel(baseline)} />}
                {amounts && <FittedAmount className="bb-comparison-amount">{money(amounts[index])}</FittedAmount>}
              </div>
              {amounts && <div className="bb-comparison-track" aria-hidden="true"><span className="bb-comparison-fill"
                style={{ width: `${maximum > 0 ? Math.max(0, amounts[index]) / maximum * 100 : 0}%` }} /></div>}
            </div>)}
          </div>
          {ready && amounts && <p className="bb-comparison-period">{mode === "projected" ? "Projected" : "Current"} Spent · days 1–{ready.throughDay}{ready.status === "partial" ? " · includes undated costs" : ""}</p>}
          {catalogLoading && !catalog && <p className="bb-comparison-note">Loading other months…</p>}
          {(catalogError || (catalog && catalog.coverage.status !== "complete")) && <p className="bb-comparison-note">
            {catalogError && catalogErrorMessage ? catalogErrorMessage : catalog?.coverage.code === "source_timeout"
              ? "Some comparison months couldn’t be checked because Google Sheets timed out."
              : "Some comparison months couldn’t be checked."} {onCatalogRetry && <button type="button" disabled={catalogLoading} onClick={onCatalogRetry}>Retry months</button>}
          </p>}
        </div>
      </div>
    </div>
  </section>
}
