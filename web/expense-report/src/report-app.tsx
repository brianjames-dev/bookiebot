import { useEffect, useState, type ReactNode, type TouchEvent } from "react"
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
import type {
  AmountRow,
  BreakdownItem,
  BurnRate,
  BurnRatePoint,
  CalendarEvent,
  CalendarEventKind,
  ExpenseEntry,
  ExpenseReportData,
  OccurrenceRow,
  SubscriptionItem,
  UtilityHistoryItem,
} from "./types"

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

type ThemeMode = "light" | "dark"

type ThemeState = {
  theme: ThemeMode
  hasOverride: boolean
}

const THEME_STORAGE_KEY = "bookiebot-expense-report-theme"

function systemTheme(): ThemeMode {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark"
  }
  return "light"
}

function storedTheme(): ThemeMode | null {
  if (typeof window === "undefined") {
    return null
  }
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === "dark" || value === "light" ? value : null
  } catch {
    return null
  }
}

function initialThemeState(): ThemeState {
  const stored = storedTheme()
  return {
    theme: stored ?? systemTheme(),
    hasOverride: stored !== null,
  }
}

function applyTheme(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return
  }
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

function persistTheme(theme: ThemeMode) {
  if (typeof window === "undefined") {
    return
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Ignore storage failures so the report remains usable in restricted browser contexts.
  }
}

function useExpenseReportTheme() {
  const [{ theme, hasOverride }, setThemeState] = useState<ThemeState>(initialThemeState)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    if (typeof window === "undefined" || hasOverride) {
      return undefined
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      setThemeState({ theme: media.matches ? "dark" : "light", hasOverride: false })
    }

    handleChange()
    if (media.addEventListener) {
      media.addEventListener("change", handleChange)
      return () => media.removeEventListener("change", handleChange)
    }

    media.addListener(handleChange)
    return () => media.removeListener(handleChange)
  }, [hasOverride])

  const toggleTheme = () => {
    setThemeState((current) => {
      const nextTheme: ThemeMode = current.theme === "dark" ? "light" : "dark"
      persistTheme(nextTheme)
      return { theme: nextTheme, hasOverride: true }
    })
  }

  return { theme, toggleTheme }
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

type ChartPanel = {
  id: string
  title: string
  content: ReactNode
  headerControl?: ReactNode
}

type CalendarFilter = "all" | "subscription"

const CHART_CAROUSEL_GAP = 16

type ChartTouchState = {
  startX: number
  startY: number
  deltaX: number
  deltaY: number
  dragging: boolean
}

type ReportView = {
  metrics: {
    totalExpenses: number
    monthlyIncome: number
    incomeAfterExpenses: number
  }
  breakdown: BreakdownItem[]
  burnRate: BurnRate | null
  calendarEvents: CalendarEvent[]
  utilityHistory: UtilityHistoryItem[]
}

function buildReportView(report: ExpenseReportData, projected: boolean): ReportView {
  const breakdown = projected ? projectedBreakdown(report) : report.breakdown
  const monthlyIncome = projected ? report.incomeProjection.projectedAmount : report.incomeProjection.currentAmount
  const totalExpenses = projected ? projectedOutflowTotal(report, breakdown) : report.metrics.totalExpenses
  return {
    metrics: {
      totalExpenses,
      monthlyIncome,
      incomeAfterExpenses: roundCurrency(monthlyIncome - totalExpenses),
    },
    breakdown,
    burnRate: projected ? projectedBurnRateFromIncome(report.burnRate, monthlyIncome) : report.burnRate,
    calendarEvents: calendarEventsForMode(report.calendarEvents),
    utilityHistory: report.utilityHistory,
  }
}

function projectedBreakdown(report: ExpenseReportData) {
  const subscriptionTotals = projectedSubscriptionTotals(report)
  const billTotals = projectedBillTotals(report)
  const rows = report.breakdown.map((item) => {
    let amount = item.amount
    if (item.key === "static_bills_subscriptions_needs") {
      amount = subscriptionTotals.needs || amount
    } else if (item.key === "subscriptions_wants") {
      amount = subscriptionTotals.wants || amount
    } else if (item.key === "rent") {
      amount = billTotals.rent || amount
    } else if (item.key === "bills_utilities") {
      amount = billTotals.billsUtilities || amount
    }
    return { ...item, amount: roundCurrency(amount) }
  })
  const total = amountRowsTotal(rows)
  return rows.map((item) => ({
    ...item,
    percentage: total ? roundCurrency((item.amount / total) * 100) : 0,
  }))
}

function projectedOutflowTotal(report: ExpenseReportData, breakdown: BreakdownItem[]) {
  return roundCurrency(amountRowsTotal(breakdown) + (report.metrics.amountSaved ?? 0))
}

function projectedSubscriptionTotals(report: ExpenseReportData) {
  const totalFor = (items: SubscriptionItem[]) => items.reduce((sum, item) => sum + item.amount, 0)
  return {
    needs: roundCurrency(totalFor(report.subscriptionsNeeds)),
    wants: roundCurrency(totalFor(report.subscriptionsWants)),
  }
}

function projectedBillTotals(report: ExpenseReportData) {
  const billsUtilities = roundCurrency(
    report.utilityHistory.reduce((sum, item) => sum + item.currentAmount, 0),
  )
  const rent = report.calendarEvents
    .filter((item) => item.kind === "bill" && item.group === "rent")
    .reduce((sum, item) => sum + item.amount, 0)
  return {
    rent: roundCurrency(rent),
    billsUtilities,
  }
}

