import {ReportLoading} from "./report-loading"
import { ratioShareCents } from "./split-ratio"
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { AnimatedDisclosure, CollapsibleContent, SlidingSelection } from "./components/ui/motion"
import { FittedAmount } from "./components/ui/fitted-amount"
import { useAppWorkStatus } from "./app-work-guard"
import { usePageRefresh, usePageRefreshRegistry } from "./page-refresh"
import { useReimbursementPage } from "./reimbursement-pagination"
import "./reimbursement-ledger.css"
import { BalanceFirstReimbursements } from "./shared-balance-first"
import { StepMotion } from "./transaction-step-motion"
import { transactionMotion } from "./transaction-inline-editor"
import { ArrowLeft } from "lucide-react"
import { ReimbursementSplitEditor } from "./reimbursement-split-editor"

export interface LedgerAllocation {
  id: string; payerOwner: string; partnerOwner: string; payerPerson: string
  item: string; location: string; expenseDate: string; category: string
  grossCents: number; payerShareCents: number; partnerShareCents: number
  settledCents: number; clearedCents?: number; outstandingCents: number; method: string; version: number
  status: "outstanding" | "settled" | "cleared"; projectedVersion: number; accounting: string
  customPayerBasisPoints?: number
  customPayerRatio?: [number, number]
}
export interface LedgerEvent {
  id: string; operationId: string; allocationId: string; kind: "receive" | "report_payment" | "offset"
  actorOwner: string; payeeOwner: string; debtorOwner: string; amountCents: number; date: string; note: string
  status: "pending" | "confirmed" | "reversed"; createdAt: string; confirmedAt: string
  confirmedBy: string; reversedAt: string; reversedBy: string
}
export interface LedgerSnapshot {
  enabled: true; ownerKey: string; allocations: LedgerAllocation[]; events: LedgerEvent[]
  currency: "USD"; projectionPending?: boolean; error?: string; resetState?: string; resets?: LedgerReset[]
  splitOptions?: Record<string, { incomePayerCents: number }>
}
interface LedgerReset {
  id: string; version: number; status: "active" | "undone"; actorOwner: string
  createdAt: string; updatedAt: string; note: string; canUndo: boolean; canRedo: boolean
  entries: { allocationId: string; amountCents: number; payerOwner: string; partnerOwner: string }[]
}
type LedgerResponse = LedgerSnapshot | { enabled: false }
type Command = Record<string, unknown>
export type Run = (command: Command, done: (saved: boolean) => void) => void
type Direction = "to" | "from"
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
const person = (owner: string) => owner ? owner[0].toUpperCase() + owner.slice(1) : "Partner"
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
const writable = (allocation: LedgerAllocation) => allocation.accounting === "cash_v1"

export function reimbursementAmountCents(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null
  const [whole, fraction = ""] = value.trim().split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return Number.isSafeInteger(cents) && cents <= 10_000_000_000 ? cents : null
}
export function ledgerTotals(allocations: LedgerAllocation[], owner: string) {
  const to = allocations.filter(item => item.payerOwner === owner).reduce((sum, item) => sum + item.outstandingCents, 0)
  const from = allocations.filter(item => item.partnerOwner === owner).reduce((sum, item) => sum + item.outstandingCents, 0)
  return { to, from, net: to - from }
}
function isoDate(value: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  const parts = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3], +us[1], +us[2]] : null
  if (!parts) return ""
  const [year, month, day] = parts
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return ""
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}
const dateLabel = (value: string) => {
  const iso = isoDate(value)
  return iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`)) : value || "Undated"
}
const monthKey = (value: string) => isoDate(value).slice(0, 7) || "undated"
const monthLabel = (key: string) => key === "undated" ? "Undated" : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-01T12:00:00Z`))
function months(allocations: LedgerAllocation[]) {
  const groups = new Map<string, LedgerAllocation[]>()
  for (const item of allocations) {
    const key = monthKey(item.expenseDate)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups].sort(([a], [b]) => a === "undated" ? 1 : b === "undated" ? -1 : b.localeCompare(a))
    .map(([key, items]) => ({ key, label: monthLabel(key), items: items.sort((a, b) => isoDate(b.expenseDate).localeCompare(isoDate(a.expenseDate)) || a.id.localeCompare(b.id)),
      cents: items.reduce((sum, item) => sum + item.outstandingCents, 0) }))
}
const pendingAllocationIds = (events: LedgerEvent[]) => new Set(events.filter(event => event.status === "pending").map(event => event.allocationId))
export function defaultOffsetEntries(allocations: LedgerAllocation[], owner: string, events: LedgerEvent[] = []) {
  const pending = pendingAllocationIds(events)
  const eligible = allocations.filter(item => writable(item) && item.outstandingCents > 0 && !pending.has(item.id))
  const totals = ledgerTotals(eligible, owner)
  const amount = Math.min(totals.to, totals.from)
  const entries: { allocationId: string; version: number; amountCents: number }[] = []
  for (const direction of ["to", "from"] as const) {
    let remaining = amount
    for (const item of eligible.filter(item => (direction === "to" ? item.payerOwner : item.partnerOwner) === owner)
      .sort((a, b) => (isoDate(a.expenseDate) || "9999").localeCompare(isoDate(b.expenseDate) || "9999") || a.id.localeCompare(b.id))) {
      const cents = Math.min(remaining, item.outstandingCents)
      if (cents) entries.push({ allocationId: item.id, version: item.version, amountCents: cents })
      remaining -= cents
    }
  }
  return entries
}
export function canReverseLedgerEvent(event: LedgerEvent, owner: string, allocations: LedgerAllocation[], events: LedgerEvent[]) {
  return event.status !== "reversed" && (event.actorOwner === owner || event.payeeOwner === owner)
    && events.filter(item => item.operationId === event.operationId).every(item => allocations.some(allocation => allocation.id === item.allocationId && writable(allocation)
      && (event.status === "pending" || !(allocation.clearedCents ?? 0))))
}

class LedgerRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
async function request<T>(body?: Command, signal?: AbortSignal, snapshotOnly = false): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let rejectAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error("The request did not finish.")) })
  controller.signal.addEventListener("abort", rejectAbort, { once: true })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const timer = window.setTimeout(abort, 20_000)
  try {
    return await Promise.race([cancelled, fetch("/app/reimbursements" + (!body && snapshotOnly ? "?snapshot=1" : ""), {
      method: body ? "POST" : "GET", credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin",
      cache: "no-store", redirect: "error", signal: controller.signal,
      headers: body ? { "Content-Type": "application/json", "X-BookieBot-App": "1" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new LedgerRequestError(typeof data.error === "string" ? data.error : "Couldn’t update reimbursements.", response.status)
      return data as T
    })])
  } finally {
    window.clearTimeout(timer)
    controller.signal.removeEventListener("abort", rejectAbort)
    signal?.removeEventListener("abort", abort)
  }
}
function validate(snapshot: LedgerResponse) {
  if (!snapshot || snapshot.enabled !== true || !snapshot.ownerKey || !Array.isArray(snapshot.allocations) || !Array.isArray(snapshot.events) || snapshot.currency !== "USD") throw new Error("Incomplete reimbursement data")
  for (const item of snapshot.allocations) {
    if (!item.id || ![item.grossCents, item.payerShareCents, item.partnerShareCents, item.settledCents, item.clearedCents ?? 0, item.outstandingCents, item.version]
      .every(value => Number.isSafeInteger(value) && value >= 0)
      || item.grossCents !== item.payerShareCents + item.partnerShareCents
      || item.partnerShareCents !== item.settledCents + (item.clearedCents ?? 0) + item.outstandingCents) throw new Error("Incomplete reimbursement amounts")
    if (item.method === "custom") {
      const ratio = item.customPayerRatio
      if (ratio !== undefined ? !Array.isArray(ratio) || ratio.length !== 2 || item.customPayerBasisPoints !== undefined
        || !ratio.every(Number.isSafeInteger) || ratio[0] < 0 || ratio[0] > ratio[1] || ratio[1] <= 0 || ratio[1] > 10_000_000_000
        || item.payerShareCents !== ratioShareCents(item.grossCents, ratio)
        : !Number.isSafeInteger(item.customPayerBasisPoints) || item.customPayerBasisPoints! < 0 || item.customPayerBasisPoints! > 10_000
          || item.payerShareCents !== Math.floor((item.grossCents * item.customPayerBasisPoints! + 5_000) / 10_000)) throw new Error("Incomplete custom split")
    }
  }
  if (snapshot.resets !== undefined) {
    if (!Array.isArray(snapshot.resets)) throw new Error("Incomplete reset history")
    for (const reset of snapshot.resets) {
      if (!reset.id || !Number.isSafeInteger(reset.version) || reset.version < 1
        || !["active", "undone"].includes(reset.status) || !Array.isArray(reset.entries)
        || reset.entries.some(entry => !entry.allocationId || !entry.payerOwner || !entry.partnerOwner
          || !Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0)) throw new Error("Incomplete reset history")
    }
  }
  return snapshot
}

