import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, RefreshCw } from "lucide-react"
import { CollapsibleContent, SlidingSelection } from "./components/ui/motion"
import { useAppWorkStatus } from "./app-work-guard"
import "./reconciliation-screen.css"

type ReviewStatus = "needs_review" | "pending" | "checked" | "ignored"
interface Suggestion {
  id: string; item: string; date: string; amountCents: number; category: string
  amountMismatch: boolean; kind: "recorded" | "schedule"; confirmable: boolean; recorded?: boolean
}
export interface ReconciliationItem {
  id: number; version: string; status: ReviewStatus; date: string; merchant: string
  amountCents: number; currency: "USD"; accountLabel: string; suggestions: Suggestion[]
  matchedSuggestionId?: string | null; needsCheck?: boolean; readOnly?: boolean; matchLabel?: string | null
}
interface Snapshot { enabled: boolean; checkedAt: string | null; items: ReconciliationItem[]; notice?: string }
type Command = { operation: "check" } | { operation: "confirm" | "ignore" | "reopen"; id: number; version: string; suggestionId?: string }
const endpoint = "/app/reconciliation"
const isText = (value: unknown, max = 300): value is string => typeof value === "string" && value.length <= max
const isDate = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value))
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
function validItem(value: unknown): value is ReconciliationItem {
  const item = value as ReconciliationItem | null
  return Boolean(item && Number.isSafeInteger(item.id) && item.id !== 0 && isText(item.version) && item.version
    && ["needs_review", "pending", "checked", "ignored"].includes(item.status) && (item.date === "" || isDate(item.date))
    && isText(item.merchant, 500) && isAmount(item.amountCents) && item.currency === "USD" && isText(item.accountLabel)
    && (item.needsCheck === undefined || typeof item.needsCheck === "boolean")
    && (item.readOnly === undefined || typeof item.readOnly === "boolean")
    && (item.matchLabel === undefined || item.matchLabel === null || isText(item.matchLabel))
    && Array.isArray(item.suggestions) && item.suggestions.length <= 25 && item.suggestions.every(suggestion =>
      suggestion && isText(suggestion.id) && suggestion.id && isText(suggestion.item, 500) && isDate(suggestion.date)
      && isAmount(suggestion.amountCents) && isText(suggestion.category) && typeof suggestion.amountMismatch === "boolean"
      && ["recorded", "schedule"].includes(suggestion.kind) && typeof suggestion.confirmable === "boolean"
      && (suggestion.recorded === undefined || typeof suggestion.recorded === "boolean")))
}
function checkedSnapshot(value: unknown): Snapshot {
  const data = value as Snapshot | null
  if (!data || typeof data.enabled !== "boolean" || (data.checkedAt !== null && !isDate(data.checkedAt))
    || !Array.isArray(data.items) || data.items.length > 300 || !data.items.every(validItem)
    || new Set(data.items.map(item => item.id)).size !== data.items.length
    || (data.notice !== undefined && !isText(data.notice, 500))) throw new Error("Couldn’t read the latest bank review.")
  return data
}
class ReviewRequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }
async function request(path: string, controller: AbortController, body?: Command): Promise<unknown> {
  let abort = () => {}
  const timeout = window.setTimeout(() => controller.abort(), body?.operation === "check" ? 60_000 : 20_000)
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(new Error("The bank check took too long. Try again."))
      if (controller.signal.aborted) { abort(); return }
      controller.signal.addEventListener("abort", abort, { once: true })
      void fetch(path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error",
        headers: { "X-BookieBot-App": "1", "Content-Type": "application/json" }, signal: controller.signal,
      }).then(async response => {
        const value = await response.json()
        if (!response.ok) throw new ReviewRequestError(response.status === 401 ? "Reconnect BookieBot to review your bank transactions."
          : isText(value?.error) ? value.error : "Couldn’t finish the bank review. Try again.", response.status)
        return value
      }).then(resolve, reject)
    })
  } finally { window.clearTimeout(timeout); controller.signal.removeEventListener("abort", abort) }
}