function projectedBurnRateFromIncome(burnRate: BurnRate | null, monthlyIncome: number) {
  if (!burnRate) {
    return null
  }
  const budget = roundCurrency(monthlyIncome * 0.3)
  const spent = roundCurrency(burnRate.spent)
  const daysInMonth = burnRate.daysInMonth
  const elapsedDays = burnRate.elapsedDays
  const expectedSpend = roundCurrency(daysInMonth ? budget * (elapsedDays / daysInMonth) : 0)
  const allowedDailyAverage = roundCurrency(daysInMonth ? budget / daysInMonth : 0)
  const actualDailyAverage = roundCurrency(elapsedDays ? spent / elapsedDays : 0)
  const dailyDifference = roundCurrency(actualDailyAverage - allowedDailyAverage)
  const totalDifference = roundCurrency(spent - expectedSpend)
  const status: BurnRate["status"] = elapsedDays === 0 ? "not_started" : totalDifference > 0 ? "over" : "under"
  const series = burnRate.series.map((point) => {
    const pointExpectedSpend = roundCurrency(daysInMonth ? budget * (point.day / daysInMonth) : 0)
    const actualSpend = point.actualSpend
    return {
      ...point,
      expectedSpend: pointExpectedSpend,
      variance: actualSpend === null || actualSpend === undefined ? null : roundCurrency(actualSpend - pointExpectedSpend),
    }
  })

  return {
    ...burnRate,
    budget,
    spent,
    remaining: roundCurrency(budget - spent),
    expectedSpend,
    allowedDailyAverage,
    actualDailyAverage,
    dailyDifference,
    totalDifference,
    status,
    series,
  }
}

function calendarEventsForMode(events: CalendarEvent[]) {
  return events
}

function roundCurrency(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function ExpenseReportApp({ report }: { report: ExpenseReportData }) {
  const { theme, toggleTheme } = useExpenseReportTheme()
  const [projectionActive, setProjectionActive] = useState(false)
  const [calendarFilter, setCalendarFilter] = useState<CalendarFilter>("all")
  const [chartTouch, setChartTouch] = useState<ChartTouchState | null>(null)
  const [chartCollapseKey, setChartCollapseKey] = useState(0)
  const activeReport = buildReportView(report, projectionActive)
  const categoryColors: Record<string, string> = Object.fromEntries(activeReport.breakdown.map((item) => [item.label, item.color]))
  const defaultChartTab = report.burnRate ? "burn-rate" : "category"
  const chartPanels: ChartPanel[] = [
    {
      id: "category",
      title: "Category Mix",
      content: <CategoryMixChart data={activeReport.breakdown} total={amountRowsTotal(activeReport.breakdown)} collapseKey={chartCollapseKey} />,
    },
    ...(activeReport.burnRate
      ? [
          {
            id: "burn-rate",
            title: "Burn Rate",
            content: <BurnRateChart burnRate={activeReport.burnRate} />,
          },
        ]
      : []),
    {
      id: "calendar",
      title: "Calendar",
      headerControl: <CalendarFilterControl filter={calendarFilter} onFilterChange={setCalendarFilter} />,
      content: (
        <CalendarAnalyticsPanel
          year={report.year}
          month={report.month}
          monthLabel={report.monthLabel}
          elapsedDays={report.elapsedDays}
          events={activeReport.calendarEvents}
          filter={calendarFilter}
          projected={projectionActive}
          needs={report.subscriptionsNeeds}
          wants={report.subscriptionsWants}
          collapseKey={chartCollapseKey}
        />
      ),
    },
    {
      id: "bills",
      title: "Bills & Utilities",
      content: <BillsUtilitiesPanel items={activeReport.utilityHistory} collapseKey={chartCollapseKey} />,
    },
  ]
  const defaultChartIndex = Math.max(0, chartPanels.findIndex((panel) => panel.id === defaultChartTab))
  const [activeChartIndex, setActiveChartIndex] = useState(defaultChartIndex)
  const savingsGoal = report.incomeProjection.savingsGoal

  useEffect(() => {
    setActiveChartIndex((current) => Math.min(current, chartPanels.length - 1))
  }, [chartPanels.length])

  const switchChart = (nextIndex: number) => {
    const next = clamp(nextIndex, 0, chartPanels.length - 1)
    if (next === activeChartIndex) {
      return
    }
    setChartCollapseKey((current) => current + 1)
    setActiveChartIndex(next)
  }

  const moveChart = (direction: -1 | 1) => {
    switchChart(activeChartIndex + direction)
  }

  const handleChartTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (isInteractiveTouchTarget(event.target)) {
      return
    }
    const touch = event.touches[0]
    if (!touch) {
      return
    }
    setChartTouch({ startX: touch.clientX, startY: touch.clientY, deltaX: 0, deltaY: 0, dragging: false })
  }

  const handleChartTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (!touch || chartTouch === null) {
      return
    }
    const deltaX = touch.clientX - chartTouch.startX
    const deltaY = touch.clientY - chartTouch.startY
    const dragging = Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2
    setChartTouch({ ...chartTouch, deltaX, deltaY, dragging })
  }

  const handleChartTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (chartTouch === null) {
      return
    }
    const endX = event.changedTouches[0]?.clientX
    const endY = event.changedTouches[0]?.clientY
    const touch = chartTouch
    setChartTouch(null)
    if (endX === undefined) {
      return
    }
    const deltaX = endX - touch.startX
    const deltaY = endY === undefined ? touch.deltaY : endY - touch.startY
    const threshold = Math.min(120, Math.max(68, window.innerWidth * 0.22))
    if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) {
      return
    }
    if ((deltaX < 0 && activeChartIndex >= chartPanels.length - 1) || (deltaX > 0 && activeChartIndex <= 0)) {
      return
    }
    moveChart(deltaX < 0 ? 1 : -1)
  }
  const edgeDragFactor =
    (activeChartIndex === 0 && (chartTouch?.deltaX ?? 0) > 0) ||
    (activeChartIndex === chartPanels.length - 1 && (chartTouch?.deltaX ?? 0) < 0)
      ? 0.25
      : 1
  const swipeOffset = chartTouch?.dragging ? clamp(chartTouch.deltaX * edgeDragFactor, -220, 220) : 0
  const carouselTransform = `translate3d(calc(${-activeChartIndex * 100}% - ${activeChartIndex * CHART_CAROUSEL_GAP}px + ${swipeOffset}px), 0, 0)`

  return (
    <div className="bb-page">
      <header className="bb-page-header">
        <div>
          <h1>Expense Breakdown</h1>
          <p>{report.monthLabel} budget report for {report.ownerName}.</p>
        </div>
        <div className="bb-header-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <Badge variant="outline">Generated {generatedTimeLabel(report.generatedAt)}</Badge>
        </div>
      </header>

      <main className="bb-main">
        <section className="bb-metrics-grid" aria-label="Budget metrics">
          <MetricCard
            label="Income"
            value={activeReport.metrics.monthlyIncome}
            description={projectionActive ? "Projected month" : "Logged income"}
            control={
              <ProjectionToggle
                active={projectionActive}
                onToggle={() => setProjectionActive((current) => !current)}
              />
            }
          />
          <MetricCard label="Spent" value={activeReport.metrics.totalExpenses} />
          <MetricCard label="Left" value={activeReport.metrics.incomeAfterExpenses} description="After expenses" accent />
          <MetricCard
            label="Saved"
            value={report.metrics.amountSaved}
            description={savingsGoal > 0 ? `Goal ${formatMoney(savingsGoal)}` : undefined}
            accent={isSavingsNearGoal(report.metrics.amountSaved, savingsGoal)}
          />
        </section>

        <div
          className="bb-chart-carousel"
          data-dragging={chartTouch?.dragging ? "true" : "false"}
          onTouchStart={handleChartTouchStart}
          onTouchMove={handleChartTouchMove}
          onTouchEnd={handleChartTouchEnd}
        >
          <div
            className={chartTouch?.dragging ? "bb-chart-carousel-track bb-chart-carousel-track-dragging" : "bb-chart-carousel-track"}
            style={{ transform: carouselTransform }}
          >
            {chartPanels.map((panel, index) => (
              <div className="bb-chart-carousel-slide" key={panel.id} aria-hidden={index !== activeChartIndex}>
                <Card className="bb-analytics-card">
                  <CardHeader className="bb-analytics-header">
                    <div className="bb-card-title-row bb-analytics-title-row">
                      <CardTitle>{panel.title}</CardTitle>
                      <div className="bb-analytics-header-controls">
                        {panel.headerControl}
                        <ChartCarouselButtons
                          onPrevious={() => moveChart(-1)}
                          onNext={() => moveChart(1)}
                          canPrevious={activeChartIndex > 0}
                          canNext={activeChartIndex < chartPanels.length - 1}
                        />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>{panel.content}</CardContent>
                </Card>
              </div>
            ))}
          </div>
        </div>
        <ChartCarouselIndicators panels={chartPanels} activeIndex={activeChartIndex} onSelect={switchChart} />

        <Card>
          <CardHeader>
            <CardTitle>Daily Spending</CardTitle>
          </CardHeader>
          <CardContent className="bb-daily-spending-content">
            <DailySpendingChart data={report.dailyTotals} total={amountRowsTotal(report.dailyTotals)} elapsedDays={report.elapsedDays} />
            <DailyEntriesTable entries={report.dailyEntries} categoryColors={categoryColors} />
          </CardContent>
        </Card>

        <ExpenseInsightsCard topEntries={report.topEntries} merchantOccurrences={report.merchantOccurrences} />

      </main>
    </div>
  )
}

function isInteractiveTouchTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, summary, [role='button'], [role='tab']"))
}

function ChartCarouselButtons({
  onPrevious,
  onNext,
  canPrevious,
  canNext,
}: {
  onPrevious: () => void
  onNext: () => void
  canPrevious: boolean
  canNext: boolean
}) {
  return (
    <div className="bb-chart-carousel-controls" aria-label="Budget chart navigation">
      <button type="button" className="bb-chart-carousel-button" aria-label="Previous chart" onClick={onPrevious} disabled={!canPrevious}>
        {"<"}
      </button>
      <button type="button" className="bb-chart-carousel-button" aria-label="Next chart" onClick={onNext} disabled={!canNext}>
        {">"}
      </button>
    </div>
  )
}

function ChartCarouselIndicators({
  panels,
  activeIndex,
  onSelect,
}: {
  panels: ChartPanel[]
  activeIndex: number
  onSelect: (index: number) => void
}) {
  return (
    <div className="bb-chart-carousel-indicators" aria-label="Budget chart position">
      {panels.map((panel, index) => (
        <button
          type="button"
          key={panel.id}
          className="bb-chart-carousel-dot"
          data-state={index === activeIndex ? "active" : "inactive"}
          aria-label={`Show ${panel.title}`}
          onClick={() => onSelect(index)}
        />
      ))}
    </div>
  )
}

function ProjectionToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="bb-metric-toggle"
      aria-pressed={active}
      aria-label="Toggle projected month view"
      title="Toggle projected month view"
      onClick={onToggle}
    >
      Proj
    </button>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
  const isDark = theme === "dark"
  return (
    <button type="button" className="bb-theme-toggle" aria-pressed={isDark} aria-label={`Turn dark mode ${isDark ? "off" : "on"}`} onClick={onToggle}>
      <span className="bb-theme-toggle-track" aria-hidden="true">
        <span className="bb-theme-toggle-thumb" />
      </span>
      <span className="bb-theme-toggle-label">Dark mode</span>
    </button>
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
    <div className="bb-chart-stack">
      <div className="bb-panel-head bb-burn-rate-summary">
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
      <ChartContainer
        config={{ variance: { label: "Variance", color: lineColor } }}
        className="bb-chart-box bb-chart-box-wide"
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
      <DetailsPanel summary="Details">
        <StatList
          rows={[
            ["Wants target", formatMoney(burnRate.budget)],
            ["Food + shopping", formatMoney(burnRate.spent)],
            ["Wants left", formatMoney(burnRate.remaining)],
            ["Allowed/day", formatMoney(burnRate.allowedDailyAverage)],
            ["Actual/day", formatMoney(burnRate.actualDailyAverage)],
          ]}
        />
      </DetailsPanel>
    </div>
  )
}