export interface MatchedReceiptScope { allocationId: string; bankAmountCents: number; review?: boolean }
export function ReimbursementLedger({ fallback, refreshKey, matchedReceipt, onClose, onRejectAccess, balanceFirst = false, aliases, onUpdated }: {
  fallback: ReactNode; refreshKey?: string; matchedReceipt?: MatchedReceiptScope; onClose?: () => void; onRejectAccess?: (message: string) => void
  balanceFirst?: boolean; aliases?: Record<string, string>; onUpdated?: (time: number | null) => void
}) {
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  useEffect(() => { onUpdated?.(updatedAt) }, [updatedAt, onUpdated])
  const [legacy, setLegacy] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const updateWork = useAppWorkStatus({ label: "Reimbursements", pending: busy, uncertain })
  const [signedOut, setSignedOut] = useState(false)
  const mounted = useRef(false)
  const readId = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const writeController = useRef<AbortController | null>(null)
  const executing = useRef(false)
  const pending = useRef<{ body: Command; done: (saved: boolean) => void } | null>(null)
  const readFlight = useRef<{ promise: Promise<boolean> } | null>(null)
  const queuedRecovery = useRef<Promise<boolean> | null>(null)
  const recovered = useRef(new Set<string>())
  const performRead = useCallback(async (recover: boolean) => {
    const id = ++readId.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    setRefreshing(true)
    try {
      const response = await request<LedgerResponse>(undefined, controller.signal, balanceFirst && !recover)
      if (!mounted.current || id !== readId.current) return false
      if (response.enabled === false) { setLegacy(true); setSnapshot(null); setUpdatedAt(null) }
      else { setSnapshot(validate(response)); setLegacy(false); setUpdatedAt(Date.now()) }
      setSignedOut(false); setError("")
      return true
    } catch (failure) {
      if (!mounted.current || id !== readId.current || controller.signal.aborted) return false
      if (failure instanceof LedgerRequestError && [401, 403].includes(failure.status)) {
        setSnapshot(null); setUpdatedAt(null); setLegacy(false); setSignedOut(failure.status === 401)
        if (matchedReceipt) onRejectAccess?.(failure.message)
      }
      setError(failure instanceof LedgerRequestError ? failure.message : "Couldn’t refresh reimbursements. Previously loaded balances may be out of date.")
      return false
    } finally { if (mounted.current && id === readId.current) setRefreshing(false) }
  }, [matchedReceipt, onRejectAccess, balanceFirst])
  const load = useCallback((recover = true): Promise<boolean> => {
    if (!balanceFirst) return performRead(true)
    // Retain the fast paint when explicit recovery arrives during its read.
    // Concurrent display reads share one result; recovery still runs afterward.
    if (readController.current?.signal.aborted) { readFlight.current = null; queuedRecovery.current = null }
    const begin = (full: boolean) => {
      const flight = { promise: Promise.resolve(false) }
      flight.promise = performRead(full).finally(() => { if (readFlight.current === flight) readFlight.current = null })
      readFlight.current = flight
      return flight.promise
    }
    const active = readFlight.current
    if (!active) return begin(recover)
    if (!recover) return active.promise
    if (queuedRecovery.current) return queuedRecovery.current
    const queued = active.promise.then(ok => {
      if (queuedRecovery.current === queued) queuedRecovery.current = null
      return ok && mounted.current && !pending.current && !executing.current ? begin(true) : false
    })
      .finally(() => { if (queuedRecovery.current === queued) queuedRecovery.current = null })
    queuedRecovery.current = queued
    return queued
  }, [balanceFirst, performRead])
  useEffect(() => {
    mounted.current = true
    const refresh = () => { if (!pending.current && document.visibilityState === "visible") void load(false) }
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      mounted.current = false; ++readId.current
      readController.current?.abort(); writeController.current?.abort()
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [load])
  useEffect(() => { if (!pending.current) void load(false) }, [load, refreshKey])
  useEffect(() => {
    if (!balanceFirst || !snapshot?.projectionPending || busy || uncertain || refreshing || error) return
    const version = snapshot.resetState ?? snapshot.allocations.map(item => `${item.id}:${item.version}`).join("|")
    if (recovered.current.has(version)) return
    recovered.current.add(version)
    void load()
  }, [balanceFirst, snapshot, busy, uncertain, refreshing, error, load])
  const pageRefresh = usePageRefresh(matchedReceipt ? "reconcile" : "shared", { refresh: load, disabled: busy || uncertain || refreshing })
  const execute = async () => {
    const change = pending.current
    if (!change || executing.current) return
    executing.current = true
    ++readId.current; readController.current?.abort(); setRefreshing(false)
    const controller = new AbortController()
    writeController.current = controller
    updateWork({ label: "Reimbursements", pending: true, uncertain })
    setBusy(true); setError("")
    try {
      const result = validate(await request<LedgerResponse>(change.body, controller.signal))
      if (!mounted.current) return
      pending.current = null; setUncertain(false); change.done(true)
      setSnapshot(result); setLegacy(false); setUpdatedAt(Date.now())
      window.dispatchEvent(new CustomEvent("bookiebot:reimbursements-changed"))
      if (change.body.operation !== "receive_all") await load(false)
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof LedgerRequestError && failure.status < 500) {
        pending.current = null; setUncertain(false)
        if (matchedReceipt && [401, 403].includes(failure.status)) { setSnapshot(null); onRejectAccess?.(failure.message) }
        if (failure.status === 401) { setSnapshot(null); setUpdatedAt(null); setSignedOut(true); change.done(false) }
        if (failure.status === 409) { change.done(false); await load() }
        setError(failure.message)
      } else {
        setUncertain(true)
        setError("This record may have saved. Retry this same record safely before making another change.")
      }
    } finally { executing.current = false; if (mounted.current) setBusy(false) }
  }
  const run: Run = (body, done) => {
    if (pending.current || executing.current || signedOut) return
    pending.current = { body: { ...body, requestId: crypto.randomUUID() }, done }
    void execute()
  }
  if (legacy && !uncertain) return <>{fallback}{matchedReceipt && <button type="button" className="bb-reconcile-action" onClick={onClose}>Back to reconciliation</button>}</>
  if (matchedReceipt) return <section className="bb-canonical-reimbursements bb-reconcile-receipt" aria-label="Receive shared payment">
    {error && <div className="bb-ledger-message" role="alert"><p>{error}</p>
      {uncertain ? <button type="button" disabled={busy || signedOut} onClick={() => void execute()}>Retry this record</button>
        : pageRefresh ? <p>Pull down from the top to refresh.</p> : <button type="button" disabled={busy || refreshing} onClick={() => void load()}>Refresh payment</button>}</div>}
    {!snapshot && !error && <ReportLoading label="Loading the matched shared payment…"/>}
    {snapshot && <MatchedReceiptContents snapshot={snapshot} scope={matchedReceipt} disabled={busy || uncertain || refreshing}
      run={run} refresh={() => void load()} />}
    <button type="button" className="bb-reconcile-action" disabled={busy || uncertain} onClick={onClose}>Back to reconciliation</button>
  </section>
  return <Card className={`bb-report-section bb-reimbursement-section bb-canonical-reimbursements${balanceFirst ? " bb-balance-first-card" : ""}`}>
    {!balanceFirst && <CardHeader><CardTitle>Shared Reimbursements</CardTitle></CardHeader>}
    <CardContent>
      {error && <div className="bb-ledger-message" role="alert"><p>{error}</p>
        {uncertain ? <button type="button" disabled={busy || signedOut} onClick={() => void execute()}>Retry this record</button>
        : pageRefresh ? <p>Pull down from the top to refresh.</p> : <button type="button" disabled={busy || refreshing} onClick={() => void load()}>Refresh reimbursements</button>}</div>}
      {!snapshot && !error && <ReportLoading label="Loading reimbursements…"/>}
      {snapshot && (balanceFirst ? <BalanceFirstReimbursements snapshot={snapshot} disabled={busy || uncertain || refreshing} selectDisabled={busy || uncertain} refreshing={refreshing} run={run} aliases={aliases} refresh={() => void load()} />
        : <LedgerContents snapshot={snapshot} disabled={busy || uncertain || refreshing} run={run}
          refresh={() => void load()} refreshing={refreshing} />)}
    </CardContent>
  </Card>
}

