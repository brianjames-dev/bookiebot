import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { AnimatedDisclosure } from "./components/ui/motion"
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
    amount: entries.reduce((sum, item) => sum + item.outstandingAmount, 0),
  }))
}

function expenseDateOrder(value: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (iso) return Number(iso[1]) * 10000 + Number(iso[2]) * 100 + Number(iso[3])
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim())
  return parts ? Number(parts[3]) * 10000 + Number(parts[1]) * 100 + Number(parts[2]) : Number.MAX_SAFE_INTEGER
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
  const groups = reimbursementGroups(openItems ?? monthly)
  const incomplete = coverage !== undefined && coverage.status !== "complete"
  const count = groups.reduce((sum, group) => sum + group.items.length, 0)
  if (!monthly.length && !count && !incomplete) return null
  const outstanding = groups.reduce((sum, group) => sum + group.amount, 0)
  const received = monthly.filter((item) => item.status === "reimbursed" || item.outstandingAmount <= 0)
  const allMonths = openItems !== undefined

  return (
    <Card className="bb-report-section bb-reimbursement-section">
      <CardHeader><CardTitle>Shared Reimbursements</CardTitle></CardHeader>
      <CardContent className="bb-reimbursement-content">
        <div className="bb-reimbursement-overview">
          <div className="bb-chart-kicker">{incomplete ? "Known outstanding" : "Outstanding"}</div>
          <div className="bb-reimbursement-total">{formatMoney(outstanding)}</div>
          <p className="bb-reimbursement-note">{allMonths ? "Across all months" : monthLabel}{count ? ` · ${count} awaiting repayment` : ""}</p>
          {incomplete && <p className="bb-reimbursement-warning" role="status">Some reimbursement records couldn’t be checked. This balance may be incomplete.</p>}
          {monthly.length > 0 && <>
            <p className="bb-reimbursement-period">{monthLabel} expenses</p>
            <dl className="bb-reimbursement-summary" aria-label={`Reimbursements for ${monthLabel} expenses`}>
              <div><dt>Received</dt><dd>{formatMoney(monthly.reduce((sum, item) => sum + item.receivedAmount, 0))}</dd></div>
              <div><dt>Gross paid</dt><dd>{formatMoney(monthly.reduce((sum, item) => sum + item.grossAmount, 0))}</dd></div>
              <div><dt>Your share</dt><dd>{formatMoney(monthly.reduce((sum, item) => sum + item.personalShare, 0))}</dd></div>
            </dl>
          </>}
        </div>
        <div className="bb-reimbursement-ledger" aria-label="Shared expenses">
          {groups.map((group) => <section className="bb-reimbursement-group" key={group.partner} aria-label={`Owed by ${group.partner}`}>
            <h3><span>Owed by {group.partner}</span><span>{formatMoney(group.amount)}</span></h3>
            {group.items.map((item) => <ReimbursementEntry key={item.id} item={item} />)}
          </section>)}
          {!count && !incomplete && <p className="bb-reimbursement-note">No outstanding reimbursements{allMonths ? "." : " for these expenses."}</p>}
          {received.length > 0 && <div className="bb-reimbursement-history">
            <AnimatedDisclosure summary={<>
              <span className="bb-reimbursement-item"><strong>Received</strong><span>For {monthLabel} expenses</span></span>
              <span className="bb-reimbursement-status">{received.length}</span>
              <span className="bb-disclosure-mark" aria-hidden="true" />
            </>}>
              {received.map((item) => <ReimbursementEntry key={item.id} item={item} />)}
            </AnimatedDisclosure>
          </div>}
        </div>
      </CardContent>
    </Card>
  )
}