export function useReconciliation() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [revision, setRevision] = useState(0)
  const mounted = useRef(false), current = useRef<AbortController | null>(null), blocked = useRef(false)
  const updateWork = useAppWorkStatus({ label: "Bank reconciliation", pending: busy, uncertain: needsRefresh })
  const load = useCallback(async (body?: Command) => {
    if (!mounted.current || current.current || (body && blocked.current)) return
    const controller = new AbortController()
    current.current = controller; setBusy(true); setError("")
    updateWork({ label: "Bank reconciliation", pending: true, uncertain: blocked.current })
    const active = () => mounted.current && current.current === controller
    try {
      const next = checkedSnapshot(await request(endpoint, controller, body))
      if (!active()) return
      setSnapshot(next); setRevision(value => value + 1); blocked.current = false; setNeedsRefresh(false)
    } catch (failure) {
      if (!active()) return
      const known = failure instanceof ReviewRequestError && failure.status < 500
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) {
        setSnapshot(null); blocked.current = false; setNeedsRefresh(false); setRevision(value => value + 1)
      } else if (body) { blocked.current = true; setNeedsRefresh(true) }
      setError(body && !known ? "This check may have finished. Check its status before trying another change."
        : failure instanceof Error ? failure.message : "Couldn’t load bank transactions.")
    } finally { if (active()) { current.current = null; setBusy(false) } }
  }, [updateWork])
  useEffect(() => {
    mounted.current = true; void load()
    const refresh = () => { if (document.visibilityState === "visible" && !blocked.current) void load() }
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh)
    return () => { mounted.current = false; current.current?.abort(); current.current = null
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh) }
  }, [load])
  const rejectAccess = useCallback((message: string) => {
    current.current?.abort(); current.current = null
    setSnapshot(null); setRevision(value => value + 1); setError(message); setBusy(false)
    blocked.current = false; setNeedsRefresh(false)
  }, [])
  return { snapshot, error, busy, needsRefresh, revision, load, rejectAccess }
}
type Controller = ReturnType<typeof useReconciliation>
const filterLabels = { needs_review: "Needs review", pending: "Pending", checked: "Checked" } as const
type Filter = keyof typeof filterLabels
const dateLabel = (value: string) => value ? new Date(value.includes("T") ? value : `${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Date unavailable"
const money = (value: number) => `${value < 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(value) / 100)}`
const statusLabel = (value: ReviewStatus) => value === "ignored" ? "Ignored" : value === "checked" ? "Matched" : value === "pending" ? "Pending" : "Needs review"

export function ReconciliationScreen({ controller }: { controller: Controller }) {
  const { snapshot, error, busy, needsRefresh, revision, load, rejectAccess } = controller
  const [filter, setFilter] = useState<Filter>("needs_review")
  const [openId, setOpenId] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, ReconciliationItem>>({})
  const [detailError, setDetailError] = useState("")
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailRetry, setDetailRetry] = useState(0)
  const rows = snapshot?.items ?? []
  const matchesFilter = (item: ReconciliationItem) => filter === "checked" ? ["checked", "ignored"].includes(item.status) : item.status === filter
  const openRow = rows.find(item => item.id === openId && matchesFilter(item))
  useEffect(() => { if (openId !== null && !openRow) setOpenId(null) }, [openId, openRow])
  useEffect(() => { setDetails({}) }, [revision])
  useEffect(() => {
    setDetailError("")
    if (openId === null || !openRow || !snapshot?.enabled) { setLoadingDetail(false); return }
    const controller = new AbortController(); let active = true
    setLoadingDetail(true)
    void request(`${endpoint}/${openId}`, controller).then(value => {
      const item = (value as { item?: unknown })?.item
      if (!validItem(item) || item.id !== openId) throw new Error("This transaction changed. Check again.")
      if (active) setDetails(previous => ({ ...previous, [item.id]: item }))
    }).catch(failure => { if (active) {
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) { setDetails({}); rejectAccess(failure.message) }
      else if (failure instanceof ReviewRequestError && [404, 409].includes(failure.status)) {
        // Close the obsolete review before refreshing so a changing bank row
        // cannot create a detail → list → detail retry loop.
        setDetails({}); setOpenId(null); void load()
      }
      setDetailError(failure instanceof Error ? failure.message : "Couldn’t load suggestions.")
    } })
      .finally(() => { if (active) setLoadingDetail(false) })
    return () => { active = false; controller.abort() }
  }, [openId, revision, detailRetry, snapshot?.enabled, rejectAccess, load])
  const visibleRows = rows.filter(matchesFilter)
  const mutate = (item: ReconciliationItem, operation: "confirm" | "ignore" | "reopen", suggestionId?: string) => {
    if (busy || needsRefresh || loadingDetail || detailError || item.id <= 0 || item.needsCheck || item.readOnly || item.status === "pending") return
    void load({ operation, id: item.id, version: item.version, ...(suggestionId ? { suggestionId } : {}) })
  }
  return <section className="bb-reconcile" aria-labelledby="bb-reconcile-title">
    <div className="bb-reconcile-heading"><div><h1 id="bb-reconcile-title">Reconcile</h1><p className="bb-reconcile-muted">{snapshot?.checkedAt
      ? `Checked ${new Date(snapshot.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Ready to check your logged expenses"}</p></div>
      <button type="button" className="bb-reconcile-check" disabled={busy || needsRefresh} onClick={() => void load({ operation: "check" })}><RefreshCw size={17} aria-hidden="true" />{busy ? "Checking…" : "Check"}</button></div>
    <SlidingSelection value={filter} className="bb-reconcile-filters" role="group" aria-label="Transaction status">
      {(Object.keys(filterLabels) as Filter[]).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setOpenId(null) }}>
        {filterLabels[value]}<span>{rows.filter(item => value === "checked" ? ["checked", "ignored"].includes(item.status) : item.status === value).length}</span></button>)}
    </SlidingSelection>
    {error && <div className="bb-reconcile-message" role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => void load()}>{needsRefresh ? "Check status" : "Try again"}</button></div>}
    {snapshot?.notice && <p className="bb-reconcile-muted" role="status">{snapshot.notice}</p>}
    {filter === "pending" && visibleRows.length > 0 && <p className="bb-reconcile-muted">Bank amounts may change. Matches stay tentative until posted.</p>}
    {!visibleRows.length && <div className="bb-reconcile-empty"><Check size={22} aria-hidden="true" /><p>{filter === "needs_review" ? "Nothing needs review." : filter === "pending" ? "No pending transactions." : "No checked transactions yet."}</p></div>}
    <div className="bb-reconcile-list">{visibleRows.map(item => { const detail = details[item.id]; return <TransactionRow key={item.id} item={item} open={openId === item.id}
      onToggle={() => setOpenId(value => value === item.id ? null : item.id)}>
      {openId === item.id && loadingDetail && <p className="bb-reconcile-muted" role="status">Finding logged expenses…</p>}
      {openId === item.id && detailError && <div className="bb-reconcile-message" role="alert"><p>{detailError}</p><button type="button" onClick={() => setDetailRetry(value => value + 1)}>Try suggestions again</button></div>}
      {detail?.id === item.id && <>
        {detail.matchLabel && <p className="bb-reconcile-matched"><Check size={15} aria-hidden="true" />{detail.matchLabel}</p>}
        {detail.readOnly && <p className="bb-reconcile-muted">Finish this transaction in BookieBot before checking again.</p>}
        {detail.suggestions.map(suggestion => <div className="bb-reconcile-suggestion" key={suggestion.id}>
          <div className="bb-reconcile-suggestion-title"><strong>{suggestion.item}</strong><span>{money(suggestion.amountCents)}</span></div>
          <p className="bb-reconcile-muted">{suggestion.kind === "schedule" ? suggestion.recorded ? "Scheduled payment" : "Not logged yet" : detail.amountCents < 0 ? "Logged income" : "Logged expense"} · {dateLabel(suggestion.date)}{suggestion.category && !["expense", "income", "schedule"].includes(suggestion.category.toLowerCase()) ? ` · ${suggestion.category}` : ""}</p>
          {suggestion.amountMismatch || suggestion.amountCents !== Math.abs(detail.amountCents) ? <div className="bb-reconcile-mismatch"><p><span>{suggestion.kind === "schedule" && !suggestion.recorded ? "Scheduled" : "Logged"}</span><strong>{money(suggestion.amountCents)}</strong><span aria-hidden="true">→</span><span>Bank</span><strong>{money(detail.amountCents)}</strong></p><p>{detail.status === "pending" ? "Wait for the payment to post before changing the logged amount." : suggestion.kind === "schedule" && !suggestion.recorded ? "Log the payment in BookieBot, then check again." : "Update the logged amount in BookieBot, then check again."}</p></div>
            : detail.status === "pending" ? <p className="bb-reconcile-muted">Tentative match</p>
              : detail.id > 0 && !detail.needsCheck && !detail.readOnly && detail.status === "needs_review" && suggestion.confirmable && <button type="button" className="bb-reconcile-action" disabled={busy || needsRefresh || loadingDetail || Boolean(detailError)} onClick={() => mutate(detail, "confirm", suggestion.id)}>Confirm match</button>}
        </div>)}
        {!detail.suggestions.length && detail.status === "needs_review" && !detail.readOnly && <p className="bb-reconcile-muted">Log it in BookieBot, then check again.</p>}
        {!detail.suggestions.length && detail.status === "pending" && <p className="bb-reconcile-muted">No tentative match yet.</p>}
        {(detail.needsCheck || detail.id < 0) && detail.status !== "pending" && !detail.readOnly && <button type="button" className="bb-reconcile-action" disabled={busy || needsRefresh} onClick={() => void load({ operation: "check" })}>Check for matches</button>}
        {detail.id > 0 && !detail.needsCheck && !detail.readOnly && detail.status !== "pending" && <button type="button" className="bb-reconcile-action bb-reconcile-secondary" disabled={busy || needsRefresh || loadingDetail || Boolean(detailError)}
          onClick={() => mutate(detail, detail.status === "needs_review" ? "ignore" : "reopen")}>{detail.status === "needs_review" ? "Ignore transaction" : "Reopen review"}</button>}
      </>}
    </TransactionRow> })}</div>
  </section>
}
function TransactionRow({ item, open, onToggle, children }: { item: ReconciliationItem; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const id = useId(), Direction = item.amountCents < 0 ? ArrowDownLeft : ArrowUpRight
  return <article className="bb-reconcile-row" data-open={open}>
    <button type="button" className="bb-reconcile-row-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <Direction className="bb-reconcile-direction" size={18} aria-hidden="true" /><span className="bb-reconcile-row-label"><strong>{item.merchant || "Bank transaction"}</strong><small>{dateLabel(item.date)} · {item.accountLabel}</small></span>
      <span className="bb-reconcile-row-amount"><strong>{money(item.amountCents)}</strong><small>{statusLabel(item.status)}</small></span><ChevronDown className="bb-reconcile-chevron" size={16} aria-hidden="true" />
    </button><CollapsibleContent open={open} id={id}><div className="bb-reconcile-row-details">{children}</div></CollapsibleContent>
  </article>
}
