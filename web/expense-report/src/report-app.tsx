import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "./components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./components/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import type { AmountRow, BreakdownItem, BurnRate, BurnRatePoint, ExpenseEntry, ExpenseReportData, PaymentItem, SubscriptionItem } from "./types"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "N/A"
  }
  return money.format(value)
}

function formatPct(value: number) {
  return `${value.toFixed(1)}%`
}

export function ExpenseReportApp({ report }: { report: ExpenseReportData }) {
  const categoryColors: Record<string, string> = Object.fromEntries(report.breakdown.map((item) => [item.label, item.color]))

  return (
    <div className="bb-page">
      <header className="bb-page-header">
        <div>
          <h1>Expense Breakdown</h1>
          <p>
            {report.monthLabel} budget report for {report.ownerName}. Generated {report.generatedAt}.
          </p>
        </div>
        <Badge variant="outline">React + shadcn/ui</Badge>
      </header>

      <main className="bb-main">
        <section className="bb-metrics-grid" aria-label="Budget metrics">
          <MetricCard label="Monthly Expenses" value={report.metrics.totalExpenses} />
          <MetricCard label="Monthly Income" value={report.metrics.monthlyIncome} />
          <MetricCard label="Personal Outflows" value={report.metrics.personalOutflows} />
          <MetricCard label="Shared Expenses" value={report.metrics.sharedExpenses} />
          <MetricCard label="Remaining Needs Budget" value={report.metrics.remainingNeedsBudget ?? report.metrics.remainingBudget} accent />
          <MetricCard label="Remaining Wants Budget" value={report.metrics.remainingWantsBudget} accent />
          <MetricCard label="Amount Saved" value={report.metrics.amountSaved} accent />
          <MetricCard label="Income After Expenses" value={report.metrics.incomeAfterExpenses} accent />
        </section>

        <Card className="bb-analytics-card">
          <CardHeader className="bb-analytics-header">
            <div>
              <CardTitle>Budget Charts</CardTitle>
              <CardDescription>Interactive views powered by shadcn/ui patterns and Recharts.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="category">
              <TabsList>
                <TabsTrigger value="category">Category Mix</TabsTrigger>
                {report.burnRate ? <TabsTrigger value="burn-rate">Burn Rate</TabsTrigger> : null}
                <TabsTrigger value="groups">Needs vs Wants</TabsTrigger>
                <TabsTrigger value="merchants">Merchants</TabsTrigger>
              </TabsList>
              <TabsContent value="category">
                <CategoryMixChart data={report.breakdown} total={report.metrics.totalExpenses} />
              </TabsContent>
              {report.burnRate ? (
                <TabsContent value="burn-rate">
                  <BurnRateChart burnRate={report.burnRate} monthLabel={report.monthLabel} />
                </TabsContent>
              ) : null}
              <TabsContent value="groups">
                <BudgetGroupChart data={report.budgetGroups} />
              </TabsContent>
              <TabsContent value="merchants">
                <MerchantChart data={report.merchantTotals} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <section className="bb-two-grid">
          <ReportTable title="Spending By Person / Card" columns={["Person", "Amount"]} rows={report.personTotals} />
          <ReportTable title="Frequent Merchants / Locations" columns={["Merchant", "Amount"]} rows={report.merchantTotals} />
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Daily Spending</CardTitle>
            <CardDescription>Shared transaction activity grouped by day.</CardDescription>
          </CardHeader>
          <CardContent className="bb-daily-spending-content">
            <DailySpendingChart data={report.dailyTotals} total={report.metrics.sharedExpenses} daysInMonth={report.daysInMonth} />
            <DailyEntriesTable entries={report.dailyEntries} categoryColors={categoryColors} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Largest Shared Expenses</CardTitle>
          </CardHeader>
          <CardContent>
            <ExpenseEntriesTable entries={report.topEntries} />
          </CardContent>
        </Card>

        <section className="bb-two-grid">
          <PaymentTable title="Rent" items={report.rentPayments} />
          <PaymentTable title="Bills & Utilities" items={report.utilityPayments} />
        </section>

        <section className="bb-two-grid">
          <SubscriptionTable title="Subscriptions (Needs)" items={report.subscriptionsNeeds} />
          <SubscriptionTable title="Subscriptions (Wants)" items={report.subscriptionsWants} />
        </section>

        <PaymentTable title="Income Entries" items={report.incomeEntries} />
      </main>
    </div>
  )
}

