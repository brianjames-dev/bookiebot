import { useEffect, useState } from "react"
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
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./components/ui/chart"
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

function generatedTimeLabel(value: string) {
  const match = value.match(/(\d{1,2}:\d{2}\s+[AP]M(?:\s+[A-Z]+)?)$/)
  return match?.[1] ?? value
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches))

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined
    }
    const media = window.matchMedia(query)
    const handleChange = () => setMatches(media.matches)
    handleChange()
    if (media.addEventListener) {
      media.addEventListener("change", handleChange)
      return () => media.removeEventListener("change", handleChange)
    }
    media.addListener(handleChange)
    return () => media.removeListener(handleChange)
  }, [query])

  return matches
}

export function ExpenseReportApp({ report }: { report: ExpenseReportData }) {
  const categoryColors: Record<string, string> = Object.fromEntries(report.breakdown.map((item) => [item.label, item.color]))

  return (
    <div className="bb-page">
      <header className="bb-page-header">
        <div>
          <h1>Expense Breakdown</h1>
          <p>{report.monthLabel} budget report for {report.ownerName}.</p>
        </div>
        <Badge variant="outline">Generated {generatedTimeLabel(report.generatedAt)}</Badge>
      </header>

      <main className="bb-main">
        <section className="bb-metrics-grid" aria-label="Budget metrics">
          <MetricCard label="Monthly Income" value={report.metrics.monthlyIncome} />
          <MetricCard label="Monthly Expenses" value={report.metrics.totalExpenses} />
          <MetricCard label="Fixed Commitments" value={report.metrics.fixedCommitments} />
          <BurnRateMetricCard burnRate={report.burnRate} />
          <MetricCard label="Remaining Needs Budget" value={report.metrics.remainingNeedsBudget ?? report.metrics.remainingBudget} accent />
          <MetricCard label="Remaining Wants Budget" value={report.metrics.remainingWantsBudget} accent />
          <MetricCard label="Amount Saved" value={report.metrics.amountSaved} accent />
          <MetricCard label="Income After Expenses" value={report.metrics.incomeAfterExpenses} accent />
        </section>

        <Card className="bb-analytics-card">
          <CardHeader className="bb-analytics-header">
            <div>
              <CardTitle>Budget Charts</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="category">
              <TabsList>
                <TabsTrigger value="category">Category Mix</TabsTrigger>
                {report.burnRate ? <TabsTrigger value="burn-rate">Burn Rate</TabsTrigger> : null}
                <TabsTrigger value="groups">Needs vs Wants</TabsTrigger>
              </TabsList>
              <TabsContent value="category">
                <CategoryMixChart data={report.breakdown} total={report.metrics.totalExpenses} />
              </TabsContent>
              {report.burnRate ? (
                <TabsContent value="burn-rate">
                  <BurnRateChart burnRate={report.burnRate} />
                </TabsContent>
              ) : null}
              <TabsContent value="groups">
                <BudgetGroupChart data={report.budgetGroups} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily Spending</CardTitle>
          </CardHeader>
          <CardContent className="bb-daily-spending-content">
            <DailySpendingChart data={report.dailyTotals} total={report.metrics.sharedExpenses} elapsedDays={report.elapsedDays} />
            <DailyEntriesTable entries={report.dailyEntries} categoryColors={categoryColors} />
          </CardContent>
        </Card>

        <ExpenseInsightsCard topEntries={report.topEntries} merchantTotals={report.merchantTotals} />

        <section className="bb-two-grid">
          <PaymentTable title="Rent" items={report.rentPayments} />
          <PaymentTable title="Bills & Utilities" items={report.utilityPayments} />
        </section>

        <SubscriptionCalendarCard
          year={report.year}
          month={report.month}
          monthLabel={report.monthLabel}
          needs={report.subscriptionsNeeds}
          wants={report.subscriptionsWants}
        />

        <PaymentTable title="Income Entries" items={report.incomeEntries} />
      </main>
    </div>
  )
}

