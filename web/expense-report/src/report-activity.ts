import type { BreakdownItem, CalendarEvent, ExpenseEntry, ExpenseReportData } from './types'

export type ActivityStatus = 'recorded' | 'scheduled'
export interface ReportActivity extends ExpenseEntry {
  id: string
  day: number | null
  status: ActivityStatus
  dateSource: 'recorded' | 'scheduled'
}
export function activityDay(value: string, year: number, month: number): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(value.trim())
  if (!iso && !us) return null
  const parsedYear = iso ? Number(iso[1]) : us?.[3] ? Number(us[3]) + (us[3].length === 2 ? 2000 : 0) : year
  const parsedMonth = Number(iso ? iso[2] : us?.[1])
  const day = Number(iso ? iso[3] : us?.[2])
  return parsedYear === year && parsedMonth === month && day >= 1 && day <= new Date(year, month, 0).getDate() ? day : null
}
export function calendarActivityCategory(event: CalendarEvent) {
  if (event.group === 'static_bills_subscriptions_needs') return 'Static Bills & Subscriptions'
  return event.kind === 'bill' ? event.group === 'rent' ? 'Rent' : 'Bills & Utilities'
    : (event.group === 'subscriptions_wants' || event.group === 'wants') ? 'Subs (Wants)' : 'Static Bills & Subscriptions'
}
export function activityMatchesCategory(entry: ReportActivity, category: Pick<BreakdownItem, 'key' | 'label'>) {
  if (category.key === 'static_bills_subscriptions_needs') {
    // Saved reports may retain the shorter label from before fixed bills joined
    // this group. The stable category key preserves their transaction drilldown.
    return entry.category === 'Subs (Needs)' || entry.category === 'Static Bills & Subscriptions'
  }
  return entry.category === category.label
}
export function calendarActivityStatus(event: CalendarEvent): ActivityStatus {
  // A subscription’s scheduled pull passing does not prove it posted at a bank.
  // A bill's future due date is separate from its amount's provenance. Only an
  // explicit estimate is scheduled; a recorded amount stays recorded on any day.
  return event.amountEstimated || event.kind === 'subscription' || (event.kind === 'income' && event.projectedOnly) ? 'scheduled' : 'recorded'
}
export function reportActivity(report: ExpenseReportData, events: CalendarEvent[], projected: boolean): ReportActivity[] {
  return [
    ...report.dailyEntries.map((entry, index) => ({...entry, id:`expense-${index}`, day:activityDay(entry.date, report.year, report.month), status:'recorded' as const, dateSource:'recorded' as const})),
    ...events.filter(event => event.kind !== 'income' && (
      projected || !event.projectedOnly || (
        event.kind === 'bill' && event.group === 'static_bills_subscriptions_needs' && !event.amountEstimated
      )
    )).map((event, index) => ({
      id:`calendar-${index}`, date:`${report.month}/${event.day}/${report.year}`, day:event.day,
      category:calendarActivityCategory(event), amount:event.amount, person:report.ownerName,
      item:event.label, location:'', status:calendarActivityStatus(event), dateSource:'scheduled' as const,
    })),
  ].sort((a,b) => (a.day ?? 99) - (b.day ?? 99) || a.id.localeCompare(b.id))
}
export function activitySummary(entries: ReportActivity[]) {
  const cents = (status: ActivityStatus) => entries.filter(e=>e.status===status).reduce((sum,e)=>sum+Math.round(e.amount*100),0)
  const recorded = cents('recorded') / 100
  const scheduled = cents('scheduled') / 100
  return {recorded, scheduled, total:Math.round((recorded+scheduled)*100)/100}
}
