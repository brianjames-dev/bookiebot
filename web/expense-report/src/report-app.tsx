import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type TouchEvent,
} from "react"
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
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartTooltipDismissProvider } from "./components/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import type {
  AmountRow,
  BreakdownItem,
  BurnRate,
  BurnRatePoint,
  BudgetCategoryKey,
  CalendarEvent,
  CalendarEventKind,
  CategoryBalanceAmounts,
  CategoryBalances,
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
  const match = value.match(/^([A-Z][a-z]{2,})\s+(\d{1,2}),?\s+(?:\d{4}\s+)?(\d{1,2}:\d{2}\s+[AP]M)(?:\s+[A-Z]+)?$/)
  if (match) {
    return `${match[1]} ${match[2]} ${match[3]}`
  }
  return value.replace(/\s+[A-Z]{2,5}$/, "")
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
  titleAccessory?: ReactNode
  headerControl?: ReactNode
}

type CalendarFilter = "all" | "subscription"
type DailySpendingFilter = "all" | "needs" | "wants"
type CategoryMixFilter = "all" | BudgetCategoryKey

const CHART_CAROUSEL_GAP = 16
const CATEGORY_MIX_FILTERS: Array<{ value: CategoryMixFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs" },
  { value: "wants", label: "Wants" },
  { value: "savings", label: "Savings" },
]
const DAILY_SPENDING_FILTERS: Array<{ value: DailySpendingFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs" },
  { value: "wants", label: "Wants" },
]
const CATEGORY_NEEDS_KEYS = new Set(["rent", "bills_utilities", "static_bills_subscriptions_needs", "need_expenses", "grocery", "gas"])
const CATEGORY_WANTS_KEYS = new Set(["subscriptions_wants", "food", "shopping"])
const DAILY_WANTS_CATEGORIES = new Set(["Food", "Shopping"])
const LEFT_CATEGORY_COLOR = "#166534"
const SAVINGS_CATEGORY_COLOR = "#0f766e"
const NEEDS_BAR_COLOR = "#2563eb"
const WANTS_BAR_COLOR = "#7c3aed"
const DAILY_SPENDING_AXIS_COLOR = "hsl(var(--muted-foreground))"
const TOP_EXPENSE_HEAT_COLORS = [
  "#dc2626",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#06b6d4",
  "#38bdf8",
  "#60a5fa",
  "#3b82f6",
  "#2563eb",
]
const MERCHANT_BAR_COLOR = "#0891b2"

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
  categoryBalances: CategoryBalances
  breakdown: BreakdownItem[]
  burnRate: BurnRate | null
  calendarEvents: CalendarEvent[]
  utilityHistory: UtilityHistoryItem[]
}

