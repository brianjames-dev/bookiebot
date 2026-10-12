import type { ReactNode } from "react"
import type { ExpenseReportData } from "./types"

const currency = (value: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(value)
const percent = (value: number) => `${new Intl.NumberFormat("en-US", {maximumFractionDigits: 2}).format(value * 100)}%`

export function MonthlySavings({report, mode, ready = true, monthControl, controls}: {
  report: ExpenseReportData; mode: "current" | "projected"; ready?: boolean; monthControl?: ReactNode; controls?: ReactNode
}) {
  const plan = report.savingsPlan
  if (!plan) return null
  const values = report.modeViews?.[mode]?.savingsInvesting ?? report.savingsInvesting?.[mode]
  const history = report.savingsInvesting?.history
  return <section className="bb-report-section bb-monthly-savings" aria-label="Monthly savings and investing">
    <div className="bb-monthly-savings-heading"><h2>Savings &amp; investing</h2>{controls}</div>
    <p className="bb-report-context">{monthControl ?? report.monthLabel} · {mode === "projected" ? "Projected" : "Current"}</p>
    {!ready ? <p role="status">Load the selected month to see its savings and ESPP totals.</p> : !values ? <p role="status">Monthly savings are unavailable.</p> : <>
      {plan.status === "pending" && <p role="status">ESPP enrollment pending. Set the first affected paycheck date in your sheet to begin automatic tracking.</p>}
      {plan.status === "invalid" && <p role="alert">Check your ESPP settings. Paychecks use ordinary cash savings targets until the plan is valid.</p>}
      {plan.status === "off" && <p>ESPP tracking is off.</p>}
      <dl>
        <div><dt>Cash saved</dt><dd>{currency(values.cashSaved)}</dd></div>
        <div><dt>Minimum cash target</dt><dd>{currency(values.cashMinimum)}</dd></div>
        <div><dt>Ideal cash target</dt><dd>{currency(values.cashIdeal)}</dd></div>
        <div><dt>{values.estimatedEsppContribution ? "ESPP · includes estimate" : "SpaceX ESPP"}</dt><dd>{currency(values.esppContribution)}</dd></div>
        <div className="bb-monthly-savings-combined"><dt>Cash saved + ESPP{values.estimatedEsppContribution ? " estimate" : ""}</dt><dd>{currency(values.combinedContributions)} · {percent(values.combinedRate)}</dd></div>
      </dl>
      <p className="bb-activity-footnote">Enrolled pay: {percent(plan.cashIdealRate)} ideal cash savings, {percent(plan.cashMinimumRate)} minimum, and {percent(plan.rate)} ESPP. Other income: {percent(plan.otherCashIdealRate)} ideal cash savings.</p>
      <p className="bb-activity-footnote">ESPP is calculated from payroll and already withheld before deposit. Cash saved is the total you recorded for this month.</p>
      {!!values.estimatedEsppContribution && <p className="bb-activity-footnote">Includes {currency(values.estimatedEsppContribution)} from expected paychecks. This portion has not been contributed yet.</p>}
      {values.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
      {history && <div className="bb-monthly-savings-history"><span>ESPP contributed through {history.throughMonth}{history.coverage === "partial" ? " · available months" : ""}</span><strong>{currency(history.totalContributed)}</strong>
        <p className="bb-activity-footnote">Calculated contributions, separate from stock market value.{history.coverage === "partial" ? ` Missing months: ${history.unavailableMonths.join(", ")}.` : ""}</p></div>}
    </>}
  </section>
}
