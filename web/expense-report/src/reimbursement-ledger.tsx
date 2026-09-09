import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { AnimatedDisclosure, CollapsibleContent, SlidingSelection } from "./components/ui/motion"
import { FittedAmount } from "./components/ui/fitted-amount"
import "./reimbursement-ledger.css"

export interface LedgerAllocation {
  id: string; payerOwner: string; partnerOwner: string; payerPerson: string
  item: string; location: string; expenseDate: string; category: string
  grossCents: number; payerShareCents: number; partnerShareCents: number
  settledCents: number; outstandingCents: number; method: string; version: number
  status: "outstanding" | "settled"; projectedVersion: number; accounting: string
}
export interface LedgerEvent {
  id: string; operationId: string; allocationId: string; kind: "receive" | "report_payment" | "offset"
  actorOwner: string; payeeOwner: string; debtorOwner: string; amountCents: number; date: string; note: string
  status: "pending" | "confirmed" | "reversed"; createdAt: string; confirmedAt: string
  confirmedBy: string; reversedAt: string; reversedBy: string
}
interface LedgerSnapshot {
  enabled: true; ownerKey: string; allocations: LedgerAllocation[]; events: LedgerEvent[]
  currency: "USD"; projectionPending?: boolean; error?: string
}
type LedgerResponse = LedgerSnapshot | { enabled: false }
type Command = Record<string, unknown>
type Run = (command: Command, done: () => void) => void
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
    .map(([key, items]) => ({ key, label: monthLabel(key), items: items.sort((a, b) => (isoDate(a.expenseDate) || "9999").localeCompare(isoDate(b.expenseDate) || "9999") || a.id.localeCompare(b.id)),
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
    && events.filter(item => item.operationId === event.operationId).every(item => allocations.some(allocation => allocation.id === item.allocationId && writable(allocation)))
}

class LedgerRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
async function request<T>(body?: Command, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let rejectAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error("The request did not finish.")) })
  controller.signal.addEventListener("abort", rejectAbort, { once: true })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const timer = window.setTimeout(abort, 20_000)
  try {
    return await Promise.race([cancelled, fetch("/app/reimbursements", {
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
    if (!item.id || ![item.grossCents, item.payerShareCents, item.partnerShareCents, item.settledCents, item.outstandingCents, item.version]
      .every(value => Number.isSafeInteger(value) && value >= 0)
      || item.grossCents !== item.payerShareCents + item.partnerShareCents
      || item.partnerShareCents !== item.settledCents + item.outstandingCents) throw new Error("Incomplete reimbursement amounts")
  }
  return snapshot
}

export function ReimbursementLedger({ fallback, refreshKey }: { fallback: ReactNode; refreshKey?: string }) {
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [signedOut, setSignedOut] = useState(false)
  const mounted = useRef(false)
  const readId = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const writeController = useRef<AbortController | null>(null)
  const executing = useRef(false)
  const pending = useRef<{ body: Command; done: () => void } | null>(null)
  const load = useCallback(async () => {
    const id = ++readId.current
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    setRefreshing(true)
    try {
      const response = await request<LedgerResponse>(undefined, controller.signal)
      if (!mounted.current || id !== readId.current) return false
      if (response.enabled === false) { setLegacy(true); setSnapshot(null) }
      else { setSnapshot(validate(response)); setLegacy(false) }
      setSignedOut(false); setError("")
      return true
    } catch (failure) {
      if (!mounted.current || id !== readId.current || controller.signal.aborted) return false
      if (failure instanceof LedgerRequestError && [401, 403].includes(failure.status)) {
        setSnapshot(null); setLegacy(false); setSignedOut(failure.status === 401)
      }
      setError(failure instanceof LedgerRequestError ? failure.message : "Couldn’t refresh reimbursements. Previously loaded balances may be out of date.")
      return false
    } finally { if (mounted.current && id === readId.current) setRefreshing(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    const refresh = () => { if (!pending.current && document.visibilityState === "visible") void load() }
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      mounted.current = false; ++readId.current
      readController.current?.abort(); writeController.current?.abort()
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [load])
  useEffect(() => { if (!pending.current) void load() }, [load, refreshKey])
  const execute = async () => {
    const change = pending.current
    if (!change || executing.current) return
    executing.current = true
    ++readId.current; readController.current?.abort(); setRefreshing(false)
    const controller = new AbortController()
    writeController.current = controller
    setBusy(true); setError("")
    try {
      const result = validate(await request<LedgerResponse>(change.body, controller.signal))
      if (!mounted.current) return
      pending.current = null; setUncertain(false); change.done()
      setSnapshot(result); setLegacy(false)
      window.dispatchEvent(new CustomEvent("bookiebot:reimbursements-changed"))
      await load()
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof LedgerRequestError && failure.status < 500) {
        pending.current = null; setUncertain(false)
        if (failure.status === 401) { setSnapshot(null); setSignedOut(true); change.done() }
        if (failure.status === 409) { change.done(); await load() }
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
  if (legacy && !uncertain) return <>{fallback}</>
  return <Card className="bb-report-section bb-reimbursement-section bb-canonical-reimbursements">
    <CardHeader><CardTitle>Shared Reimbursements</CardTitle></CardHeader>
    <CardContent>
      {error && <div className="bb-ledger-message" role="alert"><p>{error}</p>
        {uncertain ? <button type="button" disabled={busy || signedOut} onClick={() => void execute()}>Retry this record</button>
          : <button type="button" disabled={busy || refreshing} onClick={() => void load()}>Refresh reimbursements</button>}</div>}
      {!snapshot && !error && <p className="bb-ledger-note" role="status">Loading reimbursements…</p>}
      {snapshot && <LedgerContents snapshot={snapshot} disabled={busy || uncertain || refreshing} run={run}
        refresh={() => void load()} refreshing={refreshing} />}
    </CardContent>
  </Card>
}

function LedgerContents({ snapshot, disabled, run, refresh, refreshing }: {
  snapshot: LedgerSnapshot; disabled: boolean; run: Run; refresh: () => void; refreshing: boolean
}) {
  const { allocations, events, ownerKey } = snapshot
  const [direction, setDirection] = useState<Direction>("to")
  const [listOpen, setListOpen] = useState(false)
  const [offsetOpen, setOffsetOpen] = useState(false)
  const listId = useId(), offsetId = useId()
  const totals = ledgerTotals(allocations, ownerKey)
  const shown = allocations.filter(item => (direction === "to" ? item.payerOwner : item.partnerOwner) === ownerKey)
  const timeline = months(shown).filter(group => group.cents > 0).reverse()
  const rows = timeline.length <= 4 ? timeline : [{ key: "earlier", label: "Earlier expenses", items: [], cents: timeline.slice(0, -3).reduce((sum, group) => sum + group.cents, 0) }, ...timeline.slice(-3)]
  const pendingAllocs = pendingAllocationIds(events)
  const writableTotals = ledgerTotals(allocations.filter(writable), ownerKey)
  const eligible = ledgerTotals(allocations.filter(item => writable(item) && !pendingAllocs.has(item.id)), ownerKey)
  const pendingOffset = writableTotals.to > 0 && writableTotals.from > 0
    && allocations.some(item => writable(item) && item.outstandingCents > 0 && pendingAllocs.has(item.id))
  const incoming = events.filter(event => event.status === "pending" && event.kind === "report_payment" && event.payeeOwner === ownerKey
    && allocations.some(item => item.id === event.allocationId && writable(item)))
  const reversibleIds = new Set(events.filter(event => canReverseLedgerEvent(event, ownerKey, allocations, events)).map(event => event.id))
  return <>
    <SlidingSelection value={direction} className="bb-ledger-directions" role="group" aria-label="Reimbursement direction">
      <button type="button" aria-pressed={direction === "to"} onClick={() => setDirection("to")}>Owed to you<FittedAmount className="bb-ledger-direction-amount">{money(totals.to)}</FittedAmount></button>
      <button type="button" aria-pressed={direction === "from"} onClick={() => setDirection("from")}>You owe<FittedAmount className="bb-ledger-direction-amount">{money(totals.from)}</FittedAmount></button>
    </SlidingSelection>
    <div className="bb-ledger-net"><span>{totals.net > 0 ? "Net owed to you" : totals.net < 0 ? "Net you owe" : "Net balance"}</span><strong>{money(Math.abs(totals.net))}</strong></div>
    {snapshot.projectionPending && <div className="bb-ledger-message" role="status"><p>Recorded. Expense sheets are still syncing.</p><button type="button" disabled={disabled || refreshing} onClick={refresh}>Refresh</button></div>}
    {snapshot.error && <p className="bb-ledger-note" role="status">{snapshot.error}</p>}
    {rows.length > 0 && <figure className="bb-reimbursement-timeline bb-ledger-timeline" aria-label={`${direction === "to" ? "Owed to you" : "You owe"} by expense month`}>
      <div className="bb-reimbursement-bar-track" aria-hidden="true">{rows.map((group, index) => <span key={group.key} data-segment={index} style={{ width: `${group.cents / totals[direction] * 100}%` }} />)}</div>
      <ol>{rows.map((group, index) => <li key={group.key} data-segment={index}><div className="bb-reimbursement-bar-label"><span><i className="bb-reimbursement-swatch" aria-hidden="true" />{group.label}</span><FittedAmount className="bb-reimbursement-bar-amount">{money(group.cents)}</FittedAmount></div></li>)}</ol>
    </figure>}
    {pendingOffset && <p className="bb-ledger-note">Confirm pending payments before offsetting those expenses.</p>}
    {eligible.to > 0 && eligible.from > 0 && <><button className="bb-ledger-offset-toggle" type="button" disabled={disabled} aria-expanded={offsetOpen} aria-controls={offsetId} onClick={() => setOffsetOpen(!offsetOpen)}>Offset balances</button>
      <RetainedPanel id={offsetId} open={offsetOpen}><OffsetEditor allocations={allocations} events={events} owner={ownerKey} disabled={disabled} run={run} close={() => setOffsetOpen(false)} /></RetainedPanel></>}
    {incoming.length > 0 && <section className="bb-ledger-incoming" aria-label="Payments awaiting your confirmation"><h3>Awaiting your confirmation</h3>
      {incoming.map(event => <IncomingPayment key={event.id} event={event} allocation={allocations.find(item => item.id === event.allocationId)!} disabled={disabled} run={run} />)}</section>}
    <button className="bb-ledger-list-toggle" type="button" aria-expanded={listOpen} aria-controls={listId} onClick={() => setListOpen(!listOpen)}>
      <span>{shown.length ? `View ${shown.length} expense${shown.length === 1 ? "" : "s"}` : "No shared expenses in this direction"}</span><span aria-hidden="true">{listOpen ? "−" : "+"}</span>
    </button>
    <CollapsibleContent id={listId} open={listOpen}><div className="bb-reimbursement-groups">{months(shown).map(group => <LedgerMonth key={`${direction}:${group.key}`} group={group} events={events} reversibleIds={reversibleIds} owner={ownerKey} disabled={disabled} run={run} />)}</div></CollapsibleContent>
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
function LedgerMonth({ group, events, reversibleIds, owner, disabled, run }: {
  group: ReturnType<typeof months>[number]; events: LedgerEvent[]; reversibleIds: Set<string>; owner: string; disabled: boolean; run: Run
}) {
  const [opened, setOpened] = useState("")
  return <section className="bb-reimbursement-group" aria-label={group.label}>
    <div className="bb-reimbursement-month-heading"><h3>{group.label}{group.key === today().slice(0, 7) && <span className="bb-reimbursement-month-tag">This month</span>}</h3></div>
    {group.items.map(item => <LedgerRow key={item.id} allocation={item} events={events.filter(event => event.allocationId === item.id)} reversibleIds={reversibleIds} owner={owner}
      open={opened === item.id} onOpenChange={open => setOpened(open ? item.id : "")} disabled={disabled} run={run} />)}
  </section>
}
function LedgerRow({ allocation: item, events, reversibleIds, owner, open, onOpenChange, disabled, run }: {
  allocation: LedgerAllocation; events: LedgerEvent[]; reversibleIds: Set<string>; owner: string; open: boolean; onOpenChange: (open: boolean) => void; disabled: boolean; run: Run
}) {
  const [mode, setMode] = useState<"" | "payment" | "history">("")
  const paymentId = useId(), historyId = useId()
  const payer = item.payerPerson || person(item.payerOwner), partner = person(item.partnerOwner)
  const isPayer = owner === item.payerOwner
  const settled = item.outstandingCents === 0
  const shares = item.grossCents > 0 ? [item.payerShareCents, item.settledCents, item.outstandingCents].map(value => value / item.grossCents * 100) : [0, 0, 0]
  const pendingSent = events.some(event => event.status === "pending")
  const canWrite = writable(item)
  const settledLabel = events.some(event => event.kind === "offset" && event.status === "confirmed") ? "Settled" : isPayer ? "Received" : "Paid"
  return <AnimatedDisclosure open={open} onOpenChange={onOpenChange} summary={<>
    <span className="bb-reimbursement-item"><strong title={item.item || item.category}>{item.item || item.category || "Shared expense"}</strong></span>
    <div className="bb-reimbursement-status" data-settled={settled}>{settled ? settledLabel : <><FittedAmount className="bb-reimbursement-due">{money(item.outstandingCents)}</FittedAmount><i className="bb-reimbursement-due-key" aria-hidden="true" /><small>due</small></>}</div>
    <span className="bb-disclosure-mark" aria-hidden="true" />
  </>}>
    <div className="bb-reimbursement-detail">
      <div className="bb-reimbursement-receipt-meta"><p><time dateTime={isoDate(item.expenseDate) || undefined} title={item.expenseDate}>{dateLabel(item.expenseDate)}</time></p>
        <p>{item.method === "fronted" ? `Fronted for ${partner}` : item.method === "income" ? "By income" : item.method === "equal" ? "Split 50/50" : item.method}</p>
        {item.location && <p>{item.location}</p>}</div>
      <div className="bb-reimbursement-visual" role="img" aria-label={`${payer} paid ${money(item.grossCents)}. ${person(item.payerOwner)}’s share ${money(item.payerShareCents)}. ${partner}’s share ${money(item.partnerShareCents)}: ${money(item.settledCents)} settled; ${money(item.outstandingCents)} still owed.`}>
        <div className="bb-reimbursement-visual-segments" aria-hidden="true">{["personal", "received", "outstanding"].map((portion, index) => <span key={portion} data-portion={portion} style={{ width: `${shares[index]}%` }} />)}</div>
        <span className="bb-reimbursement-visual-total" aria-hidden="true">{payer} paid · <span>{money(item.grossCents)}</span></span>
      </div>
      <dl className="bb-reimbursement-visual-legend"><div><dt><i className="bb-reimbursement-visual-key" data-portion="personal" aria-hidden="true" /><span>{isPayer ? "Yours" : `${person(item.payerOwner)}’s share`}</span></dt><dd>{money(item.payerShareCents)}</dd></div>
        <div><dt><i className="bb-reimbursement-visual-key" data-portion="received" aria-hidden="true" /><span>{isPayer ? partner : "You"} {events.some(event => event.kind === "offset" && event.status === "confirmed") ? "settled" : "paid"}</span></dt><dd>{money(item.settledCents)}</dd></div></dl>
      {!canWrite && <p className="bb-ledger-note">Historical split · read only</p>}
      {pendingSent && <p className="bb-ledger-note">{isPayer ? "Review the pending payment above before recording another receipt." : "Sent payment awaiting confirmation. The balance changes when received."}</p>}
      <div className="bb-ledger-actions">
        {canWrite && !settled && <button type="button" disabled={disabled || pendingSent} aria-expanded={mode === "payment"} aria-controls={paymentId} onClick={() => setMode(mode === "payment" ? "" : "payment")}>{isPayer ? "Record received" : "Record sent payment"}</button>}
        <button type="button" aria-expanded={mode === "history"} aria-controls={historyId} onClick={() => setMode(mode === "history" ? "" : "history")}>History ({events.length})</button>
      </div>
      <RetainedPanel id={paymentId} open={open && mode === "payment"}><PaymentEditor key={item.version} allocation={item} isPayer={isPayer} disabled={disabled || pendingSent} run={run} close={() => setMode("")} /></RetainedPanel>
      <RetainedPanel id={historyId} open={open && mode === "history"}><PaymentHistory allocation={item} events={events} reversibleIds={reversibleIds} disabled={disabled} run={run} /></RetainedPanel>
    </div>
  </AnimatedDisclosure>
}

function DateField({ value, onChange, min = "1900-01-01" }: { value: string; onChange: (value: string) => void; min?: string }) {
  return <label>Date<span className="bb-ledger-date-field"><input required type="date" min={min} max={today()} value={value} onChange={event => onChange(event.target.value)} /></span></label>
}
function PaymentEditor({ allocation, isPayer, disabled, run, close }: { allocation: LedgerAllocation; isPayer: boolean; disabled: boolean; run: Run; close: () => void }) {
  const [amount, setAmount] = useState((allocation.outstandingCents / 100).toFixed(2))
  const [date, setDate] = useState(today)
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const [version] = useState(allocation.version)
  const minDate = isoDate(allocation.expenseDate) || "1900-01-01"
  return <form className="bb-ledger-form" onSubmit={event => {
    event.preventDefault()
    if (disabled) return
    const cents = reimbursementAmountCents(amount)
    if (cents === null || cents <= 0 || cents > allocation.outstandingCents || !isoDate(date) || date < minDate || date > today()) { setError("Enter a date on or after the expense and an amount up to the balance due."); return }
    run({ operation: isPayer ? "receive" : "report_payment", allocationId: allocation.id, version, amountCents: cents, date, note }, close)
  }}><fieldset disabled={disabled}><legend>{isPayer ? "Record money received" : "Record a sent payment"}</legend>
    <div className="bb-ledger-fields"><label>Amount ($)<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><DateField value={date} onChange={setDate} min={minDate} /></div>
    <label>Note (optional)<input maxLength={200} value={note} onChange={event => setNote(event.target.value)} /></label>
    <p className="bb-ledger-note">{isPayer ? "Record only money already received. No transfer is made." : `${person(allocation.payerOwner)} will confirm receipt. No transfer is made.`}</p>
    {error && <p role="alert">{error}</p>}
    <div className="bb-ledger-actions"><button type="submit">{isPayer ? "Confirm received record" : "Record sent payment"}</button><button type="button" onClick={close}>Cancel</button></div>
  </fieldset></form>
}
function IncomingPayment({ event, allocation, disabled, run }: { event: LedgerEvent; allocation: LedgerAllocation; disabled: boolean; run: Run }) {
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
