export interface AmountRow {
  label: string
  amount: number
}

export interface OccurrenceRow extends AmountRow {
  count: number
}

export interface BreakdownItem extends AmountRow {
  key: string
  percentage: number
  color: string
}

export interface ExpenseEntry {
  date: string
  category: string
  amount: number
  person: string
  item: string
  location: string
}

export interface PaymentItem extends AmountRow {
  group: string
  status?: string
}

export interface UtilityHistoryPoint extends AmountRow {
  month: number
}

export interface UtilityHistoryItem {
  key: string
  label: string
  currentAmount: number
  averageAmount: number
  deltaAmount: number
  history: UtilityHistoryPoint[]
}

export interface SubscriptionItem extends AmountRow {
  name: string
  cadence: string
  kind: string
  pullDay: number | null
  pullMonth: number | null
}

export type CalendarEventKind = "subscription" | "bill" | "income"

export interface CalendarEvent {
  kind: CalendarEventKind
  label: string
  amount: number
  day: number
  group: string
  projectedOnly: boolean
}

export interface IncomeProjection {
  currentAmount: number
  projectedAmount: number
  savingsGoal: number
}

export interface SavingsProjection {
  currentAmount: number
  projectedAmount: number
  currentIdeal: number
  currentMinimum: number
  projectedIdeal: number
  projectedMinimum: number
  currentPaycheckCount: number
  projectedPaycheckCount: number
}

export type BudgetCategoryKey = "needs" | "wants" | "savings"

export type CategoryBalanceAmounts = Record<BudgetCategoryKey, number>

export interface CategoryBalanceTransfer {
  from: BudgetCategoryKey
  to: BudgetCategoryKey
  amount: number
}

export interface CategoryBalances {
  raw: CategoryBalanceAmounts
  remaining: CategoryBalanceAmounts
  deficits: CategoryBalanceAmounts
  transfers: CategoryBalanceTransfer[]
  totalOverspend: number
}

export interface Metrics {
  totalExpenses: number
  sharedExpenses: number
  personalOutflows: number
  fixedCommitments: number
  monthlyIncome: number
  remainingBudget: number | null
  remainingNeedsBudget: number | null
  remainingWantsBudget: number | null
  remainingSavingsBudget: number | null
  needsRollover: number | null
  wantsRollover: number | null
  amountSaved: number | null
  savingsGoal: number | null
  incomeAfterExpenses: number | null
}

export interface BurnRate {
  budget: number
  spent: number
  remaining: number
  daysInMonth: number
  elapsedDays: number
  expectedSpend: number
  allowedDailyAverage: number
  actualDailyAverage: number
  dailyDifference: number
  totalDifference: number
  status: "over" | "under" | "not_started"
  series: BurnRatePoint[]
}

export interface BurnRatePoint {
  day: number
  label: string
  dailySpend: number | null
  actualSpend: number | null
  expectedSpend: number
  variance: number | null
}

export interface ExpenseReportData {
  ownerName: string
  monthLabel: string
  year: number
  month: number
  daysInMonth: number
  elapsedDays: number
  generatedAt: string
  metrics: Metrics
  categoryBalances?: CategoryBalances
  incomeProjection: IncomeProjection
  savingsProjection: SavingsProjection
  burnRate: BurnRate | null
  breakdown: BreakdownItem[]
  dailyTotals: AmountRow[]
  budgetGroups: AmountRow[]
  personTotals: AmountRow[]
  merchantTotals: AmountRow[]
  merchantOccurrences: OccurrenceRow[]
  topEntries: ExpenseEntry[]
  dailyEntries: ExpenseEntry[]
  needExpenses: PaymentItem[]
  calendarEvents: CalendarEvent[]
  utilityHistory: UtilityHistoryItem[]
  subscriptionsNeeds: SubscriptionItem[]
  subscriptionsWants: SubscriptionItem[]
}
