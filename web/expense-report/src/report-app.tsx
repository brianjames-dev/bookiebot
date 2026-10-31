import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { ChevronDown, X } from "lucide-react"
import { Popover } from "konsta/react"
import { useCategoryContour, CategoryContourCallouts } from "./category-mix-contour"
import { categoryCenterStyle, CategoryRingCenterSync } from "./category-mix-motion"
import { CONTOUR_PADDING_ANGLE } from "./category-mix-layout"
import { burnRateBalance, burnRateTooltipOccluders, positionBurnRateTooltip } from "./burn-rate-tooltip"
import { useChartSwipe } from "./chart-swipe"
import { categoryRingAnimation, stableBarAnimation, stableBarShape, StablePieSector, type AnimatedPieSector } from "./chart-animation"
import { ReportScreen, useAppNavigation } from "./app-navigation"
import { ReportBrand, ReportHeader } from "./report-header"
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Sector,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "./components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { FittedAmount } from "./components/ui/fitted-amount"
import { ReportMenu } from "./components/ui/report-menu"
import { SavingsGoals } from "./savings-goals"
import { Investments } from "./investments"
import { PhoneNotifications } from "./phone-notifications"
import { ReportQuestions } from "./report-questions"
import { SharedReimbursementsCard } from "./shared-reimbursements"
import { ReimbursementLedger } from "./reimbursement-ledger"
import { reportActivity, activitySummary, activityDay, activityMatchesCategory, calendarActivityCategory, calendarActivityStatus, type ReportActivity } from "./report-activity"
import type { MetricExplanation } from "./types"
import { useReportViewPreferences, type PreferredChart } from "./report-view-preferences"
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartTooltipDismissProvider, useChartTooltipDismiss } from "./components/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { CollapsibleContent, SlidingSelection } from "./components/ui/motion"
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
  ReportModeView,
  SubscriptionItem,
  UtilityHistoryItem,
} from "./types"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})
const wholeMoney = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0})

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

