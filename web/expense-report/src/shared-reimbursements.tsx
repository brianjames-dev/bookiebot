import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { AnimatedDisclosure } from "./components/ui/motion"
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
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim())
  return parts ? Number(parts[3]) * 10000 + Number(parts[1]) * 100 + Number(parts[2]) : Number.MAX_SAFE_INTEGER
}

export function reimbursementTimeline(items: SharedReimbursementItem[]) {
  const months = new Map<string, number>()
  for (const group of reimbursementGroups(items)) {
    for (const item of group.items) {
      const order = expenseDateOrder(item.date)
      const year = Math.floor(order / 10000)
      const month = Math.floor(order / 100) % 100
      const day = order % 100
      const dated = year >= 1000 && year <= 9999 && month >= 1 && month <= 12
        && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
      const key = dated ? `${year}-${String(month).padStart(2, "0")}` : "undated"
      months.set(key, (months.get(key) ?? 0) + Math.round(item.outstandingAmount * 100))
    }
  }
  const rows = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, cents]) => {
    const [year, month] = key.split("-").map(Number)
    const label = key === "undated" ? "Undated" : new Intl.DateTimeFormat("en-US", {
      month: "long", year: "numeric", timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, 1)))
    return { key, label, amount: cents / 100, months: [label] }
  })
  if (rows.length <= 4) return rows
  const earlier = rows.slice(0, -3)
  return [{ key: "earlier", label: "Earlier expenses",
    amount: earlier.reduce((sum, row) => sum + Math.round(row.amount * 100), 0) / 100,
    months: earlier.flatMap((row) => row.months),
  }, ...rows.slice(-3)]
}

