import { useId, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { AnimatedDisclosure, CollapsibleContent } from "./components/ui/motion"
import { FittedAmount } from "./components/ui/fitted-amount"
import type { ReimbursementCoverage, SharedReimbursementItem } from "./types"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const formatMoney = (value: number) => money.format(value)

export function reimbursementGroups(items: SharedReimbursementItem[]) {
  const groups = new Map<string, SharedReimbursementItem[]>()
  for (const item of items) {
    if (item.status !== "outstanding" || item.outstandingAmount <= 0) continue
    const partner = item.partner.trim() || "Partner"
    groups.set(partner, [...(groups.get(partner) ?? []), item])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([partner, entries]) => ({
    partner,
    items: entries.sort((a, b) => expenseDateOrder(a.date) - expenseDateOrder(b.date) || a.id.localeCompare(b.id)),
    amount: entries.reduce((sum, item) => sum + Math.round(item.outstandingAmount * 100), 0) / 100,
  }))
}

function expenseDateOrder(value: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (iso) return Number(iso[1]) * 10000 + Number(iso[2]) * 100 + Number(iso[3])
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim())
  if (!parts) return Number.MAX_SAFE_INTEGER
  let year = Number(parts[3])
  if (parts[3].length === 2) year += year <= 68 ? 2000 : 1900
  return year * 10000 + Number(parts[1]) * 100 + Number(parts[2])
}

function expenseMonthKey(date: string) {
  const order = expenseDateOrder(date)
  const year = Math.floor(order / 10000)
  const month = Math.floor(order / 100) % 100
  const day = order % 100
  const dated = year >= 1000 && year <= 9999 && month >= 1 && month <= 12
    && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  return dated ? `${year}-${String(month).padStart(2, "0")}` : "undated"
}

function expenseMonthLabel(key: string) {
  if (key === "undated") return "Undated"
  const [year, month] = key.split("-").map(Number)
  return new Intl.DateTimeFormat("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)))
}

export function reimbursementTimeline(items: SharedReimbursementItem[]) {
  const months = new Map<string, number>()
  for (const group of reimbursementGroups(items)) {
    for (const item of group.items) {
      const key = expenseMonthKey(item.date)
      months.set(key, (months.get(key) ?? 0) + Math.round(item.outstandingAmount * 100))
    }
  }
  const rows = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, cents]) => {
    const label = expenseMonthLabel(key)
    return { key, label, amount: cents / 100, months: [label] }
  })
  if (rows.length <= 4) return rows
  const earlier = rows.slice(0, -3)
  return [{ key: "earlier", label: "Earlier expenses",
    amount: earlier.reduce((sum, row) => sum + Math.round(row.amount * 100), 0) / 100,
    months: earlier.flatMap((row) => row.months),
  }, ...rows.slice(-3)]
}

export function reimbursementLedger(items: SharedReimbursementItem[], openItems: SharedReimbursementItem[], selectedMonth: string, receivedItems: SharedReimbursementItem[] = []) {
  // Both lists come from one history snapshot. A complete monthly record wins
  // if a legacy snapshot repeats an id, including a received or void record.
  const allocations = new Map(openItems.filter((item) => item.status === "outstanding" && item.outstandingAmount > 0).map((item) => [item.id, item]))
  for (const item of receivedItems) {
    if (item.status !== "void" && (item.status === "reimbursed" || item.outstandingAmount <= 0)) allocations.set(item.id, item)
  }
  for (const item of items) allocations.set(item.id, item)
  const months = new Map<string, SharedReimbursementItem[]>()
  for (const item of allocations.values()) {
    if (item.status === "void") continue
    const key = expenseMonthKey(item.date)
    months.set(key, [...(months.get(key) ?? []), item])
  }
  return [...months.entries()].sort(([a], [b]) => {
    if (a === selectedMonth) return -1
    if (b === selectedMonth) return 1
    if (a === "undated") return 1
    if (b === "undated") return -1
    return b.localeCompare(a)
  }).map(([key, entries]) => ({
    key, label: expenseMonthLabel(key),
    items: entries.sort((a, b) => expenseDateOrder(a.date) - expenseDateOrder(b.date) || a.id.localeCompare(b.id)),
  }))
}