function MatchedReceiptContents({ snapshot, scope, disabled, run, refresh }: {
  snapshot: LedgerSnapshot; scope: MatchedReceiptScope; disabled: boolean; run: Run; refresh: () => void
}) {
  const pageRefresh = Boolean(usePageRefreshRegistry())
  const item = snapshot.allocations.find(item => item.id === scope.allocationId && item.payerOwner === snapshot.ownerKey
    && writable(item) && item.grossCents === scope.bankAmountCents)
  const [editing, setEditing] = useState(Boolean(scope.review))
  const [reviewVersion, setReviewVersion] = useState(scope.review ? item?.version : undefined)
  useAppWorkStatus({ label: "Matched payment review", dirty: editing, onDiscard: () => setEditing(false) })
  if (!item) return <p role="status">This shared payment changed. Review its current details in Shared.</p>
  const incoming = snapshot.events.filter(event => event.allocationId === item.id && event.status === "pending")
  const pendingSheet = item.projectedVersion !== item.version
  const stale = editing && reviewVersion !== item.version
  const blocked = disabled || pendingSheet || Boolean(item.clearedCents) || incoming.length > 0
  const partner = person(item.partnerOwner)
  return <>
    <h2>{partner}’s share · {item.item || item.category}</h2>
    <p className="bb-ledger-note">The bank match is saved separately. Confirm only money you already received; no transfer is made.</p>
    <dl className="bb-reconcile-receipt-amounts"><div><dt>Full bank payment</dt><dd>{money(item.grossCents)}</dd></div>
      <div><dt>{partner}’s share</dt><dd>{money(item.partnerShareCents)}</dd></div>
      <div><dt>Already received / settled</dt><dd>{money(item.settledCents)}</dd></div>
      <div><dt>Still owed</dt><dd>{money(item.outstandingCents)}</dd></div></dl>
    {pendingSheet && <div role="status"><p className="bb-ledger-note">Payment recorded; sheet update pending.</p>{pageRefresh ? <p>Pull down from the top to refresh.</p> : <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={refresh}>Refresh payment</button>}</div>}
    {Boolean(item.clearedCents) && <p className="bb-ledger-note">Undo the balance reset in Shared before recording a receipt.</p>}
    {incoming.map(event => <IncomingPayment key={event.id} event={event} allocation={item} disabled={disabled || pendingSheet || Boolean(item.clearedCents)} run={run} />)}
    {!item.outstandingCents && !pendingSheet && !item.clearedCents && <p role="status">{partner}’s share is settled.</p>}
    {stale && <p role="status">This payment changed. Go back and reopen it before confirming.</p>}
    {item.outstandingCents > 0 && !editing && <button type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={blocked} onClick={() => { setReviewVersion(item.version); setEditing(true) }}>Mark {partner}’s share received</button>}
    {editing && item.outstandingCents > 0 && !pendingSheet && !item.clearedCents && !incoming.length
      && <PaymentEditor allocation={item} isPayer disabled={blocked || stale} run={run} close={() => setEditing(false)} />}
  </>
}

