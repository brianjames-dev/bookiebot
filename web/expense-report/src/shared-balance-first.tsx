import {ReimbursementSaveButton} from './reimbursement-feedback'
import {ReimbursementOptions,HistoryFilter,SelectionClose,BalanceSides,ReimbursementResetFlow,useShortReimbursementPane} from "./reimbursement-tools"
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ArrowDownLeft, ArrowUpRight, CheckCheck, ChevronDown, ChevronRight, Clock3 } from "lucide-react"
import { TransactionIcon } from "./daily-transactions"
import { transactionCategory, type DailyTransaction } from "./transaction-identity"
import { EditorExpansion, EditorScenes } from "./transaction-editor-workspace"
import { useAppWorkStatus } from "./app-work-guard"
import { useReimbursementPage } from "./reimbursement-pagination"
import { useAppNavigation } from "./app-navigation"
import { RepaymentAllocation } from "./repayment-allocation"
import { ChangeMotionContext, ChangedMoney, ChangedText } from "./transaction-value-motion"
import { reimbursementMethod, reimbursementMotionKey, useReimbursementValueMotion } from "./reimbursement-value-motion"
import { canReverseLedgerEvent, defaultOffsetEntries, IncomingPayment, LedgerRow, ledgerTotals, ResetEditor,
  type LedgerAllocation, type LedgerSnapshot, type Run } from "./reimbursement-ledger"

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
const person = (owner: string) => owner ? owner[0].toUpperCase() + owner.slice(1) : "Partner"
export function sharedExpenseDate(value: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  const p = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3], +us[1], +us[2]] : null
  return p && p[0] >= 1900 && p[1] >= 1 && p[1] <= 12 && p[2] >= 1 && p[2] <= new Date(Date.UTC(p[0], p[1], 0)).getUTCDate()
    ? `${p[0]}-${String(p[1]).padStart(2, "0")}-${String(p[2]).padStart(2, "0")}` : ""
}
const dateLabel = (value: string, month = false) => {
  const date = sharedExpenseDate(value)
  return date ? new Intl.DateTimeFormat("en-US", { month: month ? "long" : "short", ...(month ? { year: "numeric" as const } : { day: "numeric" as const }), timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)) : "Undated"
}
/** Default scope is determined by the complete snapshot, never a rendered page. */
export function balanceFirstScope(allocations: LedgerAllocation[], currentMonth: string, history = false) {
  const outstanding = allocations.some(item => item.outstandingCents > 0)
  return allocations.filter(item => history || (outstanding ? item.outstandingCents > 0 : sharedExpenseDate(item.expenseDate).slice(0, 7) === currentMonth))
}
export function reimbursementTransaction(item: LedgerAllocation): DailyTransaction {
  const categories: Record<string, string> = { need: "Needs", needs: "Needs", want: "Wants", wants: "Wants", grocery: "Groceries", food: "Food", shopping: "Shopping", gas: "Gas", rent: "Rent", bills: "Bills & Utilities", utilities: "Bills & Utilities" }
  return { id: item.id, date: item.expenseDate, item: item.item, location: item.location, person: item.payerPerson,
    category: categories[item.category.toLowerCase()] ?? item.category, amount: item.grossCents / 100 }
}
type Review = { state: string | undefined; to: number; from: number; entries: ReturnType<typeof defaultOffsetEntries>; min: string }
type Scene = import("./reimbursement-tools").ReimbursementScene