function ReimbursementEntry({ item }: { item: SharedReimbursementItem }) {
  const received = item.status === "reimbursed" || item.outstandingAmount <= 0
  return (
    <AnimatedDisclosure summary={
      <>
        <span className="bb-reimbursement-item">
          <strong title={item.item}>{item.item}</strong>
        </span>
        <div className="bb-reimbursement-status" data-settled={received}>
          {received ? "Received" : <><FittedAmount className="bb-reimbursement-due">{formatMoney(item.outstandingAmount)}</FittedAmount><small>due</small></>}
        </div>
        <span className="bb-disclosure-mark" aria-hidden="true" />
      </>
    }>
      <div className="bb-reimbursement-detail">
        <dl className="bb-reimbursement-receipt-meta">
          <div><dt>Date</dt><dd>{item.date.trim() || "Undated"}</dd></div>
          <div><dt>With</dt><dd>{item.partner.trim() || "Partner"}</dd></div>
          {item.location.trim() && <div className="bb-reimbursement-location"><dt>Location</dt><dd>{item.location}</dd></div>}
        </dl>
        <dl className="bb-reimbursement-split">
          <div className="bb-reimbursement-gross"><dt>Gross paid</dt><dd><FittedAmount className="bb-reimbursement-receipt-amount">{formatMoney(item.grossAmount)}</FittedAmount></dd></div>
          <div className="bb-reimbursement-share"><dt>Your share</dt><dd><FittedAmount className="bb-reimbursement-receipt-amount">{formatMoney(item.personalShare)}</FittedAmount></dd></div>
          <div className="bb-reimbursement-share"><dt>Partner share</dt><dd><FittedAmount className="bb-reimbursement-receipt-amount">{formatMoney(item.partnerShare)}</FittedAmount></dd></div>
          <div className="bb-reimbursement-received" data-received={item.receivedAmount > 0}><dt>Received</dt><dd><FittedAmount className="bb-reimbursement-receipt-amount">{formatMoney(item.receivedAmount)}</FittedAmount></dd></div>
        </dl>
        {item.splitMethod.trim() || item.responsiblePerson.trim() ? <dl className="bb-reimbursement-methods">
          {item.splitMethod.trim() && <div><dt>Split method</dt><dd>{item.splitMethod.trim()}</dd></div>}
          {item.responsiblePerson.trim() && <div><dt>Expense for</dt><dd>{item.responsiblePerson.trim()}</dd></div>}
        </dl> : null}
      </div>
    </AnimatedDisclosure>
  )
}