function LedgerContents({ snapshot, disabled, run, refresh, refreshing }: {
  snapshot: LedgerSnapshot; disabled: boolean; run: Run; refresh: () => void; refreshing: boolean
}) {
  const pageRefresh = Boolean(usePageRefreshRegistry())
  const { allocations, events, ownerKey } = snapshot
  const [direction, setDirection] = useState<Direction>("to")
  const [listOpen, setListOpen] = useState(false)
  const [offsetOpen, setOffsetOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetReview, setResetReview] = useState(0)
  const [receiveAllOpen, setReceiveAllOpen] = useState(false)
  const [receiveAllReview, setReceiveAllReview] = useState(0)
  const listId = useId(), offsetId = useId(), resetId = useId(), receiveAllId = useId()
  const totals = ledgerTotals(allocations, ownerKey)
  const shown = allocations.filter(item => (direction === "to" ? item.payerOwner : item.partnerOwner) === ownerKey)
  const directionGroups = {
    to: months(allocations.filter(item => item.payerOwner === ownerKey)),
    from: months(allocations.filter(item => item.partnerOwner === ownerKey)),
  }
  const timeline = directionGroups[direction].filter(group => group.cents > 0).reverse()
  const rows = timeline.length <= 4 ? timeline : [{ key: "earlier", label: "Earlier expenses", items: [], cents: timeline.slice(0, -3).reduce((sum, group) => sum + group.cents, 0) }, ...timeline.slice(-3)]
  const pendingAllocs = pendingAllocationIds(events)
  const writableTotals = ledgerTotals(allocations.filter(writable), ownerKey)
  const eligible = ledgerTotals(allocations.filter(item => writable(item) && !pendingAllocs.has(item.id)), ownerKey)
  const pendingOffset = writableTotals.to > 0 && writableTotals.from > 0
    && allocations.some(item => writable(item) && item.outstandingCents > 0 && pendingAllocs.has(item.id))
  const incoming = events.filter(event => event.status === "pending" && event.kind === "report_payment" && event.payeeOwner === ownerKey
    && allocations.some(item => item.id === event.allocationId && writable(item)))
  const reversibleIds = new Set(events.filter(event => canReverseLedgerEvent(event, ownerKey, allocations, events)).map(event => event.id))
  const resetBlocked = events.some(event => event.status === "pending")
    ? "Confirm or reverse pending payment reports before resetting balances."
    : snapshot.projectionPending ? "Wait for expense sheets to finish syncing before resetting balances." : ""
  const receivable = allocations.filter(item => item.payerOwner === ownerKey && item.outstandingCents > 0)
  const receiveAllBlocked = receivable.some(item => !writable(item) || item.version !== item.projectedVersion || Boolean(item.clearedCents))
  const showReceiveAll = Boolean(direction === "to" && snapshot.resetState && (receivable.length > 0 || receiveAllOpen))
  const showReset = Boolean(snapshot.resetState && (totals.to > 0 || totals.from > 0 || resetOpen))
  return <>
    <SlidingSelection value={direction} className="bb-ledger-directions" role="group" aria-label="Reimbursement direction">
      <button type="button" aria-pressed={direction === "to"} onClick={() => setDirection("to")}>Owed to you<FittedAmount className="bb-ledger-direction-amount">{money(totals.to)}</FittedAmount></button>
      <button type="button" aria-pressed={direction === "from"} onClick={() => setDirection("from")}>You owe<FittedAmount className="bb-ledger-direction-amount">{money(totals.from)}</FittedAmount></button>
    </SlidingSelection>
    {totals[direction] > 0
      ? <div className="bb-ledger-net"><span>{totals.net > 0 ? "Net owed to you" : totals.net < 0 ? "Net you owe" : "Net balance"}</span><strong>{money(Math.abs(totals.net))}</strong></div>
      : <p className="bb-ledger-empty">{direction === "from" ? "You don’t currently owe any money." : "No one currently owes you money."}</p>}
    {snapshot.projectionPending && <div className="bb-ledger-message" role="status"><p>Recorded. Expense sheets are still syncing.</p>{pageRefresh ? <p>Pull down from the top to refresh.</p> : <button type="button" disabled={disabled || refreshing} onClick={refresh}>Refresh</button>}</div>}
    {snapshot.error && <p className="bb-ledger-note" role="status">{snapshot.error}</p>}
    {rows.length > 0 && <figure className="bb-reimbursement-timeline bb-ledger-timeline" aria-label={`${direction === "to" ? "Owed to you" : "You owe"} by expense month`}>
      <div className="bb-reimbursement-bar-track" aria-hidden="true">{rows.map((group, index) => <span key={group.key} data-segment={index} style={{ width: `${group.cents / totals[direction] * 100}%` }} />)}</div>
      <ol>{rows.map((group, index) => <li key={group.key} data-segment={index}><div className="bb-reimbursement-bar-label"><span><i className="bb-reimbursement-swatch" aria-hidden="true" />{group.label}</span><FittedAmount className="bb-reimbursement-bar-amount">{money(group.cents)}</FittedAmount></div></li>)}</ol>
    </figure>}
    {pendingOffset && <p className="bb-ledger-note">Confirm pending payments before offsetting those expenses.</p>}
    {(showReceiveAll || showReset) && <div className="bb-ledger-bulk-actions" role="group" aria-label="Shared balance actions">
      {showReceiveAll && <button className="bb-ledger-receive-all-toggle" type="button" disabled={disabled || receiveAllBlocked}
        aria-expanded={receiveAllOpen} aria-controls={receiveAllId}
        onClick={() => { if (!receiveAllOpen) setReceiveAllReview(value => value + 1); setReceiveAllOpen(!receiveAllOpen) }}>Mark all received</button>}
      {showReset && <button className="bb-ledger-reset-toggle" type="button" disabled={disabled || Boolean(resetBlocked)} aria-expanded={resetOpen} aria-controls={resetId} onClick={() => { if (!resetOpen) setResetReview(value => value + 1); setResetOpen(!resetOpen) }}>Reset balances</button>}
    </div>}
    {showReceiveAll && <>
      <RetainedPanel id={receiveAllId} open={receiveAllOpen}><ReceiveAllEditor key={receiveAllReview} snapshot={snapshot}
        disabled={disabled || receiveAllBlocked} run={run} close={() => setReceiveAllOpen(false)} /></RetainedPanel>
      {receiveAllBlocked && <p className="bb-ledger-note" role="status">Finish syncing or review historical expenses before marking all received.</p>}
    </>}
    {eligible.to > 0 && eligible.from > 0 && <><button className="bb-ledger-offset-toggle" type="button" disabled={disabled} aria-expanded={offsetOpen} aria-controls={offsetId} onClick={() => setOffsetOpen(!offsetOpen)}>Offset balances</button>
      <RetainedPanel id={offsetId} open={offsetOpen}><OffsetEditor allocations={allocations} events={events} owner={ownerKey} disabled={disabled} run={run} close={() => setOffsetOpen(false)} /></RetainedPanel></>}
    {showReset && <>
      <RetainedPanel id={resetId} open={resetOpen}><ResetEditor key={resetReview} snapshot={snapshot} disabled={disabled || Boolean(resetBlocked)} run={run} close={() => setResetOpen(false)} /></RetainedPanel>
    </>}
    {resetBlocked && snapshot.resetState && <p className="bb-ledger-note" role="status">{resetBlocked}</p>}
    {incoming.length > 0 && <section className="bb-ledger-incoming" aria-label="Payments awaiting your confirmation"><h3>Awaiting your confirmation</h3>
      {incoming.map(event => <IncomingPayment key={event.id} event={event} allocation={allocations.find(item => item.id === event.allocationId)!} disabled={disabled} run={run} />)}</section>}
    {shown.length > 0 && <>
      <button className="bb-ledger-list-toggle" type="button" aria-expanded={listOpen} aria-controls={listId} onClick={() => setListOpen(!listOpen)}>
        <span>{`View ${shown.length} expense${shown.length === 1 ? "" : "s"}`}</span><span className="bb-disclosure-mark" aria-hidden="true" />
      </button>
    </>}
    <CollapsibleContent id={listId} open={listOpen && shown.length > 0}>{(["to", "from"] as const).map(side => <div key={side} hidden={side !== direction} aria-hidden={side !== direction} inert={side !== direction}>
      <LedgerMonths groups={directionGroups[side]} visible={listOpen && side === direction} events={events} reversibleIds={reversibleIds} owner={ownerKey} disabled={disabled} run={run} />
    </div>)}</CollapsibleContent>
    {Boolean(snapshot.resets?.length) && <ResetHistory resets={snapshot.resets!} owner={ownerKey} disabled={disabled} run={run} />}
  </>
}

