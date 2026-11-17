import { useState, type CSSProperties } from "react"
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CheckCheck, ChevronRight, X } from "lucide-react"
import { TransactionIcon } from "./daily-transactions"
import { transactionCategory, type DailyTransaction } from "./transaction-identity"
import { EditorExpansion, EditorScenes } from "./transaction-editor-workspace"
import { useAppWorkStatus } from "./app-work-guard"
import { useReimbursementPage } from "./reimbursement-pagination"
import { canReverseLedgerEvent, defaultOffsetEntries, IncomingPayment, LedgerRow, ledgerTotals, ResetEditor, ResetHistory,
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
type Scene = "summary" | "offset" | "payment" | "done" | "reset"

export function BalanceFirstReimbursements({ snapshot, disabled, run, aliases, refresh }: {
  snapshot: LedgerSnapshot; disabled: boolean; run: Run; aliases?: Record<string, string>; refresh: () => void
}) {
  const { allocations, events, ownerKey } = snapshot
  const [selected, setSelected] = useState("")
  const [history, setHistory] = useState(false)
  const [scene, setScene] = useState<Scene>("summary")
  const [review, setReview] = useState<Review | null>(null)
  const [date, setDate] = useState(today)
  const [offsetReceipt, setOffsetReceipt] = useState(0)
  const [receipt, setReceipt] = useState<{ cash: number; sent: boolean } | null>(null)
  const totals = ledgerTotals(allocations, ownerKey)
  const active = allocations.filter(item => item.outstandingCents > 0)
  const pending = events.filter(event => event.status === "pending")
  const incoming = pending.filter(event => event.payeeOwner === ownerKey && allocations.some(item => item.id === event.allocationId && item.accounting === "cash_v1"))
  const currentMonth = today().slice(0, 7)
  const shown = balanceFirstScope(allocations, currentMonth, history)
  if (selected && !shown.some(item => item.id === selected)) setSelected("")
  const groups = [...new Set(shown.map(item => sharedExpenseDate(item.expenseDate).slice(0, 7) || "undated"))]
    .sort((a, b) => a === "undated" ? 1 : b === "undated" ? -1 : b.localeCompare(a))
    .map(key => ({ key, items: shown.filter(item => (sharedExpenseDate(item.expenseDate).slice(0, 7) || "undated") === key)
      .sort((a, b) => sharedExpenseDate(b.expenseDate).localeCompare(sharedExpenseDate(a.expenseDate)) || a.id.localeCompare(b.id)) }))
  const page = useReimbursementPage(groups, group => group.key)
  const reversibleIds = new Set(events.filter(event => canReverseLedgerEvent(event, ownerKey, allocations, events)).map(event => event.id))
  const partnerKeys = [...new Set(allocations.flatMap(item => [item.payerOwner, item.partnerOwner]).filter(owner => owner !== ownerKey))]
  const partner = partnerKeys.length === 1 ? person(partnerKeys[0]) : "your household"
  const confirmingIncomingOnly = totals.to > 0 && totals.from === 0 && pending.every(event => event.payeeOwner === ownerKey)
  const blocked = snapshot.projectionPending ? "Recorded changes are still syncing. Refresh before settling."
    : pending.length && !confirmingIncomingOnly ? "Review or reverse pending payments before settling the remaining balance."
    : active.some(item => item.accounting !== "cash_v1" || item.version !== item.projectedVersion || Boolean(item.clearedCents))
      ? "Review historical or syncing expenses individually before settling all balances."
      : partnerKeys.length > 1 ? "Review each person's expenses separately before settling." : ""
  const stale = review !== null && review.state !== snapshot.resetState
  const locked = disabled || Boolean(snapshot.error)
  const close = () => { setScene("summary"); setReview(null) }
  useAppWorkStatus({ label: "Shared settlement review", dirty: scene === "offset" || scene === "payment", onDiscard: close })
  const makeReview = (source: LedgerSnapshot): Review => ({ state: source.resetState, ...ledgerTotals(source.allocations, source.ownerKey),
    entries: defaultOffsetEntries(source.allocations, source.ownerKey, source.events),
    min: source.allocations.filter(item => item.outstandingCents > 0).reduce((latest, item) => sharedExpenseDate(item.expenseDate) > latest ? sharedExpenseDate(item.expenseDate) : latest, "1900-01-01") })
  const start = () => {
    setSelected(""); setOffsetReceipt(0); setReceipt(null); setDate(today())
    setReview(makeReview(snapshot)); setScene(totals.to > 0 && totals.from > 0 ? "offset" : "payment")
  }
  // The acknowledged offset returns the new canonical snapshot in the same
  // render. Capture the cash review only from that state, never old net values.
  const paymentReview = scene === "payment" && review === null ? makeReview(snapshot) : review
  if (scene === "payment" && review === null) setReview(paymentReview)
  const cash = paymentReview ? Math.abs(paymentReview.to - paymentReview.from) : 0
  const sent = paymentReview ? paymentReview.from > paymentReview.to : false
  const dateValid = Boolean(sharedExpenseDate(date)) && date >= (paymentReview?.min ?? "1900-01-01") && date <= today()
  const primary = (label: string, click: () => void, off = false) => <button type="button" className="sr-primary" disabled={locked || off} onClick={click}>{label}<ChevronRight /></button>
  const facts = (entries: [string, string][]) => <dl className="sr-facts">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  const flow = <div className="sr-editor" data-stage={scene}>
    <EditorScenes scene={scene}>
      {scene === "offset" && review ? <>
        <div className="sr-editor-heading"><h2>Offset balances</h2></div>
        <ol className="sr-steps"><li data-current="true">1 · Offset</li><li>2 · Record payment</li><li>3 · Settle</li></ol>
        <div className="sr-offset-equation"><span>{money(review.to)}<small>Owed to you</small></span><ArrowLeftRight/><span>{money(review.from)}<small>You owe</small></span></div>
        {facts([["Offset each way", money(Math.min(review.to, review.from))], [review.to >= review.from ? "Then receive" : "Then pay", money(Math.abs(review.to - review.from))]])}
        <p className="bi-footnote">Equal debts cancel, oldest expenses first. No cash is recorded.</p>
        {stale && <p role="status">Balances changed. Cancel and review again.</p>}
        <div className="bi-editor-footer"><button className="bi-cancel" disabled={disabled} onClick={close}>Cancel</button>{primary("Confirm offset", () => {
          if (stale || blocked || !review) return
          const offset = Math.min(review.to, review.from)
          run({ operation: "offset", entries: review.entries, date: today(), note: "" }, () => {
            setOffsetReceipt(offset); setReview(null)
            if (review.to === review.from) { setReceipt({ cash: 0, sent: false }); setScene("done") }
            else setScene("payment")
          })
        }, stale || Boolean(blocked))}</div>
      </> : scene === "payment" && paymentReview ? <>
        <div className="sr-editor-heading"><h2>{sent ? "Record sent payment" : "Record money received"}</h2></div>
        <ol className="sr-steps"><li>1 · Offset</li><li data-current="true">2 · Record payment</li><li>3 · Settle</li></ol>
        <div className="sr-transfer-path"><span className="sr-person">{sent ? person(ownerKey)[0] : partner[0]}</span>{sent ? "You" : partner}<ArrowUpRight/>{sent ? partner : "You"}<span className="sr-person sr-partner">{sent ? partner[0] : person(ownerKey)[0]}</span></div>
        <div className="sr-hero" data-side={sent ? "from" : "to"}><span className="sr-eyebrow">{sent ? `Sent to ${partner}` : `Received from ${partner}`}</span><strong>{money(cash)}</strong></div>
        <label className="sr-date">Payment date<input type="date" required min={paymentReview.min} max={today()} value={date} disabled={disabled} onChange={event => {
          if (!review) setReview(paymentReview)
          setDate(event.target.value)
        }}/></label>
        <p className="bi-footnote">{sent ? "Balances stay outstanding until the recipient confirms receipt." : "Confirm only money already received. No bank transfer is made."}</p>
        {(stale || paymentReview.state !== snapshot.resetState) && <p role="status">Balances changed. Cancel and review again.</p>}
        <div className="bi-editor-footer"><button className="bi-cancel" disabled={disabled} onClick={close}>Cancel</button>{primary(sent ? "Record sent" : "Confirm received", () => {
          if (paymentReview.state !== snapshot.resetState || blocked || !dateValid) return
          run({ operation: sent ? "report_all" : "receive_all", expectedState: paymentReview.state, date, note: "" }, () => { setReceipt({ cash, sent }); setScene("done"); setReview(null) })
        }, !cash || !dateValid || Boolean(blocked) || paymentReview.state !== snapshot.resetState)}</div>
      </> : scene === "done" && receipt ? <>
        <div className="sr-success"><CheckCheck/><h2>{receipt.sent ? "Payment reported" : "Balances updated"}</h2><p>{receipt.sent ? "Awaiting the recipient’s confirmation." : "Original purchases, splits and dates are preserved."}</p></div>
        {facts([["Offset each way", money(offsetReceipt)], [receipt.sent ? "Cash reported" : "Cash received", money(receipt.cash)]])}
        {primary("View reimbursements", close)}
      </> : scene === "reset" ? <><div className="sr-editor-heading"><h2>Reset balances</h2></div><ResetEditor snapshot={snapshot} disabled={locked || Boolean(blocked) || pending.length > 0} run={run} close={close}/></> : <>
        <div className="sr-hero" data-side={totals.net >= 0 ? "to" : "from"}><span className="sr-eyebrow">{!active.length ? "Shared balance" : totals.net === 0 ? "Net balance" : totals.net > 0 ? `${partner} owes you` : `You owe ${partner}`}</span><strong>{money(Math.abs(totals.net))}</strong><span>{active.length ? "After offsetting shared balances" : "No outstanding reimbursements"}</span></div>
        <div className="sr-summary-sides"><div><span>Owed to you</span><strong>{money(totals.to)}</strong></div><ArrowLeftRight/><div><span>You owe</span><strong>{money(totals.from)}</strong></div></div>
        {active.length ? primary(totals.to && totals.from ? "Offset & settle" : totals.to ? "Record received" : "Record sent payment", start, Boolean(blocked) || !snapshot.resetState)
          : <div className="sr-settled-note"><CheckCheck/>All reimbursements are settled</div>}
        {active.length > 0 && <div className="sr-flow-caption"><span>Offset</span><ChevronRight/><span>Record payment</span><ChevronRight/><span>Settle</span></div>}
        {blocked && <p className="bi-footnote" role="status">{blocked}</p>}
        {incoming.length > 0 && <section className="bb-ledger-incoming" aria-label="Payments awaiting your confirmation"><h3>Awaiting your confirmation</h3>{incoming.map(event => <IncomingPayment key={event.id} event={event} allocation={allocations.find(item => item.id === event.allocationId)!} disabled={disabled} run={run}/>)}</section>}
        <details className="sr-more"><summary>More options</summary>{active.length > 0 && snapshot.resetState && <button type="button" className="bi-cancel" disabled={locked || Boolean(blocked) || pending.length > 0} onClick={() => setScene("reset")}>Reset balances</button>}
          {Boolean(snapshot.resets?.length) && <ResetHistory resets={snapshot.resets!} owner={ownerKey} disabled={disabled} run={run}/>}</details>
      </>}
    </EditorScenes>
  </div>
  return <div className="sr-balance-first" data-detail-open={Boolean(selected)} data-flow-open={scene !== "summary"}>
    {snapshot.projectionPending && <div className="sr-sync bb-ledger-message" role="status"><p>Recorded. Expense sheets are still syncing.</p><button disabled={disabled} onClick={refresh}>Refresh</button></div>}
    {snapshot.error && <p className="sr-sync bb-ledger-note" role="status">{snapshot.error}</p>}
    <section className="sr-list" aria-label="Shared expenses"><div className="sr-scope"><span>{history ? "All reimbursement history" : active.length ? "Outstanding · all months" : `${dateLabel(currentMonth + "-01", true)} activity`}</span><button type="button" disabled={disabled || scene !== "summary"} onClick={() => { setHistory(!history); setSelected("") }}>{history ? "Back" : "History"}</button></div>
      {!shown.length && <p className="bb-ledger-empty">No reimbursements for this month.</p>}
      {page.visible.map(group => <BalanceMonth key={group.key} group={group} selected={selected} onSelect={id => { if (!disabled && scene === "summary") setSelected(selected === id ? "" : id) }} disabled={disabled || scene !== "summary"} snapshot={snapshot} reversibleIds={reversibleIds} run={run} aliases={aliases}/>)}
      {page.hasMore && <button className="bb-reimbursement-load-more" type="button" onClick={page.loadAll}>Load all months</button>}
    </section>
    <aside className="sr-right" aria-label="Shared balance and settlement">{flow}</aside>
  </div>
}

function BalanceMonth({ group, selected, onSelect, disabled, snapshot, reversibleIds, run, aliases }: {
  group: { key: string; items: LedgerAllocation[] }; selected: string; onSelect: (id: string) => void; disabled: boolean; snapshot: LedgerSnapshot; reversibleIds: Set<string>; run: Run; aliases?: Record<string, string>
}) {
  const page = useReimbursementPage(group.items, item => item.id)
  return <section className="sr-month" aria-label={group.key === "undated" ? "Undated" : dateLabel(group.key + "-01", true)}><h3>{group.key === "undated" ? "Undated" : dateLabel(group.key + "-01", true)}</h3>
    {page.visible.map(item => {
      const entry = reimbursementTransaction(item), category = transactionCategory(entry), isPayer = item.payerOwner === snapshot.ownerKey
      const ownEvents = snapshot.events.filter(event => event.allocationId === item.id)
      const opened = selected === item.id
      const offset = ownEvents.filter(event => event.kind === "offset" && event.status === "confirmed").reduce((sum, event) => sum + event.amountCents, 0)
      return <div className="sr-row-group" key={item.id}><button type="button" className="sr-row-main" aria-expanded={opened} aria-label={`${item.item || item.category}, ${money(item.outstandingCents)} ${item.outstandingCents ? isPayer ? "owed to you" : "you owe" : "settled"}`} disabled={disabled} data-selected={opened} onClick={() => onSelect(item.id)}>
        <TransactionIcon entry={entry} aliases={aliases} eager/><span className="sr-row-copy"><strong title={entry.location || entry.item}>{entry.location || entry.item || entry.category}</strong><span><span className="sr-category" style={{ '--bb-category-color': `hsl(var(--category-${category.token},var(--muted-foreground)))` } as CSSProperties}>{category.label}</span> · {dateLabel(item.expenseDate)} · {person(isPayer ? item.partnerOwner : item.payerOwner)}</span></span>
        <span className="sr-row-value"><strong>{money(item.outstandingCents || item.partnerShareCents)}</strong><small data-side={isPayer ? "to" : "from"} data-settled={!item.outstandingCents}>{!item.outstandingCents ? <><CheckCheck/>Settled</> : isPayer ? <><ArrowUpRight/>Owed</> : <><ArrowDownLeft/>Due</>}</small></span><ChevronRight className="sr-row-chevron"/>
      </button><div className="sr-detail-host" data-open={opened}><EditorExpansion open={opened}>
        <div className="sr-detail sr-editor"><div className="sr-editor-heading"><h2>{item.item || item.category}</h2><button className="sr-icon-button" disabled={disabled} aria-label="Close reimbursement details" onClick={() => onSelect(item.id)}><X/></button></div>
          <span className="sr-eyebrow">{dateLabel(item.expenseDate)} · {category.label} · {item.method === "income" ? "By income" : item.method === "equal" ? "50/50" : item.method === "fronted" ? "Fronted" : "Custom split"}</span>
          <div className="sr-detail-amount" data-side={isPayer ? "to" : "from"}>{money(item.outstandingCents)}<span>{item.outstandingCents ? isPayer ? `${person(item.partnerOwner)} owes you` : `You owe ${person(item.payerOwner)}` : "Settled"}</span></div>
          <div className="sr-people"><div><span className="sr-person">{person(item.payerOwner)[0]}</span><span>{person(item.payerOwner)}<small>Pays the purchase</small></span></div><div><span className="sr-person sr-partner">{person(item.partnerOwner)[0]}</span><span>{person(item.partnerOwner)}<small>Repays their share</small></span></div></div>
          <dl className="sr-facts"><div><dt>Purchase total</dt><dd>{money(item.grossCents)}</dd></div><div><dt>Your share</dt><dd>{money(isPayer ? item.payerShareCents : item.partnerShareCents)}</dd></div><div><dt>Cash {isPayer ? "received" : "paid"}</dt><dd>{money(Math.max(0, item.settledCents - offset))}</dd></div><div><dt>Offset</dt><dd>{money(offset)}</dd></div>{Boolean(item.clearedCents) && <div><dt>Cleared without payment</dt><dd>{money(item.clearedCents!)}</dd></div>}</dl>
          <LedgerRow allocation={item} events={ownEvents} reversibleIds={reversibleIds} owner={snapshot.ownerKey} open={opened} onOpenChange={() => onSelect(item.id)} disabled={disabled} run={run} detailOnly/>
        </div></EditorExpansion></div>
      </div>
    })}
    {page.hasMore && <button className="bb-reimbursement-load-more" type="button" onClick={page.loadAll}>Load all expenses</button>}
  </section>
}