export function useExpenseReportTheme(enabled = true) {
  const [{ theme, hasOverride }, setThemeState] = useState<ThemeState>(initialThemeState)

  useEffect(() => {
    if (enabled) applyTheme(theme)
  }, [theme, enabled])

  useEffect(() => {
    if (typeof window === "undefined" || hasOverride || !enabled) {
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
  }, [hasOverride, enabled])

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
}

type CalendarFilter = "all" | "subscription"
type DailySpendingFilter = "all" | "needs" | "wants"
type CategoryMixFilter = "all" | BudgetCategoryKey

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
const LEFT_CATEGORY_COLOR = "hsl(var(--category-remaining))"
const SAVINGS_CATEGORY_COLOR = "hsl(var(--chart-5))"
const NEEDS_BAR_COLOR = "hsl(var(--chart-1))"
const WANTS_BAR_COLOR = "hsl(var(--chart-2))"
const DAILY_SPENDING_BAR_RADIUS: [number, number, number, number] = [2, 2, 2, 2]
const DAILY_SPENDING_GRID_COLOR = "hsl(var(--muted-foreground))"
const DAILY_SPENDING_BOUNDARY_COLOR = "hsl(var(--foreground))"
const TOP_EXPENSE_HEAT_COLORS = Array.from({ length: 10 }, (_, index) => `hsl(var(--chart-1) / ${1 - index * 0.055})`)
const MERCHANT_BAR_COLOR = "hsl(var(--chart-5))"
const CATEGORY_CHART_COLORS: Record<string, string> = {
  rent: "hsl(var(--category-rent))",
  bills_utilities: "hsl(var(--category-bills))",
  static_bills_subscriptions_needs: "hsl(var(--category-subs-needs))",
  subscriptions_wants: "hsl(var(--category-subs-wants))",
  need_expenses: "hsl(var(--category-need))",
  grocery: "hsl(var(--category-grocery))",
  gas: "hsl(var(--category-gas))",
  food: "hsl(var(--category-food))",
  shopping: "hsl(var(--category-shopping))",
}

type ReportView = ReportModeView
type MetricInspection = MetricExplanation & { key: "income" | "spent" | "left" | "saved"; view: ReportView }

function reportSpentTotal(metrics: ReportView["metrics"]) {
  return roundCurrency(metrics.totalExpenses)
}

function buildReportView(report: ExpenseReportData, projected: boolean): ReportView {
  const serverView = projected ? report.modeViews?.projected : report.modeViews?.current
  if (serverView) {
    return serverView
  }
  const breakdown = projected ? projectedBreakdown(report) : report.breakdown
  const depositedIncome = projected ? report.incomeProjection.projectedAmount : report.incomeProjection.currentAmount
  const savings = savingsForMode(report, projected)
  const totalExpenses = projected ? amountRowsTotal(breakdown) : report.metrics.totalExpenses
  const currentBudgets = currentCategoryBudgets(report)
  const savingsInvesting = report.savingsInvesting?.[projected ? "projected" : "current"]
  const monthlyIncome = savingsInvesting?.takeHomeBeforeEspp ?? depositedIncome
  const categoryBudgets = savingsInvesting?.categoryBudgets ?? (projected ? projectedCategoryBudgets(depositedIncome) : currentBudgets)
  const categorySpending = categorySpendingForBreakdown(
    breakdown,
    savings.amount,
    report.categorySpending,
  )
  const categoryBalances = projectedCategoryBalances(categoryBudgets, categorySpending)
  const budgetRemaining = categoryBalanceTotal(categoryBalances)
  return {
    savingsInvesting,
    metrics: {
      totalExpenses,
      monthlyIncome,
      incomeAfterExpenses: roundCurrency(budgetRemaining),
      amountSaved: savingsInvesting?.combinedContributions ?? savings.amount,
      savingsIdeal: savings.ideal,
      savingsMinimum: savings.minimum,
    },
    categoryBalances,
    categoryBudgets,
    categorySpending,
    breakdown,
    burnRate: projected
      ? projectedBurnRateFromIncome(report.burnRate, categoryBalances)
      : report.burnRate,
    calendarEvents: calendarEventsForMode(report.calendarEvents),
    utilityHistory: report.utilityHistory,
  }
}

function projectedBreakdown(report: ExpenseReportData) {
  // The server's projected breakdown includes both fixed bills and subscriptions.
  // Optional history/detail lists cannot replace those complete category totals.
  if (report.budgetBreakdown?.length) {
    return report.budgetBreakdown
  }
  const subscriptionTotals = projectedSubscriptionTotals(report)
  const billTotals = projectedBillTotals(report)
  const rows = report.breakdown.map((item) => {
    let amount = item.amount
    if (item.key === "static_bills_subscriptions_needs") {
      amount = Math.max(amount, subscriptionTotals.needs + billTotals.staticNeeds)
    } else if (item.key === "subscriptions_wants") {
      amount = Math.max(amount, subscriptionTotals.wants)
    } else if (item.key === "rent") {
      amount = Math.max(amount, billTotals.rent)
    } else if (item.key === "bills_utilities") {
      amount = Math.max(amount, billTotals.billsUtilities)
    }
    return { ...item, amount: roundCurrency(amount) }
  })
  const total = amountRowsTotal(rows)
  return rows.map((item) => ({
    ...item,
    percentage: total ? roundCurrency((item.amount / total) * 100) : 0,
  }))
}

function savingsForMode(report: ExpenseReportData, projected: boolean) {
  const savings = report.savingsProjection
  return {
    amount: savings.currentAmount,
    ideal: projected ? savings.projectedIdeal : savings.currentIdeal,
    minimum: projected ? savings.projectedMinimum : savings.currentMinimum,
  }
}

function currentCategoryBudgets(report: ExpenseReportData): CategoryBalanceAmounts {
  if (report.categoryBudgets) {
    return report.categoryBudgets
  }
  return projectedCategoryBudgets(report.incomeProjection.currentAmount)
}

function projectedCategoryBudgets(monthlyIncome: number): CategoryBalanceAmounts {
  const needs = roundCurrency(monthlyIncome * 0.5)
  const savings = roundCurrency(monthlyIncome * 0.2)
  const wants = roundCurrency(monthlyIncome - needs - savings)
  return { needs, wants, savings }
}

function categorySpendingForBreakdown(
  breakdown: BreakdownItem[],
  amountSaved: number,
  fallback?: CategoryBalanceAmounts,
): CategoryBalanceAmounts {
  const needs = breakdown
    .filter((item) => CATEGORY_NEEDS_KEYS.has(item.key))
    .reduce((total, item) => total + item.amount, 0)
  const wants = breakdown
    .filter((item) => CATEGORY_WANTS_KEYS.has(item.key))
    .reduce((total, item) => total + item.amount, 0)
  return {
    needs: roundCurrency(needs > 0 ? needs : fallback?.needs ?? 0),
    wants: roundCurrency(wants > 0 ? wants : fallback?.wants ?? 0),
    savings: roundCurrency(amountSaved),
  }
}

function projectedCategoryBalances(
  budgets: CategoryBalanceAmounts,
  spending: CategoryBalanceAmounts,
) {
  return cascadeCategoryBalances({
    needs: roundCurrency(budgets.needs - spending.needs),
    wants: roundCurrency(budgets.wants - spending.wants),
    savings: roundCurrency(budgets.savings - spending.savings),
  })
}

function categoryBalanceTotal(balances: CategoryBalances) {
  return roundCurrency(Object.values(balances.remaining).reduce((total, amount) => total + amount, 0))
}

function categoryBudgetTotal(budgets: CategoryBalanceAmounts) {
  return roundCurrency(Object.values(budgets).reduce((total, amount) => total + amount, 0))
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
  const totalFor = (group: string) => report.calendarEvents
    .filter((item) => item.kind === "bill" && item.group === group)
    .reduce((sum, item) => sum + item.amount, 0)
  return {
    rent: roundCurrency(totalFor("rent")),
    staticNeeds: roundCurrency(totalFor("static_bills_subscriptions_needs")),
    billsUtilities: roundCurrency(Math.max(
      totalFor("bills_utilities"),
      report.utilityHistory.reduce((sum, item) => sum + item.currentAmount, 0),
    )),
  }
}

function projectedBurnRateFromIncome(
  burnRate: BurnRate | null,
  categoryBalances: CategoryBalances,
) {
  if (!burnRate) {
    return null
  }
  const spent = roundCurrency(burnRate.spent)
  const budget = roundCurrency(spent + categoryBalances.remaining.wants)
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

function useViewportScrollbarWidth() {
  useLayoutEffect(() => {
    const root = document.documentElement
    const update = () => {
      if (root.dataset.bbModalScrollLock === "true") return
      root.style.setProperty("--bb-viewport-scrollbar-width", `${Math.max(window.innerWidth - root.clientWidth, 0)}px`)
    }
    update()
    window.addEventListener("resize", update)
    return () => {
      window.removeEventListener("resize", update)
      root.style.removeProperty("--bb-viewport-scrollbar-width")
    }
  }, [])
}

export function ExpenseReportApp({ report, appControls, appAvatarUrl, appSession, appMonthControl, appComparison, appUpdate, externalHeader = false }: {
  externalHeader?: boolean
  appUpdate?: ReactNode
  appMonthControl?: ReactNode
  appComparison?: ReactNode
  report: ExpenseReportData
  appControls?: ReactNode
  appAvatarUrl?: string
  appSession?: { signOut: () => void; signingOut: boolean }
}) {
  const navigation = useAppNavigation()
  const { theme, toggleTheme } = useExpenseReportTheme(!navigation)
  const [metricInspection, setMetricInspection] = useState<MetricInspection | null>(null)
  useViewportScrollbarWidth()
  const [inspection, setInspection] = useState<{key:string; title:string; entries:ReportActivity[]; total:number; note?:string} | null>(null)
  const localPreferences = useReportViewPreferences(report.ownerName, Boolean(report.burnRate), Boolean(appSession))
  const viewPreferences = navigation?.preferences ?? localPreferences
  const projectionActive = viewPreferences.mode === "projected"
  const [chartTooltipDismissRevision, setChartTooltipDismissRevision] = useState(0)
  const [chartCollapseKey, setChartCollapseKey] = useState(0)
  const [sourceRequest, setSourceRequest] = useState<{ section: string; id: number } | null>(null)
  const dismissChartTooltips = useCallback(() => setChartTooltipDismissRevision(current => current + 1), [])
  const showQuestionSource = useCallback((section: string) => {
    setSourceRequest(current => ({ section, id: (current?.id ?? 0) + 1 }))
  }, [])
  const preferencesRef = useRef(viewPreferences)
  preferencesRef.current = viewPreferences
  const selectChart = useCallback((chart: PreferredChart) => preferencesRef.current.setChartId(chart), [])
  const toggleProjection = () => {
    dismissChartTooltips()
    viewPreferences.setMode(projectionActive ? "current" : "projected")
  }
  const activeReport = useMemo(() => buildReportView(report, projectionActive), [report, projectionActive])
  const chartBreakdown = useMemo(() => activeReport.breakdown.map((item) => ({ ...item, color: CATEGORY_CHART_COLORS[item.key] ?? item.color })), [activeReport.breakdown])
  const categoryColors: Record<string, string> = useMemo(() => Object.fromEntries(chartBreakdown.map((item) => [item.label, item.color])), [chartBreakdown])
  const metricDetails = report.metricExplanations?.[projectionActive ? "projected" : "current"]
  const allActivity = useMemo(() => reportActivity(report, activeReport.calendarEvents, projectionActive), [report, activeReport.calendarEvents, projectionActive])
  const activityRef = useRef(allActivity)
  activityRef.current = allActivity
  const inspectCategory = useCallback((item: BreakdownItem) => {
    setChartTooltipDismissRevision(current => current + 1)
    setChartCollapseKey(current => current + 1)
    const entries = activityRef.current.filter(entry => activityMatchesCategory(entry, item))
    setInspection({key:`category-${item.key}`, title:item.label, entries, total:item.amount,
      note:item.key === "left" ? "Available budget after spending and savings; this is a balance, not a transaction." : item.key === "savings" ? "Monthly cash savings are summarized in Saved." : item.key === "espp" ? "Calculated from enrolled payroll and already withheld before deposit. Projected mode includes explicitly estimated contributions." : undefined})
  }, [])
  const inspectDay = useCallback((day: string, dailySpendingFilter: DailySpendingFilter, category = "") => {
    dismissChartTooltips()
    const entries = allActivity.filter(entry => (Number.isFinite(Number(day)) ? entry.day === Number(day) : entry.day === null) && (dailySpendingFilter === "all" || dailyEntryFilter(entry) === dailySpendingFilter) && (!category || entry.category === category))
    setInspection({key:`day-${day}`, title:Number.isFinite(Number(day)) ? `${monthOnlyLabel(report.monthLabel)} ${day}` : "Entries without a date", entries, total:activitySummary(entries).total})
  }, [allActivity, report.monthLabel, dismissChartTooltips])
  const spentTotal = reportSpentTotal(activeReport.metrics)
  useEffect(() => {
    if (!navigation) return
    dismissChartTooltips()
    setMetricInspection(null)
    setInspection(null)
  }, [navigation?.screen, projectionActive])

  return (
    <div className={navigation ? "bb-report-content" : "bb-page"}>
      {!navigation && <div className="bb-masthead">
        <ReportBrand owner={report.ownerName} avatarUrl={appAvatarUrl}
          status={appControls ?? <span className="bb-report-updated">Updated {generatedTimeLabel(report.generatedAt)}</span>} />
        <ReportMenu>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {appSession && <button type="button" className="bb-report-menu-action" disabled={appSession.signingOut} onClick={appSession.signOut}>
            {appSession.signingOut ? "Signing out…" : "Sign out"}
          </button>}
        </ReportMenu>
      </div>}
      {!externalHeader && <ReportHeader month={appMonthControl ?? report.monthLabel} projected={projectionActive} onToggle={toggleProjection}
        hidden={Boolean(navigation && navigation.screen !== "overview")} />}
      {appUpdate}
      <ChartTooltipDismissProvider revision={chartTooltipDismissRevision}>
        <main className="bb-main" data-bb-tooltip-dismiss-revision={chartTooltipDismissRevision}>
        <ReportScreen name="overview">
        <section className="bb-metrics-grid" aria-label="Budget metrics">
          <MetricCard
            label="Income"
            onExplain={metricDetails ? () => setMetricInspection({...metricDetails.income, key: "income", view: activeReport}) : undefined}
            value={activeReport.metrics.monthlyIncome}
          />
          <MetricCard label="Spent" value={spentTotal} onExplain={metricDetails ? () => setMetricInspection({...metricDetails.spent, value: spentTotal, key: "spent", view: activeReport}) : undefined} />
          <MetricCard
            label="Left"
            onExplain={metricDetails ? () => setMetricInspection({...metricDetails.left, key: "left", view: activeReport}) : undefined}
            value={activeReport.metrics.incomeAfterExpenses}
            accent
          >
            <RemainingCategoryBars balances={activeReport.categoryBalances} budgets={activeReport.categoryBudgets}
              onExplain={metricDetails ? () => setMetricInspection({...metricDetails.left, key: "left", view: activeReport}) : undefined} />
          </MetricCard>
          <SavingsMetricCard
            progressValue={activeReport.savingsInvesting?.cashSaved}
            onExplain={metricDetails ? () => setMetricInspection({...metricDetails.saved, key: "saved", view: activeReport}) : undefined}
            value={activeReport.metrics.amountSaved}
            minimum={activeReport.metrics.savingsMinimum}
            ideal={activeReport.metrics.savingsIdeal}
          />
        </section>

        {appComparison}
        <OverviewCharts report={report} activeReport={activeReport} chartBreakdown={chartBreakdown}
          projected={projectionActive} preferredChart={viewPreferences.chartId} onChartChange={selectChart}
          onInspectCategory={inspectCategory} collapseKey={chartCollapseKey}
          sourceRequest={sourceRequest} />
        <DailySpendingCard report={report} calendarEvents={activeReport.calendarEvents}
          projected={projectionActive} categoryColors={categoryColors} onInspectDay={inspectDay} />

        {navigation && <MemoizedExpenseInsightsCard topEntries={report.topEntries} merchantOccurrences={report.merchantOccurrences} />}
        </ReportScreen>

        {!navigation && (appSession ? <ReimbursementLedger refreshKey={report.generatedAt} fallback={
          <SharedReimbursementsCard items={report.sharedReimbursements ?? []} openItems={report.openSharedReimbursements}
            receivedItems={report.receivedSharedReimbursements} coverage={report.reimbursementCoverage}
            monthLabel={report.monthLabel} year={report.year} month={report.month} />
        } /> : <SharedReimbursementsCard items={report.sharedReimbursements ?? []} openItems={report.openSharedReimbursements}
          receivedItems={report.receivedSharedReimbursements} coverage={report.reimbursementCoverage}
          monthLabel={report.monthLabel} year={report.year} month={report.month} />)}

        {!navigation && <MemoizedExpenseInsightsCard
          topEntries={report.topEntries}
          merchantOccurrences={report.merchantOccurrences}
        />}

        {!navigation && appSession && <SavingsGoals />}
        {!navigation && <Investments report={report} />}

        {!navigation && appSession && <ReportQuestions month={`${report.year}-${String(report.month).padStart(2, "0")}`}
          mode={projectionActive ? "projected" : "current"} onShowSource={showQuestionSource} />}

        {!navigation && appSession && <PhoneNotifications />}

        <ModalDetails summary="Calculation" title={`${metricInspection?.title ?? "Total"} explained`} selection={metricInspection?.title ?? null}
          onDismiss={() => setMetricInspection(null)} triggerHidden>
          {metricInspection && <MetricExplanationDetails detail={metricInspection} />}
        </ModalDetails>
        <ModalDetails summary="Transactions" title={inspection?.title ?? "Transactions"} selection={inspection?.key ?? null}
          onDismiss={() => setInspection(null)} triggerHidden>
          {inspection && <ActivityDetails entries={inspection.entries} total={inspection.total} note={inspection.note} colors={categoryColors} />}
        </ModalDetails>
        </main>
      </ChartTooltipDismissProvider>
    </div>
  )
}

const MemoizedBurnRateChart = memo(BurnRateChart)
const MemoizedCalendarAnalyticsPanel = memo(CalendarAnalyticsPanel)
const MemoizedBillsUtilitiesPanel = memo(BillsUtilitiesPanel)
const MemoizedExpenseInsightsCard = memo(ExpenseInsightsCard)

const OverviewCharts = memo(function OverviewCharts({ report, activeReport, chartBreakdown, projected: projectionActive,
  preferredChart, onChartChange, onInspectCategory: inspectCategory, collapseKey, sourceRequest }: {
  report: ExpenseReportData
  activeReport: ReturnType<typeof buildReportView>
  chartBreakdown: BreakdownItem[]
  projected: boolean
  preferredChart: PreferredChart
  onChartChange: (chart: PreferredChart) => void
  onInspectCategory: (item: BreakdownItem) => void
  collapseKey: number
  sourceRequest: { section: string; id: number } | null
}) {
  const navigation = useAppNavigation()
  const [categoryMixFilter, setCategoryMixFilter] = useState<CategoryMixFilter>("all")
  const [calendarFilter, setCalendarFilter] = useState<CalendarFilter>("all")
  const tooltipCooldownTimeoutRef = useRef<number | null>(null)
  const [chartTooltipCooldown, setChartTooltipCooldown] = useState(false)
  const [localCollapseKey, setLocalCollapseKey] = useState(0)
  const dismissChartTooltips = useChartTooltipDismiss()
  const switchCategoryMixFilter = useCallback((nextFilter: CategoryMixFilter) => {
    if (nextFilter === categoryMixFilter) {
      return
    }
    dismissChartTooltips()
    setCategoryMixFilter(nextFilter)
  }, [categoryMixFilter, dismissChartTooltips])
  const switchCalendarFilter = useCallback((nextFilter: CalendarFilter) => {
    if (nextFilter === calendarFilter) {
      return
    }
    dismissChartTooltips()
    setCalendarFilter(nextFilter)
  }, [calendarFilter, dismissChartTooltips])
  const chartCollapseKey = collapseKey + localCollapseKey
  const chartPanels: ChartPanel[] = [
    {
      id: "category",
      title: "Category Mix",
      content: (
        <CategoryMixChart
          data={chartBreakdown}
          onInspect={inspectCategory}
          categoryBalances={activeReport.categoryBalances}
          categoryBudgets={activeReport.categoryBudgets}
          amountSaved={activeReport.savingsInvesting?.cashSaved ?? activeReport.metrics.amountSaved}
          allSpentTotal={reportSpentTotal(activeReport.metrics)}
          espp={activeReport.savingsInvesting?.esppContribution}
          estimatedEspp={activeReport.savingsInvesting?.estimatedEsppContribution}
          filter={categoryMixFilter}
          onFilterChange={switchCategoryMixFilter}
          projected={projectionActive}
        />
      ),
    },
    ...(activeReport.burnRate
      ? [
          {
            id: "burn-rate",
            title: "Burn Rate",
            content: (
              <MemoizedBurnRateChart
                burnRate={activeReport.burnRate}
                categoryBalances={activeReport.categoryBalances}
                month={report.month}
                collapseKey={chartCollapseKey}
              />
            ),
          },
        ]
      : []),
    {
      id: "calendar",
      title: "Calendar",
      content: (
        <MemoizedCalendarAnalyticsPanel
          year={report.year}
          month={report.month}
          monthLabel={report.monthLabel}
          elapsedDays={report.elapsedDays}
          events={activeReport.calendarEvents}
          filter={calendarFilter}
          onFilterChange={switchCalendarFilter}
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
        <MemoizedBillsUtilitiesPanel
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
  const activeChartIndex = Math.max(0, chartPanels.findIndex(panel => panel.id === preferredChart))

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
    setLocalCollapseKey((current) => current + 1)
    dismissChartTooltips()
    startChartTooltipCooldown()
    onChartChange(chartPanels[next].id as PreferredChart)
  }

  const showQuestionSource = (section: string) => {
    const chart: Record<string, string> = { categories: "category", cash_flow: "calendar", commitments: "bills", burn_rate: "burn-rate" }
    const selectors: Record<string, string> = { overview: ".bb-metrics-grid", activity: ".bb-daily-section", reimbursements: ".bb-reimbursement-section" }
    if (chart[section]) {
      const index = chartPanels.findIndex(panel => panel.id === chart[section])
      if (index < 0) return
      switchChart(index)
    }
    const target = document.querySelector<HTMLElement>(chart[section] ? ".bb-chart-carousel-band" : selectors[section] || ".bb-metrics-grid")
    if (target) {
      target.tabIndex = -1
      target.focus({ preventScroll: true })
      target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
    }
  }

  useEffect(() => {
    const request = navigation?.sourceRequest ?? sourceRequest
    if (!request || (navigation && request.section === "reimbursements")) return
    // Let the Ask panel finish its exit and release focus before the drilldown.
    const timer = window.setTimeout(() => {
      showQuestionSource(request.section)
      navigation?.consumeSource?.(request.id)
    }, navigation ? 280 : 0)
    return () => window.clearTimeout(timer)
  }, [navigation?.sourceRequest?.id, navigation?.screen, sourceRequest?.id])

  const swipe = useChartSwipe({ index: activeChartIndex, count: chartPanels.length,
    onSelect: switchChart, onDragStart: dismissChartTooltips, ignoreTarget: isInteractiveTouchTarget })

  return <>
        <section
          className="bb-chart-carousel-band"
          style={{ "--bb-chart-indicator-count": chartPanels.length } as CSSProperties}
          role="region"
          aria-roledescription="carousel"
          aria-label="Budget charts"
        >
          <ChartCarouselNavigation
            panels={chartPanels}
            activeIndex={activeChartIndex}
            onSelect={switchChart}
          />
          <div
            className="bb-chart-carousel"
            ref={swipe.viewportRef}
            data-dragging="false"
            data-tooltip-cooldown={chartTooltipCooldown ? "true" : "false"}
            onTouchStartCapture={swipe.onTouchStartCapture}
            onTouchMoveCapture={swipe.onTouchMoveCapture}
            onTouchEndCapture={swipe.onTouchEndCapture}
            onTouchCancelCapture={swipe.onTouchCancelCapture}
            onClickCapture={swipe.onClickCapture}
          >
            <div
              ref={swipe.trackRef}
              className="bb-chart-carousel-track"
            >
              {chartPanels.map((panel, index) => (
                <div
                  className="bb-chart-carousel-slide"
                  key={panel.id}
                  id={`bb-chart-${panel.id}`}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={panel.title}
                  aria-hidden={index !== activeChartIndex}
                  inert={index !== activeChartIndex}
                >
                  <div className="bb-chart-carousel-heading">
                    <h2 className="bb-chart-carousel-title">
                      <FittedAmount className="bb-chart-carousel-title-value">{panel.title}</FittedAmount>
                    </h2>
                  </div>
                  <CardContent>{panel.content}</CardContent>
                </div>
              ))}
            </div>
          </div>
        </section>
  </>
})

const DailySpendingCard = memo(function DailySpendingCard({ report, calendarEvents, projected: projectionActive,
  categoryColors, onInspectDay }: {
  report: ExpenseReportData
  calendarEvents: CalendarEvent[]
  projected: boolean
  categoryColors: Record<string, string>
  onInspectDay: (day: string, filter: DailySpendingFilter, category?: string) => void
}) {
  const [dailySpendingFilter, setDailySpendingFilter] = useState<DailySpendingFilter>("all")
  const dismissChartTooltips = useChartTooltipDismiss()
  const switchDailySpendingFilter = (filter: DailySpendingFilter) => {
    if (filter === dailySpendingFilter) return
    dismissChartTooltips()
    setDailySpendingFilter(filter)
  }
  const { dailyTableEntries, dailyTotals, dailyTotal } = useMemo(() => {
    const dailyEntries = filterDailyEntries(report.dailyEntries, dailySpendingFilter)
    const dailyCalendarEvents = dailySpendingCalendarEvents(calendarEvents, dailySpendingFilter, projectionActive)
    const dailyTableEntries = dailyEntriesWithCalendarEvents(dailyEntries, dailyCalendarEvents, report.month)
    const dailyTotals = dailyTotalsForEntries(dailyEntries, dailyCalendarEvents, report.year, report.month)
    const dailyTotal = dailySpendingTotal(dailyEntries, dailyCalendarEvents)
    return { dailyTableEntries, dailyTotals, dailyTotal }
  }, [report.dailyEntries, report.year, report.month, calendarEvents, projectionActive, dailySpendingFilter])
  const inspectDay = useCallback((day: string, category?: string) => onInspectDay(day, dailySpendingFilter, category), [onInspectDay, dailySpendingFilter])
  return (
        <Card className="bb-report-section bb-daily-section">
          <CardHeader>
            <div className="bb-card-title-row bb-inline-toggle-row">
              <CardTitle>Daily Spending</CardTitle>
              <DailySpendingFilterControl filter={dailySpendingFilter} onFilterChange={switchDailySpendingFilter} />
            </div>
          </CardHeader>
          <CardContent className="bb-daily-spending-content">
            <DailySpendingSection
              data={dailyTotals}
              onInspectDay={inspectDay}
              total={dailyTotal}
              filter={dailySpendingFilter}
              entries={dailyTableEntries}
              categoryColors={categoryColors}
              year={report.year}
              month={report.month}
            />
          </CardContent>
        </Card>
  )
})

function MetricExplanationDetails({detail}: {detail:MetricInspection}) {
  const {key, view} = detail
  if (key === "saved") {
    const {savingsMinimum: minimum, savingsIdeal: ideal} = view.metrics
    return <div className="bb-metric-explanation">
      <div className="bb-chart-total">{formatMoney(detail.value)}</div>
      <SavingsProgress value={view.savingsInvesting?.cashSaved ?? detail.value} minimum={minimum} ideal={ideal} showTargets={false} />
      <p className="bb-activity-footnote">Minimum target: {formatMoney(minimum)}. Ideal target: {formatMoney(ideal)}.</p>
      {view.savingsInvesting && <>
        <dl>
          <div><dt>Cash saved</dt><dd>{formatMoney(view.savingsInvesting.cashSaved)}</dd></div>
          <div><dt>SpaceX ESPP{view.savingsInvesting.estimatedEsppContribution ? " · includes estimate" : view.savingsInvesting.source === "Recorded payroll withholding" ? " · withheld from payroll" : " · calculated from payroll"}</dt><dd>{formatMoney(view.savingsInvesting.esppContribution)}</dd></div>
          <div><dt>Cash saved + ESPP</dt><dd>{formatMoney(view.savingsInvesting.combinedContributions)}</dd></div>
        </dl>
        <p className="bb-activity-footnote">ESPP is already withheld before deposit. The progress bar measures cash savings.</p>
        {(view.savingsInvesting.warnings ?? []).map(warning => <p key={warning} role="status" className="bb-activity-footnote">{warning}</p>)}
      </>}
    </div>
  }
  let components = detail.components
  if (key === "spent") {
    // Rebuild the compact expense summary from the active view, including
    // authoritative sheet adjustments. Cash/ESPP savings belong only to Saved.
    components = [
      {label: "Needs", amount: view.categorySpending.needs},
      {label: "Wants", amount: view.categorySpending.wants},
    ]
    const difference = roundCurrency(detail.value - amountRowsTotal(components))
    if (difference) components.push({label: "Sheet adjustment", amount: difference})
  }
  return <div className="bb-metric-explanation">
    <div className="bb-chart-total">{formatMoney(detail.value)}</div>
    {key === "income" && <p>{detail.equation}</p>}
    <dl>{components.map((component,index) => <div key={index}><dt>{component.label}
      {key === "left" && index < 3 && view.metrics.monthlyIncome > 0 && <small>
        {(100 * view.categoryBudgets[(["needs", "wants", "savings"] as const)[index]] / view.metrics.monthlyIncome).toLocaleString("en-US", {maximumFractionDigits: 1})}% of income
      </small>}
      {component.date && <small>{component.date}</small>}{component.source === "scheduled" && <small>Scheduled estimate</small>}</dt>
      <dd>{formatMoney(component.amount)}</dd></div>)}</dl>
    {key === "income" && detail.notes.map((note,index)=><p className="bb-activity-footnote" key={index}>{note}</p>)}
  </div>
}

function ActivityDetails({entries, total, note, colors}: {entries:ReportActivity[];total:number;note?:string;colors:Record<string,string>}) {
  const summary = activitySummary(entries)
  const difference = Math.round((total-summary.total)*100)/100
  return <div className="bb-activity-details">
    <div className="bb-chart-total">{formatMoney(total)}</div>
    {note ? <p>{note}</p> : <>
      <p className="bb-activity-summary">Recorded {formatMoney(summary.recorded)} · Scheduled {formatMoney(summary.scheduled)}</p>
      {Math.abs(difference) >= .01 && <p className="bb-activity-coverage">{formatMoney(difference)} is summarized outside these itemized entries.</p>}
    </>}
    {entries.length > 0 ? <ol className="bb-activity-list">{entries.map(entry => <li key={entry.id}>
      <div><strong>{entry.item || entry.location || "Transaction"}</strong><span>{entry.location && entry.item ? entry.location+" · " : ""}{entry.date || "No date"}{entry.dateSource === "scheduled" ? " · scheduled date" : ""}</span>
        <span style={{color:colors[entry.category]}}>{entry.category} · {entry.person}</span></div>
      <div><strong>{formatMoney(entry.amount)}</strong><small className={`bb-activity-status bb-activity-${entry.status}`}>{entry.status === "recorded" ? "Recorded" : "Scheduled"}</small></div>
    </li>)}</ol> : !note && <p className="bb-empty">No itemized transactions in this selection.</p>}
    {summary.scheduled !== 0 && <p className="bb-activity-footnote">Amounts marked Scheduled are estimates. A scheduled date does not confirm that a payment has posted.</p>}
  </div>
}

function isInteractiveTouchTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  if (target.closest("a, input, select, textarea, summary, dialog, [role='dialog']")) return true
  const control = target.closest("button, [role='button'], [role='tab']")
  // Plot buttons still tap normally, but can also begin a graph swipe.
  return Boolean(control && !control.closest(".bb-chart-page-body"))
}

function ChartCarouselNavigation({
  panels,
  activeIndex,
  onSelect,
}: {
  panels: ChartPanel[]
  activeIndex: number
  onSelect: (index: number) => void
}) {
  return (
    <div className="bb-chart-carousel-nav">
      <span className="sr-only" role="status" aria-live="polite">{panels[activeIndex].title}</span>
      <ChartCarouselIndicators panels={panels} activeIndex={activeIndex} onSelect={onSelect} />
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
  const [pointerFocus, setPointerFocus] = useState(false)
  return (
    <div className="bb-category-mix-filter" data-bb-tooltip-dismiss-trigger="category-mix" data-pointer-focus={pointerFocus ? "true" : undefined}>
      <span className="bb-category-filter-label" aria-hidden="true">{CATEGORY_MIX_FILTERS.find(item => item.value === filter)?.label}</span>
      <select aria-label="Category mix filter" value={filter}
        onPointerDown={() => setPointerFocus(true)} onKeyDown={() => setPointerFocus(false)} onBlur={() => setPointerFocus(false)}
        onChange={(event) => onFilterChange(event.target.value as CategoryMixFilter)}>
        {CATEGORY_MIX_FILTERS.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
      <ChevronDown className="bb-category-filter-chevron" aria-hidden="true" />
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
    <SlidingSelection
      value={filter}
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
    </SlidingSelection>
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
    <div className="bb-chart-carousel-indicators" role="group" aria-label="Budget chart position"
      onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? activeIndex + 1 : event.key === "ArrowLeft" ? activeIndex - 1 : null
        if (next === null) return
        event.preventDefault()
        onSelect(clamp(next, 0, panels.length - 1))
      }}>
      {panels.map((panel, index) => (
        <button
          type="button"
          key={panel.id}
          className="bb-chart-carousel-dot"
          data-state={index === activeIndex ? "active" : "inactive"}
          aria-label={`Show ${panel.title}`}
          aria-pressed={index === activeIndex}
          aria-controls={`bb-chart-${panel.id}`}
          onClick={() => onSelect(index)}
        >
          <span aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
  const isDark = theme === "dark"
  return (
    <button type="button" className="bb-theme-toggle bb-report-menu-action" aria-pressed={isDark} aria-label={`Turn dark mode ${isDark ? "off" : "on"}`} onClick={onToggle}>
      <span className="bb-theme-toggle-icon" aria-hidden="true">
        <span className="bb-theme-toggle-track">
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
          <svg viewBox="0 0 24 24" focusable="false">
            <path
              className="bb-theme-toggle-moon"
              d="M20.6 14.1A8.3 8.3 0 0 1 9.9 3.4a8.7 8.7 0 1 0 10.7 10.7Z"
            />
          </svg>
        </span>
      </span>
      <span>Dark mode</span>
      <span className="bb-theme-setting">{isDark ? "On" : "Off"}</span>
    </button>
  )
}

function BurnRateChart({
  burnRate,
  categoryBalances,
  month,
  collapseKey = 0,
}: {
  burnRate: BurnRate
  categoryBalances: CategoryBalances
  month: number
  collapseKey?: number
}) {
  const [tooltipPortal, setTooltipPortal] = useState<HTMLDivElement | null>(null)
  const touch = useMediaQuery("(pointer: coarse)")
  const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 1)))
  const isOver = burnRate.status === "over"
  const isNotStarted = burnRate.status === "not_started"
  const statusLabel = isNotStarted ? "Not started" : isOver ? "Over pace" : "Available today"
  const differenceLabel = isNotStarted ? "No elapsed days" : formatMoney(Math.abs(burnRate.totalDifference))
  const dailyDifference = burnRateDailyPaceLabel(burnRate)
  const chartSeries = burnRate.series
  const gradientStops = burnRateGradientStops(chartSeries)
  const lineColor = isNotStarted ? "hsl(var(--chart-1))" : "url(#burn-rate-variance-gradient)"
  const yAxisDomain = burnRateYAxisDomain(chartSeries)
  const categoryPressure = categoryMixPressure("wants", categoryBalances, burnRate.spent)

  return (
    <div className="bb-chart-stack bb-chart-page bb-burn-rate-page">
      <div className="bb-panel-head bb-burn-rate-summary bb-chart-page-header">
        <div className="bb-burn-rate-primary" data-not-started={isNotStarted}>
          <div>
            <div className="bb-title-with-accessory">
              <div className="bb-chart-kicker">{statusLabel}</div>
              <BurnRateInfoButton burnRate={burnRate} monthName={monthName} collapseKey={collapseKey} />
            </div>
            <div className={isOver ? "bb-burn-rate-value bb-negative" : "bb-burn-rate-value bb-positive"}>{differenceLabel}</div>
          </div>
          <div className="bb-burn-rate-actions">
            <div className={`bb-burn-rate-pace ${burnRate.dailyDifference > 0 ? "bb-negative" : "bb-positive"}`} aria-label={dailyDifference}>
              <span>{isNotStarted ? "No daily pace yet" : burnRate.dailyDifference > 0 ? "Overspending" : burnRate.dailyDifference < 0 ? "Saving" : "On pace"}</span>
              {!isNotStarted && <strong>{formatMoney(Math.abs(burnRate.dailyDifference))}/day</strong>}
            </div>
          </div>
          <div className="bb-burn-rate-note">
            {burnRate.elapsedDays} of {burnRate.daysInMonth} days counted
          </div>
        </div>
        {categoryPressure ? <CategoryMixPressureBar pressure={categoryPressure} /> : null}
      </div>
      <ChartContainer
        config={{ variance: { label: "Variance", color: lineColor } }}
        className="bb-chart-box bb-chart-box-wide bb-chart-page-body"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartSeries} margin={{ top: 20, right: 22, left: 0, bottom: 8 }}>
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
            <Area type="monotone" dataKey="variance" baseValue={0} stroke="none" fill={lineColor} fillOpacity={0.1} tooltipType="none" activeDot={false} connectNulls={false} isAnimationActive={false} />
            <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.45} strokeWidth={1.5} />
            {tooltipPortal && <ChartTooltip portal={tooltipPortal} trigger={touch ? "click" : "hover"} isAnimationActive={false} fadeDuration={360} content={<BurnRateTooltipContent monthName={monthName} portal={tooltipPortal} />} />}
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
              // Follow the measured viewport without a second interpolation.
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div ref={setTooltipPortal} className="bb-burn-tooltip-portal" />
      </ChartContainer>
      <div className="bb-chart-page-footer">
        <BurnRateMonthBalance burnRate={burnRate} monthName={monthName} />
      </div>
    </div>
  )
}

function BurnRateMonthBalance({ burnRate, monthName }: { burnRate: BurnRate; monthName: string }) {
  const balance = burnRateBalance(burnRate.spent, burnRate.budget)
  return (
    <div className="bb-burn-month-panel" data-over={balance.over} role="img"
      aria-label={`${burnRate.elapsedDays ? `Through ${monthName} ${burnRate.elapsedDays}` : "Month not started"}. Spent ${formatMoney(burnRate.spent)} of the ${formatMoney(burnRate.budget)} month limit. ${formatMoney(burnRate.remaining)} left.`}>
      <div className="bb-burn-fraction">
        <strong>{formatMoney(burnRate.spent)}</strong><span>/ {formatMoney(burnRate.budget)}</span>
      </div>
      <BurnRateBalanceRail balance={balance} />
      <div className="bb-burn-month-values">
        <span><span className="bb-burn-spent-label">Spent</span> / Month limit</span>
        <span className={burnRate.remaining < 0 ? "bb-negative" : "bb-positive"}>{formatMoney(burnRate.remaining)} left</span>
      </div>
    </div>
  )
}

function BurnRateBalanceRail({ balance }: { balance: ReturnType<typeof burnRateBalance> }) {
  return (
    <div className="bb-burn-balance-rail" data-over={balance.over} data-empty={balance.empty} aria-hidden="true">
      {balance.over ? <span className="bb-burn-overfill" style={{ width: `${balance.excess * 100}%` }} /> : <>
        {balance.used > 0 && <span className="bb-burn-used" style={{ flex: balance.used }} />}
        {balance.left > 0 && <span className="bb-burn-remainder" style={{ flex: balance.left }} />}
      </>}
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

function BurnRateInfoButton({ burnRate, monthName, collapseKey }: { burnRate: BurnRate; monthName: string; collapseKey: number }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const dismissChartTooltips = useChartTooltipDismiss()
  const title = burnRate.status === "not_started" ? "Not started" : burnRate.status === "over" ? "Over pace" : "Available today"
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }

  useEffect(() => setOpen(false), [burnRate, monthName, collapseKey])
  useLayoutEffect(() => {
    if (!open) return
    const contain = () => {
      const element = popover.current
      const anchor = trigger.current?.getBoundingClientRect()
      if (!element || !anchor) return
      const summary = trigger.current?.closest(".bb-burn-rate-primary")?.getBoundingClientRect() ?? anchor
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft ?? 0) + 16
      let topEdge = (viewport?.offsetTop ?? 0) + 16
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 32
      let bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 32
      element.style.maxWidth = `${Math.max(1, rightEdge - leftEdge)}px`
      const left = Math.max(leftEdge, Math.min(summary.left, rightEdge - element.offsetWidth))
      for (const control of burnRateTooltipOccluders(element.ownerDocument)) {
        const rect = control.getBoundingClientRect()
        if (rect.right <= left || rect.left >= left + element.offsetWidth) continue
        if (rect.top >= anchor.bottom) bottomEdge = Math.min(bottomEdge, rect.top - 8)
        else if (rect.bottom <= anchor.top) topEdge = Math.max(topEdge, rect.bottom + 8)
      }
      element.style.setProperty("--bb-burn-info-max-height", `${Math.max(1, bottomEdge - topEdge - 2)}px`)
      const above = summary.bottom + 8 + element.offsetHeight > bottomEdge
      const top = above ? anchor.top - element.offsetHeight - 8 : summary.bottom + 8
      element.style.setProperty("--bb-burn-info-left", `${left}px`)
      element.style.setProperty("--bb-burn-info-top", `${Math.max(topEdge, Math.min(top, bottomEdge - element.offsetHeight))}px`)
      element.style.setProperty("--bb-burn-info-origin", above ? "center bottom" : "center top")
    }
    contain()
    const observer = new ResizeObserver(contain)
    if (popover.current) observer.observe(popover.current)
    window.addEventListener("resize", contain)
    window.visualViewport?.addEventListener("resize", contain)
    window.visualViewport?.addEventListener("scroll", contain)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", contain)
      window.visualViewport?.removeEventListener("resize", contain)
      window.visualViewport?.removeEventListener("scroll", contain)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!(event.target instanceof Node) || panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      // Safari may focus an ancestor before delivering a tapped close button.
      if (event.type === "focusin" && trigger.current && event.target.contains(trigger.current)) return
      close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close(true)
    }
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) close()
    }
    const screenChange = () => close()
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }))
    document.addEventListener("pointerdown", outside)
    document.addEventListener("focusin", outside)
    document.addEventListener("keydown", escape)
    document.addEventListener("scroll", scroll, true)
    window.addEventListener("bookiebot:screen-change", screenChange)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
      document.removeEventListener("keydown", escape)
      document.removeEventListener("scroll", scroll, true)
      window.removeEventListener("bookiebot:screen-change", screenChange)
    }
  }, [open])

  return <>
    <button ref={trigger} type="button" className="bb-burn-rate-info" aria-label={`Explain ${title}`} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={id} onClick={() => { if (!open) dismissChartTooltips(); setOpen(value => !value) }}>
      <span aria-hidden="true">ⓘ</span>
    </button>
    {typeof document !== "undefined" && createPortal(
      <Popover ref={popover} className="bb-burn-info-popover" opened={open} target={trigger} backdrop={false}
        role="dialog" aria-label={title} aria-hidden={!open} id={id} inert={!open}>
        <div ref={panel} className="bb-burn-info-panel">
          <BurnRateInfoContent burnRate={burnRate} monthName={monthName} onClose={() => close(true)} />
        </div>
      </Popover>, document.body)}
  </>
}