function BurnRateChart({ burnRate }: { burnRate: BurnRate }) {
  const isOver = burnRate.status === "over"
  const isNotStarted = burnRate.status === "not_started"
  const statusLabel = isNotStarted ? "Not started" : isOver ? "Over pace" : "Under pace"
  const differenceLabel = isNotStarted ? "No elapsed days" : formatMoney(Math.abs(burnRate.totalDifference))
  const dailyDifference = isNotStarted ? "No daily pace yet" : `${burnRate.dailyDifference >= 0 ? "+" : ""}${formatMoney(burnRate.dailyDifference)}/day`
  const chartSeries = burnRate.series
  const gradientStops = burnRateGradientStops(chartSeries)
  const lineColor = isNotStarted ? "hsl(var(--chart-1))" : "url(#burn-rate-variance-gradient)"
  const yAxisDomain = burnRateYAxisDomain(chartSeries)

  return (
    <div className="bb-chart-layout">
      <ChartContainer
        config={{ variance: { label: "Variance", color: lineColor } }}
        className="bb-chart-box"
      >
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartSeries} margin={{ top: 20, right: 22, left: 0, bottom: 8 }}>
            <defs>
              <linearGradient id="burn-rate-variance-gradient" x1="0" y1="0" x2="0" y2="1">
                {gradientStops.map((stop, index) => (
                  <stop key={`${stop.offset}-${index}`} offset={stop.offset} stopColor={stop.color} />
                ))}
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis domain={yAxisDomain} tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={58} />
            <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.45} strokeWidth={1.5} />
            <ChartTooltip content={<BurnRateTooltipContent />} />
            <Line
              type="monotone"
              dataKey="variance"
              name="Variance"
              stroke={lineColor}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={renderBurnRateActiveDot}
              connectNulls={false}
              isAnimationActive
              animationBegin={0}
              animationDuration={900}
              animationEasing="ease-out"
            />
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
        <StatList
          rows={[
            ["Monthly wants target", formatMoney(burnRate.budget)],
            ["Food + shopping spent", formatMoney(burnRate.spent)],
            ["Remaining wants budget", formatMoney(burnRate.remaining)],
            ["Allowed daily average", formatMoney(burnRate.allowedDailyAverage)],
            ["Actual daily average", formatMoney(burnRate.actualDailyAverage)],
          ]}
        />
      </div>
    </div>
  )
}

function burnRateGradientStops(series: BurnRatePoint[]) {
  const values = series
    .map((point) => point.variance)
    .filter((value): value is number => value !== null && value !== undefined)

  if (!values.length) {
    return [
      { offset: "0%", color: "hsl(var(--chart-1))" },
      { offset: "100%", color: "hsl(var(--chart-1))" },
    ]
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max <= 0) {
    return [
      { offset: "0%", color: "hsl(var(--success))" },
      { offset: "100%", color: "hsl(var(--success))" },
    ]
  }
  if (min >= 0) {
    return [
      { offset: "0%", color: "hsl(var(--destructive))" },
      { offset: "100%", color: "hsl(var(--destructive))" },
    ]
  }

  const zeroOffset = `${(max / (max - min)) * 100}%`
  return [
    { offset: "0%", color: "hsl(var(--destructive))" },
    { offset: zeroOffset, color: "hsl(var(--destructive))" },
    { offset: zeroOffset, color: "hsl(var(--success))" },
    { offset: "100%", color: "hsl(var(--success))" },
  ]
}

function burnRateYAxisDomain(series: BurnRatePoint[]): [number, number] {
  const values = series
    .map((point) => point.variance)
    .filter((value): value is number => value !== null && value !== undefined)

  values.push(0)

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(max - min, 1)
  const padding = Math.max(span * 0.08, 5)
  return [
    Math.floor((min - padding) / 5) * 5,
    Math.ceil((max + padding) / 5) * 5,
  ]
}