export function BalanceFirstReimbursements({ snapshot, disabled, selectDisabled = disabled, refreshing = false, run, aliases, refresh, headerActions, undoVersion = 0 }: {
  snapshot: LedgerSnapshot; disabled: boolean; selectDisabled?: boolean; refreshing?: boolean; run: Run; aliases?: Record<string, string>; refresh: () => void; headerActions?: HTMLElement | null; undoVersion?: number
}) {
  const previousUndo = useRef(undoVersion)
  const undoing = previousUndo.current !== undoVersion
  const { allocations, events, ownerKey } = snapshot
  const wide = useAppNavigation()?.duoLandscape === true
  const short = useShortReimbursementPane(wide)
  const [detailPane, setDetailPane] = useState<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState("")
  const [resetId, setResetId] = useState("")
  const [history, setHistory] = useState(false)
  const [scene, changeScene] = useState<Scene>("summary")
  const [navigation, setNavigation] = useState<"forward" | "backward">("forward")
  const setScene = (next: Scene, direction: "forward" | "backward" = "forward") => { if (next === "reset-history" && scene === "summary") setResetId(""); setNavigation(direction); changeScene(next) }
  const [review, setReview] = useState<Review | null>(null)
  const [date, setDate] = useState(today)
  const [offsetReceipt, setOffsetReceipt] = useState(0)
  useLayoutEffect(() => { previousUndo.current = undoVersion; if (undoVersion) { setReview(null); setOffsetReceipt(0); if (scene.startsWith("reset-")) setScene("reset-history", "backward"); else if (scene !== "summary") setScene("summary", "backward") } }, [undoVersion])
  const totals = ledgerTotals(allocations, ownerKey)
  const active = allocations.filter(item => item.outstandingCents > 0)
  const pending = events.filter(event => event.status === "pending")
  const incoming = pending.filter(event => event.payeeOwner === ownerKey && allocations.some(item => item.id === event.allocationId && item.accounting === "cash_v1"))
  const currentMonth = today().slice(0, 7)
  const scoped = balanceFirstScope(allocations, currentMonth, history)
  const retained = allocations.find(item => item.id === selected)
  const shown = retained && !scoped.some(item => item.id === selected) ? [...scoped, retained] : scoped
  if (selected && !shown.some(item => item.id === selected)) setSelected("")
  const groups = [...new Set(shown.map(item => sharedExpenseDate(item.expenseDate).slice(0, 7) || "undated"))]
    .sort((a, b) => a === "undated" ? 1 : b === "undated" ? -1 : b.localeCompare(a))
    .map(key => ({ key, items: shown.filter(item => (sharedExpenseDate(item.expenseDate).slice(0, 7) || "undated") === key)
      .sort((a, b) => sharedExpenseDate(b.expenseDate).localeCompare(sharedExpenseDate(a.expenseDate)) || a.id.localeCompare(b.id)) }))
  const page = useReimbursementPage(groups, group => group.key, true, history ? 5 : groups.length)
  const reversibleIds = new Set(events.filter(event => canReverseLedgerEvent(event, ownerKey, allocations, events)).map(event => event.id))
  const partnerKeys = [...new Set(allocations.flatMap(item => [item.payerOwner, item.partnerOwner]).filter(owner => owner !== ownerKey))]
  const partner = partnerKeys.length === 1 ? person(partnerKeys[0]) : "your household"
  const confirmingIncomingOnly = totals.to > 0 && totals.from === 0 && pending.every(event => event.payeeOwner === ownerKey)
  const blocked = snapshot.projectionPending ? "Recorded changes are still syncing. Refresh before settling."
    : pending.length && !confirmingIncomingOnly ? "Review or reverse pending payments before settling the remaining balance."
    : active.some(item => item.accounting !== "cash_v1" || item.version !== item.projectedVersion || Boolean(item.clearedCents))
      ? "Review historical or syncing expenses individually before settling all balances."
      : partnerKeys.length > 1 ? "Review each person's expenses separately before settling." : ""
  const stale = review !== null && review.state !== snapshot.resetState && !undoing
  const locked = disabled || Boolean(snapshot.error)
  const close = () => { setScene("summary", "backward"); setReview(null) }
  useAppWorkStatus({ label: "Shared settlement review", dirty: scene !== "summary" && scene !== "reset-history", onDiscard: close })
  const makeReview = (source: LedgerSnapshot): Review => ({ state: source.resetState, ...ledgerTotals(source.allocations, source.ownerKey),
    entries: defaultOffsetEntries(source.allocations, source.ownerKey, source.events),
    min: source.allocations.filter(item => item.outstandingCents > 0).reduce((latest, item) => sharedExpenseDate(item.expenseDate) > latest ? sharedExpenseDate(item.expenseDate) : latest, "1900-01-01") })
  const start = () => {
    setSelected(""); setOffsetReceipt(0); setDate(today())
    setReview(makeReview(snapshot)); setScene(totals.to > 0 && totals.from > 0 ? "offset" : "payment")
  }
  // The acknowledged offset returns the new canonical snapshot in the same
  // render. Capture the cash review only from that state, never old net values.
  const paymentReview = scene === "payment" && review === null ? makeReview(snapshot) : review
  if (scene === "payment" && review === null) setReview(paymentReview)
  const cash = paymentReview ? Math.abs(paymentReview.to - paymentReview.from) : 0
  const sent = paymentReview ? paymentReview.from > paymentReview.to : false
  const dateValid = Boolean(sharedExpenseDate(date)) && date >= (paymentReview?.min ?? "1900-01-01") && date <= today()
  const primary = (label: string, click: () => void, off = false, operation = "") => <ReimbursementSaveButton operation={operation} aria-label={label} type="button" className={scene === "summary" ? "sr-primary" : "bi-primary"} disabled={locked || off} onClick={click}><span className="sr-primary-copy">{label}</span>{scene === "summary" && <ChevronRight aria-hidden="true"/>}</ReimbursementSaveButton>
  const flow = <div className="sr-editor" data-stage={scene}>
    <EditorScenes scene={scene} direction={navigation} sceneClassName={name => name === "summary" ? "" : `bi-editor sr-settlement-editor${!wide ? " sp-inline-editor" : ""}`}>
      {scene === "offset" && review ? <>
        <div className="sr-editor-heading"><h2>Offset balances</h2></div>
        <ol className="sr-settlement-steps" aria-label="Settlement steps"><li data-current="true">Offset</li>{review.to !== review.from && <><ChevronRight aria-hidden="true"/><li>Payment (optional)</li></>}</ol>
        <dl className="sr-before-balances"><div><dt>{partner} owes you</dt><dd>{money(review.to)}</dd></div><div><dt>You owe {partner}</dt><dd>{money(review.from)}</dd></div></dl>
        <div className="sr-offset-amount"><span>Offset each way</span><strong>{money(Math.min(review.to, review.from))}</strong></div>
        <div className="sr-offset-result"><span>{review.to >= review.from ? "Still owed to you" : "Still owed to " + partner}</span><strong>{money(Math.abs(review.to - review.from))}</strong></div>
        <p className="bi-footnote">Equal debts cancel. No money moves in this step.</p>
        {stale && <p role="status">Balances changed. Cancel and review again.</p>}
        <div className="bi-editor-footer"><button className="bi-cancel" disabled={disabled} onClick={close}>Cancel</button>{primary("Confirm offset", () => {
          if (stale || blocked || !review) return
          const offset = Math.min(review.to, review.from)
          run({ operation: "offset", entries: review.entries, date: today(), note: "" }, saved => {
            if (!saved) { close(); return }
            setOffsetReceipt(offset); setReview(null)
            if (review.to === review.from) { setScene("summary") }
            else setScene("payment")
          })
        }, stale || Boolean(blocked), "offset")}</div>
      </> : scene === "payment" && paymentReview ? <>
        <div className="sr-editor-heading"><h2>{sent ? "Record sent payment" : "Record money received"}</h2>{offsetReceipt > 0 && <span>Optional</span>}</div>
        <ol className="sr-settlement-steps" aria-label="Settlement steps">{offsetReceipt > 0 ? <><li data-complete="true"><CheckCheck aria-hidden="true"/>{money(offsetReceipt)} offset each way</li><ChevronRight aria-hidden="true"/></> : <><li><del aria-label="Offset not needed">Offset</del></li><ChevronRight aria-hidden="true"/></>}<li data-current="true">{sent ? "Record sent" : "Record received"}</li></ol>
        <div className="sr-transfer-path"><span className="sr-person">{sent ? person(ownerKey)[0] : partner[0]}</span>{sent ? "You" : partner}<ArrowUpRight/>{sent ? partner : "You"}<span className="sr-person sr-partner">{sent ? partner[0] : person(ownerKey)[0]}</span></div>
        <div className="rp-balance"><span className="rp-person-name">{sent ? `Still owed to ${partner}` : `Remaining to receive`}</span><strong className="rp-balance-amount">{money(cash)}</strong></div>
        <label className="sr-date">Payment date<input type="date" required min={paymentReview.min} max={today()} value={date} disabled={disabled} onChange={event => {
          if (!review) setReview(paymentReview)
          setDate(event.target.value)
        }}/></label>
        <p className="bi-footnote">{sent ? "Balances stay outstanding until the recipient confirms receipt." : "Confirm only money already received. No bank transfer is made."}</p>
        {!undoing && (stale || paymentReview.state !== snapshot.resetState) && <p role="status">Balances changed. Cancel and review again.</p>}
        <div className="bi-editor-footer"><button className="bi-cancel" disabled={disabled} onClick={close}>{offsetReceipt > 0 ? "Not now" : "Cancel"}</button>{primary(sent ? "Record sent" : "Confirm received", () => {
          if (paymentReview.state !== snapshot.resetState || blocked || !dateValid) return
          run({ operation: sent ? "report_all" : "receive_all", expectedState: paymentReview.state, date, note: "" }, saved => { if (!saved) { close(); return }; setScene("summary"); setReview(null) })
        }, !cash || !dateValid || Boolean(blocked) || paymentReview.state !== snapshot.resetState, sent ? "report_all" : "receive_all")}</div>
      </> : scene.startsWith("reset-") ? <ReimbursementResetFlow scene={scene} snapshot={snapshot} pageSize={short ? 2 : 3} disabled={locked} run={run} setScene={setScene} resetId={resetId} setResetId={setResetId} close={close}/> : scene === "reset" ? <><div className="sr-editor-heading"><h2>Reset balances</h2></div><ResetEditor snapshot={snapshot} disabled={locked || Boolean(blocked) || pending.length > 0} run={run} close={close}/></> : <>
        <div className="sr-hero" data-side={totals.net >= 0 ? "to" : "from"}><span className="sr-eyebrow">{!active.length ? "Shared balance" : totals.net === 0 ? "Net balance" : totals.net > 0 ? `${partner} owes you` : `You owe ${partner}`}</span><strong>{money(Math.abs(totals.net))}</strong><span>{active.length ? totals.to > 0 && totals.from > 0 ? "After offsetting shared balances" : totals.to > 0 ? "Remaining to receive" : "Remaining to send" : "No outstanding reimbursements"}</span></div>
        <BalanceSides wide={wide} partner={partner} owner={person(ownerKey)} to={totals.to} from={totals.from}/>
        {active.length ? primary(totals.to && totals.from ? "Offset & settle" : totals.to ? "Record received" : "Record sent payment", start, Boolean(blocked) || !snapshot.resetState)
          : <div className="sr-settled-note"><CheckCheck/>All reimbursements are settled</div>}
        {active.length > 0 && <div className="sr-flow-caption">{totals.to > 0 && totals.from > 0 ? <><span>Offset</span>{totals.net !== 0 && <><ChevronRight/><span>Payment (optional)</span></>}</> : <><del aria-label="Offset not needed">Offset</del><ChevronRight/><span>{totals.to > 0 ? "Record received" : "Record sent"}</span></>}</div>}
        {blocked && !snapshot.projectionPending && <p className="bi-footnote" role="status">{blocked}</p>}
        {incoming.length > 0 && <section className="bb-ledger-incoming" aria-label="Payments awaiting your confirmation"><h3>Awaiting your confirmation</h3>{incoming.map(event => <IncomingPayment key={event.id} event={event} allocation={allocations.find(item => item.id === event.allocationId)!} disabled={disabled} run={run}/>)}</section>}
      </>}
    </EditorScenes>
  </div>
  return <div className="sr-balance-first bi-product" data-detail-open={Boolean(selected)} data-flow-open={scene !== "summary"} data-refreshing={refreshing}>
    {snapshot.error && <p className="sr-sync bb-ledger-note" role="status">{snapshot.error}</p>}
    <ReimbursementOptions history={history} setHistory={setHistory} setSelected={setSelected} setScene={setScene} headerActions={headerActions} wide={wide} refreshing={refreshing} refresh={refresh} disabled={locked || scene !== "summary"}/>
    <section className="sr-list" aria-label="Shared expenses"><div className="sr-scope">{history ? <HistoryFilter onClear={() => { setHistory(false); setSelected("") }}/> : <span>{active.length ? "Outstanding · all months" : `${dateLabel(currentMonth + "-01", true)} activity`}</span>}</div>
      {!shown.length && <p className="bb-ledger-empty">No reimbursements for this month.</p>}
      {page.visible.map(group => <BalanceMonth key={group.key} group={group} paginate={history} selected={selected} onSelect={id => { if (!selectDisabled && scene === "summary") setSelected(selected === id ? "" : id) }} disabled={disabled || scene !== "summary"} selectDisabled={selectDisabled || scene !== "summary"} snapshot={snapshot} reversibleIds={reversibleIds} run={run} aliases={aliases} wide={wide} detailPane={detailPane}/>)}
      {page.hasMore && <button className="bb-reimbursement-load-more" type="button" onClick={page.loadAll}>Load all months</button>}
    </section>
    <aside className="sr-right" aria-label="Shared balance and settlement" aria-hidden={wide && Boolean(selected) || undefined} inert={wide && Boolean(selected) || undefined}>{flow}</aside>
    <div className="sr-detail-layer" ref={setDetailPane} aria-label="Expense details" aria-hidden={!wide || !selected} inert={!wide || !selected}/>{wide && selected && <SelectionClose disabled={selectDisabled} onClose={() => setSelected("")}/>}
  </div>
}

