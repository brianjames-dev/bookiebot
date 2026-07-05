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
  monthlyIncome: number
  remainingBudget: number | null
  remainingNeedsBudget: number | null
  remainingWantsBudget: number | null
  amountSaved: number | null
  incomeAfterExpenses: number | null
}

export interface ExpenseReportData {
  ownerName: string
  monthLabel: string
  generatedAt: string
  metrics: Metrics
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