function burnRatePointColor(value: number) {
  if (value > 0) {
    return "hsl(var(--destructive))"
  }
  if (value < 0) {
    return "hsl(var(--success))"
  }
  return "hsl(var(--foreground))"
}

function renderBurnRateActiveDot(props: unknown) {
  const { cx, cy, payload } = props as {
    cx?: number
    cy?: number
    payload?: BurnRatePoint
  }
  if (cx === undefined || cy === undefined || payload?.variance === null || payload?.variance === undefined) {
    return null
  }

  return (
    <circle
      className="bb-burn-rate-active-dot"
      cx={cx}
      cy={cy}
      r={5}
      fill={burnRatePointColor(payload.variance)}
      stroke="hsl(var(--card))"
      strokeWidth={2}
    />
  )
}

type BurnRateTooltipPayload = {
  payload?: BurnRatePoint
}

function BurnRateTooltipContent({
  active,
  payload,
}: {
  active?: boolean
  payload?: BurnRateTooltipPayload[]
}) {
  const point = payload?.find((item) => item.payload?.variance !== null && item.payload?.variance !== undefined)?.payload
  if (!active || !point || point.variance === null) {
    return null
  }

  const isOver = point.variance > 0
  const label = isOver ? "Over pace" : "Under pace"
  const color = burnRatePointColor(point.variance)

  return (
    <div className="bb-chart-tooltip">
      <div className="bb-chart-tooltip-title">Day {point.label}</div>
      <div className="bb-chart-tooltip-row">
        <span className="bb-chart-tooltip-dot" style={{ background: color }} />
        <span>{label}</span>
        <strong>{formatMoney(point.variance)}</strong>
      </div>
      <div className="bb-chart-tooltip-row">
        <span />
        <span>Day spent</span>
        <strong>{formatMoney(point.dailySpend)}</strong>
      </div>
      <div className="bb-chart-tooltip-row">
        <span />
        <span>Cumulative spent</span>
        <strong>{formatMoney(point.actualSpend)}</strong>
      </div>
      <div className="bb-chart-tooltip-row">
        <span />
        <span>Expected by day</span>
        <strong>{formatMoney(point.expectedSpend)}</strong>
      </div>
    </div>
  )
}