function BalanceMonth({ group, paginate, selected, onSelect, disabled, selectDisabled, snapshot, reversibleIds, run, aliases, wide, detailPane }: {
  group: { key: string; items: LedgerAllocation[] }; paginate: boolean; selected: string; onSelect: (id: string) => void; disabled: boolean; selectDisabled: boolean; snapshot: LedgerSnapshot; reversibleIds: Set<string>; run: Run; aliases?: Record<string, string>; wide: boolean; detailPane: HTMLDivElement | null
}) {
  const page = useReimbursementPage(group.items, item => item.id, true, paginate ? 5 : group.items.length)
  return <section className="sr-month" aria-label={group.key === "undated" ? "Undated" : dateLabel(group.key + "-01", true)}><h3>{group.key === "undated" ? "Undated" : dateLabel(group.key + "-01", true)}</h3>
    {page.visible.map(item => <BalanceRow key={item.id} item={item} selected={selected} onSelect={onSelect} disabled={disabled} selectDisabled={selectDisabled} snapshot={snapshot} reversibleIds={reversibleIds} run={run} aliases={aliases} wide={wide} detailPane={detailPane}/>)}
    {page.hasMore && <button className="bb-reimbursement-load-more" type="button" onClick={page.loadAll}>Load all expenses</button>}
  </section>
}

