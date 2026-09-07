import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { ExpenseReportApp } from "./report-app"
import { ExpenseAppReconnect } from "./expense-app-reconnect"
import {
  ExpenseAppSession,
  expenseReportIdentity,
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
    void current.refresh(true)
    return () => {
      stopWatching()
      unsubscribe()
      current.dispose()
      session.current = null
    }
  }, [config])
  return {
    state,
    refresh: () => { void session.current?.refresh(true) },
    signOut: () => { void session.current?.signOut() },
  }
}

export function FreshExpenseApp({ config }: { config: ExpenseAppConfig }) {
  useLayoutEffect(() => {
    try {
      const theme = window.localStorage.getItem("bookiebot-expense-report-theme")
      if (theme === "light" || theme === "dark") {
        document.documentElement.dataset.theme = theme
        document.documentElement.style.colorScheme = theme
      }
    } catch { /* The system theme still works when storage is unavailable. */ }
  }, [])
  const { state, refresh, signOut } = useFreshExpenseReport(config)
  const busy = state.phase === "loading" || state.phase === "refreshing"
  const disconnected = state.phase === "expired" || state.phase === "signed-out"
  const avatarUrl = `/app/avatar.png?day=${new Date().toISOString().slice(0, 10)}`
  const updated = state.updatedAt === null ? null : new Date(state.updatedAt).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })
  const status = state.signingOut ? "Signing out…" : busy
    ? state.report ? "Refreshing your report…" : "Opening your report…"
    : state.phase === "stale" || state.phase === "error" ? state.message
    : "Your report is up to date."

  const controls = (
    <div className="bb-app-controls" data-state={state.phase}>
      <div className="bb-app-status" role="status" aria-live="polite" aria-atomic="true">
        <span>{status}</span>
        {updated && <span className="bb-app-updated">{state.phase === "stale" ? "Showing last update" : "Last updated"} {updated}</span>}
      </div>
      <div className="bb-app-buttons">
        <button className="bb-app-button" type="button" disabled={busy || state.signingOut} onClick={refresh}>
          <span className={busy ? "bb-app-refresh-icon is-refreshing" : "bb-app-refresh-icon"} aria-hidden="true">↻</span>
          {busy ? "Refreshing" : "Refresh"}
        </button>
        <button className="bb-app-button bb-app-signout" type="button" disabled={state.signingOut} onClick={signOut}>
          {state.signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  )

  if (state.report) {
    return <ExpenseReportApp
      key={expenseReportIdentity(state.report)}
      report={state.report}
      appControls={controls}
      appAvatarUrl={avatarUrl}
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
        <h1>{disconnected ? state.phase === "signed-out" ? "You’re signed out" : "Reconnect to BookieBot" : "Expense Breakdown"}</h1>
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
