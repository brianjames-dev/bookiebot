import type { CalendarEvent, CalendarMonth } from './types'

export const CALENDAR_LAYOUT = { iconSize: 26, overlap: .22, cutout: 1.5, monthCellHeight: 72, cellGap: 4, bottomGap: 24 } as const
const dayMs = 86_400_000
const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' })
export function pacificToday(now = new Date()): Date {
  const parts = pacific.formatToParts(now)
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')))
}
export function dateKey(date: Date): string { return date.toISOString().slice(0, 10) }
export function calendarDates(year: number, month: number, mode: 'weeks' | 'month', today = pacificToday()): Date[] {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const current = today.getUTCFullYear() === year && today.getUTCMonth() === month - 1
  const anchor = mode === 'weeks' && current ? today : first
  const start = anchor.getTime() - anchor.getUTCDay() * dayMs
  const rows = Math.ceil((first.getUTCDay() + new Date(Date.UTC(year, month, 0)).getUTCDate()) / 7)
  return Array.from({ length: mode === 'weeks' ? 14 : rows * 7 }, (_, i) => new Date(start + i * dayMs))
}
export function calendarRange(dates: Date[], monthMode: boolean, year: number, month: number): string {
  if (monthMode) return `${shortMonth.format(new Date(Date.UTC(year, month - 1, 1)))} 1 – ${new Date(Date.UTC(year, month, 0)).getUTCDate()}`
  const start = dates[0], end = dates[dates.length - 1]
  const first = `${shortMonth.format(start)} ${start.getUTCDate()}`
  const last = `${start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear() ? '' : `${shortMonth.format(end)} `}${end.getUTCDate()}`
  return start.getUTCFullYear() === end.getUTCFullYear() ? `${first} – ${last}` : `${first}, ${start.getUTCFullYear()} – ${last}, ${end.getUTCFullYear()}`
}
export function eventsForDate(date: Date, year: number, month: number, events: CalendarEvent[], context: CalendarMonth[]) {
  const selected = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
  const adjacent = context.find(item => item.year === date.getUTCFullYear() && item.month === date.getUTCMonth() + 1)
  const available = selected || adjacent?.available === true
  return { available, events: (selected ? events : adjacent?.events ?? []).filter(item => item.day === date.getUTCDate()) }
}
export function calendarTotals(events: CalendarEvent[]) {
  const sum = (income: boolean) => events.filter(item => (item.kind === 'income') === income && !item.amountUnknown)
    .reduce((total, item) => total + Math.round(item.amount * 100), 0) / 100
  return { incoming: sum(true), outgoing: sum(false), unknown: events.some(item => item.amountUnknown) }
}
export function compactCalendarAmount(amount: number): string {
  return amount >= 1000 ? `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(amount)}`
    : `$${Math.round(amount)}`
}
export function logoCapacity(cellHeight: number, hasAmounts: boolean): number {
  const available = cellHeight - 36 - (hasAmounts ? 38 : 0)
  return Math.max(1, Math.min(6, Math.floor((available - CALENDAR_LAYOUT.iconSize) / (CALENDAR_LAYOUT.iconSize * (1 - CALENDAR_LAYOUT.overlap))) + 1))
}
export const CALENDAR_COLORS = { bill: '#78b9e2', subscription: '#b999e5', income: 'hsl(var(--success))' }
export function calendarDot(events: CalendarEvent[]): string {
  const colors = [...new Set(events.map(item => CALENDAR_COLORS[item.kind]))]
  return colors.length < 2 ? colors[0] : `conic-gradient(${colors.map((color, i) => `${color} ${i * 100 / colors.length}% ${(i + 1) * 100 / colors.length}%`).join(', ')})`
}