function amountRowsTotal(rows: AmountRow[]) {
  return rows.reduce((sum, row) => sum + row.amount, 0)
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

function MetricCard({
  label,
  value,
  description,
  accent = false,
  control,
}: {
  label: string
  value: number | null | undefined
  description?: string
  accent?: boolean
  control?: ReactNode
}) {
  const positive = accent && value !== null && value !== undefined && value >= 0
  const negative = value !== null && value !== undefined && value < 0
  return (
    <Card>
      <CardContent className="bb-metric-card">
        <div className="bb-metric-head">
          <div className="bb-metric-label">{label}</div>
          {control}
        </div>
        <div className={negative ? "bb-metric-value bb-negative" : positive ? "bb-metric-value bb-positive" : "bb-metric-value"}>
          {formatMoney(value)}
        </div>
        {description ? <div className="bb-metric-note">{description}</div> : null}
      </CardContent>
    </Card>
  )
}

function isSavingsNearGoal(value: number | null | undefined, goal: number | null | undefined) {
  if (value === null || value === undefined || goal === null || goal === undefined || goal <= 0) {
    return false
  }
  return value >= goal * 0.9
}

function CategoryMixChart({ data, total, collapseKey }: { data: BreakdownItem[]; total: number; collapseKey: number }) {
  const pieLayout = useExpensePieLayout()

  return (
    <div className="bb-chart-stack">
      <div className="bb-panel-head">
        <div>
          <div className="bb-chart-kicker">Category Mix</div>
          <div className="bb-chart-total">{formatMoney(total)}</div>
        </div>
      </div>
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
          <DetailsPanel summary="Categories" collapseKey={collapseKey}>
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
          </DetailsPanel>
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
        <DetailsPanel summary="Details">
          <StatList
            rows={[
              ["Tracked days", String(data.length)],
              ["Avg/day", formatMoney(averageDaySpend)],
              ["Days counted", String(elapsedDays)],
              ["Highest day", peak ? `${peak.label} - ${formatMoney(peak.amount)}` : "N/A"],
            ]}
          />
        </DetailsPanel>
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
          <YAxis dataKey="label" type="category" width={148} tickFormatter={(value) => truncateChartLabel(value, 22)} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="amount" name="Expense amount" fill="hsl(var(--chart-2))" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

function truncateChartLabel(value: unknown, maxLength: number) {
  const text = String(value ?? "")
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(maxLength - 3, 0))}...`
}

function MerchantChart({ data }: { data: OccurrenceRow[] }) {
  const rows = data.slice(0, 10)
  return (
    <ChartContainer config={{ count: { label: "Occurrences", color: "hsl(var(--chart-4))" } }} className="bb-insight-chart-box">
      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 22, left: 20, bottom: 12 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickFormatter={(value) => String(value)} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis dataKey="label" type="category" width={148} tickLine={false} axisLine={false} />
          <ChartTooltip content={<MerchantTooltipContent />} />
          <Bar dataKey="count" name="Occurrences" fill="hsl(var(--chart-4))" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

function MerchantTooltipContent({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload?: OccurrenceRow }>
}) {
  const row = payload?.find((item) => item.payload)?.payload
  if (!active || !row) {
    return null
  }
  return (
    <div className="bb-chart-tooltip">
      <div className="bb-chart-tooltip-title">{row.label}</div>
      <div className="bb-chart-tooltip-row">
        <span className="bb-chart-tooltip-dot" style={{ background: "hsl(var(--chart-4))" }} />
        <span>Occurrences</span>
        <strong>{row.count}</strong>
      </div>
      <div className="bb-chart-tooltip-row">
        <span />
        <span>Total</span>
        <strong>{formatMoney(row.amount)}</strong>
      </div>
    </div>
  )
}

function ExpenseInsightsCard({ topEntries, merchantOccurrences }: { topEntries: ExpenseEntry[]; merchantOccurrences: OccurrenceRow[] }) {
  return (
    <Card>
      <Tabs defaultValue="largest" className="bb-card-tabs">
        <CardHeader>
          <div className="bb-card-title-row bb-inline-toggle-row">
            <CardTitle>Expense Highlights</CardTitle>
            <TabsList>
              <TabsTrigger value="largest">Largest</TabsTrigger>
              <TabsTrigger value="merchants">Most Frequent</TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <CardContent className="bb-expense-insights-content">
          <TabsContent value="largest">
            <div className="bb-insight-panel">
              <TopExpensesChart entries={topEntries} />
              <HiddenListPanel total={topEntries.length}>
                <TopExpensesTable entries={topEntries} />
              </HiddenListPanel>
            </div>
          </TabsContent>
          <TabsContent value="merchants">
            <div className="bb-insight-panel">
              <MerchantChart data={merchantOccurrences} />
              <HiddenListPanel total={merchantOccurrences.length}>
                <MerchantOccurrencesTable rows={merchantOccurrences} />
              </HiddenListPanel>
            </div>
          </TabsContent>
        </CardContent>
      </Tabs>
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

function DetailsPanel({ summary, children, collapseKey = 0 }: { summary: string; children: ReactNode; collapseKey?: number }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setOpen(false)
  }, [collapseKey])

  return (
    <details className="bb-details-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  )
}

function ExpandRowsButton({
  expanded,
  total,
  onToggle,
}: {
  expanded: boolean
  total: number
  onToggle: () => void
}) {
  return (
    <button type="button" className="bb-expand-toggle" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "Collapse" : `View all ${total}`}
    </button>
  )
}

function HiddenListPanel({ children, total }: { children: ReactNode; total: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="bb-hidden-list-panel">
      {expanded ? children : null}
      <ExpandRowsButton expanded={expanded} total={total} onToggle={() => setExpanded((current) => !current)} />
    </div>
  )
}

function AmountTable({ columns, rows, limit }: { columns: [string, string]; rows: AmountRow[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (!rows.length) {
    return <div className="bb-empty">No data found.</div>
  }
  const visibleRows = limit && !expanded ? rows.slice(0, limit) : rows

  return (
    <>
      <AmountRowsTable columns={columns} rows={visibleRows} />
      {limit !== undefined && rows.length > limit ? (
        <ExpandRowsButton expanded={expanded} total={rows.length} onToggle={() => setExpanded((current) => !current)} />
      ) : null}
    </>
  )
}

function AmountRowsTable({ columns, rows, hideHeader = false }: { columns: [string, string]; rows: AmountRow[]; hideHeader?: boolean }) {
  return (
    <div className="bb-table-wrap">
      <table>
        {hideHeader ? null : (
          <thead>
            <tr>
              <th>{columns[0]}</th>
              <th>{columns[1]}</th>
            </tr>
          </thead>
        )}
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

  return <TopExpensesRowsTable entries={entries} />
}

function TopExpensesRowsTable({ entries, hideHeader = false }: { entries: ExpenseEntry[]; hideHeader?: boolean }) {
  return (
    <div className="bb-table-wrap">
      <table>
        {hideHeader ? null : (
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>Amount</th>
            </tr>
          </thead>
        )}
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

function MerchantOccurrencesTable({ rows }: { rows: OccurrenceRow[] }) {
  if (!rows.length) {
    return <div className="bb-empty">No merchant activity found.</div>
  }

  return (
    <div className="bb-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>Count</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.count}</td>
              <td className="bb-amount">{formatMoney(row.amount)}</td>
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

const CALENDAR_FILTERS: Array<{ value: CalendarFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "subscription", label: "Subs" },
]

const CALENDAR_EVENT_STYLES: Record<CalendarEventKind, { label: string; color: string; background: string }> = {
  subscription: {
    label: "Sub",
    color: "#7c3aed",
    background: "rgb(124 58 237 / 0.1)",
  },
  bill: {
    label: "Bill",
    color: "#ea580c",
    background: "rgb(234 88 12 / 0.1)",
  },
  income: {
    label: "Income",
    color: "#16a34a",
    background: "rgb(22 163 74 / 0.1)",
  },
}

function CalendarFilterControl({
  filter,
  onFilterChange,
}: {
  filter: CalendarFilter
  onFilterChange: (filter: CalendarFilter) => void
}) {
  return (
    <div className="bb-tabs-list bb-subscription-tone-control" role="tablist" aria-label="Calendar view">
      {CALENDAR_FILTERS.map((item) => (
        <button
          type="button"
          key={item.value}
          className="bb-tabs-trigger"
          data-state={filter === item.value ? "active" : "inactive"}
          role="tab"
          aria-selected={filter === item.value}
          onClick={() => onFilterChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function CalendarAnalyticsPanel({
  year,
  month,
  monthLabel,
  elapsedDays,
  events,
  filter,
  projected,
  needs,
  wants,
  collapseKey,
}: {
  year: number
  month: number
  monthLabel: string
  elapsedDays: number
  events: CalendarEvent[]
  filter: CalendarFilter
  projected: boolean
  needs: SubscriptionItem[]
  wants: SubscriptionItem[]
  collapseKey: number
}) {
  const visibleEvents = filter === "all" ? events : events.filter((item) => item.kind === filter)
  const totalEvents = projected ? visibleEvents : visibleEvents.filter((item) => !item.projectedOnly)
  const outflowTotal = totalEvents
    .filter((item) => item.kind !== "income")
    .reduce((sum, item) => sum + item.amount, 0)
  const subscriptionItems = [...needs, ...wants]

  return (
    <div className="bb-subscription-analytics">
      <div className="bb-subscription-tab-content" data-state="active" key={filter}>
        <div className="bb-subscription-panel">
          <div className="bb-panel-head bb-subscription-summary">
            <div>
              <div className="bb-chart-kicker">{monthOnlyLabel(monthLabel)}</div>
              <div className="bb-subscription-total">{formatMoney(outflowTotal)}</div>
            </div>
            <Badge variant="secondary">{visibleEvents.length} total</Badge>
          </div>
          <FinancialCalendar year={year} month={month} elapsedDays={elapsedDays} events={visibleEvents} />
          {subscriptionItems.length ? (
            <DetailsPanel summary="Sub details" collapseKey={collapseKey}>
              <SubscriptionAllItemsGrid items={subscriptionItems} />
            </DetailsPanel>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function FinancialCalendar({
  year,
  month,
  elapsedDays,
  events,
}: {
  year: number
  month: number
  elapsedDays: number
  events: CalendarEvent[]
}) {
  const daysInMonth = new Date(year, month, 0).getDate()
  const leadingBlankDays = new Date(year, month - 1, 1).getDay()
  const cellCount = Math.ceil((leadingBlankDays + daysInMonth) / 7) * 7
  const days = Array.from({ length: cellCount }, (_, index) => {
    const day = index - leadingBlankDays + 1
    return day >= 1 && day <= daysInMonth ? day : null
  })
  const eventsByDay = calendarEventsByDay(events)

  return (
    <div className="bb-subscription-calendar" aria-label="Cashflow calendar">
      <div className="bb-calendar-head" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="bb-calendar-grid">
        {days.map((day, index) => {
          const dayEvents = day === null ? [] : eventsByDay.get(day) ?? []
          const visibleEvents = dayEvents.slice(0, 3)
          const hiddenCount = Math.max(dayEvents.length - visibleEvents.length, 0)
          const isToday = day !== null && isCurrentCalendarDay(year, month, day)
          const hasHit = day !== null && day <= elapsedDays
          return (
            <div
              key={`${day ?? "blank"}-${index}`}
              className={[
                "bb-calendar-day",
                day === null ? "bb-calendar-day-muted" : "",
                dayEvents.length ? "bb-calendar-day-has-items" : "",
                isToday ? "bb-calendar-day-today" : "",
              ].filter(Boolean).join(" ")}
              aria-hidden={day === null}
            >
              {day === null ? null : (
                <>
                  <div className="bb-calendar-day-number">{day}</div>
                  <div className="bb-calendar-marker-stack">
                    {visibleEvents.map((item, itemIndex) => {
                      const style = calendarEventStyle(item)
                      return (
                        <button
                          type="button"
                          key={`${item.kind}-${item.label}-${item.amount}-${itemIndex}`}
                          className={[
                            "bb-subscription-marker",
                            hasHit && !item.projectedOnly ? "" : "bb-subscription-marker-pending",
                          ].filter(Boolean).join(" ")}
                          style={{
                            color: style.color,
                            backgroundColor: style.background,
                            borderColor: style.color,
                          }}
                          aria-label={calendarEventLabel(item)}
                        >
                          <span className="bb-subscription-marker-dot" />
                          <span className="bb-subscription-marker-name">{item.label}</span>
                          <span className="bb-subscription-marker-amount">{formatMoney(item.amount)}</span>
                          <CalendarEventTooltip event={item} />
                        </button>
                      )
                    })}
                    {hiddenCount ? (
                      <button
                        type="button"
                        className={[
                          "bb-subscription-marker",
                          "bb-subscription-marker-more",
                          hasHit ? "" : "bb-subscription-marker-pending",
                        ].filter(Boolean).join(" ")}
                        aria-label={`${hiddenCount} more event${hiddenCount === 1 ? "" : "s"} on day ${day}`}
                      >
                        +{hiddenCount} more
                        <CalendarOverflowTooltip events={dayEvents.slice(visibleEvents.length)} day={day} />
                      </button>
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

function calendarEventsByDay(events: CalendarEvent[]) {
  const grouped = new Map<number, CalendarEvent[]>()
  for (const event of events) {
    grouped.set(event.day, [...(grouped.get(event.day) ?? []), event])
  }
  return grouped
}

function calendarEventStyle(event: CalendarEvent) {
  if (event.group === "static_bills_subscriptions_needs") {
    return { ...CALENDAR_EVENT_STYLES.subscription, color: "#2563eb", background: "rgb(37 99 235 / 0.1)" }
  }
  if (event.group === "subscriptions_wants") {
    return { ...CALENDAR_EVENT_STYLES.subscription, color: "#7c3aed", background: "rgb(124 58 237 / 0.1)" }
  }
  if (event.group === "rent") {
    return { ...CALENDAR_EVENT_STYLES.bill, color: "#dc2626", background: "rgb(220 38 38 / 0.1)" }
  }
  return CALENDAR_EVENT_STYLES[event.kind]
}

function calendarEventLabel(event: CalendarEvent) {
  return `${event.label} - ${calendarEventKindLabel(event)} - ${formatMoney(event.amount)}`
}

function CalendarEventTooltip({ event }: { event: CalendarEvent }) {
  return (
    <span className="bb-subscription-tooltip" role="tooltip">
      <strong>{event.label}</strong>
      <span>{calendarEventKindLabel(event)}</span>
      <span className="bb-subscription-tooltip-amount">{formatMoney(event.amount)}</span>
    </span>
  )
}

function CalendarOverflowTooltip({ events, day }: { events: CalendarEvent[]; day: number }) {
  return (
    <span className="bb-subscription-tooltip bb-subscription-tooltip-wide" role="tooltip">
      <strong>More on day {day}</strong>
      {events.map((event, index) => (
        <span key={`${event.kind}-${event.label}-${event.amount}-${index}`}>
          {event.label} - {calendarEventKindLabel(event)} - {formatMoney(event.amount)}
        </span>
      ))}
    </span>
  )
}

function calendarEventKindLabel(event: CalendarEvent) {
  if (event.kind === "subscription") {
    return event.group === "subscriptions_wants" ? "Want sub" : "Need sub"
  }
  return CALENDAR_EVENT_STYLES[event.kind].label
}

function BillsUtilitiesPanel({ items, collapseKey }: { items: UtilityHistoryItem[]; collapseKey: number }) {
  const currentTotal = items.reduce((sum, item) => sum + item.currentAmount, 0)

  return (
    <div className="bb-bills-analytics">
      <div className="bb-panel-head bb-bills-analytics-head">
        <div>
          <div className="bb-chart-kicker">Bills & Utilities</div>
          <div className="bb-chart-total">{formatMoney(currentTotal)}</div>
        </div>
        <Badge variant="secondary">{items.length} tracked</Badge>
      </div>
      {!items.length ? (
        <div className="bb-empty">No bill history found.</div>
      ) : (
        <>
          <BillsUtilitiesChart items={items} />
          <DetailsPanel summary="Bill details" collapseKey={collapseKey}>
            <BillsUtilitiesSummary items={items} />
          </DetailsPanel>
        </>
      )}
    </div>
  )
}

function BillsUtilitiesChart({ items }: { items: UtilityHistoryItem[] }) {
  const rows = utilityHistoryChartRows(items)

  return (
    <ChartContainer config={utilityHistoryChartConfig(items)} className="bb-bills-chart-box">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 12, right: 20, left: 0, bottom: 6 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={54} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {items.map((item, index) => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={chartColor(index)}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

function utilityHistoryChartRows(items: UtilityHistoryItem[]) {
  const rowsByMonth = new Map<number, Record<string, string | number>>()
  for (const item of items) {
    for (const point of item.history) {
      const row = rowsByMonth.get(point.month) ?? { label: point.label, month: point.month }
      row[item.key] = point.amount
      rowsByMonth.set(point.month, row)
    }
  }
  return Array.from(rowsByMonth.entries())
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row)
}

function utilityHistoryChartConfig(items: UtilityHistoryItem[]) {
  return Object.fromEntries(
    items.map((item, index) => [item.key, { label: item.label, color: chartColor(index) }]),
  )
}

function chartColor(index: number) {
  return `hsl(var(--chart-${(index % 5) + 1}))`
}

function BillsUtilitiesSummary({ items }: { items: UtilityHistoryItem[] }) {
  return (
    <div className="bb-bill-history-list">
      {items.map((item) => {
        const hasAverage = item.averageAmount > 0
        const deltaClass = hasAverage && item.deltaAmount > 0 ? "bb-negative" : hasAverage && item.deltaAmount < 0 ? "bb-positive" : ""
        return (
          <div className="bb-bill-history-row" key={item.key}>
            <span>
              <strong>{item.label}</strong>
              <small>{hasAverage ? `Avg ${formatMoney(item.averageAmount)}` : "No prior average"}</small>
            </span>
            <span>
              <strong>{formatMoney(item.currentAmount)}</strong>
              <small className={deltaClass}>{hasAverage ? `${item.deltaAmount >= 0 ? "+" : ""}${formatMoney(item.deltaAmount)} vs avg` : "Current"}</small>
            </span>
          </div>
        )
      })}
    </div>
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

function SubscriptionAnalyticsPanel({
  year,
  month,
  monthLabel,
  elapsedDays,
  needs,
  wants,
  tone,
}: {
  year: number
  month: number
  monthLabel: string
  elapsedDays: number
  needs: SubscriptionItem[]
  wants: SubscriptionItem[]
  tone: SubscriptionTone
}) {
  const allSubscriptions = [...needs, ...wants]
  const items = tone === "needs" ? needs : tone === "wants" ? wants : allSubscriptions

  return (
    <div className="bb-subscription-analytics">
      <div className="bb-subscription-tab-content" data-state="active" key={tone}>
        <SubscriptionPanel year={year} month={month} monthLabel={monthLabel} elapsedDays={elapsedDays} items={items} tone={tone} />
      </div>
    </div>
  )
}

function SubscriptionToneControl({
  tone,
  onToneChange,
}: {
  tone: SubscriptionTone
  onToneChange: (tone: SubscriptionTone) => void
}) {
  return (
    <div className="bb-tabs-list bb-subscription-tone-control" role="tablist" aria-label="Subscription view">
      {(Object.keys(SUBSCRIPTION_TONES) as SubscriptionTone[]).map((value) => (
        <button
          type="button"
          key={value}
          className="bb-tabs-trigger"
          data-state={tone === value ? "active" : "inactive"}
          role="tab"
          aria-selected={tone === value}
          onClick={() => onToneChange(value)}
        >
          {SUBSCRIPTION_TONES[value].label}
        </button>
      ))}
    </div>
  )
}

function SubscriptionPanel({
  year,
  month,
  monthLabel,
  elapsedDays,
  items,
  tone,
}: {
  year: number
  month: number
  monthLabel: string
  elapsedDays: number
  items: SubscriptionItem[]
  tone: SubscriptionTone
}) {
  const scheduledItems = items
    .map((item) => ({ item, day: subscriptionDayInMonth(item, year, month) }))
    .filter((entry): entry is { item: SubscriptionItem; day: number } => entry.day !== null)
  const projectedTotal = scheduledItems.reduce((sum, entry) => sum + entry.item.amount, 0)
  const hitItems = scheduledItems.filter((entry) => entry.day <= elapsedDays)
  const hitTotal = hitItems.reduce((sum, entry) => sum + entry.item.amount, 0)
  const monthName = monthOnlyLabel(monthLabel)
  const toneConfig = SUBSCRIPTION_TONES[tone]

  return (
    <div className="bb-subscription-panel">
      <div className="bb-panel-head bb-subscription-summary">
        <div>
          <div className="bb-chart-kicker">{monthName}</div>
          <div className="bb-subscription-total" style={{ color: toneConfig.color }}>
            {formatMoney(hitTotal)}
          </div>
          <div className="bb-subscription-projected">Projected {formatMoney(projectedTotal)}</div>
        </div>
        <Badge variant="secondary">{scheduledItems.length} total</Badge>
      </div>
      <SubscriptionCalendar year={year} month={month} elapsedDays={elapsedDays} items={items} tone={tone} />
      <DetailsPanel summary="Details">
        {tone === "all" ? <SubscriptionAllItemsGrid items={items} /> : <SubscriptionItemsTable items={items} />}
      </DetailsPanel>
    </div>
  )
}

function SubscriptionCalendar({
  year,
  month,
  elapsedDays,
  items,
  tone,
}: {
  year: number
  month: number
  elapsedDays: number
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
    <div className="bb-subscription-calendar" aria-label={`${toneConfig.label} subs calendar`}>
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
          const isToday = day !== null && isCurrentCalendarDay(year, month, day)
          const hasHit = day !== null && day <= elapsedDays
          return (
            <div
              key={`${day ?? "blank"}-${index}`}
              className={[
                "bb-calendar-day",
                day === null ? "bb-calendar-day-muted" : "",
                dayItems.length ? "bb-calendar-day-has-items" : "",
                isToday ? "bb-calendar-day-today" : "",
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
                          className={[
                            "bb-subscription-marker",
                            hasHit ? "" : "bb-subscription-marker-pending",
                          ].filter(Boolean).join(" ")}
                          style={{
                            color: markerToneConfig.color,
                            backgroundColor: markerToneConfig.background,
                            borderColor: markerToneConfig.color,
                          }}
                          aria-label={subscriptionMarkerLabel(item)}
                        >
                          <span className="bb-subscription-marker-dot" />
                          <span className="bb-subscription-marker-name">{item.name}</span>
                          <span className="bb-subscription-marker-amount">{formatMoney(item.amount)}</span>
                          <SubscriptionTooltip item={item} />
                        </button>
                      )
                    })}
                    {hiddenCount ? (
                      <button
                        type="button"
                        className={[
                          "bb-subscription-marker",
                          "bb-subscription-marker-more",
                          hasHit ? "" : "bb-subscription-marker-pending",
                        ].filter(Boolean).join(" ")}
                        style={{
                          color: toneConfig.color,
                          backgroundColor: toneConfig.background,
                          borderColor: toneConfig.color,
                        }}
                        aria-label={`${hiddenCount} more sub${hiddenCount === 1 ? "" : "s"} on day ${day}`}
                      >
                        +{hiddenCount} more
                        <SubscriptionOverflowTooltip items={dayItems.slice(visibleItems.length)} day={day} />
                      </button>
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

function SubscriptionTooltip({ item }: { item: SubscriptionItem }) {
  return (
    <span className="bb-subscription-tooltip" role="tooltip">
      <strong>{item.name}</strong>
      <span>{subscriptionPullDescription(item)}</span>
      <span className="bb-subscription-tooltip-amount">{formatMoney(item.amount)}</span>
    </span>
  )
}

function SubscriptionOverflowTooltip({ items, day }: { items: SubscriptionItem[]; day: number }) {
  return (
    <span className="bb-subscription-tooltip bb-subscription-tooltip-wide" role="tooltip">
      <strong>More on day {day}</strong>
      {items.map((item, index) => (
        <span key={`${item.name}-${item.amount}-${index}`}>
          {item.name} - {formatMoney(item.amount)}
        </span>
      ))}
    </span>
  )
}

function SubscriptionAllItemsGrid({ items }: { items: SubscriptionItem[] }) {
  const needs = items.filter((item) => subscriptionToneForItem(item) === "needs")
  const wants = items.filter((item) => subscriptionToneForItem(item) === "wants")

  return (
    <div className="bb-subscription-all-grid">
      <SubscriptionCompactTable title="Needs" items={needs} tone="needs" />
      <SubscriptionCompactTable title="Wants" items={wants} tone="wants" />
    </div>
  )
}

function SubscriptionCompactTable({
  title,
  items,
  tone,
}: {
  title: string
  items: SubscriptionItem[]
  tone: Exclude<SubscriptionTone, "all">
}) {
  const [expanded, setExpanded] = useState(false)
  const toneConfig = SUBSCRIPTION_TONES[tone]
  const total = items.reduce((sum, item) => sum + item.amount, 0)
  const visibleItems = items.slice(0, 5)
  const rows = expanded ? items : visibleItems
  const hasMore = items.length > visibleItems.length

  return (
    <section className="bb-subscription-compact-group" aria-label={`${title} subs`}>
      <div className="bb-subscription-compact-heading">
        <span style={{ color: toneConfig.color }}>{title}</span>
        <strong>{formatMoney(total)}</strong>
      </div>
      {!items.length ? (
        <div className="bb-empty">No matching subs found.</div>
      ) : (
        <>
          <SubscriptionRowsTable items={rows} compact />
          {hasMore ? <ExpandRowsButton expanded={expanded} total={items.length} onToggle={() => setExpanded((current) => !current)} /> : null}
        </>
      )}
    </section>
  )
}

function SubscriptionItemsTable({ items }: { items: SubscriptionItem[] }) {
  const [expanded, setExpanded] = useState(false)
  if (!items.length) {
    return <div className="bb-empty">No matching subs found.</div>
  }
  const visibleItems = items.slice(0, 5)
  const rows = expanded ? items : visibleItems
  const hasMore = items.length > visibleItems.length

  return (
    <>
      <SubscriptionRowsTable items={rows} />
      {hasMore ? <ExpandRowsButton expanded={expanded} total={items.length} onToggle={() => setExpanded((current) => !current)} /> : null}
    </>
  )
}

function SubscriptionRowsTable({ items, compact = false }: { items: SubscriptionItem[]; compact?: boolean }) {
  return (
    <div className="bb-table-wrap">
      <table className={compact ? "bb-subscription-compact-table" : undefined}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Cadence</th>
            <th>Pull</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.name}-${item.amount}-${index}`}>
              <td>{item.name}</td>
              <td>
                <span className="bb-cadence-full">{subscriptionCadenceLabel(item.cadence)}</span>
                <span className="bb-cadence-short">{subscriptionCadenceShortLabel(item.cadence)}</span>
              </td>
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

function subscriptionCadenceLabel(cadence: string) {
  return cadence || "-"
}

function subscriptionCadenceShortLabel(cadence: string) {
  const lowered = cadence.trim().toLowerCase()
  if (lowered.startsWith("month")) {
    return "M"
  }
  if (lowered.startsWith("year")) {
    return "Y"
  }
  return cadence ? cadence.slice(0, 1).toUpperCase() : "-"
}

function subscriptionPullDescription(item: SubscriptionItem) {
  const cadence = item.cadence ? `${item.cadence} pull` : "Pull"
  return `${item.kind || "Sub"} - ${cadence} - ${subscriptionPullLabel(item)}`
}

function subscriptionToneForItem(item: SubscriptionItem): Exclude<SubscriptionTone, "all"> {
  const kind = item.kind.trim().toLowerCase()
  return kind === "want" || kind === "wants" ? "wants" : "needs"
}

function subscriptionMarkerLabel(item: SubscriptionItem) {
  return `${item.name} - ${subscriptionPullDescription(item)} - ${formatMoney(item.amount)}`
}

function monthOnlyLabel(monthLabel: string) {
  return monthLabel.split(/\s+/)[0] || monthLabel
}

function isCurrentCalendarDay(year: number, month: number, day: number) {
  const today = new Date()
  return today.getFullYear() === year && today.getMonth() + 1 === month && today.getDate() === day
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
