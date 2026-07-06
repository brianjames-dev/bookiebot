export interface AmountRow {
  label: string
  amount: number
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

export interface SubscriptionItem extends AmountRow {
  name: string
  cadence: string
  kind: string
  pullDay: number | null
  pullMonth: number | null
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
  amountSaved: number | null
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
  burnRate: BurnRate | null
  breakdown: BreakdownItem[]
  dailyTotals: AmountRow[]
  budgetGroups: AmountRow[]
  personTotals: AmountRow[]
  merchantTotals: AmountRow[]
  topEntries: ExpenseEntry[]
  dailyEntries: ExpenseEntry[]
  rentPayments: PaymentItem[]
  utilityPayments: PaymentItem[]
  subscriptionsNeeds: SubscriptionItem[]
  subscriptionsWants: SubscriptionItem[]
  incomeEntries: PaymentItem[]
}