function RetainedPanel({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const [retained, setRetained] = useState(open)
  useEffect(() => {
    if (open) { setRetained(true); return }
    const timer = window.setTimeout(() => setRetained(false), 320)
    return () => window.clearTimeout(timer)
  }, [open])
  return <CollapsibleContent id={id} open={open}>{(open || retained) && children}</CollapsibleContent>
}
function LedgerMonths({ groups, visible, ...props }: { groups: ReturnType<typeof months>; visible: boolean; events: LedgerEvent[]; reversibleIds: Set<string>; owner: string; disabled: boolean; run: Run }) {
  const page = useReimbursementPage(groups, group => group.key, visible)
  return <div className="bb-reimbursement-groups">
    {page.visible.map(group => <LedgerMonth key={group.key} group={group} visible={visible} {...props} />)}
    {page.hasMore && <button className="bb-reimbursement-load-more" type="button" onClick={page.loadAll}>Load all months</button>}
  </div>
}
function LedgerMonth({ group, visible, events, reversibleIds, owner, disabled, run }: {
  group: ReturnType<typeof months>[number]; visible: boolean; events: LedgerEvent[]; reversibleIds: Set<string>; owner: string; disabled: boolean; run: Run
}) {
  const [opened, setOpened] = useState("")
  const currentMonth = group.key === today().slice(0, 7)
  const [expanded, setExpanded] = useState(currentMonth)
  const [loaded, setLoaded] = useState(currentMonth)
  const page = useReimbursementPage(group.items, item => item.id, visible && expanded)
  const contentId = useId()
  return <section className="bb-reimbursement-group" aria-label={group.label}>
    <div className="bb-reimbursement-month-heading"><h3><button type="button" className="bb-reimbursement-month-toggle" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => { setLoaded(true); setExpanded(value => !value) }}>
      <span>{group.label}{currentMonth && <span className="bb-reimbursement-month-tag">This month</span>}</span><span className="bb-disclosure-mark" aria-hidden="true" />
    </button></h3></div>
    <CollapsibleContent id={contentId} open={expanded}><div className="bb-reimbursement-month-entries">
      {loaded && page.visible.map(item => <LedgerRow key={item.id} allocation={item} events={events.filter(event => event.allocationId === item.id)} reversibleIds={reversibleIds} owner={owner}
        open={opened === item.id} onOpenChange={open => setOpened(open ? item.id : "")} disabled={disabled} run={run} />)}
      {loaded && page.hasMore && <button className="bb-reimbursement-load-more" type="button" onClick={page.loadAll}>Load all expenses</button>}
    </div></CollapsibleContent>
  </section>
}
export function LedgerRow({ allocation: item, events, reversibleIds, owner, open, onOpenChange, disabled, run, detailOnly = false, detailSummary, compact = true, incomePayerCents }: {
  allocation: LedgerAllocation; events: LedgerEvent[]; reversibleIds: Set<string>; owner: string; open: boolean; onOpenChange: (open: boolean) => void; disabled: boolean; run: Run; detailOnly?: boolean; detailSummary?: ReactNode; compact?: boolean; incomePayerCents?: number
}) {
  const [mode, setMode] = useState<"" | "payment" | "history" | "split">("")
  const [splitReview, setSplitReview] = useState(0)
  const paymentId = useId(), historyId = useId(), splitId = useId()
  const payer = item.payerPerson || person(item.payerOwner), partner = person(item.partnerOwner)
  const isPayer = owner === item.payerOwner
  const settled = item.outstandingCents === 0
  const cleared = item.clearedCents ?? 0
  const shares = item.grossCents > 0 ? [item.payerShareCents, item.settledCents, cleared, item.outstandingCents].map(value => value / item.grossCents * 100) : [0, 0, 0, 0]
  const pendingSent = events.some(event => event.status === "pending")
  const canWrite = writable(item)
  const sheetPending = item.version !== item.projectedVersion
  const splitBlocked = pendingSent || sheetPending || cleared > 0 || item.settledCents > 0
    || events.some(event => event.status === "confirmed")
  const settledLabel = sheetPending ? "Sheet update pending" : item.partnerShareCents === 0 ? "No reimbursement due" : cleared > 0 ? "Cleared" : events.some(event => event.kind === "offset" && event.status === "confirmed") ? "Settled" : isPayer ? "Received" : "Paid"
  const summary = <>
    <span className="bb-reimbursement-item"><strong title={item.item || item.category}>{item.item || item.category || "Shared expense"}</strong></span>
    <div className="bb-reimbursement-status" data-settled={settled}>{settled ? settledLabel : <><FittedAmount className="bb-reimbursement-due">{money(item.outstandingCents)}</FittedAmount><i className="bb-reimbursement-due-key" aria-hidden="true" /><small>due</small></>}</div>
    <span className="bb-disclosure-mark" aria-hidden="true" />
  </>
  const detail = <>
    <div className="bb-reimbursement-detail">
      <div className="bb-reimbursement-receipt-meta"><p><time dateTime={isoDate(item.expenseDate) || undefined} title={item.expenseDate}>{dateLabel(item.expenseDate)}</time></p>
        <p>{item.method === "fronted" ? `Fronted for ${partner}` : item.method === "income" ? "By income" : item.method === "equal" ? "Split 50/50" : item.method === "custom" ? "Custom split" : item.method}</p>
        {item.location && <p>{item.location}</p>}</div>
      <div className="bb-reimbursement-visual" role="img" aria-label={`${payer} paid ${money(item.grossCents)}. ${person(item.payerOwner)}’s share ${money(item.payerShareCents)}. ${partner}’s share ${money(item.partnerShareCents)}: ${money(item.settledCents)} settled; ${cleared ? `${money(cleared)} cleared without payment; ` : ""}${money(item.outstandingCents)} still owed.`}>
        <div className="bb-reimbursement-visual-segments" aria-hidden="true">{["personal", "received", "cleared", "outstanding"].map((portion, index) => <span key={portion} data-portion={portion} style={{ width: `${shares[index]}%` }} />)}</div>
        <span className="bb-reimbursement-visual-total" aria-hidden="true">{payer} paid · <span>{money(item.grossCents)}</span></span>
      </div>
      <dl className="bb-reimbursement-visual-legend"><div><dt><i className="bb-reimbursement-visual-key" data-portion="personal" aria-hidden="true" /><span>{isPayer ? "Yours" : `${person(item.payerOwner)}’s share`}</span></dt><dd>{money(item.payerShareCents)}</dd></div>
        <div><dt><i className="bb-reimbursement-visual-key" data-portion="received" aria-hidden="true" /><span>{isPayer ? partner : "You"} {events.some(event => event.kind === "offset" && event.status === "confirmed") ? "settled" : "paid"}</span></dt><dd>{money(item.settledCents)}</dd></div>
        {cleared > 0 && <div><dt><i className="bb-reimbursement-visual-key" data-portion="cleared" aria-hidden="true" /><span>Cleared without payment</span></dt><dd>{money(cleared)}</dd></div>}</dl>
      {!canWrite && <p className="bb-ledger-note">Historical split · read only</p>}
      {sheetPending && <p className="bb-ledger-note" role="status">Change saved; budget and reimbursement sheets still need to update. Refresh Shared to retry.</p>}
      {pendingSent && <p className="bb-ledger-note">{isPayer ? "Review the pending payment above before recording another receipt." : "Sent payment awaiting confirmation. The balance changes when received."}</p>}
      {cleared > 0 && <p className="bb-ledger-note">Undo the balance reset before changing this expense or reversing its payments.</p>}
      {isPayer && canWrite && item.settledCents > 0 && <p className="bb-ledger-note">Reverse confirmed repayments before editing the split or expense total.</p>}
      <div className="bb-ledger-actions">
        {canWrite && isPayer && <button type="button" disabled={disabled || splitBlocked} aria-expanded={mode === "split"} aria-controls={splitId}
          onClick={() => { if (mode !== "split") setSplitReview(value => value + 1); setMode(mode === "split" ? "" : "split") }}>Edit split</button>}
        {canWrite && !settled && <button type="button" disabled={disabled || pendingSent} aria-expanded={mode === "payment"} aria-controls={paymentId} onClick={() => setMode(mode === "payment" ? "" : "payment")}>{isPayer ? "Record received" : "Record sent payment"}</button>}
        <button type="button" aria-expanded={mode === "history"} aria-controls={historyId} onClick={() => setMode(mode === "history" ? "" : "history")}>History ({events.length})</button>
      </div>
      <RetainedPanel id={splitId} open={(open || detailOnly) && mode === "split"}><SplitEditor key={splitReview} allocation={item}
        disabled={disabled} blocked={splitBlocked} run={run} close={() => setMode("")} /></RetainedPanel>
      <RetainedPanel id={paymentId} open={(open || detailOnly) && mode === "payment"}><PaymentEditor key={item.version} allocation={item} isPayer={isPayer} disabled={disabled || pendingSent} run={run} close={() => setMode("")} /></RetainedPanel>
      <RetainedPanel id={historyId} open={(open || detailOnly) && mode === "history"}><PaymentHistory allocation={item} events={events} reversibleIds={reversibleIds} disabled={disabled} run={run} /></RetainedPanel>
    </div>
  </>
  return detailOnly ? <LedgerDetailScenes allocation={item} events={events} reversibleIds={reversibleIds} open={open} compact={compact} disabled={disabled} run={run} incomePayerCents={incomePayerCents}
    summary={detailSummary} close={() => onOpenChange(false)} isPayer={isPayer} canWrite={canWrite} settled={settled} pendingSent={pendingSent} splitBlocked={splitBlocked}
    notices={<>{!canWrite && <p className="bi-footnote">Historical split · read only</p>}{sheetPending && <p className="bi-footnote" role="status">Change saved; sheets are still syncing.</p>}
      {pendingSent && <p className="bi-footnote">{isPayer ? "Review the pending payment before recording another receipt." : "Sent payment awaiting confirmation. The balance changes when received."}</p>}
      {cleared > 0 && <p className="bi-footnote">Undo the balance reset before changing this expense or reversing its payments.</p>}
      {isPayer && canWrite && item.settledCents > 0 && <p className="bi-footnote">Reverse confirmed repayments before editing the split or expense total.</p>}</>}/>
    : <AnimatedDisclosure open={open} onOpenChange={onOpenChange} summary={summary}>{detail}</AnimatedDisclosure>
}