function BalanceRow({ item, selected, onSelect, disabled, selectDisabled, snapshot, reversibleIds, run, aliases, wide, detailPane }: {
  item: LedgerAllocation; selected: string; onSelect: (id: string) => void; disabled: boolean; selectDisabled: boolean; snapshot: LedgerSnapshot; reversibleIds: Set<string>; run: Run; aliases?: Record<string, string>; wide: boolean; detailPane: HTMLDivElement | null
}) {
  const opened = selected === item.id, isPayer = item.payerOwner === snapshot.ownerKey
  const { shown, plan } = useReimbursementValueMotion(item, opened, isPayer), key = reimbursementMotionKey(item.id)
  const entry = reimbursementTransaction(shown), category = transactionCategory(entry)
  const ownEvents = snapshot.events.filter(event => event.allocationId === item.id)
  const offset = ownEvents.filter(event => event.kind === "offset" && event.status === "confirmed").reduce((sum, event) => sum + event.amountCents, 0)
  const method = <ChangedText value={reimbursementMethod(shown)} motionKey={key + "method"}/>
  const pendingCents = ownEvents.filter(event => event.status === "pending").reduce((sum, event) => sum + event.amountCents, 0)
  const status = <span className="rp-status"><Clock3/>{!item.outstandingCents ? "Settled" : pendingCents ? "Payment reported" : item.settledCents ? "Partly repaid" : wide ? "Awaiting repayment" : "Pending"}</span>
  const balance = <div className="rp-balance"><span className="rp-person-name">{isPayer ? `${person(item.partnerOwner)} owes you` : `You owe ${person(item.payerOwner)}`}</span><strong className="rp-balance-amount"><ChangedMoney value={money(shown.outstandingCents)} motionKey={key + "remaining"}/></strong>{wide && status}</div>
  const detailSummary = <>
    <div className="rp-purchase"><TransactionIcon entry={entry} aliases={aliases} eager/><div className="rp-merchant"><strong>{entry.location || entry.item || entry.category}</strong><span>{category.label} · {dateLabel(item.expenseDate)}</span></div></div>
    {wide ? balance : <header className="sp-detail-heading">{balance}</header>}{!wide && <div className="rp-inline-status">{status}<span>{method}</span></div>}
    <RepaymentAllocation payerName={person(item.payerOwner)} partnerName={person(item.partnerOwner)} payerCents={shown.payerShareCents} partnerCents={shown.partnerShareCents} incoming={isPayer} method={wide && method} renderAmount={(cents, side) => <ChangedMoney value={money(cents)} motionKey={key + side}/>}/>
    <dl className="rp-payment-summary" aria-label="Purchase and repayments"><div><dt>Purchase total</dt><dd>{money(item.grossCents)}</dd></div><div><dt>Cash {isPayer ? "received" : "paid"}</dt><dd>{money(Math.max(0, item.settledCents - offset))}</dd></div>
      {offset > 0 && <div><dt>Settled by offset</dt><dd>{money(offset)}</dd></div>}{Boolean(item.clearedCents) && <div><dt>Cleared without payment</dt><dd>{money(item.clearedCents!)}</dd></div>}</dl>
  </>
  return <ChangeMotionContext.Provider value={plan}><div className="sr-row-group" data-feedback={plan ? "animating" : undefined}><button type="button" className="sr-row-main" aria-expanded={opened} aria-label={`${item.item || item.category}, ${money(item.outstandingCents)} ${item.outstandingCents ? isPayer ? "owed to you" : "you owe" : "settled"}`} disabled={selectDisabled} data-selected={opened} onClick={() => onSelect(item.id)}>
    <TransactionIcon entry={entry} aliases={aliases} eager/><span className="sr-row-copy"><strong title={entry.location || entry.item}>{entry.location || entry.item || entry.category}</strong><span><span className="sr-category" style={{ '--bb-category-color': `hsl(var(--category-${category.token},var(--muted-foreground)))` } as CSSProperties}>{category.label}</span> · {dateLabel(item.expenseDate)} · {person(isPayer ? item.partnerOwner : item.payerOwner)}</span></span>
    <span className="sr-row-value"><strong><ChangedMoney value={money(shown.outstandingCents || shown.partnerShareCents)} motionKey={key + "remaining"}/></strong><small data-side={isPayer ? "to" : "from"} data-settled={!item.outstandingCents}>{!item.outstandingCents ? <><CheckCheck/>Settled</> : isPayer ? <><ArrowUpRight/>Owed</> : <><ArrowDownLeft/>Due</>}</small></span><ChevronDown className="sr-row-chevron" aria-hidden="true"/>
  </button><ReimbursementDetailHost wide={wide} pane={detailPane}><div className="sr-detail-host" data-open={opened} data-feedback={plan ? "animating" : undefined}><EditorExpansion open={opened} retain>
    <LedgerRow allocation={item} events={ownEvents} reversibleIds={reversibleIds} owner={snapshot.ownerKey} open={opened} onOpenChange={() => onSelect(item.id)} disabled={disabled} run={run} detailOnly detailSummary={detailSummary} compact={!wide} incomePayerCents={snapshot.splitOptions?.[item.id]?.incomePayerCents}/>
  </EditorExpansion></div></ReimbursementDetailHost>
  </div></ChangeMotionContext.Provider>
}

/** Move one stable portal target, not its React controller, when folding.
 * Open details must never remain inside the left pane's scroll/paint clip. */
function ReimbursementDetailHost({ wide, pane, children }: { wide: boolean; pane: HTMLDivElement | null; children: ReactNode }) {
  const inline = useRef<HTMLDivElement>(null)
  const [container] = useState(() => typeof document !== "undefined" && document.createElement ? document.createElement("div") : null)
  useLayoutEffect(() => {
    const target = wide ? pane : inline.current
    if (container && target) { container.className = "sr-detail-mount"; target.appendChild(container) }
    return () => container?.remove()
  }, [wide, pane, container])
  return <><div className="sr-inline-host" ref={inline}/>{container ? createPortal(children, container) : children}</>
}