function BurnRateInfoContent({ burnRate, monthName, onClose }: { burnRate: BurnRate; monthName: string; onClose: () => void }) {
  const isNotStarted = burnRate.status === "not_started"
  const isOver = burnRate.status === "over"
  const title = isNotStarted ? "Not started" : isOver ? "Over pace" : "Available today"
  const date = isNotStarted ? "" : ` through ${monthName} ${burnRate.elapsedDays}`
  return <>
    <div className="bb-burn-info-head">
      <h3>{title}</h3>
      <button type="button" className="bb-burn-info-close" aria-label="Close spending pace explanation" onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </div>
    <p className="bb-burn-info-lede">{isNotStarted ? "Your spending pace starts with the first day of this month." : isOver ? "Spending above the allowance so far." : "Room to spend while staying on pace."}</p>
    <dl className="bb-burn-info-calculation">
      <div><dt>Allowance{date}</dt><dd>{formatMoney(burnRate.expectedSpend)}</dd></div>
      <div><dt>Spent{date}</dt><dd>{formatMoney(burnRate.spent)}</dd></div>
      <div className="bb-burn-info-answer"><dt>{title}</dt><dd className={isNotStarted ? undefined : isOver ? "bb-negative" : "bb-positive"}>{isNotStarted ? "No elapsed days" : formatMoney(Math.abs(burnRate.totalDifference))}</dd></div>
    </dl>
    <div className="bb-burn-info-scope">
      <span>Counts toward pace</span>
      <p>Food · Shopping · Wants subscriptions</p>
      <small>Allowance reflects category coverage.</small>
    </div>
  </>
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
  coordinate,
  monthName,
  portal,
}: {
  active?: boolean
  payload?: BurnRateTooltipPayload[]
  coordinate?: { x?: number; y?: number }
  monthName: string
  portal: HTMLDivElement
}) {
  const point = payload?.find((item) => item.payload?.variance !== null && item.payload?.variance !== undefined)?.payload
  const nodeRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!active || !point || !node) return
    // One owner positions the portal before paint. No competing native transform
    // or React state update can briefly paint this day's content at the old node.
    const place = () => positionBurnRateTooltip(portal, node, coordinate?.x)
    place()
    const observer = new ResizeObserver(place)
    observer.observe(node)
    if (portal.parentElement) observer.observe(portal.parentElement)
    const page = portal.closest(".bb-burn-rate-page")
    if (page) observer.observe(page)
    for (const occluder of burnRateTooltipOccluders(portal.ownerDocument)) observer.observe(occluder)
    window.addEventListener("scroll", place, { passive: true, capture: true })
    window.visualViewport?.addEventListener("resize", place)
    window.visualViewport?.addEventListener("scroll", place)
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", place, true)
      window.visualViewport?.removeEventListener("resize", place)
      window.visualViewport?.removeEventListener("scroll", place)
    }
  }, [active, point, coordinate?.x, portal])
  if (!active || !point || point.variance === null) {
    return null
  }

  const isOver = point.variance > 0
  const balance = burnRateBalance(point.actualSpend ?? 0, point.expectedSpend)

  return (
    <div ref={nodeRef} className="bb-burn-node-tooltip" data-over={isOver} data-inspected-day={point.day} role="tooltip" aria-label={`${monthName} ${point.day} spending details`}>
      <div className="bb-burn-mini-header">
        <span>{monthName} {point.day}</span>
        <span><strong>{formatMoney(point.dailySpend)}</strong> spent</span>
      </div>
      <div className={`bb-burn-day-pace ${isOver ? "bb-negative" : "bb-positive"}`}>
        <strong>{formatMoney(Math.abs(point.variance))}</strong><span>{point.variance === 0 ? "on pace" : isOver ? "over pace" : "under pace"}</span>
      </div>
      <div className="bb-burn-day-bar" aria-label={`Spending and limit through ${monthName} ${point.day}`}>
        <div className="bb-burn-pair bb-burn-pair-labels">
          <span><i className="bb-burn-key bb-burn-key-spent" aria-hidden="true" />Spent</span>
          <span><i className="bb-burn-key bb-burn-key-limit" aria-hidden="true" />Limit</span>
        </div>
        <BurnRateBalanceRail balance={balance} />
        <div className="bb-burn-pair bb-burn-pair-values">
          <strong>{formatMoney(point.actualSpend)}</strong><strong>{formatMoney(point.expectedSpend)}</strong>
        </div>
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
  onExplain,
  children,
}: {
  onExplain?: () => void
  label: string
  value: number | null | undefined
  description?: string
  accent?: boolean
  control?: ReactNode
  children?: ReactNode
}) {
  const positive = accent && value !== null && value !== undefined && value >= 0
  const negative = value !== null && value !== undefined && value < 0
  return (
    <div className="bb-metric-card" data-accent={accent || undefined}>
      <div className="bb-metric-head">
        <div className="bb-metric-label">{onExplain ? <button type="button" className="bb-metric-explain" aria-label={`Explain ${label}`} onClick={onExplain}>{label}<span aria-hidden="true">ⓘ</span></button> : label}</div>
        {control}
      </div>
      <FittedAmount className={negative ? "bb-metric-value bb-negative" : positive ? "bb-metric-value bb-positive" : "bb-metric-value"}>
        {formatMoney(value)}
      </FittedAmount>
      {description ? <div className="bb-metric-note">{description}</div> : null}
      {children}
    </div>
  )
}

