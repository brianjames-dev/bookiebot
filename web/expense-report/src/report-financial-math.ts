import type {BudgetCategoryKey,CategoryBalanceAmounts,CategoryBalances,BurnRate} from "./types"

function roundCurrency(value:number){return Math.round((Number.isFinite(value)?value:0)*100)/100}

const CATEGORY_BALANCE_PRIORITIES: Array<[BudgetCategoryKey, BudgetCategoryKey[]]> = [
  ["needs", ["wants", "savings"]],
  ["wants", ["savings", "needs"]],
  ["savings", ["wants", "needs"]],
]

export function cascadeCategoryBalances(rawAmounts: CategoryBalanceAmounts): CategoryBalances {
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

export function projectedBurnRateFromIncome(
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