function LedgerDetailScenes({ allocation, events, reversibleIds, open, compact, disabled, run, summary, notices, close, isPayer, canWrite, settled, pendingSent, splitBlocked, incomePayerCents }: {
  allocation: LedgerAllocation; events: LedgerEvent[]; reversibleIds: Set<string>; open: boolean; compact: boolean; disabled: boolean; run: Run; summary: ReactNode; notices: ReactNode; close: () => void
  isPayer: boolean; canWrite: boolean; settled: boolean; pendingSent: boolean; splitBlocked: boolean
  incomePayerCents?: number
}) {
  const [mode, setMode] = useState<"" | "payment" | "split" | "history">("")
  const [visits, setVisits] = useState({ payment: 0, split: 0, history: 0 })
  const choose = (next: "payment" | "split" | "history") => { setVisits(value => ({ ...value, [next]: value[next] + 1 })); setMode(next) }
  const back = () => setMode("")
  const editing = mode !== "", alternate = mode === "split" || mode === "history"
  const title = mode === "payment" ? isPayer ? "Record money received" : "Record sent payment" : mode === "split" ? "Edit split" : mode === "history" ? "Payment history" : "Reimbursement"
  return <div className={`sr-detail-native bi-editor${compact ? " sp-inline-editor" : ""}`} data-detail-mode={mode || "summary"}>
    {(mode === "payment" || mode === "history") && <header className="sr-detail-heading sp-flow-heading"><h2>{title}</h2></header>}
    <section className={`sp-detail${compact ? " sp-detail-inline" : ""}`} data-direction={isPayer ? "receive" : "send"} aria-label="Reimbursement editor" onKeyDown={event => { if (event.key === "Escape" && !disabled) { event.preventDefault(); close() } }}>
      <StepMotion review={editing} open={open} mode="slide" duration={transactionMotion.duration} edit={<div className="sp-summary">
        {summary}{notices}
        <div className="sr-detail-tools">{canWrite && isPayer && <button type="button" className="bi-primary" disabled={disabled || splitBlocked} onClick={() => choose("split")}>Edit split</button>}
          <button type="button" className="bi-cancel" disabled={disabled} onClick={() => choose("history")}>History ({events.length})</button></div>
        <footer className="bi-editor-footer sp-summary-footer"><button type="button" className="bi-cancel" disabled={disabled} onClick={close}>Cancel</button>
          {canWrite && !settled && <button type="button" className="bi-primary" disabled={disabled || pendingSent} onClick={() => choose("payment")}>{isPayer ? "Record received" : "Record sent payment"}</button>}</footer>
      </div>} confirm={<div className="bi-editor bi-editor-embedded">
        <StepMotion review={alternate} open={open && editing} mode="slide" duration={transactionMotion.duration}
          edit={visits.payment > 0 && <PaymentEditor key={`${allocation.version}:${visits.payment}`} allocation={allocation} isPayer={isPayer} disabled={disabled || pendingSent} run={run} close={back} native/>}
          confirm={<StepMotion review={mode === "history"} open={open && alternate} mode="slide" duration={transactionMotion.duration}
            edit={visits.split > 0 && <ReimbursementSplitEditor key={visits.split} active={open && mode === "split"} allocation={allocation} incomePayerCents={incomePayerCents} disabled={disabled} blocked={splitBlocked} run={run} close={back}/>}
            confirm={visits.history > 0 && <><PaymentHistory allocation={allocation} events={events} reversibleIds={reversibleIds} disabled={disabled} run={run}/><footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={disabled} onClick={back}><ArrowLeft/>Back</button></footer></>}/>} />
      </div>} />
    </section>
  </div>
}

function SplitEditor({ allocation, disabled, blocked, run, close }: { allocation: LedgerAllocation; disabled: boolean; blocked: boolean; run: Run; close: () => void }) {
  const [review] = useState(allocation)
  const initialBasis = review.customPayerBasisPoints ?? Math.round(review.payerShareCents / review.grossCents * 10_000)
  const [basis, setBasis] = useState(initialBasis)
  const [total, setTotal] = useState((review.grossCents / 100).toFixed(2))
  const gross = reimbursementAmountCents(total)
  const valid = gross !== null && gross > 0
  const changed = gross !== review.grossCents || basis !== initialBasis
  const preserveRatio = review.customPayerRatio && basis === initialBasis
  const payerShare = valid ? changed ? preserveRatio ? ratioShareCents(gross, review.customPayerRatio!) : Math.floor((gross * basis + 5_000) / 10_000) : review.payerShareCents : null
  const partnerShare = valid && payerShare !== null ? gross - payerShare : null
  const stale = allocation.version !== review.version
  const percent = (value: number) => `${Number((value / 100).toFixed(2))}%`
  const payer = person(review.payerOwner), partner = person(review.partnerOwner)
  const finish = () => { setBasis(initialBasis); setTotal((review.grossCents / 100).toFixed(2)); close() }
  useAppWorkStatus({ label: "Split changes", dirty: changed,
    onDiscard: () => { setBasis(initialBasis); setTotal((review.grossCents / 100).toFixed(2)); close() } })
  return <form className="bb-ledger-form bb-ledger-split-editor" onSubmit={event => {
    event.preventDefault()
    if (disabled || blocked || stale || !valid || !changed) return
    run({ operation: "edit_split", allocationId: review.id, version: review.version, grossCents: gross, ...(preserveRatio ? {payerShareCents: payerShare} : {payerBasisPoints: basis}) }, finish)
  }}><fieldset disabled={disabled || blocked || stale}><legend>Edit split</legend>
    <label>Expense total ($)<input required inputMode="decimal" value={total} aria-invalid={!valid}
      onChange={event => setTotal(event.target.value)} /></label>
    {!valid && <p className="bb-ledger-note" role="status">Enter a total greater than $0.00 with at most two decimal places.</p>}
    <label>Your share · {percent(basis)}<input type="range" min="0" max="100" step="0.01" value={basis / 100}
      aria-label="Your share percentage" aria-valuetext={`${percent(basis)}${payerShare === null ? "" : `, ${money(payerShare)}`}`}
      onChange={event => setBasis(Math.max(0, Math.min(10_000, Math.round(Number(event.target.value) * 100))))} /></label>
    <div className="bb-ledger-split-preview" aria-live="polite" aria-atomic="true">
      <div><span>{payer} · {percent(basis)}</span><strong>{payerShare === null ? "—" : money(payerShare)}</strong></div>
      <div><span>{partner} · {percent(10_000 - basis)}</span><strong>{partnerShare === null ? "—" : money(partnerShare)}</strong></div>
    </div>
    <p className="bb-ledger-note">Save to apply this split and expense total. The full expense stays in your budget until repayment is confirmed.</p>
  </fieldset>{stale && <p className="bb-ledger-note" role="status">This expense changed. Cancel and reopen Edit split to review the latest amounts.</p>}
    <div className="bb-ledger-actions"><button type="submit" disabled={disabled || blocked || stale || !valid || !changed}>Save split</button>
      <button type="button" disabled={disabled} onClick={finish}>Cancel</button></div>
  </form>
}