function RemainingCategoryBars({balances, budgets, onExplain}: {
  balances: CategoryBalances; budgets: CategoryBalanceAmounts; onExplain?: () => void
}) {
  const categories = ["needs", "wants", "savings"] as const
  const summary = categories.map(key => `${CATEGORY_BALANCE_LABELS[key]}: ${formatMoney(balances.remaining[key])} remaining of ${formatMoney(budgets[key])}`).join("; ")
  const rows = <span className="bb-left-category-rows" aria-hidden="true">
    {categories.map(key => {
      const amount = balances.remaining[key]
      const fraction = budgets[key] > 0 ? clamp(amount / budgets[key], 0, 1) : 0
      return <span className="bb-left-category-row" data-category={key} key={key}>
        <span>{key[0].toUpperCase()}</span>
        <span className="bb-left-category-track"><span style={{width: `${fraction * 100}%`}} /></span>
        <span className="bb-left-category-amount">{wholeMoney.format(amount)}</span>
      </span>
    })}
  </span>
  return onExplain
    ? <button type="button" className="bb-left-categories" aria-label={`Explain Left: ${summary}`} onClick={onExplain}>{rows}</button>
    : <div className="bb-left-categories" role="img" aria-label={summary}>{rows}</div>
}

function isSavingsNearGoal(value: number | null | undefined, goal: number | null | undefined) {
  if (value === null || value === undefined || goal === null || goal === undefined || goal <= 0) {
    return false
  }
  return value >= goal * 0.9
}

