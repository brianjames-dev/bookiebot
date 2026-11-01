import { useEffect, useMemo, useState } from "react"
import type { CalendarEvent, UtilityHistoryItem } from "./types"

type StorageAccess = Pick<Storage, "getItem" | "setItem">
export const billLabelKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "")
export const billPreferenceKey = (owner: string) => `bookiebot-bill-comparison:v1:${encodeURIComponent(owner.trim().toLowerCase())}`
function browserStorage(): StorageAccess | null {
  try { return typeof window === "undefined" ? null : window.localStorage } catch { return null }
}

export function loadBillSelection(owner: string, defaults: string[], storage = browserStorage()): string[] {
  try {
    const saved = JSON.parse(storage?.getItem(billPreferenceKey(owner)) || "null")
    if (saved?.version === 1 && Array.isArray(saved.keys) && saved.keys.every((key: unknown) => typeof key === "string")) {
      return [...new Set<string>(saved.keys)]
    }
  } catch { /* Storage is optional; the graph remains usable. */ }
  return [...defaults]
}

export function saveBillSelection(owner: string, keys: string[], storage = browserStorage()) {
  try { storage?.setItem(billPreferenceKey(owner), JSON.stringify({ version: 1, keys })) } catch { /* Private browsing. */ }
}

export function useBillSelection(owner: string, defaults: string[]) {
  // Defaults seed this owner once, rather than re-enabling newly discovered
  // bills on every refresh/month change. Keep absent IDs for their return.
  const initial = useMemo(() => loadBillSelection(owner, defaults), [owner])
  const [choices, setChoices] = useState<Record<string, string[]>>({})
  const key = billPreferenceKey(owner)
  const selected = choices[key] ?? initial
  useEffect(() => saveBillSelection(owner, selected), [owner, selected])
  return [selected, (next: string[]) => setChoices(current => ({ ...current, [key]: next }))] as const
}

export function comparisonItems(history: UtilityHistoryItem[], events: CalendarEvent[], month: number, projected: boolean): UtilityHistoryItem[] {
  const byName = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    if (event.kind === "income") continue
    const key = billLabelKey(event.label)
    byName.set(key, [...(byName.get(key) ?? []), event])
  }
  const existing = new Set(history.map(item => billLabelKey(item.label)))
  const total = (rows: CalendarEvent[]) => Math.round(rows.filter(event => projected || !event.projectedOnly).reduce((sum, event) => sum + event.amount, 0) * 100) / 100
  const items = history.map(item => {
    const rows = byName.get(billLabelKey(item.label))
    // The headline/pills honor Current/Projected; the historical plot always
    // retains recorded amounts and nulls, including the selected month.
    return { ...item, key: `bill_${billLabelKey(item.label)}`, currentAmount: rows ? total(rows) : item.currentAmount }
  })
  for (const [key, rows] of byName) {
    if (existing.has(key)) continue
    const amount = total(rows)
    const recorded = total(rows.filter(event => !event.projectedOnly && !event.amountEstimated && !event.amountUnknown))
    items.push({ key: `bill_${key}`, label: rows[0].label, currentAmount: amount, averageAmount: 0, deltaAmount: 0,
      // No historical monthly subscription snapshots exist. A current-month
      // point is honest; duplicating the current price backwards would not be.
      history: [{ month, label: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 1))), amount: recorded || null }] })
  }
  return items.sort((a, b) => a.label.localeCompare(b.label))
}

export function priorBillAverage(item: UtilityHistoryItem, month: number): number | null {
  const prior = item.history.filter(point => point.month < month && point.amount !== null && point.amount > 0)
  return prior.length ? prior.reduce((sum, point) => sum + point.amount!, 0) / prior.length : null
}