function BurnRateChart({ burnRate, monthLabel }: { burnRate: BurnRate; monthLabel: string }) {
  const isOver = burnRate.status === "over"
  const isNotStarted = burnRate.status === "not_started"
  const statusLabel = isNotStarted ? "Not started" : isOver ? "Over pace" : "Under pace"
  const differenceLabel = isNotStarted ? "No elapsed days" : formatMoney(Math.abs(burnRate.totalDifference))
  const dailyDifference = isNotStarted ? "No daily pace yet" : `${burnRate.dailyDifference >= 0 ? "+" : ""}${formatMoney(burnRate.dailyDifference)}/day`
  const recordedPoints = burnRate.series.filter((point): point is BurnRatePoint & { variance: number } => point.variance !== null)
  const segments = recordedPoints.slice(1).map((point, index) => ({
    key: `segment${index}`,
    label: point.variance > 0 ? "Over pace" : "Under pace",
    color: point.variance > 0 ? "hsl(var(--destructive))" : "hsl(var(--success))",
    fromDay: recordedPoints[index].day,
    toDay: point.day,
    fromVariance: recordedPoints[index].variance,
    toVariance: point.variance,
  }))
  const chartData = burnRate.series.map((point) => {
    const row: Record<string, string | number | null> = {
      ...point,
    }
    for (const segment of segments) {
      row[segment.key] = point.day === segment.fromDay ? segment.fromVariance : point.day === segment.toDay ? segment.toVariance : null
    }
    return row
  })
  const segmentConfig: ChartConfig = Object.fromEntries(
    segments.map((segment) => [segment.key, { label: segment.label, color: segment.color }]),
  )

  return (
    <div className="bb-chart-layout">
      <ChartContainer
        config={segmentConfig}
        className="bb-chart-box"
      >
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData} margin={{ top: 20, right: 22, left: 0, bottom: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={58} />
            <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.45} strokeWidth={1.5} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {segments.map((segment) => (
              <Line
                key={segment.key}
                type="linear"
                dataKey={segment.key}
                name={segment.label}
                stroke={segment.color}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="bb-chart-side">
        <div className="bb-burn-rate-summary">
          <div>
            <div className="bb-chart-kicker">{statusLabel}</div>
            <div className={isOver ? "bb-burn-rate-value bb-negative" : "bb-burn-rate-value bb-positive"}>{differenceLabel}</div>
            <div className="bb-burn-rate-note">
              {burnRate.elapsedDays} of {burnRate.daysInMonth} days counted
            </div>
          </div>
          <div className={isOver ? "bb-burn-rate-pill bb-burn-rate-pill-danger" : "bb-burn-rate-pill"}>
            {dailyDifference}
          </div>
        </div>
        <div>
          <div className="bb-chart-kicker">Wants Burn Rate</div>
          <div className="bb-burn-rate-note">Food and shopping pace for {monthLabel}.</div>
        </div>
        <StatList
          rows={[
            ["Variable wants target", formatMoney(burnRate.budget)],
            ["Food + shopping spent", formatMoney(burnRate.spent)],
            ["Expected spend", formatMoney(burnRate.expectedSpend)],
            ["Remaining wants budget", formatMoney(burnRate.remaining)],
            ["Allowed daily average", formatMoney(burnRate.allowedDailyAverage)],
            ["Actual daily average", formatMoney(burnRate.actualDailyAverage)],
          ]}
        />
      </div>
    </div>
  )
}

function MetricCard({
  label,
  value,
  description,
  accent = false,
}: {
  label: string
  value: number | null | undefined
  description?: string
  accent?: boolean
}) {
  const positive = accent && value !== null && value !== undefined && value >= 0
  const negative = value !== null && value !== undefined && value < 0
  return (
    <Card>
      <CardContent className="bb-metric-card">
        <div className="bb-metric-label">{label}</div>
        <div className={negative ? "bb-metric-value bb-negative" : positive ? "bb-metric-value bb-positive" : "bb-metric-value"}>
          {formatMoney(value)}
        </div>
        {description ? <div className="bb-metric-note">{description}</div> : null}
      </CardContent>
    </Card>
  )
}

function CategoryMixChart({ data, total }: { data: BreakdownItem[]; total: number }) {
  return (
    <div className="bb-chart-layout">
      <ChartContainer config={chartConfig(data)} className="bb-chart-box">
        <ResponsiveContainer width="100%" height={330}>
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={data} dataKey="amount" nameKey="label" innerRadius={72} outerRadius={122} paddingAngle={1}>
              {data.map((item) => (
                <Cell key={item.key} fill={item.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="bb-chart-side">
        <div>
          <div className="bb-chart-kicker">Category Mix</div>
          <div className="bb-chart-total">{formatMoney(total)}</div>
        </div>
        <div className="bb-legend-list">
          {data.map((item) => (
            <div className="bb-legend-row" key={item.key}>
              <span className="bb-swatch" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
              <strong>
                {formatMoney(item.amount)} <span>{formatPct(item.percentage)}</span>
              </strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DailySpendingChart({ data, total, daysInMonth }: { data: AmountRow[]; total: number; daysInMonth: number }) {
  const peak = data.reduce<AmountRow | null>((best, item) => (!best || item.amount > best.amount ? item : best), null)
  const averageDaySpend = daysInMonth ? total / daysInMonth : 0
  return (
    <div className="bb-chart-layout">
      <ChartContainer config={{ amount: { label: "Amount", color: "hsl(var(--chart-1))" } }} className="bb-chart-box">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={52} />
            <ChartTooltip content={<ChartTooltipContent />} cursor={{ fill: "hsl(var(--muted) / 0.08)" }} />
            <Bar dataKey="amount" name="Daily spending" fill="hsl(var(--chart-1))" radius={[6, 6, 2, 2]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="bb-chart-side">
        <div>
          <div className="bb-chart-kicker">Daily Spending</div>
          <div className="bb-chart-total">{formatMoney(total)}</div>
        </div>
        <StatList
          rows={[
            ["Tracked days", String(data.length)],
            ["Average day", formatMoney(averageDaySpend)],
            ["Highest day", peak ? `${peak.label} - ${formatMoney(peak.amount)}` : "N/A"],
          ]}
        />
      </div>
    </div>
  )
}

function BudgetGroupChart({ data }: { data: AmountRow[] }) {
  const total = data.reduce((sum, item) => sum + item.amount, 0)
  return (
    <div className="bb-chart-layout">
      <ChartContainer config={chartConfig(data)} className="bb-chart-box">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} layout="vertical" margin={{ top: 24, right: 32, left: 24, bottom: 24 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} />
            <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={86} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="amount" name="Budget group" radius={[0, 6, 6, 0]}>
              {data.map((item, index) => (
                <Cell key={item.label} fill={`hsl(var(--chart-${index + 1}))`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="bb-chart-side">
        <div>
          <div className="bb-chart-kicker">Needs vs Wants</div>
          <div className="bb-chart-total">{formatMoney(total)}</div>
        </div>
        <StatList rows={data.map((item) => [item.label, `${formatMoney(item.amount)} (${formatPct((item.amount / total) * 100 || 0)})`])} />
      </div>
    </div>
  )
}

function MerchantChart({ data }: { data: AmountRow[] }) {
  const rows = data.slice(0, 8)
  return (
    <div className="bb-chart-layout">
      <ChartContainer config={{ amount: { label: "Amount", color: "hsl(var(--chart-4))" } }} className="bb-chart-box">
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 20, left: 20, bottom: 12 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} />
            <YAxis dataKey="label" type="category" width={128} tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="amount" name="Merchant total" fill="hsl(var(--chart-4))" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="bb-chart-side">
        <div>
          <div className="bb-chart-kicker">Merchant Concentration</div>
          <div className="bb-chart-total">{rows.length}</div>
        </div>
        <StatList rows={rows.slice(0, 4).map((item) => [item.label, formatMoney(item.amount)])} />
      </div>
    </div>
  )
}

function StatList({ rows }: { rows: [string, string][] }) {
  return (
    <div className="bb-stat-list">
      {rows.map(([label, value]) => (
        <div className="bb-stat-row" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

function ReportTable({ title, columns, rows }: { title: string; columns: [string, string]; rows: AmountRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <AmountTable columns={columns} rows={rows} />
      </CardContent>
    </Card>
  )
}

function AmountTable({ columns, rows }: { columns: [string, string]; rows: AmountRow[] }) {
  if (!rows.length) {
    return <div className="bb-empty">No data found.</div>
  }
  return (
    <div className="bb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>{columns[0]}</th>
            <th>{columns[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="bb-amount">{formatMoney(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ExpenseEntriesTable({ entries }: { entries: ExpenseEntry[] }) {
  if (!entries.length) {
    return <div className="bb-empty">No shared expense entries found.</div>
  }
  return (
    <div className="bb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Category</th>
            <th>Item</th>
            <th>Location</th>
            <th>Person</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.date}-${entry.category}-${entry.amount}-${index}`}>
              <td>{entry.date}</td>
              <td>{entry.category}</td>
              <td>{entry.item}</td>
              <td>{entry.location}</td>
              <td>{entry.person}</td>
              <td className="bb-amount">{formatMoney(entry.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DailyEntriesTable({ entries, categoryColors }: { entries: ExpenseEntry[]; categoryColors: Record<string, string> }) {
  if (!entries.length) {
    return <div className="bb-empty">No shared expense entries found.</div>
  }

  const grouped = new Map<string, ExpenseEntry[]>()
  for (const entry of entries) {
    const day = entry.date ? entry.date.split("/")[1] || entry.date : "No date"
    grouped.set(day, [...(grouped.get(day) || []), entry])
  }

  return (
    <div className="bb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Total</th>
            <th>Transactions</th>
          </tr>
        </thead>
        <tbody>
          {Array.from(grouped.entries()).sort(compareDayGroups).map(([day, dayEntries]) => {
            const total = dayEntries.reduce((sum, entry) => sum + entry.amount, 0)
            return (
              <tr key={day}>
                <td>{day}</td>
                <td className="bb-amount">{formatMoney(total)}</td>
                <td>
                  <div className="bb-transaction-list">
                    {dayEntries.map((entry, index) => (
                      <div key={`${entry.category}-${entry.amount}-${index}`}>
                        <strong className="bb-transaction-category" style={{ color: categoryColors[entry.category] }}>
                          {entry.category}
                        </strong>{" "}
                        {entry.item || entry.location || "Transaction"} - {formatMoney(entry.amount)}
                        <span> ({entry.person})</span>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function compareDayGroups([left]: [string, ExpenseEntry[]], [right]: [string, ExpenseEntry[]]) {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber
  }
  if (Number.isFinite(leftNumber)) {
    return -1
  }
  if (Number.isFinite(rightNumber)) {
    return 1
  }
  return left.localeCompare(right)
}

function PaymentTable({ title, items }: { title: string; items: PaymentItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {!items.length ? (
          <div className="bb-empty">No entries found.</div>
        ) : (
          <div className="bb-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Group</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.label}-${item.amount}`}>
                    <td>{item.label}</td>
                    <td>{item.group}</td>
                    <td className="bb-amount">{formatMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SubscriptionTable({ title, items }: { title: string; items: SubscriptionItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {!items.length ? (
          <div className="bb-empty">No matching subscriptions found for this month.</div>
        ) : (
          <div className="bb-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Cadence</th>
                  <th>Pull Day</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.name}-${item.amount}`}>
                    <td>{item.name}</td>
                    <td>{item.kind || "-"}</td>
                    <td>{item.cadence}</td>
                    <td>{item.pullDay || "-"}</td>
                    <td className="bb-amount">{formatMoney(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function chartConfig(items: Array<AmountRow | BreakdownItem>) {
  return Object.fromEntries(
    items.map((item, index) => [
      "key" in item ? item.key : item.label,
      {
        label: item.label,
        color: "color" in item ? item.color : `hsl(var(--chart-${index + 1}))`,
      },
    ]),
  )
}
