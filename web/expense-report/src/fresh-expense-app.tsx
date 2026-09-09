import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { KonstaProvider } from "konsta/react"
import { ExpenseAppShell } from "./expense-app-shell"
import { AppWorkGuardProvider } from "./app-work-guard"
import type { ExpenseReportData } from "./types"
import { ExpenseAppReconnect } from "./expense-app-reconnect"
import { AppRefreshControl } from "./app-refresh-control"
import { MonthHistoryControl, ReportComparison, reportMonthLabel, useReportMonthCatalog } from "./report-history"
import {
  ExpenseAppSession,
  initialExpenseAppState,
  watchExpenseAppLifecycle,
  type ExpenseAppConfig,
} from "./expense-app-session"

function useFreshExpenseReport(config: ExpenseAppConfig) {
  const [state, setState] = useState(initialExpenseAppState)
  const session = useRef<ExpenseAppSession | null>(null)
  useEffect(() => {
    const current = new ExpenseAppSession(config)
    session.current = current
    const unsubscribe = current.subscribe(setState)
    const stopWatching = watchExpenseAppLifecycle(current)
    const refreshSettlements = () => { void current.refresh(true) }
    window.addEventListener("bookiebot:reimbursements-changed", refreshSettlements)
    void current.refresh(true)
    return () => {
      stopWatching()
      window.removeEventListener("bookiebot:reimbursements-changed", refreshSettlements)
      unsubscribe()
      current.dispose()
      session.current = null
    }
  }, [config])
  return {
    state,
    refresh: () => { void session.current?.refresh(true) },
    signOut: () => { void session.current?.signOut() },
    selectMonth: (month: string | null) => { void session.current?.selectMonth(month) },
    expire: () => { session.current?.expire() },
  }
}

export function FreshExpenseApp({ config }: { config: ExpenseAppConfig }) {
  return <KonstaProvider theme="ios" dark><AppWorkGuardProvider><FreshExpenseContent config={config} /></AppWorkGuardProvider></KonstaProvider>
}

function FreshExpenseContent({ config }: { config: ExpenseAppConfig }) {
  useLayoutEffect(() => {
    try {
      const theme = window.localStorage.getItem("bookiebot-expense-report-theme")
      if (theme === "light" || theme === "dark") {
        document.documentElement.dataset.theme = theme
        document.documentElement.style.colorScheme = theme
      }
    } catch { /* The system theme still works when storage is unavailable. */ }
  }, [])
  const { state, refresh, signOut, selectMonth, expire } = useFreshExpenseReport(config)
  const busy = state.phase === "loading" || state.phase === "refreshing"
  const disconnected = state.phase === "expired" || state.phase === "signed-out"
  // Month selection intentionally clears the report while loading. Keep the
  // owner shell alive, but never present its old report as the requested month.
  const lastReport = useRef<ExpenseReportData | null>(null)
  if (disconnected) lastReport.current = null
  else if (state.report) lastReport.current = state.report
  const shellReport = state.report ?? lastReport.current
  const avatarUrl = `/app/avatar.png?day=${new Date().toISOString().slice(0, 10)}`
  const controls = <AppRefreshControl state={state} refresh={refresh} />
  const reportMonth = state.report ? `${state.report.year}-${String(state.report.month).padStart(2, "0")}` : undefined
  const history = useReportMonthCatalog(!disconnected, expire, reportMonth, state.report)
  const monthControl = <MonthHistoryControl monthLabel={state.report?.monthLabel ?? reportMonthLabel(state.selectedMonth)}
    selectedMonth={state.selectedMonth} catalog={history.catalog} loading={history.loading} error={history.error} errorMessage={history.errorMessage}
    onSelect={selectMonth} onRetry={history.refresh} disabled={state.signingOut} />

  if (shellReport) {
    return <ExpenseAppShell
      key={shellReport.ownerName}
      report={shellReport}
      monthlyReady={Boolean(state.report)}
      questionMonth={state.selectedMonth ?? history.catalog?.currentMonth ?? reportMonth}
      controls={controls}
      initialVersion={config.version ?? ""}
      avatarUrl={avatarUrl}
      signOut={signOut} signingOut={state.signingOut}
      monthControl={monthControl}
      comparison={<ReportComparison report={shellReport} onExpired={expire} refreshing={busy || !state.report}
        catalog={history.catalog} catalogLoading={history.loading} catalogError={history.error} catalogErrorMessage={history.errorMessage} onCatalogRetry={history.refresh} />}
    />
  }

  return (
    <div className="bb-page bb-app-welcome">
      <div className="bb-masthead">
        <span className="bb-wordmark"><img className="bb-app-avatar" src={avatarUrl} alt="" />BookieBot</span>
        {!disconnected && config.ownerName !== "BookieBot" && <span className="bb-app-owner">{config.ownerName}</span>}
      </div>
      <main className="bb-app-opening" aria-busy={busy}>
        <p className="bb-report-period">Your spending, at a glance</p>
        <h1>{disconnected ? state.phase === "signed-out" ? "You’re signed out" : "Reconnect to BookieBot" : monthControl}</h1>
        {disconnected ? (
          <div>
            <p role="status">{state.phase === "expired" ? "Your connection has expired." : "Your report is closed on this device."}</p>
            <ExpenseAppReconnect />
          </div>
        ) : <>
          {controls}
          {busy && <div className="bb-app-loading-sheet" aria-hidden="true"><span /><span /><span /><span /></div>}
        </>}
      </main>
    </div>
  )
}