export function SharedReimbursementsCard({ items, openItems, receivedItems, coverage, monthLabel, year, month }: {
  items: SharedReimbursementItem[]
  openItems?: SharedReimbursementItem[]
  receivedItems?: SharedReimbursementItem[]
  coverage?: ReimbursementCoverage
  monthLabel: string
  year: number
  month: number
}) {
  const monthly = items.filter((item) => item.status !== "void")
  const outstandingItems = openItems ?? monthly
  const groups = reimbursementGroups(outstandingItems)
  const timeline = reimbursementTimeline(outstandingItems)
  const incomplete = coverage !== undefined && coverage.status !== "complete"
  const count = groups.reduce((sum, group) => sum + group.items.length, 0)
  const selectedMonth = `${year}-${String(month).padStart(2, "0")}`
  const ledger = reimbursementLedger(items, openItems ?? [], selectedMonth, receivedItems)
  const expenseCount = ledger.reduce((sum, group) => sum + group.items.length, 0)
  if (!expenseCount && !count && !incomplete) return null
  const outstanding = groups.reduce((sum, group) => sum + Math.round(group.amount * 100), 0) / 100
  const allMonths = openItems !== undefined

  return (
    <Card className="bb-report-section bb-reimbursement-section">
      <CardHeader><CardTitle>Shared Reimbursements</CardTitle></CardHeader>
      <CardContent className="bb-reimbursement-content">
        <div className="bb-reimbursement-at-glance">
          <div className="bb-reimbursement-overview">
            <div className="bb-chart-kicker">{incomplete ? "Known outstanding" : "Outstanding"}</div>
            <FittedAmount className="bb-reimbursement-total">{formatMoney(outstanding)}</FittedAmount>
            {!allMonths && <p className="bb-reimbursement-note">{monthLabel}</p>}
            {!count && !incomplete && <p className="bb-reimbursement-note bb-reimbursement-settled">No outstanding reimbursements{allMonths ? "." : " for these expenses."}</p>}
          </div>
          {timeline.length > 0 && <figure className="bb-reimbursement-timeline" aria-label="Outstanding by expense month">
            <figcaption>Each segment shows that expense month’s share of the {incomplete ? "known " : ""}outstanding balance.</figcaption>
            <div className="bb-reimbursement-bar-track" aria-hidden="true">
              {timeline.map((row, index) => <span key={row.key} data-segment={index} style={{ width: `${Math.round(row.amount * 100) / Math.round(outstanding * 100) * 100}%` }} />)}
            </div>
            <ol>{timeline.map((row, index) => <li key={row.key} data-segment={index}>
              <div className="bb-reimbursement-bar-label"><span title={row.months.join(", ")}><i className="bb-reimbursement-swatch" aria-hidden="true" />{row.label}</span><FittedAmount className="bb-reimbursement-bar-amount">{formatMoney(row.amount)}</FittedAmount></div>
            </li>)}</ol>
          </figure>}
        </div>
        {incomplete && <p className="bb-reimbursement-warning" role="status">Some reimbursement records couldn’t be checked. This balance may be incomplete.</p>}
        <div className="bb-reimbursement-ledger" aria-label="Shared expenses">
          {expenseCount > 0 && <div className="bb-reimbursement-open-list">
            <AnimatedDisclosure summary={<>
              <span className="bb-reimbursement-item"><strong>View {expenseCount} {expenseCount === 1 ? "expense" : "expenses"}</strong></span>
              <span className="bb-disclosure-mark" aria-hidden="true" />
            </>}>
              <div className="bb-reimbursement-groups">
                {monthly.length > 0 && !ledger.some((group) => group.key === selectedMonth) && <MonthHeading label={monthLabel} items={monthly} />}
                {ledger.map((group) => <section className="bb-reimbursement-group" key={group.key} aria-label={`${group.label} expenses`}>
                  <MonthHeading label={group.label} tag={group.key === coverage?.asOf.slice(0, 7)
                    ? "This month" : group.key === selectedMonth ? "Selected month" : undefined}
                    items={group.key === selectedMonth && monthly.length > 0 ? monthly : undefined} />
                  {group.items.map((item) => <ReimbursementEntry key={item.id} item={item} />)}
                </section>)}
              </div>
            </AnimatedDisclosure>
          </div>}
        </div>
      </CardContent>
    </Card>
  )
}

function MonthHeading({ label, tag, items }: { label: string; tag?: string; items?: SharedReimbursementItem[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className="bb-reimbursement-month-heading">
    <h3><span>{label}</span>{tag && <span className="bb-reimbursement-month-tag">{tag}</span>}</h3>
    {items && <>
      <button type="button" className="bb-reimbursement-month-totals-toggle" aria-label={`${label} reimbursement totals`}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}>
        <span>Totals</span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="m3 6 5 5 5-5" /></svg>
      </button>
      <CollapsibleContent open={open} id={id}><MonthlySummary items={items} monthLabel={label} /></CollapsibleContent>
    </>}
  </div>
}

function MonthlySummary({ items, monthLabel }: { items: SharedReimbursementItem[]; monthLabel: string }) {
  const total = (field: "receivedAmount" | "grossAmount" | "personalShare") =>
    formatMoney(items.reduce((sum, item) => sum + Math.round(item[field] * 100), 0) / 100)
  return <div className="bb-reimbursement-month-summary">
    <dl className="bb-reimbursement-summary" aria-label={`Reimbursements for ${monthLabel} expenses`}>
      <div><dt>Gross paid</dt><dd><FittedAmount className="bb-reimbursement-summary-amount">{total("grossAmount")}</FittedAmount></dd></div>
      <div><dt>Your share</dt><dd><FittedAmount className="bb-reimbursement-summary-amount">{total("personalShare")}</FittedAmount></dd></div>
      <div><dt>Received</dt><dd><FittedAmount className="bb-reimbursement-summary-amount">{total("receivedAmount")}</FittedAmount></dd></div>
    </dl>
  </div>
}