function ResetAmounts({ to, from }: { to: number; from: number }) {
  return <div className="bb-ledger-offset-totals"><span>Owed to you <strong>{money(to)}</strong></span><span>You owe <strong>{money(from)}</strong></span></div>
}
function ReceiveAllEditor({ snapshot, disabled, run, close }: { snapshot: LedgerSnapshot; disabled: boolean; run: Run; close: () => void }) {
  const [review] = useState(() => ({ state: snapshot.resetState,
    items: snapshot.allocations.filter(item => item.payerOwner === snapshot.ownerKey && item.outstandingCents > 0) }))
  const [date, setDate] = useState(today)
  const [note, setNote] = useState("")
  const stale = snapshot.resetState !== review.state
  const total = review.items.reduce((sum, item) => sum + item.outstandingCents, 0)
  const minDate = review.items.reduce((latest, item) => isoDate(item.expenseDate) > latest ? isoDate(item.expenseDate) : latest, "1900-01-01")
  useAppWorkStatus({ label: "All reimbursements received", dirty: Boolean(note) || date !== today(),
    onDiscard: () => { setNote(""); close() } })
  return <form className="bb-ledger-form" onSubmit={event => {
    event.preventDefault()
    if (disabled || stale || !review.state || !total || !isoDate(date) || date < minDate || date > today()) return
    run({ operation: "receive_all", expectedState: review.state, date, note }, close)
  }}><fieldset disabled={disabled}><legend>Review all money received</legend>
    <p className="bb-ledger-note">Record {money(total)} received across {review.items.length} outstanding expense{review.items.length === 1 ? "" : "s"} owed to you, across all months.</p>
    <p className="bb-ledger-note">Confirm only money you already received. Pending sent payments are included once. Money you owe stays unchanged.</p>
    <DateField value={date} onChange={setDate} min={minDate} />
    <label>Note (optional)<input maxLength={200} value={note} onChange={event => setNote(event.target.value)} /></label>
    {stale && <p className="bb-ledger-note" role="status">Reimbursements changed. Cancel and review the latest total.</p>}
    <div className="bb-ledger-actions"><button type="submit" disabled={stale || !total}>Confirm all received</button><button type="button" onClick={close}>Cancel</button></div>
  </fieldset></form>
}
export function ResetEditor({ snapshot, disabled, run, close }: { snapshot: LedgerSnapshot; disabled: boolean; run: Run; close: () => void }) {
  const [review] = useState(() => ({ expectedState: snapshot.resetState, totals: ledgerTotals(snapshot.allocations, snapshot.ownerKey),
    count: snapshot.allocations.filter(item => item.outstandingCents > 0).length }))
  const [note, setNote] = useState("")
  const stale = snapshot.resetState !== review.expectedState
  useAppWorkStatus({ label: "Reimbursement reset", dirty: Boolean(note), onDiscard: () => { setNote(""); close() } })
  return <form className="bb-ledger-form bb-ledger-reset-form" onSubmit={event => {
    event.preventDefault()
    if (disabled || stale || !review.expectedState || !review.count) return
    run({ operation: "reset", expectedState: review.expectedState, note }, close)
  }}><fieldset disabled={disabled}><legend>Review balance reset</legend>
    <ResetAmounts {...review.totals} />
    <p className="bb-ledger-note">Clear the remaining balances on {review.count} shared expense{review.count === 1 ? "" : "s"} across all months. Both directions will be $0.00.</p>
    <p className="bb-ledger-note">Recorded expenses and receipts stay unchanged. No payment or transfer is recorded. New shared expenses start a new balance. You can undo this reset from Reset history.</p>
    <label>Note (optional)<input maxLength={200} value={note} onChange={event => setNote(event.target.value)} placeholder="Settled outside BookieBot" /></label>
    {stale && <p className="bb-ledger-note" role="status">Reimbursements changed while this review was open. Cancel and open Reset balances again to review the latest amounts.</p>}
    <div className="bb-ledger-actions"><button type="submit" disabled={stale || !review.count}>Confirm reset to $0.00</button><button type="button" onClick={close}>Cancel</button></div>
  </fieldset></form>
}
export function ResetHistory({ resets, owner, disabled, run }: { resets: LedgerReset[]; owner: string; disabled: boolean; run: Run }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<LedgerReset | null>(null)
  const id = useId(), confirmationPrefix = useId()
  return <section className="bb-ledger-reset-history" aria-label="Reset history">
    <button className="bb-ledger-list-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><span>Reset history ({resets.length})</span><span className="bb-disclosure-mark" aria-hidden="true" /></button>
    <CollapsibleContent id={id} open={open}><div className="bb-ledger-history">{[...resets].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(reset => {
      const totals = { to: reset.entries.filter(entry => entry.payerOwner === owner).reduce((sum, entry) => sum + entry.amountCents, 0),
        from: reset.entries.filter(entry => entry.partnerOwner === owner).reduce((sum, entry) => sum + entry.amountCents, 0) }
      const undo = reset.status === "active", canChange = undo ? reset.canUndo : reset.canRedo
      const reviewing = selected?.id === reset.id
      const stale = reviewing && (selected.version !== reset.version || selected.status !== reset.status)
      const confirmationId = `${confirmationPrefix}-${reset.id}`
      const parsedDate = new Date(reset.createdAt)
      const createdLabel = Number.isFinite(parsedDate.getTime()) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(parsedDate) : "Date unavailable"
      return <div key={reset.id} className="bb-ledger-history-row"><div><strong>{undo ? "Balances reset" : "Reset undone"}</strong>
        <span>Originally reset by {person(reset.actorOwner)} · <time dateTime={reset.createdAt}>{createdLabel}</time></span>
        <span>{reset.entries.length} shared expense{reset.entries.length === 1 ? "" : "s"} · Owed to you {money(totals.to)} · You owe {money(totals.from)}</span>
        {reset.note && <span>{reset.note}</span>}<span>No payment recorded.</span>
        {!canChange && <span>{undo ? "Undo is unavailable for the current expenses." : "Redo is unavailable for the current expenses."}</span>}</div>
        {canChange && <button type="button" disabled={disabled} aria-expanded={reviewing} aria-controls={confirmationId} onClick={() => setSelected(reviewing ? null : reset)}>{undo ? "Undo reset" : "Redo reset"}</button>}
        <RetainedPanel id={confirmationId} open={reviewing}><div className="bb-ledger-confirm">
          <p>{selected?.status === "active" ? "Restore the balances cleared by this reset?" : "Clear the same balances again? Shared expenses added after the reset keep their balances."} Recorded expenses and receipts stay unchanged.</p>
          {selected && <ResetAmounts to={selected.entries.filter(entry => entry.payerOwner === owner).reduce((sum, entry) => sum + entry.amountCents, 0)} from={selected.entries.filter(entry => entry.partnerOwner === owner).reduce((sum, entry) => sum + entry.amountCents, 0)} />}
          {stale && <p className="bb-ledger-note" role="status">This reset changed. Cancel and review its current status again.</p>}
          <div className="bb-ledger-actions"><button type="button" disabled={disabled || stale || !canChange} onClick={() => {
            if (disabled || stale || !canChange || !selected) return
            run({ operation: selected.status === "active" ? "undo_reset" : "redo_reset", resetId: selected.id, version: selected.version }, () => setSelected(null))
          }}>{selected?.status === "active" ? "Confirm undo reset" : "Confirm redo reset"}</button><button type="button" disabled={disabled} onClick={() => setSelected(null)}>Cancel</button></div>
        </div></RetainedPanel>
      </div>
    })}</div></CollapsibleContent>
  </section>
}

