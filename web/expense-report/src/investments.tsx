import type { ExpenseReportData } from "./types"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { FittedAmount } from "./components/ui/fitted-amount"

const currency = (value: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(value)

export function Investments({report, ready = true}: {report: ExpenseReportData; ready?: boolean}) {
  if (!report.savingsPlan) return null
  const history = report.savingsInvesting?.history
  const valid = report.savingsPlan.status !== "invalid" && report.savingsPlan.status !== "pending"
  return <Card className="bb-report-section bb-investments-section" aria-label="Investments">
    <CardHeader><CardTitle>Investments</CardTitle></CardHeader>
    <CardContent>
      <div className="bb-investment-bucket">
        <div><h3>SpaceX stock</h3><p>ESPP · Total contributed</p></div>
        <FittedAmount className="bb-investment-total">{ready && valid && history ? currency(history.totalContributed) : "—"}</FittedAmount>
      </div>
      {!ready ? <p role="status" className="bb-activity-footnote">Load the selected month to see investments.</p>
        : !valid ? <p role="status" className="bb-activity-footnote">Check your ESPP enrollment settings.</p>
        : !history ? <p role="status" className="bb-activity-footnote">Investment contributions are unavailable.</p>
        : history.coverage === "partial" ? <p role="status" className="bb-activity-footnote">Available history through {history.throughMonth}. Missing months: {history.unavailableMonths.join(", ")}.</p> : null}
      {ready && valid && (report.savingsInvesting?.current.warnings ?? []).map(warning => <p key={warning} role="status" className="bb-activity-footnote">{warning}</p>)}
    </CardContent>
  </Card>
}