function SavingsMetricCard({
  progressValue,
  onExplain,
  value,
  minimum,
  ideal,
}: {
  progressValue?: number
  onExplain?: () => void
  value: number
  minimum: number
  ideal: number
}) {
  const cash = progressValue ?? value
  const tone = cash <= 0 ? "empty" : cash < minimum ? "low" : isSavingsNearGoal(cash, ideal) ? "ideal" : "minimum"
  return (
    <div className="bb-metric-card bb-savings-metric-card">
      <div className="bb-metric-label">{onExplain ? <button type="button" className="bb-metric-explain" aria-label="Explain Saved" onClick={onExplain}>Saved<span aria-hidden="true">ⓘ</span></button> : "Saved"}</div>
      <FittedAmount className={`bb-metric-value bb-savings-value bb-savings-value-${tone}`}>{formatMoney(value)}</FittedAmount>
      <SavingsProgress value={cash} minimum={minimum} ideal={ideal} />
    </div>
  )
}

function SavingsProgress({value, minimum, ideal, showTargets = true}: {value:number; minimum:number; ideal:number; showTargets?:boolean}) {
  const progressPercent = ideal > 0 ? clamp((value / ideal) * 100, 0, 100) : 0
  const minimumPercent = ideal > 0 ? clamp((minimum / ideal) * 100, 0, 100) : 0
  const tone = value <= 0 ? "empty" : value < minimum ? "low" : isSavingsNearGoal(value, ideal) ? "ideal" : "minimum"
  return (
      <div
        className={`bb-savings-progress bb-savings-progress-${tone}`}
        role="img"
        aria-label={`${formatMoney(value)} saved; minimum ${formatMoney(minimum)}; ideal ${formatMoney(ideal)}`}
      >
        <div className="bb-savings-progress-track">
          <span className="bb-savings-progress-fill" style={{ width: `${progressPercent}%` }} />
          {minimumPercent > 0 && minimumPercent < 100 ? (
            <span className="bb-savings-progress-minimum-marker" style={{ left: `${minimumPercent}%` }} />
          ) : null}
        </div>
        {showTargets && <div className="bb-savings-progress-labels">
          <span>Minimum <b>{wholeMoney.format(minimum)}</b></span>
          <span>Ideal <b>{wholeMoney.format(ideal)}</b></span>
        </div>}
      </div>
  )
}

type CategoryMixChartProps = {
  onInspect: (item: BreakdownItem) => void
  data: BreakdownItem[]
  categoryBalances: CategoryBalances
  categoryBudgets: CategoryBalanceAmounts
  amountSaved: number
  allSpentTotal: number
  espp?: number
  estimatedEspp?: number
  filter: CategoryMixFilter
  onFilterChange: (filter: CategoryMixFilter) => void
  projected: boolean
}

const CategoryMixChart = memo(function CategoryMixChart({
  onInspect,
  data,
  categoryBalances,
  categoryBudgets,
  amountSaved,
  allSpentTotal,
  espp,
  estimatedEspp,
  filter,
  onFilterChange,
  projected,
}: CategoryMixChartProps) {
  const selectedRollover = categoryMixRollover(categoryBalances, filter)
  const transferRows = categoryMixTransferRows(categoryBalances, filter)
  const chartData = categoryMixRows(data, selectedRollover, filter, amountSaved, transferRows, espp, estimatedEspp)
  // Spend/savings begin at noon, with the remaining balance last.
  const ringData = [...chartData.filter(item => item.key !== "left"), ...chartData.filter(item => item.key === "left")]
  const [pieHostRef, pieHostSize] = useElementSize<HTMLDivElement>()
  const [showCallouts, setShowCallouts] = useState(false)
  const centerRef = useRef<HTMLButtonElement>(null)
  const pieLayout = useExpensePieLayout(ringData, pieHostSize, showCallouts)
  // After mounting, the painted sector owns these styles. A new React target
  // must not overwrite the current label before the next native ring frame.
  const initialCenterStyle = useRef(categoryCenterStyle(pieLayout)).current
  const spentTotal = filter === "all" ? allSpentTotal : amountRowsTotal(chartData.filter((item) => item.key !== "left" && !item.key.startsWith("coverage-")))
  const selectedBudget = (filter === "all" ? categoryBudgetTotal(categoryBudgets) : categoryBudgets[filter]) + ((filter === "all" || filter === "savings") ? espp ?? 0 : 0)
  // All still shows where income went, including cash savings and ESPP.
  // Keep its ring allocation distinct from the expense-only Spent headline.
  const savedTotal = amountRowsTotal(chartData.filter((item) => item.key === "savings" || item.key === "espp"))
  const usedTotal = filter === "all" ? roundCurrency(spentTotal + savedTotal) : amountRowsTotal(chartData.filter((item) => item.key !== "left"))
  const usedLabel = filter === "all" ? "spent + saved" : filter === "savings" ? "saved" : "used"
  const pressure = categoryMixPressure(filter, categoryBalances, usedTotal)
  const usedPercent = selectedBudget > 0 ? (usedTotal / selectedBudget) * 100 : 0

  return (
    <div className="bb-chart-stack bb-chart-page bb-category-mix-page">
      <div className="bb-panel-head bb-chart-page-header bb-category-mix-summary">
        <div className="bb-category-summary-label">
            <span className="bb-chart-kicker">{filter === "savings" ? "Saved" : "Spent"}</span>
            <span className="bb-chart-mode-note">{projected ? "Projected" : "Current"}</span>
        </div>
        <div className="bb-category-amount-row">
          <FittedAmount className="bb-chart-total">{formatMoney(spentTotal)}</FittedAmount>
          <div className="bb-chart-page-header-actions">
            <CategoryMixFilterControl filter={filter} onFilterChange={onFilterChange} />
          </div>
        </div>
        {selectedBudget > 0 ? <div className="bb-chart-budget-note">{formatMoney(selectedBudget)} budget</div> : null}
        {pressure ? <CategoryMixPressureBar pressure={pressure} /> : null}
      </div>
      <div className="bb-chart-layout bb-category-chart-layout bb-chart-page-body">
        <ChartContainer config={chartConfig(chartData)} className="bb-chart-box bb-category-chart-box">
          <CategoryMixPieMotionHost
            hostRef={pieHostRef}
            layout={pieLayout}
            showCallouts={showCallouts}
            onToggle={() => setShowCallouts(shown => !shown)}
          >
            <CategoryMixPieSurface data={ringData} layout={pieLayout} centerRef={centerRef} onInspect={onInspect} />
            <CategoryContourCallouts scene={pieLayout.contour} data={ringData} ready={pieLayout.calloutsReady} visible={showCallouts} onInspect={onInspect} />
            <button ref={centerRef} type="button" className="bb-category-pie-center" aria-label={showCallouts ? "Hide category callouts" : "Show category callouts"} aria-pressed={showCallouts} onClick={() => setShowCallouts(shown => !shown)} style={ringData.some(item => item.amount > 0) ? initialCenterStyle : categoryCenterStyle(pieLayout)} aria-live="polite">
              <FittedAmount className="bb-category-used">{selectedBudget > 0 ? `${Number(usedPercent.toFixed(1))}%` : "—"}</FittedAmount>
              <span>{selectedBudget > 0 ? usedLabel : "no budget"}</span>
            </button>
          </CategoryMixPieMotionHost>
        </ChartContainer>
      </div>
    </div>
  )
}, areCategoryMixChartPropsEqual)

type CategoryMixPieMotionHostProps = {
  hostRef: RefObject<HTMLDivElement | null>
  layout: ExpensePieLayout
  showCallouts: boolean
  onToggle: () => void
  children: ReactNode
}

function CategoryMixPieMotionHost({ hostRef, layout, showCallouts, onToggle, children }: CategoryMixPieMotionHostProps) {
  const gesture = useRef<{x: number; y: number; moved: boolean} | null>(null)
  return (
    <div ref={hostRef} className="bb-category-pie-host" data-callouts={showCallouts}
      data-bb-pie-fit-padding={layout.containerPadding} data-bb-pie-layout-motion="geometry"
      onPointerDownCapture={event => { gesture.current = event.isPrimary ? {x: event.clientX, y: event.clientY, moved: false} : null }}
      onPointerMoveCapture={event => {
        const start = gesture.current
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) start.moved = true
      }}
      onPointerCancel={() => { gesture.current = null }}
      onClick={event => {
        const start = gesture.current
        gesture.current = null
        // Slice/callout inspection and keyboard buttons have their own actions.
        // Never prevent native vertical scrolling or the carousel's swipe.
        if (!start || start.moved || (event.target as Element).closest('[role="button"],button')) return
        onToggle()
      }}
    >{children}</div>
  )
}

type CategoryMixPieSurfaceProps = {
  centerRef: RefObject<HTMLButtonElement | null>
  onInspect: (item: BreakdownItem) => void
  data: BreakdownItem[]
  layout: ExpensePieLayout
}