function BurnRateMetricCard({ burnRate }: { burnRate: BurnRate | null }) {
  if (!burnRate) {
    return <MetricCard label="Burn Rate" value={null} />
  }

  const isOver = burnRate.status === "over"
  const isNotStarted = burnRate.status === "not_started"
  const isOnPace = !isNotStarted && burnRate.totalDifference === 0
  const statusLabel = isNotStarted
    ? "Not started"
    : isOnPace
      ? "On pace"
      : `${isOver ? "Over" : "Under"} ${formatMoney(Math.abs(burnRate.totalDifference))}`
  const dailyLabel = isNotStarted
    ? "No daily pace yet"
    : `${burnRate.dailyDifference >= 0 ? "+" : ""}${formatMoney(burnRate.dailyDifference)}/day`

  return (
    <Card>
      <CardContent className="bb-metric-card">
        <div className="bb-metric-label">Burn Rate</div>
        <div className={isOver ? "bb-metric-value bb-negative" : "bb-metric-value bb-positive"}>
          {statusLabel}
        </div>
        <div className="bb-metric-note">{dailyLabel}</div>
      </CardContent>
    </Card>
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
  const pieLayout = useExpensePieLayout()

  return (
    <div className="bb-chart-layout">
      <ChartContainer config={chartConfig(data)} className="bb-chart-box">
        <ResponsiveContainer width="100%" height={pieLayout.chartHeight}>
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie
              data={data}
              dataKey="amount"
              nameKey="label"
              innerRadius={pieLayout.innerRadius}
              outerRadius={pieLayout.outerRadius}
              paddingAngle={1}
              label={pieLayout.showLabels ? (props) => renderPieMetricLabel(props, pieLayout) : false}
              labelLine={pieLayout.showLabels ? (props) => renderPieMetricLabelLine(props, pieLayout) : false}
            >
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

function useExpensePieLayout() {
  const isPhone = useMediaQuery("(max-width: 520px)")

  return {
    chartHeight: 330,
    innerRadius: 72,
    outerRadius: 122,
    labelOffset: 20,
    labelGap: PIE_METRIC_LABEL_GAP,
    compactLabel: false,
    showLabels: !isPhone,
  }
}

function pieMetricAnimationDelay(index: number | undefined) {
  return `${Math.min(index ?? 0, 8) * 45 + 180}ms`
}

function pieMetricColor(payload: BreakdownItem | undefined, fallback: string | undefined) {
  return payload?.color ?? fallback ?? "hsl(var(--foreground))"
}

type PieMetricTextAnchor = "start" | "middle" | "end" | "inherit"

const PIE_METRIC_LABEL_GAP = 10

type ExpensePieLayout = ReturnType<typeof useExpensePieLayout>

function pieMetricLabelX(x: number | string | undefined, textAnchor: PieMetricTextAnchor | undefined, gap: number) {
  const numericX = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : Number.NaN
  if (!Number.isFinite(numericX)) {
    return x
  }
  if (textAnchor === "start") {
    return numericX + gap
  }
  if (textAnchor === "end") {
    return numericX - gap
  }
  return x
}

function renderPieMetricLabel(props: unknown, layout: ExpensePieLayout) {
  const { name, value, payload, fill, index } = props as {
    name?: string
    value?: number
    payload?: BreakdownItem
    fill?: string
    index?: number
  }
  const position = pieMetricLabelPosition(props, layout)
  const label = payload?.label ?? name ?? ""
  const amount = payload?.amount ?? Number(value ?? 0)
  const labelX = pieMetricLabelX(position.x, position.textAnchor, layout.labelGap)
  const amountLabel = formatMoney(amount)

  return (
    <text
      x={labelX}
      y={position.y}
      textAnchor={position.textAnchor}
      dominantBaseline="central"
      className="bb-pie-metric-label"
      style={{ animationDelay: pieMetricAnimationDelay(index), fill: pieMetricColor(payload, fill) }}
    >
      {layout.compactLabel ? (
        <>
          <tspan x={labelX} dy="-0.35em">
            {label}
          </tspan>
          <tspan x={labelX} dy="1.25em">
            {amountLabel}
          </tspan>
        </>
      ) : (
        `${label} ${amountLabel}`
      )}
    </text>
  )
}

function renderPieMetricLabelLine(props: unknown, layout: ExpensePieLayout) {
  const { payload, stroke, index } = props as {
    payload?: BreakdownItem
    stroke?: string
    index?: number
  }
  const line = pieMetricLinePosition(props, layout)
  if (!line) {
    return <path className="bb-pie-metric-label-line" d="" fill="none" opacity={0} />
  }

  return (
    <path
      className="bb-pie-metric-label-line"
      d={`M${line.start.x},${line.start.y}L${line.end.x},${line.end.y}`}
      fill="none"
      pathLength={1}
      stroke={pieMetricColor(payload, stroke)}
      strokeLinecap="round"
      strokeWidth={1.5}
      style={{ animationDelay: pieMetricAnimationDelay(index) }}
    />
  )
}

function pieMetricLabelPosition(props: unknown, layout: ExpensePieLayout) {
  const { x, y, textAnchor } = props as {
    x?: number | string
    y?: number | string
    textAnchor?: PieMetricTextAnchor
  }
  const computed = pieMetricPolarPoint(props, layout.outerRadius + layout.labelOffset)
  if (computed) {
    return {
      x: computed.x,
      y: computed.y,
      textAnchor: computed.x > computed.cx ? "start" as const : "end" as const,
    }
  }
  return { x, y, textAnchor }
}

function pieMetricLinePosition(props: unknown, layout: ExpensePieLayout) {
  const start = pieMetricPolarPoint(props, layout.outerRadius)
  const end = pieMetricPolarPoint(props, layout.outerRadius + layout.labelOffset)
  if (start && end) {
    return { start, end }
  }

  const { points } = props as {
    points?: Array<{ x?: number | string; y?: number | string }>
  }
  const [fallbackStart, fallbackEnd] = points ?? []
  if (fallbackStart?.x === undefined || fallbackStart?.y === undefined || fallbackEnd?.x === undefined || fallbackEnd?.y === undefined) {
    return null
  }
  return { start: fallbackStart, end: fallbackEnd }
}

function pieMetricPolarPoint(props: unknown, radius: number) {
  const { cx, cy, midAngle } = props as {
    cx?: number
    cy?: number
    midAngle?: number
  }
  if (cx === undefined || cy === undefined || midAngle === undefined) {
    return null
  }
  const radians = (-midAngle * Math.PI) / 180
  return {
    cx,
    x: cx + Math.cos(radians) * radius,
    y: cy + Math.sin(radians) * radius,
  }
}

function DailySpendingChart({ data, total, elapsedDays }: { data: AmountRow[]; total: number; elapsedDays: number }) {
  const peak = data.reduce<AmountRow | null>((best, item) => (!best || item.amount > best.amount ? item : best), null)
  const averageDaySpend = elapsedDays ? total / elapsedDays : 0
  return (
    <div className="bb-chart-layout">
      <ChartContainer config={{ amount: { label: "Amount", color: "hsl(var(--chart-1))" } }} className="bb-chart-box">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={52} />
            <ChartTooltip content={<ChartTooltipContent />} cursor={{ fill: "hsl(var(--primary) / 0.1)" }} />
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
            ["Days counted", String(elapsedDays)],
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

function TopExpensesChart({ entries }: { entries: ExpenseEntry[] }) {
  const rows = entries.slice(0, 10).map((entry) => ({
    label: expenseEntryItemLabel(entry),
    amount: entry.amount,
  }))

  return (
    <ChartContainer config={{ amount: { label: "Amount", color: "hsl(var(--chart-2))" } }} className="bb-insight-chart-box">
      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 22, left: 20, bottom: 12 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} />
          <YAxis dataKey="label" type="category" width={148} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="amount" name="Expense amount" fill="hsl(var(--chart-2))" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

function MerchantChart({ data }: { data: AmountRow[] }) {
  const rows = data.slice(0, 10)
  return (
    <ChartContainer config={{ amount: { label: "Amount", color: "hsl(var(--chart-4))" } }} className="bb-insight-chart-box">
      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 22, left: 20, bottom: 12 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} />
          <YAxis dataKey="label" type="category" width={148} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="amount" name="Merchant total" fill="hsl(var(--chart-4))" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

function ExpenseInsightsCard({ topEntries, merchantTotals }: { topEntries: ExpenseEntry[]; merchantTotals: AmountRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Expense Highlights</CardTitle>
      </CardHeader>
      <CardContent className="bb-expense-insights-content">
        <Tabs defaultValue="largest">
          <TabsList>
            <TabsTrigger value="largest">Largest</TabsTrigger>
            <TabsTrigger value="merchants">Most Frequent</TabsTrigger>
          </TabsList>
          <TabsContent value="largest">
            <div className="bb-insight-panel">
              <TopExpensesChart entries={topEntries} />
              <TopExpensesTable entries={topEntries} />
            </div>
          </TabsContent>
          <TabsContent value="merchants">
            <div className="bb-insight-panel">
              <MerchantChart data={merchantTotals} />
              <AmountTable columns={["Merchant", "Amount"]} rows={merchantTotals} />
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
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

function expenseEntryItemLabel(entry: ExpenseEntry) {
  return entry.item || entry.location || "Transaction"
}

function TopExpensesTable({ entries }: { entries: ExpenseEntry[] }) {
  if (!entries.length) {
    return <div className="bb-empty">No shared expense entries found.</div>
  }
  return (
    <div className="bb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.date}-${entry.category}-${entry.amount}-${index}`}>
              <td>{expenseEntryItemLabel(entry)}</td>
              <td>{entry.category}</td>
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

type SubscriptionTone = "all" | "needs" | "wants"

const SUBSCRIPTION_TONES: Record<SubscriptionTone, { label: string; color: string; background: string }> = {
  all: {
    label: "All",
    color: "hsl(var(--foreground))",
    background: "hsl(var(--muted) / 0.12)",
  },
  needs: {
    label: "Needs",
    color: "#2563eb",
    background: "rgb(37 99 235 / 0.1)",
  },
  wants: {
    label: "Wants",
    color: "#7c3aed",
    background: "rgb(124 58 237 / 0.1)",
  },
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function SubscriptionCalendarCard({
  year,
  month,
  monthLabel,
  needs,
  wants,
}: {
  year: number
  month: number
  monthLabel: string
  needs: SubscriptionItem[]
  wants: SubscriptionItem[]
}) {
  const allSubscriptions = [...needs, ...wants]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscriptions</CardTitle>
      </CardHeader>
      <CardContent className="bb-subscription-card-content">
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="needs">Needs</TabsTrigger>
            <TabsTrigger value="wants">Wants</TabsTrigger>
          </TabsList>
          <TabsContent value="all">
            <SubscriptionPanel year={year} month={month} monthLabel={monthLabel} items={allSubscriptions} tone="all" />
          </TabsContent>
          <TabsContent value="needs">
            <SubscriptionPanel year={year} month={month} monthLabel={monthLabel} items={needs} tone="needs" />
          </TabsContent>
          <TabsContent value="wants">
            <SubscriptionPanel year={year} month={month} monthLabel={monthLabel} items={wants} tone="wants" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function SubscriptionPanel({
  year,
  month,
  monthLabel,
  items,
  tone,
}: {
  year: number
  month: number
  monthLabel: string
  items: SubscriptionItem[]
  tone: SubscriptionTone
}) {
  const total = items.reduce((sum, item) => sum + item.amount, 0)
  const scheduledCount = items.filter((item) => subscriptionDayInMonth(item, year, month) !== null).length
  const toneConfig = SUBSCRIPTION_TONES[tone]

  return (
    <div className="bb-subscription-panel">
      <div className="bb-subscription-summary">
        <div>
          <div className="bb-chart-kicker">{toneConfig.label} subscriptions</div>
          <div className="bb-subscription-total" style={{ color: toneConfig.color }}>
            {formatMoney(total)}
          </div>
        </div>
        <Badge variant="secondary">
          {scheduledCount} in {monthLabel}
        </Badge>
      </div>
      <SubscriptionCalendar year={year} month={month} items={items} tone={tone} />
      <SubscriptionItemsTable items={items} />
    </div>
  )
}

function SubscriptionCalendar({
  year,
  month,
  items,
  tone,
}: {
  year: number
  month: number
  items: SubscriptionItem[]
  tone: SubscriptionTone
}) {
  const toneConfig = SUBSCRIPTION_TONES[tone]
  const daysInMonth = new Date(year, month, 0).getDate()
  const leadingBlankDays = new Date(year, month - 1, 1).getDay()
  const cellCount = Math.ceil((leadingBlankDays + daysInMonth) / 7) * 7
  const days = Array.from({ length: cellCount }, (_, index) => {
    const day = index - leadingBlankDays + 1
    return day >= 1 && day <= daysInMonth ? day : null
  })
  const itemsByDay = subscriptionsByDay(items, year, month)

  return (
    <div className="bb-subscription-calendar" aria-label={`${toneConfig.label} subscription calendar`}>
      <div className="bb-calendar-head" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="bb-calendar-grid">
        {days.map((day, index) => {
          const dayItems = day === null ? [] : itemsByDay.get(day) ?? []
          const visibleItems = dayItems.slice(0, 3)
          const hiddenCount = Math.max(dayItems.length - visibleItems.length, 0)
          return (
            <div
              key={`${day ?? "blank"}-${index}`}
              className={[
                "bb-calendar-day",
                day === null ? "bb-calendar-day-muted" : "",
                dayItems.length ? "bb-calendar-day-has-items" : "",
              ].filter(Boolean).join(" ")}
              aria-hidden={day === null}
            >
              {day === null ? null : (
                <>
                  <div className="bb-calendar-day-number">{day}</div>
                  <div className="bb-calendar-marker-stack">
                    {visibleItems.map((item, itemIndex) => {
                      const markerTone = tone === "all" ? subscriptionToneForItem(item) : tone
                      const markerToneConfig = SUBSCRIPTION_TONES[markerTone]
                      return (
                        <button
                          type="button"
                          key={`${item.name}-${item.amount}-${itemIndex}`}
                          className="bb-subscription-marker"
                          style={{
                            color: markerToneConfig.color,
                            backgroundColor: markerToneConfig.background,
                            borderColor: markerToneConfig.color,
                          }}
                          title={subscriptionMarkerTitle(item)}
                          aria-label={subscriptionMarkerTitle(item)}
                        >
                          <span className="bb-subscription-marker-dot" />
                          <span className="bb-subscription-marker-name">{item.name}</span>
                          <span className="bb-subscription-marker-amount">{formatMoney(item.amount)}</span>
                        </button>
                      )
                    })}
                    {hiddenCount ? (
                      <span
                        className="bb-subscription-marker bb-subscription-marker-more"
                        style={{
                          color: toneConfig.color,
                          backgroundColor: toneConfig.background,
                          borderColor: toneConfig.color,
                        }}
                        title={`${hiddenCount} more subscription${hiddenCount === 1 ? "" : "s"} on day ${day}`}
                      >
                        +{hiddenCount} more
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SubscriptionItemsTable({ items }: { items: SubscriptionItem[] }) {
  if (!items.length) {
    return <div className="bb-empty">No matching subscriptions found.</div>
  }

  return (
    <div className="bb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Cadence</th>
            <th>Pull Date</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.name}-${item.amount}-${index}`}>
              <td>{item.name}</td>
              <td>{item.kind || "-"}</td>
              <td>{item.cadence}</td>
              <td>{subscriptionPullLabel(item)}</td>
              <td className="bb-amount">{formatMoney(item.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function subscriptionsByDay(items: SubscriptionItem[], year: number, month: number) {
  const grouped = new Map<number, SubscriptionItem[]>()
  for (const item of items) {
    const day = subscriptionDayInMonth(item, year, month)
    if (day === null) {
      continue
    }
    grouped.set(day, [...(grouped.get(day) ?? []), item])
  }
  return grouped
}

function subscriptionDayInMonth(item: SubscriptionItem, year: number, month: number) {
  if (!item.pullDay) {
    return null
  }
  if (item.cadence === "yearly" && item.pullMonth !== month) {
    return null
  }
  const daysInMonth = new Date(year, month, 0).getDate()
  return Math.min(item.pullDay, daysInMonth)
}

function subscriptionPullLabel(item: SubscriptionItem) {
  if (!item.pullDay) {
    return "-"
  }
  if (item.cadence === "yearly" && item.pullMonth) {
    return `${item.pullMonth}/${item.pullDay}`
  }
  return String(item.pullDay)
}

function subscriptionToneForItem(item: SubscriptionItem): Exclude<SubscriptionTone, "all"> {
  const kind = item.kind.trim().toLowerCase()
  return kind === "want" || kind === "wants" ? "wants" : "needs"
}

function subscriptionMarkerTitle(item: SubscriptionItem) {
  return `${item.name} - ${item.kind || "Subscription"} - ${formatMoney(item.amount)} - ${subscriptionPullLabel(item)}`
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