function buildReportView(report: ExpenseReportData, projected: boolean): ReportView {
  const breakdown = projected ? projectedBreakdown(report) : report.breakdown
  const monthlyIncome = projected ? report.incomeProjection.projectedAmount : report.incomeProjection.currentAmount
  const totalExpenses = projected ? projectedOutflowTotal(report, breakdown) : report.metrics.totalExpenses
  const categoryBalances = projected
    ? projectedCategoryBalances(monthlyIncome, breakdown, report.metrics.amountSaved ?? 0)
    : report.categoryBalances ?? currentCategoryBalances(report)
  return {
    metrics: {
      totalExpenses,
      monthlyIncome,
      incomeAfterExpenses: roundCurrency(monthlyIncome - totalExpenses),
    },
    categoryBalances,
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

function projectedCategoryBalances(monthlyIncome: number, breakdown: BreakdownItem[], amountSaved: number) {
  const needsSpent = amountRowsTotal(breakdown.filter((item) => CATEGORY_NEEDS_KEYS.has(item.key)))
  const wantsSpent = amountRowsTotal(breakdown.filter((item) => CATEGORY_WANTS_KEYS.has(item.key)))
  return cascadeCategoryBalances({
    needs: roundCurrency(monthlyIncome * 0.5 - needsSpent),
    wants: roundCurrency(monthlyIncome * 0.3 - wantsSpent),
    savings: roundCurrency(monthlyIncome * 0.2 - amountSaved),
  })
}

function currentCategoryBalances(report: ExpenseReportData) {
  const needs = report.metrics.remainingNeedsBudget ?? report.metrics.needsRollover ?? 0
  const wants = report.metrics.remainingWantsBudget
    ?? roundCurrency((report.metrics.wantsRollover ?? 0) - (report.metrics.needsRollover ?? 0))
  const savings = report.metrics.remainingSavingsBudget
    ?? roundCurrency((report.metrics.savingsGoal ?? 0) - (report.metrics.amountSaved ?? 0))
  return cascadeCategoryBalances({ needs, wants, savings })
}

const CATEGORY_BALANCE_PRIORITIES: Array<[BudgetCategoryKey, BudgetCategoryKey[]]> = [
  ["needs", ["wants", "savings"]],
  ["wants", ["savings", "needs"]],
  ["savings", ["wants", "needs"]],
]

function cascadeCategoryBalances(rawAmounts: CategoryBalanceAmounts): CategoryBalances {
  const raw: CategoryBalanceAmounts = {
    needs: roundCurrency(rawAmounts.needs),
    wants: roundCurrency(rawAmounts.wants),
    savings: roundCurrency(rawAmounts.savings),
  }
  const remaining = { ...raw }
  const transfers: CategoryBalances["transfers"] = []

  CATEGORY_BALANCE_PRIORITIES.forEach(([recipient, donors]) => {
    let deficit = Math.max(-remaining[recipient], 0)
    donors.forEach((donor) => {
      if (deficit <= 0) {
        return
      }
      const transferred = roundCurrency(Math.min(deficit, Math.max(remaining[donor], 0)))
      if (transferred <= 0) {
        return
      }
      remaining[donor] = roundCurrency(remaining[donor] - transferred)
      remaining[recipient] = roundCurrency(remaining[recipient] + transferred)
      deficit = roundCurrency(deficit - transferred)
      transfers.push({ from: donor, to: recipient, amount: transferred })
    })
  })

  const deficits: CategoryBalanceAmounts = {
    needs: roundCurrency(Math.max(-raw.needs, 0)),
    wants: roundCurrency(Math.max(-raw.wants, 0)),
    savings: roundCurrency(Math.max(-raw.savings, 0)),
  }
  return {
    raw,
    remaining,
    deficits,
    transfers,
    totalOverspend: roundCurrency(
      Object.values(remaining).reduce((total, amount) => total + Math.max(-amount, 0), 0),
    ),
  }
}

function projectedSubscriptionTotals(report: ExpenseReportData) {
  const totalFor = (items: SubscriptionItem[]) => items.reduce((sum, item) => sum + item.amount, 0)
  const scheduledNeeds = report.subscriptionsNeeds.filter((item) => subscriptionDayInMonth(item, report.year, report.month) !== null)
  const scheduledWants = report.subscriptionsWants.filter((item) => subscriptionDayInMonth(item, report.year, report.month) !== null)
  return {
    needs: roundCurrency(totalFor(scheduledNeeds)),
    wants: roundCurrency(totalFor(scheduledWants)),
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
  const [categoryMixFilter, setCategoryMixFilter] = useState<CategoryMixFilter>("all")
  const [calendarFilter, setCalendarFilter] = useState<CalendarFilter>("all")
  const [dailySpendingFilter, setDailySpendingFilter] = useState<DailySpendingFilter>("all")
  const [chartTouch, setChartTouch] = useState<ChartTouchState | null>(null)
  const chartGestureRef = useRef<ChartTouchState | null>(null)
  const tooltipCooldownTimeoutRef = useRef<number | null>(null)
  const [chartTooltipCooldown, setChartTooltipCooldown] = useState(false)
  const [chartTooltipDismissRevision, setChartTooltipDismissRevision] = useState(0)
  const [chartCollapseKey, setChartCollapseKey] = useState(0)
  const dismissChartTooltips = () => {
    setChartTooltipDismissRevision((current) => current + 1)
  }
  const switchCategoryMixFilter = (nextFilter: CategoryMixFilter) => {
    if (nextFilter === categoryMixFilter) {
      return
    }
    dismissChartTooltips()
    setCategoryMixFilter(nextFilter)
  }
  const switchCalendarFilter = (nextFilter: CalendarFilter) => {
    if (nextFilter === calendarFilter) {
      return
    }
    dismissChartTooltips()
    setCalendarFilter(nextFilter)
  }
  const switchDailySpendingFilter = (nextFilter: DailySpendingFilter) => {
    if (nextFilter === dailySpendingFilter) {
      return
    }
    dismissChartTooltips()
    setDailySpendingFilter(nextFilter)
  }
  const toggleProjection = () => {
    dismissChartTooltips()
    setProjectionActive((current) => !current)
  }
  const activeReport = buildReportView(report, projectionActive)
  const categoryColors: Record<string, string> = Object.fromEntries(activeReport.breakdown.map((item) => [item.label, item.color]))
  const dailyEntries = filterDailyEntries(report.dailyEntries, dailySpendingFilter)
  const dailySubscriptionEvents = dailySpendingSubscriptionEvents(activeReport.calendarEvents, dailySpendingFilter, projectionActive)
  const dailyTableEntries = dailyEntriesWithSubscriptions(dailyEntries, dailySubscriptionEvents, report.month)
  const dailyTotals = dailyTotalsForEntries(dailyEntries, dailySubscriptionEvents)
  const dailyTotal = dailySpendingTotal(dailyEntries, dailySubscriptionEvents)
  const spentTotal = amountRowsTotal(activeReport.breakdown)
  const defaultChartTab = report.burnRate ? "burn-rate" : "category"
  const chartPanels: ChartPanel[] = [
    {
      id: "category",
      title: "Category Mix",
      headerControl: <CategoryMixFilterControl filter={categoryMixFilter} onFilterChange={switchCategoryMixFilter} />,
      content: (
        <CategoryMixChart
          data={activeReport.breakdown}
          categoryBalances={activeReport.categoryBalances}
          amountSaved={report.metrics.amountSaved ?? 0}
          filter={categoryMixFilter}
          projected={projectionActive}
          collapseKey={chartCollapseKey}
        />
      ),
    },
    ...(activeReport.burnRate
      ? [
          {
            id: "burn-rate",
            title: "Burn Rate",
            titleAccessory: <BurnRateInfoButton />,
            content: <BurnRateChart burnRate={activeReport.burnRate} collapseKey={chartCollapseKey} />,
          },
        ]
      : []),
    {
      id: "calendar",
      title: "Calendar",
      headerControl: <CalendarFilterControl filter={calendarFilter} onFilterChange={switchCalendarFilter} />,
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
      content: (
        <BillsUtilitiesPanel
          items={activeReport.utilityHistory}
          events={activeReport.calendarEvents}
          year={report.year}
          month={report.month}
          projected={projectionActive}
          collapseKey={chartCollapseKey}
        />
      ),
    },
  ]
  const defaultChartIndex = Math.max(0, chartPanels.findIndex((panel) => panel.id === defaultChartTab))
  const [activeChartIndex, setActiveChartIndex] = useState(defaultChartIndex)
  const savingsGoal = report.incomeProjection.savingsGoal

  useEffect(() => {
    setActiveChartIndex((current) => Math.min(current, chartPanels.length - 1))
  }, [chartPanels.length])

  useEffect(() => {
    return () => {
      if (tooltipCooldownTimeoutRef.current !== null) {
        window.clearTimeout(tooltipCooldownTimeoutRef.current)
      }
    }
  }, [])

  const startChartTooltipCooldown = () => {
    if (tooltipCooldownTimeoutRef.current !== null) {
      window.clearTimeout(tooltipCooldownTimeoutRef.current)
    }
    setChartTooltipCooldown(true)
    tooltipCooldownTimeoutRef.current = window.setTimeout(() => {
      setChartTooltipCooldown(false)
      tooltipCooldownTimeoutRef.current = null
    }, 320)
  }

  const switchChart = (nextIndex: number) => {
    const next = clamp(nextIndex, 0, chartPanels.length - 1)
    if (next === activeChartIndex) {
      return
    }
    setChartCollapseKey((current) => current + 1)
    setChartTooltipDismissRevision((current) => current + 1)
    startChartTooltipCooldown()
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
    chartGestureRef.current = { startX: touch.clientX, startY: touch.clientY, deltaX: 0, deltaY: 0, dragging: false }
  }

  const handleChartTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    const gesture = chartGestureRef.current
    if (!touch || gesture === null) {
      return
    }
    const deltaX = touch.clientX - gesture.startX
    const deltaY = touch.clientY - gesture.startY
    const dragging = Math.abs(deltaX) > 18 && Math.abs(deltaX) > Math.abs(deltaY) * 1.35
    const nextGesture = { ...gesture, deltaX, deltaY, dragging: gesture.dragging || dragging }
    chartGestureRef.current = nextGesture
    if (nextGesture.dragging) {
      setChartTouch(nextGesture)
    }
  }

  const handleChartTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const touch = chartGestureRef.current
    chartGestureRef.current = null
    if (touch === null) {
      return
    }
    const endX = event.changedTouches[0]?.clientX
    const endY = event.changedTouches[0]?.clientY
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

  const handleChartTouchCancel = () => {
    chartGestureRef.current = null
    setChartTouch(null)
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
          <ProjectionToggle
            active={projectionActive}
            onToggle={toggleProjection}
          />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <Badge variant="outline">{generatedTimeLabel(report.generatedAt)}</Badge>
        </div>
      </header>

      <ChartTooltipDismissProvider revision={chartTooltipDismissRevision}>
        <main className="bb-main" data-bb-tooltip-dismiss-revision={chartTooltipDismissRevision}>
        <section className="bb-metrics-grid" aria-label="Budget metrics">
          <MetricCard
            label="Income"
            value={activeReport.metrics.monthlyIncome}
            description={projectionActive ? "Projected month" : "Logged income"}
          />
          <MetricCard label="Spent" value={spentTotal} />
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
          data-tooltip-cooldown={chartTooltipCooldown ? "true" : "false"}
          onTouchStart={handleChartTouchStart}
          onTouchMove={handleChartTouchMove}
          onTouchEnd={handleChartTouchEnd}
          onTouchCancel={handleChartTouchCancel}
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
                      <div className="bb-title-with-accessory">
                        <CardTitle>{panel.title}</CardTitle>
                        {panel.titleAccessory}
                      </div>
                      {panel.headerControl ? <div className="bb-analytics-header-controls">{panel.headerControl}</div> : null}
                    </div>
                  </CardHeader>
                  <CardContent>{panel.content}</CardContent>
                </Card>
              </div>
            ))}
          </div>
        </div>
        <ChartCarouselNavigation
          panels={chartPanels}
          activeIndex={activeChartIndex}
          onSelect={switchChart}
          onPrevious={() => moveChart(-1)}
          onNext={() => moveChart(1)}
          canPrevious={activeChartIndex > 0}
          canNext={activeChartIndex < chartPanels.length - 1}
        />

        <Card>
          <CardHeader>
            <div className="bb-card-title-row bb-inline-toggle-row">
              <CardTitle>Daily Spending</CardTitle>
              <DailySpendingFilterControl filter={dailySpendingFilter} onFilterChange={switchDailySpendingFilter} />
            </div>
          </CardHeader>
          <CardContent className="bb-daily-spending-content">
            <DailySpendingChart data={dailyTotals} total={dailyTotal} elapsedDays={report.elapsedDays} filter={dailySpendingFilter} />
            <DailyEntriesTable entries={dailyTableEntries} categoryColors={categoryColors} />
          </CardContent>
        </Card>

        <ExpenseInsightsCard
          topEntries={report.topEntries}
          merchantOccurrences={report.merchantOccurrences}
          onViewChange={dismissChartTooltips}
        />

        </main>
      </ChartTooltipDismissProvider>
    </div>
  )
}

function isInteractiveTouchTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, summary, [role='button'], [role='tab']"))
}

function ChartCarouselNavigation({
  panels,
  activeIndex,
  onSelect,
  onPrevious,
  onNext,
  canPrevious,
  canNext,
}: {
  panels: ChartPanel[]
  activeIndex: number
  onSelect: (index: number) => void
  onPrevious: () => void
  onNext: () => void
  canPrevious: boolean
  canNext: boolean
}) {
  return (
    <div className="bb-chart-carousel-nav">
      <button type="button" className="bb-chart-carousel-button" aria-label="Previous chart" onClick={onPrevious} disabled={!canPrevious}>
        {"<"}
      </button>
      <ChartCarouselIndicators panels={panels} activeIndex={activeIndex} onSelect={onSelect} />
      <button type="button" className="bb-chart-carousel-button" aria-label="Next chart" onClick={onNext} disabled={!canNext}>
        {">"}
      </button>
    </div>
  )
}

