import type { ExpenseAppState } from "./expense-app-session"

export function AppRefreshControl({ state, refresh }: { state: ExpenseAppState; refresh: () => void }) {
  const busy = state.phase === "loading" || state.phase === "refreshing"
  const stale = state.phase === "stale" || state.phase === "error"
  const updated = state.updatedAt === null ? null : new Date(state.updatedAt)
  const sameDay = updated?.toDateString() === new Date().toDateString()
  const time = updated?.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short" as const, day: "numeric" as const }),
    hour: "numeric", minute: "2-digit",
  })
  const status = state.signingOut ? "Signing out…" : busy ? "Refreshing…" : stale ? state.message : null

  return (
    <div className="bb-app-controls" data-state={state.phase}>
      <button className="bb-icon-button bb-app-refresh" type="button" disabled={busy || state.signingOut}
        aria-label={busy ? "Refreshing expenses" : "Refresh expenses"} title="Refresh expenses" onClick={refresh}>
        <svg className={busy ? "bb-app-refresh-icon is-refreshing" : "bb-app-refresh-icon"} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 7v5h-5M19.5 12a7.5 7.5 0 1 0-2 5.1M20 12l-3.4-3.4" />
        </svg>
      </button>
      <div className="bb-app-status" role="status" aria-live="polite" aria-atomic="true">
        {status && <span>{status}</span>}
        {updated && <time className="bb-app-updated" dateTime={updated.toISOString()} title={updated.toLocaleString()}>
          {stale ? "Showing" : "Updated"} {time}
        </time>}
      </div>
    </div>
  )
}
