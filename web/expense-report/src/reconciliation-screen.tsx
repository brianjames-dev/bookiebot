import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, RefreshCw } from "lucide-react"
import { CollapsibleContent, SlidingSelection } from "./components/ui/motion"
import { useAppWorkStatus } from "./app-work-guard"
import "./reconciliation-screen.css"

type ReviewStatus = "needs_review" | "pending" | "checked" | "ignored"
interface Suggestion {
  id: string; item: string; date: string; amountCents: number; category: string
  amountMismatch: boolean; kind: "recorded" | "schedule"; confirmable: boolean; recorded?: boolean; confidence?: number
}
export interface ReconciliationItem {
  id: number; version: string; stateVersion?: string; loadedAt?: number; status: ReviewStatus; date: string; merchant: string
  amountCents: number; currency: "USD"; accountLabel: string; suggestions: Suggestion[]
  logging?: { allowed: boolean; kind: "expense" | "income"; categories: string[]; paymentMethods: string[]; reason: string }; matchedSuggestionId?: string | null; needsCheck?: boolean; readOnly?: boolean; scheduleRecovery?: boolean; matchLabel?: string | null
}
interface ConnectionIssue { id: number; institution: string; needsReconnect: boolean; reconnectUrl?: string }
interface Snapshot { enabled: boolean; checkedAt: string | null; items: ReconciliationItem[]; notice?: string; connections?: ConnectionIssue[] }
type Command = { operation: "check" } | { operation: "confirm" | "update_match" | "update_schedule" | "recover_schedule" | "log" | "ignore" | "reopen"; id: number; version: string; suggestionId?: string; fields?: Record<string, string>; scheduleVersion?: string; updateFuture?: boolean; splitMethod?: string }
const endpoint = "/app/reconciliation"
const isText = (value: unknown, max = 300): value is string => typeof value === "string" && value.length <= max
const isDate = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value))
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
function validItem(value: unknown): value is ReconciliationItem {
  const item = value as ReconciliationItem | null
  return Boolean(item && Number.isSafeInteger(item.id) && item.id !== 0 && isText(item.version) && item.version
    && (item.stateVersion === undefined || isText(item.stateVersion))
    && (item.logging === undefined || (typeof item.logging.allowed === "boolean" && ["expense", "income"].includes(item.logging.kind)
      && Array.isArray(item.logging.categories) && item.logging.categories.every(value => isText(value))
      && Array.isArray(item.logging.paymentMethods) && item.logging.paymentMethods.every(value => isText(value)) && isText(item.logging.reason)))
    && ["needs_review", "pending", "checked", "ignored"].includes(item.status) && (item.date === "" || isDate(item.date))
    && isText(item.merchant, 500) && isAmount(item.amountCents) && item.currency === "USD" && isText(item.accountLabel)
    && (item.needsCheck === undefined || typeof item.needsCheck === "boolean")
    && (item.scheduleRecovery === undefined || typeof item.scheduleRecovery === "boolean")
    && (item.readOnly === undefined || typeof item.readOnly === "boolean")
    && (item.matchLabel === undefined || item.matchLabel === null || isText(item.matchLabel))
    && Array.isArray(item.suggestions) && item.suggestions.length <= 25 && item.suggestions.every(suggestion =>
      suggestion && isText(suggestion.id) && suggestion.id && isText(suggestion.item, 500) && isDate(suggestion.date)
      && isAmount(suggestion.amountCents) && isText(suggestion.category) && typeof suggestion.amountMismatch === "boolean"
      && ["recorded", "schedule"].includes(suggestion.kind) && typeof suggestion.confirmable === "boolean"
      && (suggestion.recorded === undefined || typeof suggestion.recorded === "boolean")
      && (suggestion.confidence === undefined || (Number.isFinite(suggestion.confidence) && suggestion.confidence >= 0 && suggestion.confidence <= 1))))
}
function checkedSnapshot(value: unknown): Snapshot {
  const data = value as Snapshot | null
  if (!data || typeof data.enabled !== "boolean" || (data.checkedAt !== null && !isDate(data.checkedAt))
    || !Array.isArray(data.items) || data.items.length > 300 || !data.items.every(validItem)
    || new Set(data.items.map(item => item.id)).size !== data.items.length
    || (data.notice !== undefined && !isText(data.notice, 500))
    || (data.connections !== undefined && (!Array.isArray(data.connections) || data.connections.length > 50
      || !data.connections.every(connection => connection && Number.isSafeInteger(connection.id) && connection.id > 0
        && isText(connection.institution) && typeof connection.needsReconnect === 'boolean'
        && (!connection.needsReconnect || (typeof connection.reconnectUrl === 'string'
          && /^\/bank\/link\?token=[A-Za-z0-9_.%-]+$/.test(connection.reconnectUrl))))))) throw new Error("Couldn’t read the latest bank review.")
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
  const [pendingOperation, setPendingOperation] = useState<Command["operation"] | null>(null)
  const [revision, setRevision] = useState(0)
  const mounted = useRef(false), current = useRef<AbortController | null>(null), blocked = useRef(false)
  const updateWork = useAppWorkStatus({ label: "Bank reconciliation", pending: busy, uncertain: needsRefresh })
  const load = useCallback(async (body?: Command) => {
    if (!mounted.current || current.current || (body && blocked.current)) return
    const controller = new AbortController()
    current.current = controller; setBusy(true); setPendingOperation(body?.operation ?? null); setError("")
    updateWork({ label: "Bank reconciliation", pending: true, uncertain: blocked.current })
    const active = () => mounted.current && current.current === controller
    try {
      const next = checkedSnapshot(await request(endpoint, controller, body))
      if (!active()) return
      if (blocked.current || (body && ["update_match", "update_schedule", "recover_schedule", "log"].includes(body.operation))) window.dispatchEvent(new Event("bookiebot:transactions-changed"))
      setSnapshot(next); setRevision(value => value + 1); blocked.current = false; setNeedsRefresh(false)
    } catch (failure) {
      if (!active()) return
      const known = failure instanceof ReviewRequestError && failure.status < 500
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) {
        setSnapshot(null); blocked.current = false; setNeedsRefresh(false); setRevision(value => value + 1)
      } else if (body) { blocked.current = true; setNeedsRefresh(true) }
      setError(body && !known ? "This check may have finished. Check its status before trying another change."
        : failure instanceof Error ? failure.message : "Couldn’t load bank transactions.")
    } finally { if (active()) { current.current = null; setBusy(false); setPendingOperation(null) } }
  }, [updateWork])
  useEffect(() => {
    mounted.current = true; void load()
    const refresh = () => { if (document.visibilityState === "visible" && !blocked.current) void load() }
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { mounted.current = false; current.current?.abort(); current.current = null
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh)
      document.removeEventListener("visibilitychange", refresh) }
  }, [load])
  const rejectAccess = useCallback((message: string) => {
    current.current?.abort(); current.current = null
    setSnapshot(null); setRevision(value => value + 1); setError(message); setBusy(false)
    blocked.current = false; setNeedsRefresh(false)
  }, [])
  return { snapshot, error, busy, needsRefresh, revision, pendingOperation, load, rejectAccess }
}
type Controller = ReturnType<typeof useReconciliation>
const filterLabels = { needs_review: "Needs review", pending: "Pending", checked: "Checked" } as const
type Filter = keyof typeof filterLabels
const dateLabel = (value: string) => value ? new Date(value.includes("T") ? value : `${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Date unavailable"
const money = (value: number) => `${value < 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(value) / 100)}`
const statusLabel = (value: ReviewStatus) => value === "ignored" ? "Ignored" : value === "checked" ? "Matched" : value === "pending" ? "Pending" : "Needs review"

export function ReconciliationScreen({ controller }: { controller: Controller }) {
  const { snapshot, error, busy, needsRefresh, revision, pendingOperation, load, rejectAccess } = controller
  const [filter, setFilter] = useState<Filter>("needs_review")
  const [openId, setOpenId] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, ReconciliationItem>>({})
  const [detailError, setDetailError] = useState("")
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailRetry, setDetailRetry] = useState(0)
  const rows = snapshot?.items ?? []
  const matchesFilter = (item: ReconciliationItem) => filter === "checked" ? ["checked", "ignored"].includes(item.status) : item.status === filter
  const openRow = rows.find(item => item.id === openId && matchesFilter(item))
  useEffect(() => { if (needsRefresh) setDetails(previous => Object.fromEntries(Object.entries(previous).map(([id, item]) => [id, { ...item, loadedAt: 0 }]))) }, [needsRefresh])
  useEffect(() => { if (openId !== null && !openRow) setOpenId(null) }, [openId, openRow])
  // Keep source previews for unchanged bank/review versions for up to 30 seconds.
  // Every financial confirmation still validates fresh server-side evidence.
  useEffect(() => { setDetails(previous => Object.fromEntries(Object.entries(previous).filter(([id, detail]) => {
    const row = rows.find(entry => entry.id === Number(id))
    return row && (row.stateVersion ?? row.version) === (detail.stateVersion ?? detail.version)
  }))) }, [revision])
  useEffect(() => {
    setDetailError("")
    if (openId === null || !openRow || !snapshot?.enabled) { setLoadingDetail(false); return }
    const cached = details[openId]
    if (cached && (cached.stateVersion ?? cached.version) === (openRow.stateVersion ?? openRow.version)
      && Date.now() - (cached.loadedAt ?? 0) < 30_000) { setLoadingDetail(false); return }
    const controller = new AbortController(); let active = true
    setLoadingDetail(true)
    void request(`${endpoint}/${openId}`, controller).then(value => {
      const item = (value as { item?: unknown })?.item
      if (!validItem(item) || item.id !== openId) throw new Error("This transaction changed. Check again.")
      if (active) setDetails(previous => ({ ...previous, [item.id]: { ...item, loadedAt: Date.now() } }))
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
  return <section className="bb-reconcile" aria-labelledby="bb-reconcile-title">
    <div className="bb-reconcile-heading"><div><h1 id="bb-reconcile-title">Reconcile</h1><p className="bb-reconcile-muted">{snapshot?.checkedAt
      ? `Checked ${new Date(snapshot.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Review your logged expenses"}</p></div>
      <button type="button" className="bb-reconcile-check" disabled={!snapshot?.enabled || busy || needsRefresh} onClick={() => void load({ operation: "check" })}><RefreshCw size={17} aria-hidden="true" />{busy ? "Checking…" : "Check"}</button></div>
    {snapshot?.enabled && <SlidingSelection value={filter} className="bb-reconcile-filters" role="group" aria-label="Transaction status">
      {(Object.keys(filterLabels) as Filter[]).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setOpenId(null) }}>
        {filterLabels[value]}<span>{rows.filter(item => value === "checked" ? ["checked", "ignored"].includes(item.status) : item.status === value).length}</span></button>)}
    </SlidingSelection>}
    {!snapshot && !error && <p className="bb-reconcile-muted" role="status">Loading bank transactions…</p>}
    {error && <div className="bb-reconcile-message" role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => void load()}>{needsRefresh ? "Check status" : "Try again"}</button></div>}
    {busy && pendingOperation && pendingOperation !== "check" && <p className="bb-reconcile-muted" role="status">Saving your review…</p>}
    {snapshot?.notice && <div className="bb-reconcile-message" role={snapshot.connections?.length ? 'alert' : 'status'}><p>{snapshot.notice}</p>
      <div className="bb-reconcile-recovery-actions">
      {snapshot.connections?.filter(connection => connection.needsReconnect).map(connection => <a key={connection.id}
        className="bb-reconcile-action" href={connection.reconnectUrl}>Reconnect {connection.institution}</a>)}
      {!!snapshot.connections?.length && <button type="button" className="bb-reconcile-action" disabled={busy || needsRefresh}
        onClick={() => void load({ operation: "check" })}>Resync bank information</button>}</div></div>}
    {filter === "pending" && visibleRows.length > 0 && <p className="bb-reconcile-muted">Bank amounts may change. Matches stay tentative until posted.</p>}
    {snapshot?.enabled && !visibleRows.length && <div className="bb-reconcile-empty"><Check size={22} aria-hidden="true" /><p>{filter === "needs_review" ? snapshot.connections?.length ? "No saved transactions need review." : "Nothing needs review." : filter === "pending" ? "No pending transactions." : "No checked transactions yet."}</p></div>}
    <div className="bb-reconcile-list">{visibleRows.map(item => { const detail = details[item.id]; return <TransactionRow key={item.id} item={item} open={openId === item.id}
      onToggle={() => setOpenId(value => value === item.id ? null : item.id)}>
      {openId === item.id && loadingDetail && <p className="bb-reconcile-muted" role="status">Finding sheet entries…</p>}
      {openId === item.id && detailError && <div className="bb-reconcile-message" role="alert"><p>{detailError}</p><button type="button" onClick={() => { setDetails({}); setDetailRetry(value => value + 1) }}>Try suggestions again</button></div>}
      {detail?.id === item.id && <>
        {detail.matchLabel && <p className="bb-reconcile-matched"><Check size={15} aria-hidden="true" />{detail.matchLabel}</p>}
        {detail.scheduleRecovery && <button type="button" className="bb-reconcile-action bb-reconcile-outline" disabled={busy || needsRefresh}
          onClick={() => void load({ operation: "recover_schedule", id: detail.id, version: detail.stateVersion ?? detail.version })}>Verify saved payment change</button>}
        {detail.readOnly && <p className="bb-reconcile-muted">{detail.scheduleRecovery ? "A sheet change may have finished. Verify the saved amounts without writing them again." : "Finish this transaction in BookieBot before checking again."}</p>}
        <ReviewChoices key={detail.version} item={detail} disabled={busy || needsRefresh || loadingDetail || Boolean(detailError)} onCommand={command => void load(command)} onRejectAccess={rejectAccess} onRefresh={() => { setDetails({}); setDetailRetry(value => value + 1) }} />
        {(detail.needsCheck || detail.id < 0) && detail.status !== "pending" && !detail.readOnly && <button type="button" className="bb-reconcile-action" disabled={busy || needsRefresh} onClick={() => void load({ operation: "check" })}>Check for matches</button>}
        {detail.id > 0 && !detail.needsCheck && !detail.readOnly && detail.status !== "pending" && <button type="button" className="bb-reconcile-action bb-reconcile-secondary" disabled={busy || needsRefresh || loadingDetail || Boolean(detailError)}
          onClick={() => void load({ operation: detail.status === "needs_review" ? "ignore" : "reopen", id: detail.id, version: detail.stateVersion ?? detail.version })}>{detail.status === "needs_review" ? "Ignore transaction" : "Reopen review"}</button>}
      </>}
    </TransactionRow> })}</div>
  </section>
}
function ReviewChoices({ item, disabled, onCommand, onRefresh, onRejectAccess }: { item: ReconciliationItem; disabled: boolean; onCommand: (command: Command) => void; onRefresh: () => void; onRejectAccess: (message: string) => void }) {
  const recommended = item.suggestions.find((_, index) => index === 0 && (item.suggestions[0].confidence ?? 1) >= .72)
  const [selectedId, setSelectedId] = useState(recommended?.id ?? "")
  const [reviewAmount, setReviewAmount] = useState(false)
  const [logging, setLogging] = useState<"" | "edit" | "review">("")
  const [fields, setFields] = useState<Record<string, string>>((): Record<string, string> => item.amountCents < 0
    ? { source: item.merchant, label: "" }
    : { category: "", item: item.merchant, location: item.merchant, person: item.logging?.paymentMethods.length === 1 ? item.logging.paymentMethods[0] : "" })
  const discardDraft = useCallback(() => { setLogging(""); setReviewAmount(false) }, [])
  useAppWorkStatus({ label: "Bank entry review", dirty: Boolean(logging || reviewAmount), onDiscard: discardDraft })
  const selected = item.suggestions.find(entry => entry.id === selectedId)
  const editable = item.status === "needs_review" && item.id > 0 && !item.needsCheck && !item.readOnly
  const choose = (suggestion: Suggestion) => { setSelectedId(suggestion.id); setReviewAmount(false); setLogging("") }
  const card = (suggestion: Suggestion) => <div key={suggestion.id} className="bb-reconcile-suggestion" data-selected={selectedId === suggestion.id}>
    {suggestion.id === recommended?.id && <p className="bb-reconcile-eyebrow">Suggested match</p>}
    <button type="button" className="bb-reconcile-choice" aria-pressed={selectedId === suggestion.id} disabled={disabled} onClick={() => choose(suggestion)}>
      <span className="bb-reconcile-suggestion-title"><strong>{suggestion.item}</strong><span>{money(suggestion.amountCents)}</span></span>
      <span className="bb-reconcile-muted">{suggestion.kind === "schedule" ? suggestion.recorded ? "Scheduled payment" : "Scheduled · not recorded in sheet" : item.amountCents < 0 ? "Logged income" : suggestion.category === "Payment" ? "Logged bill payment · full amount" : "Logged expense"} · {dateLabel(suggestion.date)}</span>
      <span className="bb-reconcile-muted">{suggestion.amountCents === Math.abs(item.amountCents) ? "Amount matches bank" : `Sheet ${money(suggestion.amountCents)} → Bank ${money(item.amountCents)}`}{selectedId === suggestion.id ? " · Selected" : " · Choose this entry"}</span>
    </button>
  </div>
  if (item.readOnly || ["checked", "ignored"].includes(item.status)) return null
  const others = item.suggestions.filter(entry => entry.id !== recommended?.id)
  const send = (operation: "confirm" | "update_match") => onCommand({ operation, id: item.id, version: item.version, suggestionId: selectedId })
  const readyToLog = item.amountCents < 0 ? Boolean(fields.source.trim()) : Boolean(fields.category && fields.item.trim() && fields.person)
  return <div className="bb-reconcile-choices">
    {!recommended && <p className="bb-reconcile-muted">{item.status === "pending" ? "No close tentative match yet." : "No close match found in your budget sheet."}</p>}
    {recommended && card(recommended)}
    {others.length > 0 && <details className="bb-reconcile-alternatives"><summary>Other possible entries ({others.length})</summary>{others.map(card)}</details>}
    {item.status === "pending" && <p className="bb-reconcile-muted">{selected?.amountMismatch ? "Wait for the payment to post before changing the logged amount." : "Tentative match · review after the bank posts it."}</p>}
    {editable && selected && !logging && <div className="bb-reconcile-decision">
      {selected.kind === "schedule" && (!selected.recorded || selected.amountCents !== Math.abs(item.amountCents)) ? item.logging?.allowed === false
        ? <p className="bb-reconcile-muted">Scheduled payment changes are available for the current month.</p>
        : reviewAmount ? <ScheduleAmountReview item={item} suggestion={selected} disabled={disabled} onCommand={onCommand} onCancel={() => setReviewAmount(false)} onRefresh={onRefresh} onRejectAccess={onRejectAccess} />
        : <button type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} onClick={() => setReviewAmount(true)}>Review payment change</button>
      : selected.amountCents !== Math.abs(item.amountCents) ? reviewAmount ? <div className="bb-reconcile-confirm" role="group" aria-label="Review amount change">
        <strong>Update {selected.item}?</strong>{selected.category === "Payment" && <p>The bank amount is the full bill. Any existing split method is preserved and its shares are recalculated. Existing repayment safeguards still apply.</p>}<p>Change its {selected.category === "Payment" ? "full bill" : "sheet"} amount from {money(selected.amountCents)} to {money(item.amountCents)}, then match this bank transaction. Its other details stay the same.</p>
        <button type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} onClick={() => send("update_match")}>Update amount &amp; match</button>
        <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={() => setReviewAmount(false)}>Cancel amount change</button>
      </div> : <button type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} onClick={() => setReviewAmount(true)}>Review amount change</button>
      : selected.confirmable && <button type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} onClick={() => send("confirm")}>Confirm match</button>}
    </div>}
    {editable && item.logging?.allowed && <>
      {!logging ? <button type="button" className="bb-reconcile-action bb-reconcile-outline" disabled={disabled} onClick={() => { setLogging("edit"); setReviewAmount(false) }}>Add {item.amountCents < 0 ? "income" : "expense"} to budget sheet</button>
      : <form className="bb-reconcile-log" onSubmit={event => { event.preventDefault(); if (disabled || !readyToLog) return
        if (logging === "edit") setLogging("review")
        else onCommand({ operation: "log", id: item.id, version: item.stateVersion ?? item.version, fields }) }}>
        <h3>{logging === "review" ? "Review new sheet entry" : `Add ${item.amountCents < 0 ? "income" : "expense"}`}</h3>
        <p className="bb-reconcile-muted">{money(item.amountCents)} · {dateLabel(item.date)} · {item.amountCents < 0 ? "Income" : "Expense"} sheet</p>
        {logging === "edit" ? Object.entries(fields).map(([field, value]) => <label key={field}>
          {({ category: "Category", item: "Item", location: "Location (optional)", person: "Payment method", source: "Income source", label: "Note (optional)" } as Record<string, string>)[field]}
          {field === "category" || field === "person" ? <select value={value} required disabled={disabled} onChange={event => setFields(previous => ({ ...previous, [field]: event.target.value }))}>
            <option value="">Choose…</option>{(field === "category" ? item.logging!.categories : item.logging!.paymentMethods).map(option => <option key={option} value={option}>{option.replace(/_/g, " ")}</option>)}</select>
          : <input value={value} maxLength={200} required={field === "item" || field === "source"} disabled={disabled} onChange={event => setFields(previous => ({ ...previous, [field]: event.target.value }))} />}
        </label>) : <><dl>{Object.entries(fields).filter(([, value]) => value).map(([field, value]) => <div key={field}><dt>{field === "person" ? "Payment method" : field}</dt><dd>{value.replace(/_/g, " ")}</dd></div>)}</dl>
          <p>This creates one new entry in your budget sheet and matches this bank transaction. Only continue if it is not already recorded.</p>
          <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={() => setLogging("edit")}>Edit entry</button></>}
        <div className="bb-reconcile-form-actions"><button type="submit" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled || !readyToLog}>{logging === "review" ? "Add entry & match" : "Review entry"}</button>
        <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={() => setLogging("")}>Cancel new entry</button></div>
      </form>}
    </>}
    {editable && item.logging && !item.logging.allowed && <p className="bb-reconcile-muted">{item.logging.reason}</p>}
    {editable && !item.suggestions.length && <p className="bb-reconcile-muted">No matching entry was found in your budget sheet.{item.logging?.allowed && " Adding it here records the bank amount and date in the sheet."}</p>}
  </div>
}
interface BillSharing {
  method: string; label: string; canChoose: boolean; payer: string; partner: string
  payerShareCents: number; partnerShareCents: number; budgetAmountCents: number; settledCents: number; oldGrossCents: number | null
}
interface ScheduleChange {
  sharing?: BillSharing | null
  version: string; fingerprint: string; name: string; kind: "bill" | "subscription"
  oldAmountCents: number; newAmountCents: number; scheduleAmountCents?: number | null; futureAmountCents?: number | null; description: string; canUpdateFuture: boolean; updateFuture: boolean
}
function ScheduleAmountReview({ item, suggestion, disabled, onCommand, onCancel, onRefresh, onRejectAccess }: {
  item: ReconciliationItem; suggestion: Suggestion; disabled: boolean; onCommand: (command: Command) => void; onCancel: () => void; onRefresh: () => void; onRejectAccess: (message: string) => void
}) {
  const [future, setFuture] = useState(false)
  const [splitMethod, setSplitMethod] = useState("income")
  const [plan, setPlan] = useState<ScheduleChange | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState("")
  useAppWorkStatus({ label: "Scheduled payment preview", pending: loading })
  useEffect(() => {
    const abort = new AbortController(); let active = true
    setLoading(true); setError("")
    const query = `version=${encodeURIComponent(item.version)}&suggestionId=${encodeURIComponent(suggestion.id)}&future=${future ? "1" : "0"}&splitMethod=${splitMethod}`
    void request(`${endpoint}/${item.id}/schedule?${query}`, abort).then(value => {
      const change = (value as { change?: ScheduleChange })?.change
      if (!change || !isText(change.version) || !isText(change.fingerprint) || change.fingerprint.length !== 64
        || !isText(change.name) || !isText(change.description, 500) || !["bill", "subscription"].includes(change.kind)
        || !isAmount(change.oldAmountCents) || !isAmount(change.newAmountCents) || change.newAmountCents !== Math.abs(item.amountCents)
        || (change.scheduleAmountCents !== undefined && change.scheduleAmountCents !== null && !isAmount(change.scheduleAmountCents))
        || (change.futureAmountCents !== undefined && change.futureAmountCents !== null && !isAmount(change.futureAmountCents))
        || (change.sharing != null && (!["income", "equal", "fronted", "none"].includes(change.sharing.method)
          || !isText(change.sharing.payer) || !isText(change.sharing.partner) || !isText(change.sharing.label)
          || typeof change.sharing.canChoose !== "boolean"
          || ![change.sharing.payerShareCents, change.sharing.partnerShareCents, change.sharing.budgetAmountCents, change.sharing.settledCents].every(isAmount)
          || change.sharing.payerShareCents + change.sharing.partnerShareCents !== change.newAmountCents))
        || typeof change.canUpdateFuture !== "boolean" || change.updateFuture !== future) throw new Error("Couldn’t read the scheduled payment review.")
      if (active) setPlan(change)
    }).catch(failure => { if (active) {
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) onRejectAccess(failure.message)
      else setError(failure instanceof Error ? failure.message : "Couldn’t prepare the payment change.")
    } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; abort.abort() }
  }, [item.id, item.version, suggestion.id, future, splitMethod, onRejectAccess])
  return <div className="bb-reconcile-confirm" role="group" aria-label="Review scheduled payment change">
    <strong>Update {suggestion.item}?</strong>
    {loading && <p role="status">Preparing payment change…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="bb-reconcile-action" disabled={disabled} onClick={onRefresh}>Refresh suggestions</button></div>}
    {plan && !error && <>{plan.sharing ? <>
      <p>Full {plan.name} bill from the bank: <strong>{money(plan.newAmountCents)}</strong>.</p>
      {plan.sharing.oldGrossCents != null && <p>Previously logged full bill: {money(plan.sharing.oldGrossCents)}.</p>}
      {plan.sharing.canChoose ? <label className="bb-reconcile-split">Split this bill<select aria-label="Split this bill" value={splitMethod} disabled={disabled || loading} onChange={event => setSplitMethod(event.target.value)}>
        <option value="income">By income</option><option value="equal">50/50</option><option value="none">No split</option>
      </select></label> : <p>Keep existing split: {plan.sharing.label}.</p>}
      <p>{plan.sharing.payer}’s share: <strong>{money(plan.sharing.payerShareCents)}</strong><br />{plan.sharing.partner}’s share: <strong>{money(plan.sharing.partnerShareCents)}</strong></p>
      <p>Budget payment: {money(plan.oldAmountCents)} → {money(plan.sharing.budgetAmountCents)}. {plan.sharing.method !== "none" && (plan.sharing.settledCents ? `${money(plan.sharing.settledCents)} already received is preserved.` : `The full cash payment stays in your budget until ${plan.sharing.partner}’s repayment is confirmed in Shared.`)}</p>
      <p>Matching this bank transaction does not mark a repayment received.</p>
    </> : <p>Change {plan.name} from {money(plan.oldAmountCents)} to {money(plan.newAmountCents)}, then match this bank transaction.</p>}
      {typeof plan.scheduleAmountCents === "number" && plan.scheduleAmountCents !== plan.oldAmountCents && <p>The schedule currently uses {money(plan.scheduleAmountCents)}. Both the source and schedule will use {money(plan.newAmountCents)}.</p>}
      <p>{plan.description}</p>
      {plan.updateFuture && <p>Future full-bill estimate: {typeof plan.futureAmountCents === "number" ? money(plan.futureAmountCents) : "Not set"} → {money(plan.newAmountCents)}</p>}
      {plan.canUpdateFuture && <label className="bb-reconcile-future"><input type="checkbox" checked={future} disabled={disabled || loading} onChange={event => setFuture(event.target.checked)} />Also update the future bill estimate</label>}
      <button type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled || loading} onClick={() => onCommand({
        operation: "update_schedule", id: item.id, version: plan.version, suggestionId: suggestion.id, scheduleVersion: plan.fingerprint, updateFuture: future, splitMethod,
      })}>Update scheduled payment &amp; match</button></>}
    <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={onCancel}>Cancel payment change</button>
  </div>
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
