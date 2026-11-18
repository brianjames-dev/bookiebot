import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { KonstaProvider } from "konsta/react"
import { ExpenseAppShell } from "./expense-app-shell"
import {useStartupSplash} from "./startup-splash"
import {useAppResource} from "./app-resource-state"
import {displayOverview} from "./overview-display-state"
import {clearAppResources} from "./app-resource-state"
import {reimbursementDisplay} from "./reimbursement-display-state"
import { AppWorkGuardProvider } from "./app-work-guard"
import { AuthFeedback } from "./account-settings"
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
    // Dependent sheet reports keep their last successful data until the shared
    // canonical state is projected. Coalesce changes instead of rereading Sheets
    // once for the action and again for its inverse.
    let changed=false,refreshTimer:number|undefined
    const flushChanges=()=>{
      window.clearTimeout(refreshTimer)
      if(!changed)return
      if(["signed-out","expired"].includes(current.state.phase)){changed=false;return}
      const owner=current.state.report?.ownerName??config.ownerName??''
      if(reimbursementDisplay.read(owner)?.projectionPending){refreshTimer=window.setTimeout(flushChanges,1000);return}
      changed=false;void current.refresh(true)
    }
    const refreshSettlements=()=>{changed=true;window.clearTimeout(refreshTimer);refreshTimer=window.setTimeout(flushChanges,0)}
    window.addEventListener("bookiebot:reimbursements-changed", refreshSettlements)
    window.addEventListener("bookiebot:transactions-changed", refreshSettlements)
    void current.refresh(true)
    return () => {
      window.clearTimeout(refreshTimer)
      stopWatching()
      window.removeEventListener("bookiebot:reimbursements-changed", refreshSettlements)
      window.removeEventListener("bookiebot:transactions-changed", refreshSettlements)
      unsubscribe()
      current.dispose()
      session.current = null
    }
  }, [config])
  return {
    state,
    refresh: async () => {
      const current = session.current
      if (!current) return false
      await current.refresh(true)
      return current.state.phase === "ready"
    },
    signOut: () => { void session.current?.signOut() },
    selectMonth: (month: string | null) => { void session.current?.selectMonth(month) },
    expire: () => { session.current?.expire() },
  }
}

export function FreshExpenseApp({ config }: { config: ExpenseAppConfig }) {
  return <KonstaProvider theme="ios" dark><AppWorkGuardProvider><AuthFeedback/><FreshExpenseContent config={config} /></AppWorkGuardProvider></KonstaProvider>
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
  useStartupSplash(Boolean(state.report)||["error","expired","signed-out","stale"].includes(state.phase))
  // Month selection intentionally clears the report while loading. Keep the
  // owner shell alive, but never present its old report as the requested month.
  const lastReport = useRef<ExpenseReportData | null>(null)
  if (disconnected) lastReport.current = null
  else if (state.report) lastReport.current = state.report
  const shellReport = state.report ?? lastReport.current
  const liveReimbursements=useAppResource(reimbursementDisplay,shellReport?.ownerName??config.ownerName)
  const displayedReport=useMemo(()=>displayOverview(shellReport,liveReimbursements),[shellReport,liveReimbursements])
  const resourceOwner=shellReport?.ownerName
  useLayoutEffect(()=>{if(disconnected)clearAppResources();return clearAppResources},[disconnected,resourceOwner])
  const avatarUrl = `/app/avatar.png?day=${new Date().toISOString().slice(0, 10)}`
  // Learning the initial owner hydrates the existing chrome. A subsequent
  // owner change still disposes all previous financial controllers and drafts.
  const ownerScope = useRef({ owner: "", generation: 0 })
  if (state.report) {
    if (ownerScope.current.owner && ownerScope.current.owner !== state.report.ownerName) ownerScope.current.generation++
    ownerScope.current.owner = state.report.ownerName
  }
  const controls = <AppRefreshControl state={state} refresh={refresh} showButton={false} />
  const reportMonth = state.report ? `${state.report.year}-${String(state.report.month).padStart(2, "0")}` : undefined
  const history = useReportMonthCatalog(!disconnected, expire, reportMonth, state.report)
  const monthControl = <MonthHistoryControl monthLabel={state.report?.monthLabel ?? reportMonthLabel(state.selectedMonth)}
    selectedMonth={state.selectedMonth} catalog={history.catalog} loading={history.loading} error={history.error} errorMessage={history.errorMessage}
    onSelect={selectMonth} onRetry={history.refresh} disabled={state.signingOut} />

  if (!disconnected) {
    return <ExpenseAppShell
      key={ownerScope.current.generation}
      report={displayedReport} ownerName={config.ownerName}
      monthlyReady={Boolean(state.report)}
      onRefresh={refresh} reportBusy={busy}
      questionMonth={state.selectedMonth ?? history.catalog?.currentMonth ?? reportMonth}
      controls={controls}
      initialVersion={config.version ?? ""}
      householdEnabled={config.householdEnabled}
      avatarUrl={avatarUrl}
      signOut={signOut} signingOut={state.signingOut}
      monthControl={monthControl}
      comparison={shellReport && <ReportComparison report={shellReport} onExpired={expire} refreshing={busy || !state.report}
        catalog={history.catalog} catalogLoading={history.loading} catalogError={history.error} catalogErrorMessage={history.errorMessage} onCatalogRetry={history.refresh} />}
    />
  }

  return (
    <div className="bb-page bb-app-welcome">
      <div className="bb-masthead">
        <span className="bb-wordmark"><img className="bb-app-avatar" src={avatarUrl} alt="" />BookieBot</span>
      </div>
      <main className="bb-app-opening" aria-busy={busy}>
        <h1>{state.phase === "signed-out" ? "You’re signed out" : "Reconnect to BookieBot"}</h1>
        <p role="status">{state.phase === "expired" ? "Your connection has expired." : "Your report is closed on this device."}</p>
        <ExpenseAppReconnect />
      </main>
    </div>
  )
}