function DateField({ value, onChange, min = "1900-01-01", native = false }: { value: string; onChange: (value: string) => void; min?: string; native?: boolean }) {
  return <label>Date<span className={native ? "sr-native-date" : "bb-ledger-date-field"}><input required type="date" min={min} max={today()} value={value} onChange={event => onChange(event.target.value)} /></span></label>
}
function PaymentEditor({ allocation, isPayer, disabled, run, close, native = false }: { allocation: LedgerAllocation; isPayer: boolean; disabled: boolean; run: Run; close: () => void; native?: boolean }) {
  const [amount, setAmount] = useState((allocation.outstandingCents / 100).toFixed(2))
  const [date, setDate] = useState(today)
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const [initial] = useState({ amount, date })
  const finish = () => { setAmount(initial.amount); setDate(initial.date); setNote(""); setError(""); close() }
  useAppWorkStatus({ label: "Reimbursement payment", dirty: amount !== initial.amount || date !== initial.date || Boolean(note),
    onDiscard: () => { setAmount(initial.amount); setDate(initial.date); setNote(""); setError(""); close() } })
  const [version] = useState(allocation.version)
  const minDate = isoDate(allocation.expenseDate) || "1900-01-01"
  const amountInput = <input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} />
  return <form className={native ? "bi-fields sr-native-form sr-native-payment" : "bb-ledger-form"} onSubmit={event => {
    event.preventDefault()
    if (disabled) return
    const cents = reimbursementAmountCents(amount)
    if (cents === null || cents <= 0 || cents > allocation.outstandingCents || !isoDate(date) || date < minDate || date > today()) { setError("Enter a date on or after the expense and an amount up to the balance due."); return }
    run({ operation: isPayer ? "receive" : "report_payment", allocationId: allocation.id, version, amountCents: cents, date, note }, finish)
  }}><fieldset disabled={disabled}><legend className={native ? "bi-sr-only" : undefined}>{isPayer ? "Record money received" : "Record a sent payment"}</legend>
    <div className={native ? "bi-secondary-fields" : "bb-ledger-fields"}><label>Amount ($){native ? <span className="bi-money-input"><span aria-hidden="true">$</span>{amountInput}</span> : amountInput}</label><DateField value={date} onChange={setDate} min={minDate} native={native}/></div>
    <label>Note (optional)<input maxLength={200} value={note} onChange={event => setNote(event.target.value)} /></label>
    <p className={native ? "bi-footnote" : "bb-ledger-note"}>{isPayer ? "Record only money already received. No transfer is made." : `${person(allocation.payerOwner)} will confirm receipt. No transfer is made.`}</p>
    {error && <p role="alert">{error}</p>}
    <div className={native ? "bi-editor-footer" : "bb-ledger-actions"}>{native && <button className="bi-cancel" type="button" onClick={finish}>Cancel</button>}<button className={native ? "bi-primary" : undefined} type="submit">{isPayer ? "Confirm received record" : "Record sent payment"}</button>{!native && <button type="button" onClick={finish}>Cancel</button>}</div>
  </fieldset></form>
}
export function IncomingPayment({ event, allocation, disabled, run }: { event: LedgerEvent; allocation: LedgerAllocation; disabled: boolean; run: Run }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className="bb-ledger-incoming-row"><div><strong>{allocation.item || allocation.category}</strong><span>{person(event.debtorOwner)} marked {money(event.amountCents)} sent</span></div>
    <button type="button" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>Review</button>
    <RetainedPanel id={id} open={open}><div className="bb-ledger-confirm"><p>{dateLabel(event.date)}{event.note ? ` · ${event.note}` : ""}</p><p>Confirm only after receiving {money(event.amountCents)}.</p>
      <div className="bb-ledger-actions"><button type="button" disabled={disabled} onClick={() => run({ operation: "confirm_payment", allocationId: allocation.id, eventId: event.id, version: allocation.version }, () => setOpen(false))}>Confirm received</button><button type="button" disabled={disabled} onClick={() => setOpen(false)}>Cancel</button></div></div></RetainedPanel>
  </div>
}
function PaymentHistory({ allocation, events, reversibleIds, disabled, run }: { allocation: LedgerAllocation; events: LedgerEvent[]; reversibleIds: Set<string>; disabled: boolean; run: Run }) {
  const [selected, setSelected] = useState("")
  const confirmationPrefix = useId()
  return <div className="bb-ledger-history">
    {!events.length && <p className="bb-ledger-note">{writable(allocation) ? "No payments recorded." : "Historical split. Earlier receipts are retained in the original ledger."}</p>}
    {[...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(event => {
      const group = events.filter(item => item.operationId === event.operationId)
      const canReverse = reversibleIds.has(event.id)
      const confirmationId = `${confirmationPrefix}-${event.id}`
      return <div key={event.id} className="bb-ledger-history-row"><div><strong>{money(event.amountCents)} <span>{event.status === "reversed" ? "Reversed" : event.kind === "offset" ? "Offset" : event.status === "pending" ? "Awaiting confirmation" : "Received"}</span></strong>
        <span>{dateLabel(event.date)} · {person(event.debtorOwner)} → {person(event.payeeOwner)}</span>{event.note && <span>{event.note}</span>}</div>
        {canReverse && <button type="button" disabled={disabled} aria-expanded={selected === event.id} aria-controls={confirmationId} onClick={() => setSelected(selected === event.id ? "" : event.id)}>Reverse</button>}
        <RetainedPanel id={confirmationId} open={canReverse && selected === event.id}><div className="bb-ledger-confirm"><p>{event.kind === "offset" ? "Reverse the entire offset, including its matching entries?" : event.status === "pending" ? "Remove this unconfirmed payment record?" : `Reverse this ${money(event.amountCents)} receipt and restore the balance owed?`} No money is moved.</p>
          {event.kind === "offset" && group.length > 1 && <p className="bb-ledger-note">{group.length} linked entries in this expense.</p>}
          <div className="bb-ledger-actions"><button type="button" disabled={disabled} onClick={() => run({ operation: "reverse", eventId: event.id }, () => setSelected(""))}>Confirm reversal</button><button type="button" disabled={disabled} onClick={() => setSelected("")}>Cancel</button></div></div></RetainedPanel>
      </div>
    })}
  </div>
}
function OffsetEditor({ allocations, events, owner, disabled, run, close }: { allocations: LedgerAllocation[]; events: LedgerEvent[]; owner: string; disabled: boolean; run: Run; close: () => void }) {
  const pendingAllocs = pendingAllocationIds(events)
  const [initialEligible] = useState(() => allocations.filter(item => writable(item) && item.outstandingCents > 0 && !pendingAllocs.has(item.id)))
  const eligible = initialEligible.filter(item => !pendingAllocs.has(item.id))
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(defaultOffsetEntries(allocations, owner, events).map(entry => [entry.allocationId, (entry.amountCents / 100).toFixed(2)])))
  const [date, setDate] = useState(today)
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const [initial] = useState({ amounts, date })
  useAppWorkStatus({ label: "Reimbursement offset", dirty: JSON.stringify(amounts) !== JSON.stringify(initial.amounts) || date !== initial.date || Boolean(note),
    onDiscard: () => { setAmounts(initial.amounts); setDate(initial.date); setNote(""); setError(""); close() } })
  const entries = eligible.map(item => ({ allocationId: item.id, version: item.version, amountCents: reimbursementAmountCents(amounts[item.id] || "0"), item }))
  const validAmounts = entries.every(entry => entry.amountCents !== null && entry.amountCents <= entry.item.outstandingCents)
  const to = entries.filter(entry => entry.item.payerOwner === owner).reduce((sum, entry) => sum + (entry.amountCents ?? 0), 0)
  const from = entries.filter(entry => entry.item.partnerOwner === owner).reduce((sum, entry) => sum + (entry.amountCents ?? 0), 0)
  const valid = validAmounts && to > 0 && to === from
  const minDate = entries.filter(entry => (entry.amountCents ?? 0) > 0)
    .reduce((latest, entry) => { const date = isoDate(entry.item.expenseDate); return date > latest ? date : latest }, "1900-01-01")
  return <form className="bb-ledger-form" onSubmit={event => {
    event.preventDefault()
    if (disabled) return
    if (!valid || !isoDate(date) || date < minDate || date > today()) { setError("Choose equal amounts and a date on or after the selected expenses."); return }
    run({ operation: "offset", entries: entries.filter(entry => entry.amountCents! > 0).map(({ allocationId, version, amountCents }) => ({ allocationId, version, amountCents })), date, note }, close)
  }}><fieldset disabled={disabled}><legend>Review matching balances</legend>
    <p className="bb-ledger-note">Cancel equal amounts you owe each other. No money is transferred.</p>
    {(["to", "from"] as const).map(direction => <div key={direction} className="bb-ledger-offset-side"><h4>{direction === "to" ? "Owed to you" : "You owe"}</h4>
      {eligible.filter(item => (direction === "to" ? item.payerOwner : item.partnerOwner) === owner).map(item => <label key={item.id} className="bb-ledger-offset-entry"><span>{item.item || item.category}<small>{dateLabel(item.expenseDate)} · {money(item.outstandingCents)} due</small></span>
        <input inputMode="decimal" aria-label={`Offset ${item.item || item.category}, ${dateLabel(item.expenseDate)}, ${direction === "to" ? "owed to you" : "you owe"}`} value={amounts[item.id] || ""} placeholder="0.00" onChange={event => setAmounts(previous => ({ ...previous, [item.id]: event.target.value }))} /></label>)}</div>)}
    <div className="bb-ledger-offset-totals"><span>Owed to you <strong>{money(to)}</strong></span><span>You owe <strong>{money(from)}</strong></span></div>
    {!valid && <p className="bb-ledger-note">Both totals must match and stay within each expense’s balance.</p>}
    <DateField value={date} onChange={setDate} min={minDate} /><label>Note (optional)<input maxLength={200} value={note} onChange={event => setNote(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="bb-ledger-actions"><button type="submit" disabled={!valid}>Confirm offset{valid ? ` · ${money(to)}` : ""}</button><button type="button" onClick={close}>Cancel</button></div>
  </fieldset></form>
}