function CategoryMixFilterControl({
  filter,
  onFilterChange,
}: {
  filter: CategoryMixFilter
  onFilterChange: (filter: CategoryMixFilter) => void
}) {
  return (
    <div
      className="bb-tabs-list bb-category-mix-filter"
      role="tablist"
      aria-label="Category mix filter"
      data-bb-tooltip-dismiss-trigger="category-mix"
    >
      {CATEGORY_MIX_FILTERS.map((item) => (
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

function DailySpendingFilterControl({
  filter,
  onFilterChange,
}: {
  filter: DailySpendingFilter
  onFilterChange: (filter: DailySpendingFilter) => void
}) {
  return (
    <div
      className="bb-tabs-list bb-daily-spending-filter"
      role="tablist"
      aria-label="Daily spending filter"
      data-bb-tooltip-dismiss-trigger="daily-spending"
    >
      {DAILY_SPENDING_FILTERS.map((item) => (
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
      data-bb-tooltip-dismiss-trigger="projection"
      onClick={onToggle}
    >
      Projected
    </button>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
  const isDark = theme === "dark"
  return (
    <button type="button" className="bb-theme-toggle" aria-pressed={isDark} aria-label={`Turn dark mode ${isDark ? "off" : "on"}`} onClick={onToggle}>
      <span className="bb-theme-toggle-icon" aria-hidden="true">
        {isDark ? (
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              className="bb-theme-toggle-moon"
              d="M20.6 14.1A8.3 8.3 0 0 1 9.9 3.4a8.7 8.7 0 1 0 10.7 10.7Z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
      </span>
    </button>
  )
}

function BurnRateChart({ burnRate, collapseKey }: { burnRate: BurnRate; collapseKey: number }) {
  const isOver = burnRate.status === "over"
  const isNotStarted = burnRate.status === "not_started"
  const statusLabel = isNotStarted ? "Not started" : isOver ? "Over pace" : "Available today"
  const differenceLabel = isNotStarted ? "No elapsed days" : formatMoney(Math.abs(burnRate.totalDifference))
  const dailyDifference = burnRateDailyPaceLabel(burnRate)
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
        <div className="bb-burn-rate-actions">
          <div className={isOver ? "bb-burn-rate-pill bb-burn-rate-pill-danger" : "bb-burn-rate-pill"}>
            {dailyDifference}
          </div>
        </div>
      </div>
      <ChartContainer
        config={{ variance: { label: "Variance", color: lineColor } }}
        className="bb-chart-box bb-chart-box-wide"
      >
        <ResponsiveContainer width="100%" height="100%">
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
      <DetailsPanel summary="Details" collapseKey={collapseKey}>
        <StatList
          rows={[
            ["Limit", formatMoney(burnRate.budget)],
            ["Spent", formatMoney(burnRate.spent)],
            ["Left", formatMoney(burnRate.remaining)],
            ["Allowed/day", formatMoney(burnRate.allowedDailyAverage)],
            ["Actual/day", formatMoney(burnRate.actualDailyAverage)],
          ]}
        />
      </DetailsPanel>
    </div>
  )
}

function burnRateDailyPaceLabel(burnRate: BurnRate) {
  if (burnRate.status === "not_started") {
    return "No daily pace yet"
  }
  if (burnRate.dailyDifference > 0) {
    return `Overspending ${formatMoney(Math.abs(burnRate.dailyDifference))}/day`
  }
  if (burnRate.dailyDifference < 0) {
    return `Saving ${formatMoney(Math.abs(burnRate.dailyDifference))}/day`
  }
  return "On pace"
}

function BurnRateInfoButton() {
  return (
    <button type="button" className="bb-burn-rate-info" aria-label="What burn rate means">
      <span aria-hidden="true">i</span>
      <span className="bb-burn-rate-info-tooltip" role="tooltip">
        Tracks Food + Shopping pace against your wants limit. Available today is what you can spend now and stay on pace.
      </span>
    </button>
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
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
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
        <span>Total Spent</span>
        <strong>{formatMoney(point.actualSpend)}</strong>
      </div>
      <div className="bb-chart-tooltip-row">
        <span />
        <span>Limit</span>
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

type CategoryMixChartProps = {
  data: BreakdownItem[]
  categoryBalances: CategoryBalances
  amountSaved: number
  filter: CategoryMixFilter
  projected: boolean
  collapseKey: number
}

const CategoryMixChart = memo(function CategoryMixChart({
  data,
  categoryBalances,
  amountSaved,
  filter,
  projected,
  collapseKey,
}: CategoryMixChartProps) {
  const selectedRollover = categoryMixRollover(categoryBalances, filter)
  const chartData = categoryMixRows(data, selectedRollover, filter, amountSaved)
  const [pieHostRef, pieHostSize] = useElementSize<HTMLDivElement>()
  const pieLayout = useExpensePieLayout(chartData, pieHostSize)
  const spentTotal = amountRowsTotal(chartData.filter((item) => item.key !== "left"))
  const pressure = categoryMixPressure(filter, categoryBalances, spentTotal)

  return (
    <div className="bb-chart-stack">
      <div className="bb-panel-head">
        <div>
          <div className="bb-chart-kicker">{filter === "savings" ? "Saved" : "Spent"}</div>
          <div className="bb-chart-total">{formatMoney(spentTotal)}</div>
          <div className="bb-chart-mode-note">{projected ? "Projected" : "Current"}</div>
        </div>
        {pressure ? <CategoryMixPressureBar pressure={pressure} /> : null}
      </div>
      <div className="bb-chart-layout bb-category-chart-layout">
        <ChartContainer config={chartConfig(chartData)} className="bb-chart-box bb-category-chart-box">
          <CategoryMixPieMotionHost
            hostRef={pieHostRef}
            layout={pieLayout}
            filter={filter}
          >
            <CategoryMixPieSurface data={chartData} layout={pieLayout} />
          </CategoryMixPieMotionHost>
        </ChartContainer>
      </div>
      <DetailsPanel summary="Categories" collapseKey={collapseKey}>
        <div className="bb-legend-list">
          {chartData.map((item) => (
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
  )
}, areCategoryMixChartPropsEqual)

type CategoryMixPieMotionHostProps = {
  hostRef: RefObject<HTMLDivElement>
  layout: ExpensePieLayout
  filter: CategoryMixFilter
  children: ReactNode
}

function CategoryMixPieMotionHost({ hostRef, layout, filter, children }: CategoryMixPieMotionHostProps) {
  const motion = useExpensePieLayoutMotion(layout, filter)

  return (
    <div
      ref={hostRef}
      className="bb-category-pie-host"
      data-bb-pie-fit-padding={layout.containerPadding}
      data-bb-pie-layout-motion={motion.phase}
      data-bb-pie-layout-motion-revision={motion.revision}
      data-bb-pie-layout-travel-x={motion.travelX}
      data-bb-pie-layout-travel-y={motion.travelY}
      data-bb-pie-motion-isolated="true"
      data-bb-pie-animation-synchronized="true"
      style={{
        "--bb-pie-layout-offset-x": `${motion.offsetX}px`,
        "--bb-pie-layout-offset-y": `${motion.offsetY}px`,
      } as CSSProperties}
    >
      {children}
    </div>
  )
}

type CategoryMixPieSurfaceProps = {
  data: BreakdownItem[]
  layout: ExpensePieLayout
}

const CategoryMixPieSurface = memo(function CategoryMixPieSurface({ data, layout }: CategoryMixPieSurfaceProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={layout.margin}>
        <ChartTooltip content={<ChartTooltipContent />} />
        <Pie
          data={data}
          dataKey="amount"
          nameKey="label"
          cx={layout.cx}
          cy={layout.cy}
          innerRadius={layout.innerRadius}
          outerRadius={layout.outerRadius}
          startAngle={PIE_METRIC_START_ANGLE}
          endAngle={PIE_METRIC_END_ANGLE}
          paddingAngle={PIE_METRIC_PADDING_ANGLE}
          animationBegin={0}
          animationDuration={520}
          animationEasing="ease-out"
          label={layout.showLabels ? (props) => renderPieMetricLabel(props, layout) : false}
          labelLine={layout.showLabels ? (props) => renderPieMetricLabelLine(props, layout) : false}
        >
          {data.map((item) => (
            <Cell key={item.key} fill={item.color} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  )
}, areCategoryMixPieSurfacePropsEqual)

function areCategoryMixPieSurfacePropsEqual(
  previous: CategoryMixPieSurfaceProps,
  next: CategoryMixPieSurfaceProps,
) {
  return breakdownRowsEqual(previous.data, next.data) && expensePieLayoutsEqual(previous.layout, next.layout)
}

function areCategoryMixChartPropsEqual(previous: CategoryMixChartProps, next: CategoryMixChartProps) {
  return (
    previous.amountSaved === next.amountSaved &&
    categoryBalancesEqual(previous.categoryBalances, next.categoryBalances) &&
    previous.filter === next.filter &&
    previous.projected === next.projected &&
    previous.collapseKey === next.collapseKey &&
    breakdownRowsEqual(previous.data, next.data)
  )
}

function categoryBalancesEqual(previous: CategoryBalances, next: CategoryBalances) {
  return (
    previous.raw.needs === next.raw.needs &&
    previous.raw.wants === next.raw.wants &&
    previous.raw.savings === next.raw.savings &&
    previous.remaining.needs === next.remaining.needs &&
    previous.remaining.wants === next.remaining.wants &&
    previous.remaining.savings === next.remaining.savings &&
    previous.totalOverspend === next.totalOverspend &&
    previous.transfers.length === next.transfers.length &&
    previous.transfers.every((transfer, index) => {
      const nextTransfer = next.transfers[index]
      return transfer.from === nextTransfer.from && transfer.to === nextTransfer.to && transfer.amount === nextTransfer.amount
    })
  )
}

function breakdownRowsEqual(previous: BreakdownItem[], next: BreakdownItem[]) {
  if (previous.length !== next.length) {
    return false
  }
  return previous.every((item, index) => {
    const nextItem = next[index]
    return (
      item.key === nextItem.key &&
      item.label === nextItem.label &&
      item.amount === nextItem.amount &&
      item.percentage === nextItem.percentage &&
      item.color === nextItem.color
    )
  })
}

function categoryMixRollover(
  balances: CategoryBalances,
  filter: CategoryMixFilter,
) {
  if (filter !== "all") {
    return balances.remaining[filter]
  }
  return roundCurrency(Object.values(balances.remaining).reduce((total, amount) => total + amount, 0))
}

const CATEGORY_BALANCE_LABELS: Record<BudgetCategoryKey, string> = {
  needs: "Needs",
  wants: "Wants",
  savings: "Savings",
}

type CategoryMixPressure = {
  label: string
  amount: number
  note: string
  tone: "danger" | "impact"
  fillPercent: number
}

function categoryMixPressure(
  filter: CategoryMixFilter,
  balances: CategoryBalances,
  spentTotal: number,
): CategoryMixPressure | null {
  let pressure: Omit<CategoryMixPressure, "fillPercent"> | null = null
  if (filter === "all" && balances.totalOverspend > 0) {
    pressure = {
      label: "Budget overspend",
      amount: balances.totalOverspend,
      note: "Needs, Wants, and Savings funds are fully depleted",
      tone: "danger",
    }
  }

  if (filter !== "all") {
    const deficit = balances.deficits[filter]
    const receivedTransfers = balances.transfers.filter((transfer) => transfer.to === filter)
    const remainingDeficit = Math.max(-balances.remaining[filter], 0)
    if (deficit > 0) {
      const coverage = receivedTransfers
        .map((transfer) => `${formatMoney(transfer.amount)} from ${CATEGORY_BALANCE_LABELS[transfer.from]}`)
        .join(" + ")
      const uncovered = remainingDeficit > 0
        ? `${formatMoney(remainingDeficit)} remains beyond the total budget`
        : ""
      pressure = {
        label: filter === "savings" ? "Over saving" : `${CATEGORY_BALANCE_LABELS[filter]} overspend`,
        amount: deficit,
        note: coverage
          ? `Covered by ${coverage}${uncovered ? `; ${uncovered}` : ""}`
          : uncovered || "No other category funds were needed",
        tone: "danger",
      }
    } else {
      const donatedTransfers = balances.transfers.filter((transfer) => transfer.from === filter)
      const impact = roundCurrency(donatedTransfers.reduce((total, transfer) => total + transfer.amount, 0))
      if (impact > 0) {
        const recipients = [...new Set(donatedTransfers.map((transfer) => CATEGORY_BALANCE_LABELS[transfer.to]))]
        pressure = {
          label: recipients.length === 1 ? `${recipients[0]} overspend impact` : "Category overspend impact",
          amount: impact,
          note: `${formatMoney(impact)} deducted from ${CATEGORY_BALANCE_LABELS[filter]} income left`,
          tone: "impact",
        }
      }
    }
  }

  if (!pressure) {
    return null
  }
  return {
    ...pressure,
    fillPercent: clamp((pressure.amount / Math.max(spentTotal, pressure.amount)) * 100, 8, 100),
  }
}

function CategoryMixPressureBar({ pressure }: { pressure: CategoryMixPressure }) {
  return (
    <div
      className={`bb-category-pressure bb-category-pressure-${pressure.tone}`}
      data-bb-category-balance-alert={pressure.tone}
    >
      <div className="bb-category-pressure-head">
        <span>{pressure.label}</span>
        <strong>{formatMoney(pressure.amount)}</strong>
      </div>
      <div
        className="bb-category-pressure-track"
        role="img"
        aria-label={`${pressure.label}: ${formatMoney(pressure.amount)}`}
      >
        <span style={{ width: `${pressure.fillPercent}%` }} />
      </div>
      <div className="bb-category-pressure-note">{pressure.note}</div>
    </div>
  )
}

function categoryMixRows(
  data: BreakdownItem[],
  rolloverAmount: number,
  filter: CategoryMixFilter,
  amountSaved: number,
) {
  let filtered = data.filter((item) => {
    if (filter === "needs") return CATEGORY_NEEDS_KEYS.has(item.key)
    if (filter === "wants") return CATEGORY_WANTS_KEYS.has(item.key)
    return filter === "all"
  })
  if (filter === "savings") {
    filtered = amountSaved > 0
      ? [{
          key: "savings",
          label: "Saved",
          amount: roundCurrency(amountSaved),
          percentage: 0,
          color: SAVINGS_CATEGORY_COLOR,
        }]
      : []
  }
  const positiveLeftAmount = Math.max(roundCurrency(rolloverAmount), 0)
  const rows =
    positiveLeftAmount > 0
      ? [
          {
            key: "left",
            label: "Income left",
            amount: positiveLeftAmount,
            percentage: 0,
            color: LEFT_CATEGORY_COLOR,
          },
          ...filtered,
        ]
      : filtered
  const total = amountRowsTotal(rows)
  return rows.map((item) => ({
    ...item,
    percentage: total ? roundCurrency((item.amount / total) * 100) : 0,
  }))
}

type ElementSize = {
  width: number
  height: number
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return undefined
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      setSize((current) => {
        const next = {
          width: Math.max(0, Math.round(rect.width * 10) / 10),
          height: Math.max(0, Math.round(rect.height * 10) / 10),
        }
        return current.width === next.width && current.height === next.height ? current : next
      })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}

type ExpensePieBaseLayout = {
  fallbackWidth: number
  fallbackHeight: number
  minOuterRadius: number
  maxOuterRadius: number
  innerRadiusRatio: number
  labelOffset: number
  labelGap: number
  containerPadding: number
  compactLabel: boolean
  showLabels: boolean
}

function useExpensePieLayout(data: BreakdownItem[], hostSize: ElementSize) {
  const isPhone = useMediaQuery("(max-width: 520px)")
  const isTablet = useMediaQuery("(max-width: 860px)")

  let base: ExpensePieBaseLayout
  if (isPhone) {
    base = {
      fallbackWidth: 360,
      fallbackHeight: 330,
      minOuterRadius: 72,
      maxOuterRadius: 122,
      innerRadiusRatio: 72 / 122,
      labelOffset: 20,
      labelGap: PIE_METRIC_LABEL_GAP,
      containerPadding: 12,
      compactLabel: false,
      showLabels: false,
    }
  } else if (isTablet) {
    base = {
      fallbackWidth: 760,
      fallbackHeight: 390,
      minOuterRadius: 96,
      maxOuterRadius: 150,
      innerRadiusRatio: 86 / 150,
      labelOffset: 26,
      labelGap: PIE_METRIC_LABEL_GAP,
      containerPadding: 14,
      compactLabel: false,
      showLabels: true,
    }
  } else {
    base = {
      fallbackWidth: 1100,
      fallbackHeight: 460,
      minOuterRadius: 120,
      maxOuterRadius: 220,
      innerRadiusRatio: 122 / 220,
      labelOffset: 42,
      labelGap: PIE_METRIC_LABEL_GAP,
      containerPadding: 16,
      compactLabel: false,
      showLabels: true,
    }
  }

  return fitExpensePieLayout(data, hostSize, base)
}

function pieMetricAnimationDelay(index: number | undefined) {
  return `${Math.min(index ?? 0, 8) * 10 + 35}ms`
}

function pieMetricColor(payload: BreakdownItem | undefined, fallback: string | undefined) {
  return payload?.color ?? fallback ?? "hsl(var(--foreground))"
}

type PieMetricTextAnchor = "start" | "middle" | "end" | "inherit"

const PIE_METRIC_LABEL_GAP = 10
const PIE_METRIC_LABEL_HALF_HEIGHT = 8
const PIE_METRIC_LABEL_MIN_VERTICAL_GAP = 18
const PIE_METRIC_LABEL_WIDTH_SAFETY = 4
const PIE_METRIC_MINIMUM_RADIUS = 54
const PIE_METRIC_START_ANGLE = 0
const PIE_METRIC_END_ANGLE = 360
const PIE_METRIC_PADDING_ANGLE = 1

type PieMetricDelta = {
  x: number
  y: number
}

type PieMetricEnvelope = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type PieMetricPlacement = {
  key: string
  cos: number
  sin: number
  labelWidth: number
  delta: PieMetricDelta
}

const pieMetricLabelWidthCache = new Map<string, number>()
let pieMetricMeasureContext: CanvasRenderingContext2D | null | undefined

function fitExpensePieLayout(data: BreakdownItem[], hostSize: ElementSize, base: ExpensePieBaseLayout) {
  const width = hostSize.width || base.fallbackWidth
  const height = hostSize.height || base.fallbackHeight
  const safeWidth = Math.max(1, width - base.containerPadding * 2)
  const safeHeight = Math.max(1, height - base.containerPadding * 2)
  const minimumRadius = Math.min(base.minOuterRadius, base.maxOuterRadius, safeWidth / 2, safeHeight / 2)
  let low = Math.min(PIE_METRIC_MINIMUM_RADIUS, minimumRadius)
  let high = base.maxOuterRadius

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const candidate = (low + high) / 2
    const candidateEnvelope = expensePieEnvelope(data, candidate, base)
    if (
      candidateEnvelope.maxX - candidateEnvelope.minX <= safeWidth &&
      candidateEnvelope.maxY - candidateEnvelope.minY <= safeHeight
    ) {
      low = candidate
    } else {
      high = candidate
    }
  }

  const outerRadius = Math.max(PIE_METRIC_MINIMUM_RADIUS, Math.min(base.maxOuterRadius, low))
  const envelope = expensePieEnvelope(data, outerRadius, base)
  const envelopeWidth = envelope.maxX - envelope.minX
  const envelopeHeight = envelope.maxY - envelope.minY
  const cx = base.containerPadding + (safeWidth - envelopeWidth) / 2 - envelope.minX
  const cy = base.containerPadding + (safeHeight - envelopeHeight) / 2 - envelope.minY

  return {
    ...base,
    cx,
    cy,
    innerRadius: outerRadius * base.innerRadiusRatio,
    outerRadius,
    labelDeltas: pieMetricLabelDeltas(data, outerRadius, base),
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  }
}

function expensePieEnvelope(data: BreakdownItem[], outerRadius: number, layout: ExpensePieBaseLayout): PieMetricEnvelope {
  const envelope: PieMetricEnvelope = {
    minX: -outerRadius,
    maxX: outerRadius,
    minY: -outerRadius,
    maxY: outerRadius,
  }
  if (!layout.showLabels) {
    return envelope
  }

  for (const placement of pieMetricPlacements(data, outerRadius, layout)) {
    const lineEndX = placement.cos * (outerRadius + layout.labelOffset) + placement.delta.x
    const lineEndY = placement.sin * (outerRadius + layout.labelOffset) + placement.delta.y
    const isRight = placement.cos >= 0
    const labelNearX = lineEndX + (isRight ? layout.labelGap : -layout.labelGap)
    const labelMinX = isRight ? labelNearX : labelNearX - placement.labelWidth
    const labelMaxX = isRight ? labelNearX + placement.labelWidth : labelNearX

    envelope.minX = Math.min(envelope.minX, lineEndX, labelMinX)
    envelope.maxX = Math.max(envelope.maxX, lineEndX, labelMaxX)
    envelope.minY = Math.min(envelope.minY, lineEndY - PIE_METRIC_LABEL_HALF_HEIGHT)
    envelope.maxY = Math.max(envelope.maxY, lineEndY + PIE_METRIC_LABEL_HALF_HEIGHT)
  }
  return envelope
}

function pieMetricPlacements(data: BreakdownItem[], outerRadius: number, layout: ExpensePieBaseLayout) {
  const total = amountRowsTotal(data)
  const nonZeroCount = data.filter((item) => item.amount !== 0).length
  const angleDirection = Math.sign(PIE_METRIC_END_ANGLE - PIE_METRIC_START_ANGLE) || 1
  const realTotalAngle =
    Math.abs(PIE_METRIC_END_ANGLE - PIE_METRIC_START_ANGLE) - nonZeroCount * PIE_METRIC_PADDING_ANGLE
  let currentAngle = PIE_METRIC_START_ANGLE
  const placements: PieMetricPlacement[] = data.map((item, index) => {
    if (index > 0 && item.amount !== 0) {
      currentAngle += angleDirection * PIE_METRIC_PADDING_ANGLE
    }
    const sweep = total ? (realTotalAngle * item.amount) / total : 0
    const midAngle = currentAngle + (angleDirection * sweep) / 2
    currentAngle += angleDirection * sweep
    const radians = (-midAngle * Math.PI) / 180
    return {
      key: item.key,
      cos: Math.cos(radians),
      sin: Math.sin(radians),
      labelWidth: pieMetricLabelWidth(item, layout.compactLabel),
      delta: { x: 0, y: 0 },
    }
  })

  for (const side of [-1, 1]) {
    const sidePlacements = placements
      .filter((placement) => (placement.cos >= 0 ? 1 : -1) === side)
      .sort((left, right) => left.sin - right.sin)
    let priorY = Number.NEGATIVE_INFINITY
    for (const placement of sidePlacements) {
      const baseY = placement.sin * (outerRadius + layout.labelOffset)
      const adjustedY = Math.max(baseY, priorY + PIE_METRIC_LABEL_MIN_VERTICAL_GAP)
      placement.delta.y = adjustedY - baseY
      priorY = adjustedY
    }
    if (sidePlacements.length) {
      const averageDelta = sidePlacements.reduce((sum, placement) => sum + placement.delta.y, 0) / sidePlacements.length
      for (const placement of sidePlacements) {
        placement.delta.y -= averageDelta
      }
    }
  }

  return placements
}

function pieMetricLabelDeltas(data: BreakdownItem[], outerRadius: number, layout: ExpensePieBaseLayout) {
  return Object.fromEntries(
    pieMetricPlacements(data, outerRadius, layout).map((placement) => [placement.key, placement.delta]),
  ) as Record<string, PieMetricDelta>
}

function pieMetricLabelWidth(item: BreakdownItem, compactLabel: boolean) {
  const text = compactLabel ? `${item.label}\n${formatMoney(item.amount)}` : `${item.label} ${formatMoney(item.amount)}`
  const cached = pieMetricLabelWidthCache.get(text)
  if (cached !== undefined) {
    return cached
  }

  if (pieMetricMeasureContext === undefined) {
    pieMetricMeasureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")
    if (pieMetricMeasureContext) {
      pieMetricMeasureContext.font = "650 12px Inter, ui-sans-serif, system-ui, sans-serif"
    }
  }
  const width = pieMetricMeasureContext
    ? pieMetricMeasureContext.measureText(text.replace("\n", " ")).width
    : text.replace("\n", " ").length * 7
  const measured = Math.ceil(width + PIE_METRIC_LABEL_WIDTH_SAFETY)
  pieMetricLabelWidthCache.set(text, measured)
  return measured
}

type ExpensePieLayout = ReturnType<typeof useExpensePieLayout>

const PIE_LAYOUT_MOTION_DURATION_MS = 520
const PIE_LAYOUT_MOTION_SETTLE_MS = 80

type PieLayoutMotionPhase = "idle" | "primed" | "active"

type PieLayoutMotion = {
  phase: PieLayoutMotionPhase
  offsetX: number
  offsetY: number
  travelX: number
  travelY: number
  revision: number
}

function useExpensePieLayoutMotion(layout: ExpensePieLayout, filter: CategoryMixFilter) {
  const previousLayoutRef = useRef<{ filter: CategoryMixFilter; cx: number; cy: number } | null>(null)
  const revisionRef = useRef(0)
  const [motion, setMotion] = useState<PieLayoutMotion>({
    phase: "idle",
    offsetX: 0,
    offsetY: 0,
    travelX: 0,
    travelY: 0,
    revision: 0,
  })

  useLayoutEffect(() => {
    const previous = previousLayoutRef.current
    previousLayoutRef.current = { filter, cx: layout.cx, cy: layout.cy }
    if (!previous) {
      return
    }

    const offsetX = previous.cx - layout.cx
    const offsetY = previous.cy - layout.cy
    if (Math.abs(offsetX) < 0.1 && Math.abs(offsetY) < 0.1) {
      setMotion((current) => current.phase === "idle"
        ? current
        : { ...current, phase: "idle", offsetX: 0, offsetY: 0 })
      return
    }

    revisionRef.current += 1
    const revision = revisionRef.current
    setMotion({ phase: "primed", offsetX, offsetY, travelX: offsetX, travelY: offsetY, revision })

    let startFrame = 0
    let activeFrame = 0
    let completionTimer = 0
    startFrame = window.requestAnimationFrame(() => {
      activeFrame = window.requestAnimationFrame(() => {
        setMotion({ phase: "active", offsetX: 0, offsetY: 0, travelX: offsetX, travelY: offsetY, revision })
        completionTimer = window.setTimeout(() => {
          setMotion((current) => current.revision === revision
            ? { phase: "idle", offsetX: 0, offsetY: 0, travelX: offsetX, travelY: offsetY, revision }
            : current)
        }, PIE_LAYOUT_MOTION_DURATION_MS + PIE_LAYOUT_MOTION_SETTLE_MS)
      })
    })

    return () => {
      window.cancelAnimationFrame(startFrame)
      window.cancelAnimationFrame(activeFrame)
      window.clearTimeout(completionTimer)
    }
  }, [filter])

  useLayoutEffect(() => {
    if (previousLayoutRef.current?.filter === filter) {
      previousLayoutRef.current = { filter, cx: layout.cx, cy: layout.cy }
    }
  }, [filter, layout.cx, layout.cy])

  return motion
}

function expensePieLayoutsEqual(previous: ExpensePieLayout, next: ExpensePieLayout) {
  const previousDeltaKeys = Object.keys(previous.labelDeltas)
  const nextDeltaKeys = Object.keys(next.labelDeltas)
  return (
    previous.fallbackWidth === next.fallbackWidth &&
    previous.fallbackHeight === next.fallbackHeight &&
    previous.minOuterRadius === next.minOuterRadius &&
    previous.maxOuterRadius === next.maxOuterRadius &&
    previous.innerRadiusRatio === next.innerRadiusRatio &&
    previous.labelOffset === next.labelOffset &&
    previous.labelGap === next.labelGap &&
    previous.containerPadding === next.containerPadding &&
    previous.compactLabel === next.compactLabel &&
    previous.showLabels === next.showLabels &&
    previous.cx === next.cx &&
    previous.cy === next.cy &&
    previous.innerRadius === next.innerRadius &&
    previous.outerRadius === next.outerRadius &&
    previous.margin.top === next.margin.top &&
    previous.margin.right === next.margin.right &&
    previous.margin.bottom === next.margin.bottom &&
    previous.margin.left === next.margin.left &&
    previousDeltaKeys.length === nextDeltaKeys.length &&
    previousDeltaKeys.every((key) => (
      previous.labelDeltas[key]?.x === next.labelDeltas[key]?.x &&
      previous.labelDeltas[key]?.y === next.labelDeltas[key]?.y
    ))
  )
}

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
  const delta = pieMetricPositionDelta(props, layout)
  const computed = pieMetricPolarPoint(props, layout.outerRadius + layout.labelOffset)
  if (computed) {
    return {
      x: computed.x + delta.x,
      y: computed.y + delta.y,
      textAnchor: computed.x > computed.cx ? "start" as const : "end" as const,
    }
  }
  return { x, y, textAnchor }
}

function pieMetricLinePosition(props: unknown, layout: ExpensePieLayout) {
  const delta = pieMetricPositionDelta(props, layout)
  const start = pieMetricPolarPoint(props, layout.outerRadius)
  const end = pieMetricPolarPoint(props, layout.outerRadius + layout.labelOffset)
  if (start && end) {
    return {
      start,
      end: { ...end, x: end.x + delta.x, y: end.y + delta.y },
    }
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

function pieMetricPositionDelta(props: unknown, layout: ExpensePieLayout): PieMetricDelta {
  const { payload } = props as { payload?: BreakdownItem }
  return payload ? layout.labelDeltas[payload.key] ?? { x: 0, y: 0 } : { x: 0, y: 0 }
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

type DailySpendingRow = AmountRow & {
  needsAmount: number
  wantsAmount: number
}

type DailyEntryDisplayRow = ExpenseEntry & {
  categoryColor?: string
}

function DailySpendingChart({
  data,
  total,
  elapsedDays,
  filter,
}: {
  data: DailySpendingRow[]
  total: number
  elapsedDays: number
  filter: DailySpendingFilter
}) {
  const peak = data.reduce<AmountRow | null>((best, item) => (!best || item.amount > best.amount ? item : best), null)
  const averageDaySpend = elapsedDays ? total / elapsedDays : 0
  const yAxisDomain = dailySpendingYAxisDomain(data)
  const yAxisTicks = dailySpendingYAxisTicks(yAxisDomain)
  const showStackedBars = filter === "all"
  const singleBarColor = filter === "needs" ? NEEDS_BAR_COLOR : filter === "wants" ? WANTS_BAR_COLOR : "hsl(var(--chart-1))"
  return (
    <div className="bb-chart-layout">
      <ChartContainer
        config={
          showStackedBars
            ? {
                needsAmount: { label: "Needs", color: NEEDS_BAR_COLOR },
                wantsAmount: { label: "Wants", color: WANTS_BAR_COLOR },
              }
            : { amount: { label: "Amount", color: singleBarColor } }
        }
        className="bb-chart-box"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid
              className="bb-daily-spending-grid"
              vertical={false}
              stroke={DAILY_SPENDING_AXIS_COLOR}
              strokeDasharray="3 3"
            />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis
              domain={yAxisDomain}
              ticks={yAxisTicks}
              scale="sqrt"
              tick={{ fill: DAILY_SPENDING_AXIS_COLOR }}
              tickFormatter={(value) => `$${value}`}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ChartTooltip content={showStackedBars ? <DailySpendingTooltipContent /> : <ChartTooltipContent />} cursor={{ fill: dailySpendingCursorFill(filter) }} />
            {showStackedBars ? (
              <>
                <Bar dataKey="needsAmount" name="Needs" stackId="daily" fill={NEEDS_BAR_COLOR} radius={[2, 2, 2, 2]} />
                <Bar dataKey="wantsAmount" name="Wants" stackId="daily" fill={WANTS_BAR_COLOR} radius={[6, 6, 2, 2]} />
              </>
            ) : (
              <Bar dataKey="amount" name="Daily spending" fill={singleBarColor} radius={[6, 6, 2, 2]} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="bb-chart-side">
        <div>
          <div className="bb-chart-kicker">Total Spent</div>
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

function dailySpendingYAxisDomain(data: DailySpendingRow[]): [number, number] {
  const peak = Math.max(0, ...data.map((item) => item.amount))
  if (peak <= 0) {
    return [0, 1]
  }
  const paddedPeak = peak * 1.06
  return [0, Math.max(1, Math.ceil(paddedPeak / 10) * 10)]
}

function dailySpendingYAxisTicks([, max]: [number, number]) {
  if (max <= 0) {
    return [0]
  }
  if (max <= 160) {
    const step = max <= 60 ? 10 : 20
    return dailySpendingTickRange(step, max)
  }

  const ticks = [0, 25, 50, 75, 100]
  for (let value = 200; value < max; value += 100) {
    ticks.push(value)
  }
  return ticks.filter((value) => value < max)
}

function dailySpendingTickRange(step: number, max: number) {
  const ticks: number[] = []
  for (let value = 0; value < max; value += step) {
    ticks.push(value)
  }
  return ticks
}

function dailySpendingCursorFill(filter: DailySpendingFilter) {
  if (filter === "needs") {
    return "rgb(37 99 235 / 0.14)"
  }
  if (filter === "wants") {
    return "rgb(124 58 237 / 0.14)"
  }
  return "hsl(var(--foreground) / 0.08)"
}

type DailySpendingTooltipPayload = {
  name?: string | number
  value?: string | number | null
  color?: string
  payload?: DailySpendingRow
}

function DailySpendingTooltipContent({
  active,
  payload,
}: {
  active?: boolean
  payload?: DailySpendingTooltipPayload[]
}) {
  const rows = (payload ?? []).filter((item) => item.value !== null && item.value !== undefined && Number(item.value) > 0)
  const point = rows[0]?.payload
  if (!active || !rows.length || !point) {
    return null
  }

  return (
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
      <div className="bb-chart-tooltip-title">Day {point.label}</div>
      {rows.map((item, index) => (
        <div className="bb-chart-tooltip-row" key={`${item.name}-${item.value}-${index}`}>
          <span className="bb-chart-tooltip-dot" style={{ background: item.color }} />
          <span>{item.name}</span>
          <strong>{formatMoney(Number(item.value || 0))}</strong>
        </div>
      ))}
      <div className="bb-chart-tooltip-row">
        <span />
        <span>Total</span>
        <strong>{formatMoney(point.amount)}</strong>
      </div>
    </div>
  )
}

function TopExpensesChart({ entries }: { entries: ExpenseEntry[] }) {
  const showYAxisLabels = !useMediaQuery("(max-width: 640px)")
  const visibleEntries = entries.slice(0, 10)
  const rows = visibleEntries.map((entry, index) => ({
    label: expenseEntryItemLabel(entry),
    amount: entry.amount,
    color: topExpenseHeatColor(index, visibleEntries.length),
  }))

  return (
    <ChartContainer config={{ amount: { label: "Amount", color: "hsl(var(--chart-2))" } }} className="bb-insight-chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 22, left: showYAxisLabels ? 20 : 0, bottom: 12 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} />
          <YAxis
            dataKey="label"
            type="category"
            width={showYAxisLabels ? 148 : 0}
            tick={showYAxisLabels}
            tickFormatter={(value) => truncateChartLabel(value, 22)}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip content={<TopExpensesTooltipContent />} cursor={{ fill: "hsl(var(--foreground) / 0.08)" }} />
          <Bar dataKey="amount" name="Expense amount" fill="hsl(var(--chart-2))" radius={[0, 6, 6, 0]}>
            {rows.map((row, index) => (
              <Cell key={`${row.label}-${index}`} fill={row.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

type TopExpensesChartRow = {
  label: string
  amount: number
  color: string
}

function TopExpensesTooltipContent({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload?: TopExpensesChartRow }>
}) {
  const row = payload?.find((item) => item.payload)?.payload
  if (!active || !row) {
    return null
  }
  return (
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
      <div className="bb-chart-tooltip-title">{row.label}</div>
      <div className="bb-chart-tooltip-row">
        <span className="bb-chart-tooltip-dot" style={{ background: row.color }} />
        <span>Expense amount</span>
        <strong>{formatMoney(row.amount)}</strong>
      </div>
    </div>
  )
}

function topExpenseHeatColor(index: number, total: number) {
  if (total <= 1) {
    return TOP_EXPENSE_HEAT_COLORS[0]
  }
  const paletteIndex = Math.round((index / (total - 1)) * (TOP_EXPENSE_HEAT_COLORS.length - 1))
  return TOP_EXPENSE_HEAT_COLORS[Math.min(Math.max(paletteIndex, 0), TOP_EXPENSE_HEAT_COLORS.length - 1)]
}

function truncateChartLabel(value: unknown, maxLength: number) {
  const text = String(value ?? "")
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(maxLength - 3, 0))}...`
}

function MerchantChart({ data }: { data: OccurrenceRow[] }) {
  const showYAxisLabels = !useMediaQuery("(max-width: 640px)")
  const rows = data.slice(0, 10)
  return (
    <ChartContainer config={{ count: { label: "Occurrences", color: MERCHANT_BAR_COLOR } }} className="bb-insight-chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 22, left: showYAxisLabels ? 20 : 0, bottom: 12 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickFormatter={(value) => String(value)} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis dataKey="label" type="category" width={showYAxisLabels ? 148 : 0} tick={showYAxisLabels} tickLine={false} axisLine={false} />
          <ChartTooltip content={<MerchantTooltipContent />} cursor={{ fill: "rgb(8 145 178 / 0.14)" }} />
          <Bar dataKey="count" name="Occurrences" fill={MERCHANT_BAR_COLOR} radius={[0, 6, 6, 0]} />
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
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
      <div className="bb-chart-tooltip-title">{row.label}</div>
      <div className="bb-chart-tooltip-row">
        <span className="bb-chart-tooltip-dot" style={{ background: MERCHANT_BAR_COLOR }} />
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

type ExpenseInsightsView = "largest" | "merchants"

function ExpenseInsightsCard({
  topEntries,
  merchantOccurrences,
  onViewChange,
}: {
  topEntries: ExpenseEntry[]
  merchantOccurrences: OccurrenceRow[]
  onViewChange: () => void
}) {
  const [view, setView] = useState<ExpenseInsightsView>("largest")
  const switchView = (nextView: string) => {
    const resolvedView = nextView as ExpenseInsightsView
    if (resolvedView === view) {
      return
    }
    onViewChange()
    setView(resolvedView)
  }

  return (
    <Card>
      <Tabs value={view} onValueChange={switchView} className="bb-card-tabs">
        <CardHeader>
          <div className="bb-card-title-row bb-inline-toggle-row">
            <CardTitle>Expense Highlights</CardTitle>
            <TabsList data-bb-tooltip-dismiss-trigger="expense-highlights">
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
    <div className="bb-details-panel" data-state={open ? "open" : "closed"}>
      <button type="button" className="bb-details-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {summary}
      </button>
      <div className="bb-details-content" aria-hidden={!open}>
        <div className="bb-details-content-inner">{children}</div>
      </div>
    </div>
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
      <div className="bb-details-content" data-state={expanded ? "open" : "closed"} aria-hidden={!expanded}>
        <div className="bb-details-content-inner">{children}</div>
      </div>
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

function DailyEntriesTable({ entries, categoryColors }: { entries: DailyEntryDisplayRow[]; categoryColors: Record<string, string> }) {
  if (!entries.length) {
    return <div className="bb-empty">No shared expense entries found.</div>
  }

  const grouped = new Map<string, DailyEntryDisplayRow[]>()
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
                        <strong className="bb-transaction-category" style={{ color: entry.categoryColor ?? categoryColors[entry.category] }}>
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

function compareDayGroups([left]: [string, DailyEntryDisplayRow[]], [right]: [string, DailyEntryDisplayRow[]]) {
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

function filterDailyEntries(entries: ExpenseEntry[], filter: DailySpendingFilter) {
  if (filter === "all") {
    return entries
  }
  return entries.filter((entry) => dailyEntryFilter(entry) === filter)
}

function dailyEntryFilter(entry: ExpenseEntry): Exclude<DailySpendingFilter, "all"> {
  return DAILY_WANTS_CATEGORIES.has(entry.category) ? "wants" : "needs"
}

function dailyEntriesWithSubscriptions(
  entries: ExpenseEntry[],
  subscriptionEvents: CalendarEvent[],
  month: number,
): DailyEntryDisplayRow[] {
  return [
    ...entries,
    ...subscriptionEvents.map((event) => {
      const bucket = dailySubscriptionBucket(event)
      return {
        date: `${month}/${event.day}`,
        category: "Subscription",
        amount: event.amount,
        person: bucket === "wants" ? "Want sub" : "Need sub",
        item: event.label,
        location: "",
        categoryColor: bucket === "wants" ? WANTS_BAR_COLOR : NEEDS_BAR_COLOR,
      }
    }),
  ]
}

function dailyTotalsForEntries(entries: ExpenseEntry[], subscriptionEvents: CalendarEvent[]) {
  const totals = new Map<string, DailySpendingRow>()
  for (const entry of entries) {
    const day = dailyEntryDayLabel(entry)
    if (day === null) {
      continue
    }
    const bucket = dailyEntryFilter(entry)
    addDailySpendingAmount(totals, day, bucket, entry.amount)
  }
  for (const event of subscriptionEvents) {
    addDailySpendingAmount(totals, String(event.day), dailySubscriptionBucket(event), event.amount)
  }
  return Array.from(totals.entries())
    .sort(([left], [right]) => compareDayLabels(left, right))
    .map(([, row]) => row)
}

function dailySpendingTotal(entries: ExpenseEntry[], subscriptionEvents: CalendarEvent[]) {
  return roundCurrency(
    entries.reduce((sum, entry) => sum + entry.amount, 0) +
      subscriptionEvents.reduce((sum, event) => sum + event.amount, 0),
  )
}

function addDailySpendingAmount(
  totals: Map<string, DailySpendingRow>,
  day: string,
  bucket: Exclude<DailySpendingFilter, "all">,
  amount: number,
) {
  const current = totals.get(day) ?? { label: day, amount: 0, needsAmount: 0, wantsAmount: 0 }
  totals.set(day, {
    ...current,
    amount: roundCurrency(current.amount + amount),
    needsAmount: roundCurrency(current.needsAmount + (bucket === "needs" ? amount : 0)),
    wantsAmount: roundCurrency(current.wantsAmount + (bucket === "wants" ? amount : 0)),
  })
}

function dailyEntryDayLabel(entry: ExpenseEntry) {
  if (!entry.date || entry.date.trim().toLowerCase() === "no date") {
    return null
  }
  const label = entry.date.split("/")[1] || entry.date
  return label.trim().toLowerCase() === "no date" ? null : label
}

function dailySpendingSubscriptionEvents(events: CalendarEvent[], filter: DailySpendingFilter, projected: boolean) {
  return events.filter((event) => {
    if (event.kind !== "subscription" || (!projected && event.projectedOnly)) {
      return false
    }
    if (filter === "all") {
      return true
    }
    return dailySubscriptionBucket(event) === filter
  })
}

function dailySubscriptionBucket(event: CalendarEvent): Exclude<DailySpendingFilter, "all"> {
  return event.group === "subscriptions_wants" ? "wants" : "needs"
}

function compareDayLabels(left: string, right: string) {
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
    <div
      className="bb-tabs-list bb-subscription-tone-control"
      role="tablist"
      aria-label="Calendar view"
      data-bb-tooltip-dismiss-trigger="calendar"
    >
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
      <div
        className="bb-subscription-tab-content bb-cashflow-calendar-content"
        data-state="active"
        data-bb-calendar-filter={filter}
      >
        <div className="bb-subscription-panel">
          <div className="bb-panel-head bb-subscription-summary">
            <div>
              <div className="bb-chart-kicker" data-bb-calendar-static-label="month">
                {monthOnlyLabel(monthLabel)}
              </div>
              <div className="bb-subscription-total">
                <CalendarChangingValue value={formatMoney(outflowTotal)} />
              </div>
              <div className="bb-chart-mode-note" data-bb-calendar-static-label="mode">
                {projected ? "Projected" : "Current"}
              </div>
            </div>
            <Badge variant="secondary">
              <CalendarChangingValue value={String(visibleEvents.length)} /> total
            </Badge>
          </div>
          <FinancialCalendar
            year={year}
            month={month}
            elapsedDays={elapsedDays}
            events={events}
            filter={filter}
          />
          {subscriptionItems.length ? (
            <DetailsPanel summary="Details" collapseKey={collapseKey}>
              <SubscriptionAllItemsGrid items={subscriptionItems} />
            </DetailsPanel>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function CalendarChangingValue({ value }: { value: string }) {
  const [currentValue, setCurrentValue] = useState(value)
  const [previousValue, setPreviousValue] = useState<string | null>(null)
  const transitionTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (value === currentValue) {
      return
    }
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current)
    }
    setPreviousValue(currentValue)
    setCurrentValue(value)
    transitionTimerRef.current = window.setTimeout(() => {
      setPreviousValue(null)
      transitionTimerRef.current = null
    }, 220)
  }, [currentValue, value])

  useEffect(() => () => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current)
    }
  }, [])

  return (
    <span className="bb-calendar-changing-value" aria-live="polite" data-bb-calendar-changing-value>
      {previousValue !== null ? (
        <span className="bb-calendar-changing-value-out" aria-hidden="true">
          {previousValue}
        </span>
      ) : null}
      <span
        className={previousValue !== null ? "bb-calendar-changing-value-in" : undefined}
        aria-label={currentValue}
      >
        {currentValue}
      </span>
    </span>
  )
}

function FinancialCalendar({
  year,
  month,
  elapsedDays,
  events,
  filter,
}: {
  year: number
  month: number
  elapsedDays: number
  events: CalendarEvent[]
  filter: CalendarFilter
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
          const indexedEvents = dayEvents.map((event, eventIndex) => ({ event, eventIndex }))
          const subscriptionEvents = indexedEvents.filter(({ event }) => event.kind === "subscription")
          const filteredEvents = filter === "all"
            ? indexedEvents
            : subscriptionEvents
          const visibleEventIndexes = new Set(filteredEvents.slice(0, 3).map(({ eventIndex }) => eventIndex))
          const renderableEventIndexes = new Set([
            ...indexedEvents.slice(0, 3).map(({ eventIndex }) => eventIndex),
            ...subscriptionEvents.slice(0, 3).map(({ eventIndex }) => eventIndex),
          ])
          const overflowGroups: Array<{ filter: CalendarFilter; events: CalendarEvent[] }> = [
            { filter: "all", events: indexedEvents.slice(3).map(({ event }) => event) },
            {
              filter: "subscription",
              events: subscriptionEvents.slice(3).map(({ event }) => event),
            },
          ]
          const isToday = day !== null && isCurrentCalendarDay(year, month, day)
          const hasHit = day !== null && day <= elapsedDays
          return (
            <div
              key={`${day ?? "blank"}-${index}`}
              className={[
                "bb-calendar-day",
                day === null ? "bb-calendar-day-muted" : "",
                filteredEvents.length ? "bb-calendar-day-has-items" : "",
                isToday ? "bb-calendar-day-today" : "",
              ].filter(Boolean).join(" ")}
              aria-hidden={day === null}
            >
              {day === null ? null : (
                <>
                  <div className="bb-calendar-day-number">{day}</div>
                  <div className="bb-calendar-marker-stack">
                    {indexedEvents
                      .filter(({ eventIndex }) => renderableEventIndexes.has(eventIndex))
                      .map(({ event: item, eventIndex }) => {
                        const style = calendarEventStyle(item)
                        const isVisible = visibleEventIndexes.has(eventIndex)
                        return (
                          <button
                            type="button"
                            key={calendarEventKey(item, eventIndex)}
                            className={[
                              "bb-subscription-marker",
                              "bb-calendar-marker-transition",
                              hasHit && !item.projectedOnly ? "" : "bb-subscription-marker-pending",
                            ].filter(Boolean).join(" ")}
                            data-visible={isVisible ? "true" : "false"}
                            data-calendar-event-kind={item.kind}
                            style={{
                              color: style.color,
                              backgroundColor: style.background,
                              borderColor: style.color,
                            }}
                            aria-label={calendarEventLabel(item)}
                            aria-hidden={!isVisible}
                            tabIndex={isVisible ? 0 : -1}
                          >
                            <span className="bb-subscription-marker-dot" />
                            <span className="bb-subscription-marker-name">{item.label}</span>
                            <span className="bb-subscription-marker-amount">{formatMoney(item.amount)}</span>
                            <CalendarEventTooltip event={item} />
                          </button>
                        )
                      })}
                    {overflowGroups
                      .filter((overflowGroup) => overflowGroup.events.length > 0)
                      .map((overflowGroup) => {
                        const hiddenCount = overflowGroup.events.length
                        const isVisible = overflowGroup.filter === filter
                        return (
                          <button
                            type="button"
                            key={`overflow-${overflowGroup.filter}`}
                            className={[
                              "bb-subscription-marker",
                              "bb-subscription-marker-more",
                              "bb-calendar-marker-transition",
                              hasHit ? "" : "bb-subscription-marker-pending",
                            ].filter(Boolean).join(" ")}
                            data-visible={isVisible ? "true" : "false"}
                            data-calendar-overflow-filter={overflowGroup.filter}
                            aria-label={`${hiddenCount} more event${hiddenCount === 1 ? "" : "s"} on day ${day}`}
                            aria-hidden={!isVisible}
                            tabIndex={isVisible ? 0 : -1}
                          >
                            +{hiddenCount} more
                            <CalendarOverflowTooltip events={overflowGroup.events} day={day} />
                          </button>
                        )
                      })}
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

function calendarEventKey(event: CalendarEvent, index: number) {
  return [
    event.kind,
    event.group,
    event.day,
    event.label,
    event.amount,
    event.projectedOnly ? "projected" : "actual",
    index,
  ].join("-")
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

function BillsUtilitiesPanel({
  items,
  events,
  year,
  month,
  projected,
  collapseKey,
}: {
  items: UtilityHistoryItem[]
  events: CalendarEvent[]
  year: number
  month: number
  projected: boolean
  collapseKey: number
}) {
  const billEvents = billsUtilitiesEvents(events)
  const currentTotal = billsUtilitiesPanelTotal(items, billEvents, projected)

  return (
    <div className="bb-bills-analytics">
      <div className="bb-panel-head bb-bills-analytics-head">
        <div>
          <div className="bb-chart-kicker">Bills & Utilities</div>
          <div className="bb-chart-total">{formatMoney(currentTotal)}</div>
          <div className="bb-chart-mode-note">{projected ? "Projected" : "Current"}</div>
        </div>
        <Badge variant="secondary">{items.length} tracked</Badge>
      </div>
      {!items.length ? (
        <div className="bb-empty">No bill history found.</div>
      ) : (
        <>
          <BillsUtilitiesChart items={items} billEvents={billEvents} year={year} month={month} />
          <DetailsPanel summary="Details" collapseKey={collapseKey}>
            <BillsUtilitiesSummary items={items} />
          </DetailsPanel>
        </>
      )}
    </div>
  )
}

function BillsUtilitiesChart({
  items,
  billEvents,
  year,
  month,
}: {
  items: UtilityHistoryItem[]
  billEvents: CalendarEvent[]
  year: number
  month: number
}) {
  const rows = utilityHistoryChartRows(items)
  const eventByLabel = billEventByLabel(billEvents)

  return (
    <ChartContainer config={utilityHistoryChartConfig(items)} className="bb-bills-chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 12, right: 20, left: 0, bottom: 6 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} width={54} />
          <ChartTooltip content={<BillsUtilitiesTooltipContent eventByLabel={eventByLabel} year={year} month={month} />} />
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

function billsUtilitiesEvents(events: CalendarEvent[]) {
  return events.filter((item) => item.kind === "bill" && item.group === "bills_utilities")
}

function billsUtilitiesPanelTotal(items: UtilityHistoryItem[], events: CalendarEvent[], projected: boolean) {
  if (events.length) {
    return roundCurrency(
      events
        .filter((item) => projected || !item.projectedOnly)
        .reduce((sum, item) => sum + item.amount, 0),
    )
  }
  return roundCurrency(items.reduce((sum, item) => sum + item.currentAmount, 0))
}

function billEventByLabel(events: CalendarEvent[]) {
  return new Map(events.map((event) => [normalizeChartLabel(event.label), event]))
}

type BillsUtilitiesTooltipPayload = {
  name?: string | number
  value?: string | number | null
  color?: string
  payload?: Record<string, string | number>
}

function BillsUtilitiesTooltipContent({
  active,
  payload,
  eventByLabel,
  year,
  month,
}: {
  active?: boolean
  payload?: BillsUtilitiesTooltipPayload[]
  eventByLabel: Map<string, CalendarEvent>
  year: number
  month: number
}) {
  const rows = (payload ?? []).filter((item) => item.value !== null && item.value !== undefined)
  if (!active || !rows.length) {
    return null
  }
  const title = String(rows[0]?.payload?.label ?? "Bills")

  return (
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
      <div className="bb-chart-tooltip-title">{title}</div>
      {rows.map((item, index) => {
        const name = String(item.name ?? "")
        const event = eventByLabel.get(normalizeChartLabel(name))
        return (
          <div className="bb-chart-tooltip-row" key={`${name}-${item.value}-${index}`}>
            <span className="bb-chart-tooltip-dot" style={{ background: item.color }} />
            <span>
              <span>{name}</span>
              {event ? <small>{billHitTooltipLabel(event, year, month)}</small> : null}
            </span>
            <strong>{formatMoney(Number(item.value || 0))}</strong>
          </div>
        )
      })}
    </div>
  )
}

function billHitTooltipLabel(event: CalendarEvent, year: number, month: number) {
  const date = new Date(year, month - 1, event.day)
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date)
  return `${event.projectedOnly ? "Upcoming" : "Hit"} ${weekday} ${ordinalDay(event.day)}`
}

function ordinalDay(day: number) {
  const mod10 = day % 10
  const mod100 = day % 100
  if (mod10 === 1 && mod100 !== 11) {
    return `${day}st`
  }
  if (mod10 === 2 && mod100 !== 12) {
    return `${day}nd`
  }
  if (mod10 === 3 && mod100 !== 13) {
    return `${day}rd`
  }
  return `${day}th`
}

function normalizeChartLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "")
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
      {items.map((item, index) => {
        const color = chartColor(index)
        const hasAverage = item.averageAmount > 0
        const deltaClass = hasAverage && item.deltaAmount > 0 ? "bb-negative" : hasAverage && item.deltaAmount < 0 ? "bb-positive" : ""
        return (
          <div className="bb-bill-history-row" key={item.key}>
            <span>
              <strong className="bb-bill-history-name">
                <span className="bb-bill-history-dot" style={{ background: color }} />
                <span>{item.label}</span>
              </strong>
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
          <SubscriptionRowsTable items={rows} compact dividerBeforeIndex={expanded && hasMore ? visibleItems.length : undefined} />
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
      <SubscriptionRowsTable items={rows} dividerBeforeIndex={expanded && hasMore ? visibleItems.length : undefined} />
      {hasMore ? <ExpandRowsButton expanded={expanded} total={items.length} onToggle={() => setExpanded((current) => !current)} /> : null}
    </>
  )
}

function SubscriptionRowsTable({
  items,
  compact = false,
  dividerBeforeIndex,
}: {
  items: SubscriptionItem[]
  compact?: boolean
  dividerBeforeIndex?: number
}) {
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
            <tr
              key={`${item.name}-${item.amount}-${index}`}
              className={dividerBeforeIndex !== undefined && index === dividerBeforeIndex ? "bb-table-row-divider" : undefined}
            >
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