const CategoryMixPieSurface = memo(function CategoryMixPieSurface({ data, layout, centerRef, onInspect }: CategoryMixPieSurfaceProps) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")
  return (
    <div className="bb-category-pie-surface bb-chart-motion-surface" data-bb-pie-transition={reducedMotion ? "none" : "morph"}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={layout.margin}>
          <Pie
            data={data}
            dataKey="amount"
            nameKey="label"
            stroke="none"
            shape={(props: unknown) => {
              const { key: _key, animationGeometry, ...sector } = props as ComponentProps<typeof Sector> & AnimatedPieSector & { key?: string; payload?: Pick<BreakdownItem, "key"> }
              const shape = { cx: sector.cx, cy: sector.cy, innerRadius: sector.innerRadius, outerRadius: sector.outerRadius,
                startAngle: sector.startAngle, endAngle: sector.endAngle, ...animationGeometry,
                fill: sector.fill, stroke: sector.stroke, payload: sector.payload, index: sector.index,
                "data-recharts-item-index": sector["data-recharts-item-index"], "data-recharts-item-id": sector["data-recharts-item-id"] }
              // Recharts can render its previous sectors while new data is being
              // synchronized. Their indices no longer describe the current rows.
              const item = data.find(row => row.key === sector.payload?.key)
              if (!item) return <StablePieSector {...shape} tabIndex={-1} aria-hidden="true" />
              const path = <StablePieSector {...shape} tabIndex={0} role="button" aria-label={`Inspect ${item.label}, ${formatMoney(item.amount)}`}
                onClick={() => onInspect(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onInspect(item) } }} />
              return item.key === data[0]?.key ? <CategoryRingCenterSync geometry={shape} centerRef={centerRef}>{path}</CategoryRingCenterSync> : path
            }}
            cx={layout.cx}
            cy={layout.cy}
            innerRadius={layout.innerRadius}
            outerRadius={layout.outerRadius}
            startAngle={PIE_METRIC_START_ANGLE}
            endAngle={PIE_METRIC_END_ANGLE}
            paddingAngle={PIE_METRIC_PADDING_ANGLE}
            isAnimationActive={!reducedMotion}
            animationInterpolateFn={categoryRingAnimation}
            animationBegin={0}
            animationDuration={520}
            animationEasing="ease-out"
            label={false}
            labelLine={false}
          >
            {data.map((item) => (
              <Cell key={item.key} fill={item.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}, areCategoryMixPieSurfacePropsEqual)

function areCategoryMixPieSurfacePropsEqual(
  previous: CategoryMixPieSurfaceProps,
  next: CategoryMixPieSurfaceProps,
) {
  return previous.onInspect === next.onInspect && previous.centerRef === next.centerRef && breakdownRowsEqual(previous.data, next.data) && expensePieLayoutsEqual(previous.layout, next.layout)
}

function areCategoryMixChartPropsEqual(previous: CategoryMixChartProps, next: CategoryMixChartProps) {
  return (
    previous.onInspect === next.onInspect &&
    previous.amountSaved === next.amountSaved &&
    previous.allSpentTotal === next.allSpentTotal &&
    previous.espp === next.espp && previous.estimatedEspp === next.estimatedEspp &&
    previous.categoryBudgets.needs === next.categoryBudgets.needs &&
    previous.categoryBudgets.wants === next.categoryBudgets.wants &&
    previous.categoryBudgets.savings === next.categoryBudgets.savings &&
    categoryBalancesEqual(previous.categoryBalances, next.categoryBalances) &&
    previous.filter === next.filter &&
    previous.projected === next.projected &&
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
          note: `${formatMoney(impact)} moved from ${CATEGORY_BALANCE_LABELS[filter]} to cover ${recipients.join(" + ")} overspend`,
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
  transferRows: BreakdownItem[] = [],
  espp?: number,
  estimatedEspp = 0,
) {
  let filtered = data.filter((item) => {
    if (filter === "needs") return CATEGORY_NEEDS_KEYS.has(item.key)
    if (filter === "wants") return CATEGORY_WANTS_KEYS.has(item.key)
    return filter === "all" && item.key !== "savings"
  })
  if (filter === "savings" || filter === "all") {
    filtered = [...filtered, ...(amountSaved > 0
      ? [{
          key: "savings",
          label: espp === undefined ? "Saved" : "Cash saved",
          amount: roundCurrency(amountSaved),
          percentage: 0,
          color: SAVINGS_CATEGORY_COLOR,
        }]
      : [])]
    if ((espp ?? 0) > 0) filtered.push({key:"espp", label:estimatedEspp ? "SpaceX ESPP · includes estimate" : "SpaceX ESPP", amount:roundCurrency(espp ?? 0), percentage:0, color:"hsl(var(--chart-4))"})
  }
  filtered = [...filtered, ...transferRows]
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

function categoryMixTransferRows(
  balances: CategoryBalances,
  filter: CategoryMixFilter,
): BreakdownItem[] {
  if (filter === "all") {
    return []
  }
  return balances.transfers
    .filter((transfer) => transfer.from === filter)
    .map((transfer) => ({
      key: `coverage-${transfer.from}-${transfer.to}`,
      label: `${CATEGORY_BALANCE_LABELS[transfer.to]} overspend coverage`,
      amount: transfer.amount,
      percentage: 0,
      color: transfer.to === "needs" ? NEEDS_BAR_COLOR : transfer.to === "wants" ? WANTS_BAR_COLOR : SAVINGS_CATEGORY_COLOR,
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

function useExpensePieLayout(data: BreakdownItem[], hostSize: ElementSize, showCallouts = false) {
  return useCategoryContour(data, hostSize, showCallouts)
}

const PIE_METRIC_START_ANGLE = 90
const PIE_METRIC_END_ANGLE = -270
const PIE_METRIC_PADDING_ANGLE = CONTOUR_PADDING_ANGLE

type ExpensePieLayout = ReturnType<typeof useExpensePieLayout>

function expensePieLayoutsEqual(previous: ExpensePieLayout, next: ExpensePieLayout) {
  // Worker completion changes callouts, not the sector animation target.
  return previous.cx === next.cx && previous.cy === next.cy &&
    previous.innerRadius === next.innerRadius && previous.outerRadius === next.outerRadius
}


type DailySpendingRow = AmountRow & {
  needsAmount: number
  wantsAmount: number
}

type DailySpendingChartRow = DailySpendingRow & {
  chartAmount: number
  chartNeedsAmount: number
  chartWantsAmount: number
}

type DailySpendingAxis = {
  compressed: boolean
  breakAt: number
  peak: number
  visualMax: number
  domain: [number, number]
  ticks: number[]
}

type DailyEntryDisplayRow = ExpenseEntry & { status?: "recorded" | "scheduled" }

const MemoizedDailySpendingChart = memo(DailySpendingChart)

function DailySpendingSection({ data, total, filter, entries, categoryColors, year, month, onInspectDay }: {
  data: DailySpendingRow[]
  total: number
  filter: DailySpendingFilter
  entries: DailyEntryDisplayRow[]
  categoryColors: Record<string, string>
  year: number
  month: number
  onInspectDay: (day: string, category?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState("")
  const detailsId = useId()
  const filterId = useId()
  const categories = useMemo(() => Array.from(new Set(entries.map(entry => entry.category))).sort((left, right) => left.localeCompare(right)), [entries])
  const selectedCategory = categories.includes(category) ? category : ""
  const filteredEntries = useMemo(() => selectedCategory ? entries.filter(entry => entry.category === selectedCategory) : entries, [entries, selectedCategory])
  const toggleDetails = useCallback(() => setOpen(current => !current), [])

  useEffect(() => { setCategory("") }, [year, month, filter])

  return <>
    <MemoizedDailySpendingChart data={data} total={total} filter={filter} onInspectDay={onInspectDay}
      detailsOpen={open} detailsId={detailsId} onToggleDetails={toggleDetails} />
    <CollapsibleContent open={open} id={detailsId} lazy>
      <div className="bb-daily-transactions">
        <div className="bb-daily-entry-filter">
          <label htmlFor={filterId}>Type</label>
          <div className="bb-daily-entry-select">
            <select id={filterId} value={selectedCategory} onChange={event => setCategory(event.target.value)}>
              <option value="">All types</option>
              {categories.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
          </div>
        </div>
        <DailyEntriesTable entries={filteredEntries} categoryColors={categoryColors} year={year} month={month}
          onInspectDay={day => onInspectDay(day, selectedCategory)} />
      </div>
    </CollapsibleContent>
  </>
}

function DailySpendingChart({
  data,
  total,
  filter,
  detailsOpen,
  detailsId,
  onToggleDetails,
  onInspectDay,
}: {
  onInspectDay: (day: string) => void
  data: DailySpendingRow[]
  total: number
  filter: DailySpendingFilter
  detailsOpen: boolean
  detailsId: string
  onToggleDetails: () => void
}) {
  const axis = dailySpendingAxis(data)
  const chartData = dailySpendingChartRows(data, axis)
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")
  const showStackedBars = filter === "all"
  const singleBarColor = filter === "needs" ? NEEDS_BAR_COLOR : filter === "wants" ? WANTS_BAR_COLOR : "hsl(var(--chart-1))"
  return (
    <div className="bb-chart-layout">
      <ChartContainer
        config={
          showStackedBars
            ? {
                chartNeedsAmount: { label: "Needs", color: NEEDS_BAR_COLOR },
                chartWantsAmount: { label: "Wants", color: WANTS_BAR_COLOR },
              }
            : { chartAmount: { label: "Amount", color: singleBarColor } }
        }
        className="bb-chart-box"
      >
        <div className="bb-chart-motion-surface" data-bb-chart-transition={reducedMotion ? "none" : "morph"}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} onClick={(state) => { if (state?.activeLabel !== undefined) onInspectDay(String(state.activeLabel)) }} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid
                className="bb-daily-spending-grid"
                vertical={false}
                syncWithTicks
                stroke={DAILY_SPENDING_GRID_COLOR}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="label"
                tick={{ className: "bb-daily-spending-x-axis-label", fill: DAILY_SPENDING_BOUNDARY_COLOR }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={axis.domain}
                ticks={axis.ticks}
                interval="preserveStartEnd"
                scale={axis.compressed ? "linear" : "sqrt"}
                tick={{ fill: DAILY_SPENDING_GRID_COLOR }}
                tickFormatter={(value) => dailySpendingAxisTickLabel(Number(value), axis)}
                tickLine={false}
                axisLine={false}
                width={58}
              />
              <ChartTooltip content={<DailySpendingTooltipContent filter={filter} />} cursor={{ fill: dailySpendingCursorFill(filter) }} />
              {showStackedBars ? (
                <>
                  <Bar isAnimationActive={!reducedMotion} animationInterpolateFn={stableBarAnimation} shape={stableBarShape} dataKey="chartNeedsAmount" name="Needs" stackId="daily" fill={NEEDS_BAR_COLOR} radius={DAILY_SPENDING_BAR_RADIUS} />
                  <Bar isAnimationActive={!reducedMotion} animationInterpolateFn={stableBarAnimation} shape={stableBarShape} dataKey="chartWantsAmount" name="Wants" stackId="daily" fill={WANTS_BAR_COLOR} radius={DAILY_SPENDING_BAR_RADIUS} />
                </>
              ) : (
                <Bar isAnimationActive={!reducedMotion} animationInterpolateFn={stableBarAnimation} shape={stableBarShape} dataKey="chartAmount" name="Daily spending" fill={singleBarColor} radius={DAILY_SPENDING_BAR_RADIUS} />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartContainer>
      <div className="bb-chart-side">
        <div>
          <div className="bb-chart-kicker">Total Spent</div>
          <div className="bb-chart-total">{formatMoney(total)}</div>
        </div>
        <button type="button" className="bb-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={onToggleDetails}>
          Transactions
        </button>
      </div>
    </div>
  )
}

function dailySpendingAxis(data: DailySpendingRow[]): DailySpendingAxis {
  const values = data.map((item) => item.amount).filter((amount) => amount > 0).sort((left, right) => right - left)
  const peak = values[0] ?? 0
  const referencePeak = values[1] ?? 0
  const linearDomain = dailySpendingYAxisDomain(data)
  const compressed = peak >= 500 && referencePeak > 0 && peak >= referencePeak * 2.5

  if (!compressed) {
    return {
      compressed: false,
      breakAt: 0,
      peak,
      visualMax: linearDomain[1],
      domain: linearDomain,
      ticks: dailySpendingYAxisTicks(linearDomain),
    }
  }

  const breakAt = dailySpendingBreakAmount(referencePeak)
  const visualMax = breakAt * 1.1
  return {
    compressed: true,
    breakAt,
    peak,
    visualMax,
    domain: [0, visualMax * 1.04],
    ticks: [0, breakAt * 0.25, breakAt * 0.5, breakAt * 0.75, breakAt, visualMax],
  }
}

function dailySpendingBreakAmount(referencePeak: number) {
  const step = referencePeak >= 1000 ? 100 : referencePeak >= 250 ? 50 : referencePeak >= 100 ? 25 : referencePeak >= 50 ? 10 : 5
  return Math.max(step, Math.ceil(referencePeak / step) * step)
}

function dailySpendingChartRows(data: DailySpendingRow[], axis: DailySpendingAxis): DailySpendingChartRow[] {
  return data.map((item) => {
    const chartAmount = dailySpendingVisualAmount(item.amount, axis)
    const ratio = item.amount > 0 ? chartAmount / item.amount : 0
    return {
      ...item,
      chartAmount,
      chartNeedsAmount: item.needsAmount * ratio,
      chartWantsAmount: item.wantsAmount * ratio,
    }
  })
}

function dailySpendingVisualAmount(amount: number, axis: DailySpendingAxis) {
  if (!axis.compressed || amount <= axis.breakAt || axis.peak <= axis.breakAt) {
    return amount
  }
  const progress = (amount - axis.breakAt) / (axis.peak - axis.breakAt)
  return axis.breakAt + progress * (axis.visualMax - axis.breakAt)
}

function dailySpendingActualAmount(value: number, axis: DailySpendingAxis) {
  if (!axis.compressed || value <= axis.breakAt || axis.visualMax <= axis.breakAt) {
    return value
  }
  const progress = (value - axis.breakAt) / (axis.visualMax - axis.breakAt)
  return axis.breakAt + progress * (axis.peak - axis.breakAt)
}

function dailySpendingAxisTickLabel(value: number, axis: DailySpendingAxis) {
  const amount = dailySpendingActualAmount(value, axis)
  if (amount >= 1000) {
    const digits = amount % 1000 === 0 ? 0 : 1
    return `$${(amount / 1000).toFixed(digits)}k`
  }
  return `$${Math.round(amount)}`
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
  return [...ticks.filter((value) => value < max), max]
}

function dailySpendingTickRange(step: number, max: number) {
  const ticks: number[] = []
  for (let value = 0; value < max; value += step) {
    ticks.push(value)
  }
  return [...ticks, max]
}

function dailySpendingCursorFill(filter: DailySpendingFilter) {
  if (filter === "needs") {
    return "hsl(var(--chart-1) / 0.14)"
  }
  if (filter === "wants") {
    return "hsl(var(--chart-2) / 0.14)"
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
  filter,
}: {
  active?: boolean
  payload?: DailySpendingTooltipPayload[]
  filter: DailySpendingFilter
}) {
  const point = (payload ?? []).find((item) => item.payload)?.payload
  if (!active || !point) {
    return null
  }

  const rows = filter === "all"
    ? [
        { label: "Needs", amount: point.needsAmount, color: NEEDS_BAR_COLOR },
        { label: "Wants", amount: point.wantsAmount, color: WANTS_BAR_COLOR },
      ].filter((item) => item.amount > 0)
    : [
        {
          label: filter === "needs" ? "Needs" : "Wants",
          amount: point.amount,
          color: filter === "needs" ? NEEDS_BAR_COLOR : WANTS_BAR_COLOR,
        },
      ]

  return (
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
      <div className="bb-chart-tooltip-title">Day {point.label}</div>
      {rows.map((item, index) => (
        <div className="bb-chart-tooltip-row" key={`${item.label}-${item.amount}-${index}`}>
          <span className="bb-chart-tooltip-dot" style={{ background: item.color }} />
          <span>{item.label}</span>
          <strong>{formatMoney(item.amount)}</strong>
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
}: {
  topEntries: ExpenseEntry[]
  merchantOccurrences: OccurrenceRow[]
}) {
  const [view, setView] = useState<ExpenseInsightsView>("largest")
  const dismissChartTooltips = useChartTooltipDismiss()
  const largestEntries = useMemo(() => topEntries
    .filter((entry) => entry.category.trim().toLowerCase() !== "rent" && expenseEntryItemLabel(entry).trim().toLowerCase() !== "rent")
    .sort((left, right) => (
      right.amount - left.amount
      || right.date.localeCompare(left.date)
      || expenseEntryItemLabel(left).localeCompare(expenseEntryItemLabel(right))
    )), [topEntries])
  const switchView = (nextView: string) => {
    const resolvedView = nextView as ExpenseInsightsView
    if (resolvedView === view) {
      return
    }
    dismissChartTooltips()
    setView(resolvedView)
  }

  return (
    <Card className="bb-report-section bb-highlights-section">
      <Tabs value={view} onValueChange={switchView} className="bb-card-tabs">
        <CardHeader>
          <div className="bb-card-title-row bb-inline-toggle-row">
            <CardTitle>Expense Highlights</CardTitle>
            <TabsList activeValue={view} data-bb-tooltip-dismiss-trigger="expense-highlights">
              <TabsTrigger value="largest">Largest</TabsTrigger>
              <TabsTrigger value="merchants">Most Frequent</TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <CardContent className="bb-expense-insights-content">
          <TabsContent value="largest" forceMount inert={view !== "largest"} aria-hidden={view !== "largest"}>
            <div className="bb-insight-panel">
              <TopExpensesChart entries={largestEntries} />
              <HiddenListPanel total={largestEntries.length} collapseKey={view}>
                <TopExpensesTable entries={largestEntries} />
              </HiddenListPanel>
            </div>
          </TabsContent>
          <TabsContent value="merchants" forceMount inert={view !== "merchants"} aria-hidden={view !== "merchants"}>
            <div className="bb-insight-panel">
              <MerchantChart data={merchantOccurrences} />
              <HiddenListPanel total={merchantOccurrences.length} collapseKey={view}>
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

function DetailsPanel({
  summary,
  children,
  collapseKey = 0,
  defaultOpen = false,
}: {
  summary: string
  children: ReactNode
  collapseKey?: number
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    setOpen(defaultOpen)
  }, [collapseKey, defaultOpen])

  return (
    <div className="bb-details-panel" data-state={open ? "open" : "closed"}>
      <button type="button" className="bb-details-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {summary}
      </button>
      <CollapsibleContent open={open}>{children}</CollapsibleContent>
    </div>
  )
}

function useModalPageScrollLock(locked: boolean) {
  useLayoutEffect(() => {
    if (!locked) {
      return undefined
    }
    const body = document.body
    const root = document.documentElement
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const previous = {
      bodyPaddingRight: body.style.paddingRight,
      rootOverflow: root.style.overflow,
      scrollLock: root.dataset.bbModalScrollLock,
    }
    const scrollbarWidth = Math.max(window.innerWidth - root.clientWidth, 0)
    // Keep the page in normal flow. Fixing/repositioning the whole body changes
    // chart geometry and compositor layers on both edges of every dialog.
    const paddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0
    root.dataset.bbModalScrollLock = "true"
    root.style.setProperty("--bb-viewport-scrollbar-width", `${scrollbarWidth}px`)
    if (scrollbarWidth > 0) body.style.paddingRight = `${paddingRight + scrollbarWidth}px`
    root.style.overflow = "hidden"

    return () => {
      body.style.paddingRight = previous.bodyPaddingRight
      root.style.overflow = previous.rootOverflow
      if (previous.scrollLock === undefined) delete root.dataset.bbModalScrollLock
      else root.dataset.bbModalScrollLock = previous.scrollLock
      root.style.setProperty("--bb-viewport-scrollbar-width", `${Math.max(window.innerWidth - root.clientWidth, 0)}px`)
      // Native focus restoration may scroll in some browsers. Correct only an
      // actual change, avoiding another scroll event/repaint on normal exits.
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY)
    }
  }, [locked])
}

function ModalDetails({
  summary,
  title,
  children,
  collapseKey = 0,
  selection,
  onDismiss,
  triggerHidden = false,
}: {
  selection?: string | null
  onDismiss?: () => void
  triggerHidden?: boolean
  summary: string
  title: string
  children: ReactNode
  collapseKey?: number
}) {
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">("closed")
  const open = phase !== "closed"
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | SVGElement | null>(null)
  useModalPageScrollLock(open)

  const finishClose = () => {
    if (dialogRef.current?.open) dialogRef.current.close()
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true })
    returnFocusRef.current = null
    setPhase("closed")
    onDismiss?.()
  }

  useEffect(() => { if (selection) setPhase("opening") }, [selection])

  useEffect(() => {
    setPhase((current) => current === "closed" ? current : "closing")
  }, [collapseKey])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    if (phase === "opening") {
      if (!dialog.open) {
        const activeElement = document.activeElement
        if (!returnFocusRef.current && activeElement && "focus" in activeElement) {
          returnFocusRef.current = activeElement as HTMLElement | SVGElement
        }
        // Native showModal otherwise autofocuses Close, including its keyboard
        // ring. Start at the title so the content is announced in reading order.
        titleRef.current?.setAttribute("autofocus", "")
        dialog.showModal()
        titleRef.current?.focus({ preventScroll: true })
      }
      // Commit the initial pose before starting the transition. Keep the native
      // dialog/focus trap alive until the same transition finishes on closing.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setPhase((current) => current === "opening" ? "open" : current))
      })
      return () => cancelAnimationFrame(frame)
    }
    if (phase === "closed" && dialog.open) dialog.close()
    if (phase === "closing") {
      const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280
      const timeout = window.setTimeout(finishClose, duration)
      return () => window.clearTimeout(timeout)
    }
  }, [phase])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return undefined
    // A non-passive native listener also contains touch scrolling on iPhones.
    // The body remains scrollable; its overscroll boundary is handled by CSS.
    const containTouchScroll = (event: globalThis.TouchEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".bb-details-dialog-body")) event.preventDefault()
    }
    dialog.addEventListener("touchmove", containTouchScroll, { passive: false })
    return () => dialog.removeEventListener("touchmove", containTouchScroll)
  }, [open])

  const close = () => setPhase((current) => current === "closed" ? current : "closing")
  const modal = typeof document === "undefined" ? null : createPortal(
    <dialog
      ref={dialogRef}
      className="bb-details-dialog"
      data-state={phase}
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); close() }}
      onClose={(event) => { if (!event.currentTarget.open) setPhase("closed") }}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
      onTouchCancel={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close()
        }
      }}
    >
      <div className="bb-details-dialog-shade" aria-hidden="true" onClick={close} />
      <div
        className="bb-details-dialog-surface"
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "opacity" && phase === "closing") finishClose()
        }}
      >
        <div className="bb-details-dialog-header">
          <strong ref={titleRef} tabIndex={-1}>{title}</strong>
          <button type="button" className="bb-details-dialog-close" aria-label={`Close ${title}`} onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="bb-details-dialog-body">{children}</div>
      </div>
    </dialog>,
    document.body,
  )

  return (
    <div className="bb-modal-details">
      {!triggerHidden && <button
        type="button"
        className="bb-details-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          if (!dialogRef.current?.open) returnFocusRef.current = event.currentTarget
          setPhase("opening")
        }}
      >
        {summary}
      </button>}
      {modal}
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