function ReimbursementEntry({ item }: { item: SharedReimbursementItem }) {
  const received = item.status === "reimbursed" || item.outstandingAmount <= 0
  return (
    <AnimatedDisclosure summary={
      <>
        <span className="bb-reimbursement-item">
          <strong>{item.item}</strong>
          <span>{[item.location, item.date].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="bb-reimbursement-status" data-settled={received}>
          {received ? "Received" : `${formatMoney(item.outstandingAmount)} due`}
        </span>
        <span className="bb-disclosure-mark" aria-hidden="true" />
      </>
    }>
      <div className="bb-reimbursement-detail">
        <dl>
          <div><dt>Gross paid</dt><dd>{formatMoney(item.grossAmount)}</dd></div>
          <div><dt>Your share</dt><dd>{formatMoney(item.personalShare)}</dd></div>
          <div><dt>Partner share</dt><dd>{formatMoney(item.partnerShare)}</dd></div>
          <div><dt>Received</dt><dd>{formatMoney(item.receivedAmount)}</dd></div>
        </dl>
        {item.splitMethod || item.responsiblePerson ? <p>{[item.splitMethod, item.responsiblePerson ? `Expense: ${item.responsiblePerson}` : ""].filter(Boolean).join(" · ")}</p> : null}
      </div>
    </AnimatedDisclosure>
  )
}

export function SharedReimbursementsCard({ items, openItems, coverage, monthLabel }: {
  items: SharedReimbursementItem[]
  openItems?: SharedReimbursementItem[]
  coverage?: ReimbursementCoverage
  monthLabel: string
}) {
  const monthly = items.filter((item) => item.status !== "void")
  const outstandingItems = openItems ?? monthly
  const groups = reimbursementGroups(outstandingItems)
  const timeline = reimbursementTimeline(outstandingItems)
  const incomplete = coverage !== undefined && coverage.status !== "complete"
  const count = groups.reduce((sum, group) => sum + group.items.length, 0)
  if (!monthly.length && !count && !incomplete) return null
  const outstanding = groups.reduce((sum, group) => sum + Math.round(group.amount * 100), 0) / 100
  const received = monthly.filter((item) => item.status === "reimbursed" || item.outstandingAmount <= 0)
  const allMonths = openItems !== undefined

  return (
    <Card className="bb-report-section bb-reimbursement-section">
      <CardHeader><CardTitle>Shared Reimbursements</CardTitle></CardHeader>
      <CardContent className="bb-reimbursement-content">
        <div className="bb-reimbursement-at-glance">
          <div className="bb-reimbursement-overview">
            <div className="bb-chart-kicker">{incomplete ? "Known outstanding" : "Outstanding"}</div>
            <FittedAmount className="bb-reimbursement-total">{formatMoney(outstanding)}</FittedAmount>
            <p className="bb-reimbursement-note">{allMonths ? "Across all months" : monthLabel}</p>
            {!count && !incomplete && <p className="bb-reimbursement-note bb-reimbursement-settled">No outstanding reimbursements{allMonths ? "." : " for these expenses."}</p>}
          </div>
          {timeline.length > 0 && <figure className="bb-reimbursement-timeline" aria-label="Outstanding by expense month">
            <figcaption>By expense month</figcaption>
            <ol>{timeline.map((row) => <li key={row.key}>
              <div className="bb-reimbursement-bar-label"><span title={row.months.join(", ")}>{row.label}</span><FittedAmount className="bb-reimbursement-bar-amount">{formatMoney(row.amount)}</FittedAmount></div>
              <div className="bb-reimbursement-bar-track" aria-hidden="true"><span style={{ width: `${row.amount / outstanding * 100}%` }} /></div>
            </li>)}</ol>
          </figure>}
        </div>
        {incomplete && <p className="bb-reimbursement-warning" role="status">Some reimbursement records couldn’t be checked. This balance may be incomplete.</p>}
        <div className="bb-reimbursement-ledger" aria-label="Shared expenses">
          {count > 0 && <div className="bb-reimbursement-open-list">
            <AnimatedDisclosure summary={<>
              <span className="bb-reimbursement-item"><strong>View {count} {count === 1 ? "expense" : "expenses"}</strong></span>
              <span className="bb-reimbursement-status">Outstanding</span><span className="bb-disclosure-mark" aria-hidden="true" />
            </>}>
              <div className="bb-reimbursement-groups">
                {groups.map((group) => <section className="bb-reimbursement-group" key={group.partner} aria-label={`Owed by ${group.partner}`}>
                  <h3><span>Owed by {group.partner}</span><span>{formatMoney(group.amount)}</span></h3>
                  {group.items.map((item) => <ReimbursementEntry key={item.id} item={item} />)}
                </section>)}
              </div>
            </AnimatedDisclosure>
          </div>}
          {monthly.length > 0 && <div className="bb-reimbursement-history">
            <AnimatedDisclosure summary={<>
              <span className="bb-reimbursement-item"><strong>{monthLabel}</strong><span>Expense statement</span></span>
              <span className="bb-reimbursement-status">Details</span><span className="bb-disclosure-mark" aria-hidden="true" />
            </>}>
              <div className="bb-reimbursement-statement">
                <dl className="bb-reimbursement-summary" aria-label={`Reimbursements for ${monthLabel} expenses`}>
                  <div><dt>Received</dt><dd>{formatMoney(monthly.reduce((sum, item) => sum + item.receivedAmount, 0))}</dd></div>
                  <div><dt>Gross paid</dt><dd>{formatMoney(monthly.reduce((sum, item) => sum + item.grossAmount, 0))}</dd></div>
                  <div><dt>Your share</dt><dd>{formatMoney(monthly.reduce((sum, item) => sum + item.personalShare, 0))}</dd></div>
                </dl>
                {received.length > 0 && <div className="bb-reimbursement-received">
                  <h3>Received <span>For {monthLabel} expenses</span></h3>
                  {received.map((item) => <ReimbursementEntry key={item.id} item={item} />)}
                </div>}
              </div>
            </AnimatedDisclosure>
          </div>}
        </div>
      </CardContent>
    </Card>
  )
}