function HiddenListPanel({ children, total, collapseKey }: { children: ReactNode; total: number; collapseKey?: string }) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [collapseKey])
  return (
    <div className="bb-hidden-list-panel">
      <CollapsibleContent open={expanded} lazy>{children}</CollapsibleContent>
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

function DailyEntriesTable({ entries, categoryColors, year, month, onInspectDay }: {
  onInspectDay?: (day: string) => void
  entries: DailyEntryDisplayRow[]
  categoryColors: Record<string, string>
  year: number
  month: number
}) {
  if (!entries.length) {
    return <div className="bb-empty">No transactions found.</div>
  }

  const grouped = new Map<string, DailyEntryDisplayRow[]>()
  for (const entry of entries) {
    const day = dailyEntryDayLabel(entry, year, month) ?? "No date"
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
            const isToday = isCurrentCalendarDay(year, month, Number(day))
            return (
              <tr key={day}>
                <td>
                  <button type="button" onClick={() => onInspectDay?.(day)}
                    className={isToday ? "bb-daily-day bb-daily-day-today" : "bb-daily-day"}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={isToday ? `${day}, today` : `Inspect day ${day}`}
                    title={isToday ? "Today" : undefined}
                  >
                    {day}
                  </button>
                </td>
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
                        {entry.status && <small className={`bb-activity-status bb-activity-${entry.status}`}>{entry.status === "scheduled" ? "Scheduled" : "Recorded"}</small>}
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

function dailyEntriesWithCalendarEvents(
  entries: ExpenseEntry[],
  calendarEvents: CalendarEvent[],
  month: number,
): DailyEntryDisplayRow[] {
  return [
    ...entries.map(entry => ({...entry, status: "recorded" as const})),
    ...calendarEvents.map((event) => {
      const bucket = dailyCalendarEventBucket(event)
      return {
        date: `${month}/${event.day}`,
        status: calendarActivityStatus(event),
        category: calendarActivityCategory(event),
        amount: event.amount,
        person: event.kind === "bill" ? "Need bill" : bucket === "wants" ? "Want sub" : "Need sub",
        item: event.label,
        location: "",
      }
    }),
  ]
}

function dailyTotalsForEntries(entries: ExpenseEntry[], calendarEvents: CalendarEvent[], year?: number, month?: number) {
  const totals = new Map<string, DailySpendingRow>()
  for (const entry of entries) {
    const day = dailyEntryDayLabel(entry, year, month)
    if (day === null) {
      continue
    }
    const bucket = dailyEntryFilter(entry)
    addDailySpendingAmount(totals, day, bucket, entry.amount)
  }
  for (const event of calendarEvents) {
    addDailySpendingAmount(totals, String(event.day), dailyCalendarEventBucket(event), event.amount)
  }
  return Array.from(totals.entries())
    .sort(([left], [right]) => compareDayLabels(left, right))
    .map(([, row]) => row)
}

function dailySpendingTotal(entries: ExpenseEntry[], calendarEvents: CalendarEvent[]) {
  return roundCurrency(
    entries.reduce((sum, entry) => sum + entry.amount, 0) +
      calendarEvents.reduce((sum, event) => sum + event.amount, 0),
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

function dailyEntryDayLabel(entry: ExpenseEntry, year?: number, month?: number) {
  const value = entry.date?.trim() ?? ""
  const iso = /^(\d{4})-(\d{2})-\d{2}$/.exec(value)
  const us = /^(\d{1,2})\/\d{1,2}(?:\/(\d{2}|\d{4}))?$/.exec(value)
  const parsedYear = iso ? Number(iso[1]) : us?.[2] ? Number(us[2]) + (us[2].length === 2 ? 2000 : 0) : 2000
  const parsedMonth = Number(iso ? iso[2] : us?.[1])
  const day = activityDay(value, year ?? parsedYear, month ?? parsedMonth)
  return day === null ? null : String(day)
}

function dailySpendingCalendarEvents(events: CalendarEvent[], filter: DailySpendingFilter, projected: boolean) {
  return events.filter((event) => {
    if ((event.kind !== "subscription" && event.kind !== "bill") || (!projected && event.projectedOnly)) {
      return false
    }
    if (filter === "all") {
      return true
    }
    return dailyCalendarEventBucket(event) === filter
  })
}

function dailyCalendarEventBucket(event: CalendarEvent): Exclude<DailySpendingFilter, "all"> {
  return event.kind === "subscription" && event.group === "subscriptions_wants" ? "wants" : "needs"
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
    color: CATEGORY_CHART_COLORS.static_bills_subscriptions_needs,
    background: "hsl(var(--category-subs-needs) / 0.1)",
  },
  bill: {
    label: "Bill",
    color: CATEGORY_CHART_COLORS.bills_utilities,
    background: "hsl(var(--category-bills) / 0.1)",
  },
  income: {
    label: "Income",
    color: "hsl(var(--success))",
    background: "hsl(var(--success) / 0.1)",
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
    <SlidingSelection
      value={filter}
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
    </SlidingSelection>
  )
}

function CalendarAnalyticsPanel({
  year,
  month,
  monthLabel,
  elapsedDays,
  events,
  filter,
  onFilterChange,
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
  onFilterChange: (filter: CalendarFilter) => void
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
  const fixedBills = visibleEvents.filter((item) => item.kind === "bill" && item.group === "static_bills_subscriptions_needs")

  return (
    <div className="bb-subscription-analytics">
      <div
        className="bb-subscription-tab-content bb-cashflow-calendar-content"
        data-state="active"
        data-bb-calendar-filter={filter}
      >
        <div className="bb-subscription-panel bb-chart-page">
          <div className="bb-panel-head bb-subscription-summary bb-chart-page-header">
            <div>
              <div className="bb-subscription-total" data-bb-calendar-static-label="month">
                {monthOnlyLabel(monthLabel)}
              </div>
              <div className="bb-chart-mode-note" data-bb-calendar-summary="outflow">
                <CalendarChangingValue value={formatMoney(outflowTotal)} />
              </div>
            </div>
            <div className="bb-chart-page-header-actions">
              <Badge variant="secondary">
                <CalendarChangingValue value={`${totalEvents.length} total`} />
              </Badge>
              <CalendarFilterControl filter={filter} onFilterChange={onFilterChange} />
            </div>
          </div>
          <div className="bb-chart-page-body">
            <FinancialCalendar
              year={year}
              month={month}
              elapsedDays={elapsedDays}
              events={events}
              filter={filter}
            />
          </div>
          <div className="bb-chart-page-footer">
            {subscriptionItems.length || fixedBills.length ? (
              <ModalDetails summary="Details" title="Calendar details" collapseKey={collapseKey}>
                <p className="bb-activity-footnote">Recurring schedules · these dates and amounts do not confirm bank posting.</p>
                {fixedBills.length > 0 && <FixedBillItemsTable items={fixedBills} month={month} />}
                {subscriptionItems.length > 0 && <SubscriptionAllItemsGrid items={subscriptionItems} showAll />}
              </ModalDetails>
            ) : null}
          </div>
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
          const filteredEvents = filter === "all"
            ? dayEvents
            : dayEvents.filter((event) => event.kind === "subscription")
          const isToday = day !== null && isCurrentCalendarDay(year, month, day)
          const hasHit = day !== null && day <= elapsedDays
          const markerIsPending = !hasHit || filteredEvents.every((event) => event.projectedOnly)
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
                    {filteredEvents.length === 1 ? (() => {
                      const item = filteredEvents[0]
                      const style = calendarEventStyle(item)
                      return (
                        <button
                          type="button"
                          key={calendarEventKey(item, 0)}
                          className={[
                            "bb-subscription-marker",
                            "bb-calendar-marker-transition",
                            markerIsPending ? "bb-subscription-marker-pending" : "",
                          ].filter(Boolean).join(" ")}
                          data-calendar-event-kind={item.kind}
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
                    })() : filteredEvents.length > 1 ? (() => {
                      const style = calendarEventsStyle(filteredEvents)
                      const total = filteredEvents.reduce((sum, event) => sum + event.amount, 0)
                      return (
                        <button
                          type="button"
                          key={`events-${filter}-${day}`}
                          className={[
                            "bb-subscription-marker",
                            "bb-subscription-marker-more",
                            "bb-calendar-marker-transition",
                            markerIsPending ? "bb-subscription-marker-pending" : "",
                          ].filter(Boolean).join(" ")}
                          style={{
                            color: style.color,
                            backgroundColor: style.background,
                            borderColor: style.color,
                          }}
                          aria-label={`${filteredEvents.length} events on day ${day}: ${filteredEvents.map(calendarEventLabel).join("; ")}`}
                        >
                          <span className="bb-subscription-marker-dot" style={{ background: style.dotBackground }} />
                          <span className="bb-calendar-marker-count" aria-hidden="true">
                            +{filteredEvents.length - 1}
                          </span>
                          <span className="bb-subscription-marker-name">{filteredEvents.length} events</span>
                          <span className="bb-subscription-marker-amount">{formatMoney(total)}</span>
                          <CalendarOverflowTooltip events={filteredEvents} day={day} />
                        </button>
                      )
                    })() : null}
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
  const fallback = CALENDAR_EVENT_STYLES[event.kind]
  const color = event.kind === "income" ? fallback.color : CATEGORY_CHART_COLORS[event.group] ?? fallback.color
  return { ...fallback, color, background: `color-mix(in srgb, ${color} 10%, transparent)` }
}

function calendarEventsStyle(events: CalendarEvent[]) {
  const colors = [...new Set(events.map((event) => calendarEventStyle(event).color))]
  if (colors.length === 1) {
    return { ...calendarEventStyle(events[0]), dotBackground: colors[0] }
  }
  // A consolidated day can contain several categories; its dot shows each one
  // instead of assigning every payment the first event's category color.
  return {
    color: "hsl(var(--muted-foreground))",
    background: "hsl(var(--muted-foreground) / 0.08)",
    dotBackground: `conic-gradient(${colors.map((color, index) => `${color} ${index * 100 / colors.length}% ${(index + 1) * 100 / colors.length}%`).join(", ")})`,
  }
}

function calendarEventLabel(event: CalendarEvent) {
  return `${event.label} - ${calendarEventKindLabel(event)} - ${formatMoney(event.amount)} - ${calendarActivityStatus(event) === "scheduled" ? "Scheduled" : "Recorded"}`
}

function CalendarEventTooltip({ event }: { event: CalendarEvent }) {
  return (
    <span className="bb-subscription-tooltip" role="tooltip">
      <strong className="bb-calendar-tooltip-category" style={{ color: calendarEventStyle(event).color }}>{event.label}</strong>
      <span>{calendarEventKindLabel(event)} · {calendarActivityStatus(event) === "scheduled" ? "Scheduled" : "Recorded"}</span>
      <span className="bb-subscription-tooltip-amount">{formatMoney(event.amount)}</span>
    </span>
  )
}

function CalendarOverflowTooltip({ events, day }: { events: CalendarEvent[]; day: number }) {
  return (
    <span className="bb-subscription-tooltip bb-subscription-tooltip-wide" role="tooltip">
      <strong>More on day {day}</strong>
      {events.map((event, index) => (
        <span
          key={`${event.kind}-${event.label}-${event.amount}-${index}`}
          className="bb-calendar-tooltip-category"
          style={{ color: calendarEventStyle(event).color }}
        >
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
    <div className="bb-bills-analytics bb-chart-page">
      <div className="bb-panel-head bb-bills-analytics-head bb-chart-page-header">
        <div>
          <div className="bb-chart-kicker">Bills & Utilities</div>
          <div className="bb-chart-total">{formatMoney(currentTotal)}</div>
          <div className="bb-chart-mode-note">{projected ? "Projected" : "Current"}</div>
        </div>
        <Badge variant="secondary">{items.length} tracked</Badge>
      </div>
      {!items.length ? (
        <div className="bb-empty bb-chart-page-body">No bill history found.</div>
      ) : (
        <BillsUtilitiesChart items={items} billEvents={billEvents} year={year} month={month} />
      )}
      <div className="bb-chart-page-footer">
        {items.length ? (
          <DetailsPanel summary="Details" collapseKey={collapseKey}>
            <BillsUtilitiesSummary items={items} />
          </DetailsPanel>
        ) : null}
      </div>
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
    <ChartContainer config={utilityHistoryChartConfig(items)} className="bb-bills-chart-box bb-chart-page-body">
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
              connectNulls
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              // Follow each responsive resize frame; do not tween again after
              // the shared disclosure has already reached its final height.
              isAnimationActive={false}
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
  const rowsByMonth = new Map<number, Record<string, string | number | null>>()
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
    color: CATEGORY_CHART_COLORS.static_bills_subscriptions_needs,
    background: "hsl(var(--category-subs-needs) / 0.1)",
  },
  wants: {
    label: "Wants",
    color: CATEGORY_CHART_COLORS.subscriptions_wants,
    background: "hsl(var(--category-subs-wants) / 0.1)",
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
    <SlidingSelection value={tone} className="bb-tabs-list bb-subscription-tone-control" role="tablist" aria-label="Subscription view">
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
    </SlidingSelection>
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

function SubscriptionAllItemsGrid({ items, showAll = false }: { items: SubscriptionItem[]; showAll?: boolean }) {
  const needs = items.filter((item) => subscriptionToneForItem(item) === "needs")
  const wants = items.filter((item) => subscriptionToneForItem(item) === "wants")

  return (
    <div className="bb-subscription-all-grid">
      <SubscriptionCompactTable title="Needs" items={needs} tone="needs" showAll={showAll} />
      <SubscriptionCompactTable title="Wants" items={wants} tone="wants" showAll={showAll} />
    </div>
  )
}

function FixedBillItemsTable({ items, month }: { items: CalendarEvent[]; month: number }) {
  return (
    <section className="bb-subscription-compact-group" aria-label="Fixed bills">
      <div className="bb-subscription-compact-heading">
        <span style={{ color: CATEGORY_CHART_COLORS.static_bills_subscriptions_needs }}>Fixed bills</span>
        <strong>{formatMoney(items.reduce((sum, item) => sum + item.amount, 0))}</strong>
      </div>
      <ol className="bb-activity-list">
        {items.map((item, index) => <li key={calendarEventKey(item, index)}>
          <div><strong>{item.label}</strong><span>{month}/{item.day} · scheduled date</span></div>
          <div><strong>{formatMoney(item.amount)}</strong>
            <small className={`bb-activity-status bb-activity-${calendarActivityStatus(item)}`}>
              {calendarActivityStatus(item) === "scheduled" ? "Scheduled" : "Recorded"}
            </small>
          </div>
        </li>)}
      </ol>
    </section>
  )
}

function SubscriptionCompactTable({
  title,
  items,
  tone,
  showAll = false,
}: {
  title: string
  items: SubscriptionItem[]
  tone: Exclude<SubscriptionTone, "all">
  showAll?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const toneConfig = SUBSCRIPTION_TONES[tone]
  const total = items.reduce((sum, item) => sum + item.amount, 0)
  const visibleItems = items.slice(0, 5)
  const rows = showAll || expanded ? items : visibleItems
  const hasMore = !showAll && items.length > visibleItems.length

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

const PACIFIC_CALENDAR_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "numeric",
  day: "numeric",
})

function isCurrentCalendarDay(year: number, month: number, day: number, now = new Date()) {
  const parts = PACIFIC_CALENDAR_DATE.formatToParts(now)
  const date = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))
  return date.year === year && date.month === month && date.day === day
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
