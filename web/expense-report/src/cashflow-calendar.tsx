import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { CalendarDays, Rows2, CreditCard, Droplets, GraduationCap, House, Repeat, ShieldCheck, Wallet, Wifi, Zap } from 'lucide-react'
import { companyLogo } from './company-logo'
import { calendarActivityStatus } from './report-activity'
import { CALENDAR_LAYOUT, CALENDAR_COLORS, calendarDates, calendarDot, calendarRange, calendarTotals, compactCalendarAmount, dateKey, eventsForDate, logoCapacity, pacificToday } from './calendar-model'
import type { CalendarEvent, CalendarMonth } from './types'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
export type CalendarSelection = { key: string; title: string; events: CalendarEvent[] }
export function calendarEventDescription(event: CalendarEvent): string {
  return `${event.label} · ${event.kind === 'subscription' ? 'Subscription' : event.kind === 'bill' ? 'Bill' : 'Income'} · ${event.amountUnknown ? 'Amount not entered' : money.format(event.amount)} · ${calendarActivityStatus(event) === 'scheduled' || event.amountUnknown ? 'Scheduled' : 'Recorded'}${event.amountEstimated ? ' · Estimated amount' : ''}`
}
function FallbackIcon({ event }: { event: CalendarEvent }) {
  const label = event.label.toLowerCase()
  const Icon = event.kind === 'income' ? Wallet : event.kind === 'subscription' ? Repeat
    : /water/.test(label) ? Droplets : /loan/.test(label) ? GraduationCap : /rent/.test(label) ? House
    : /internet|xfinity|spectrum|phone/.test(label) ? Wifi : /insurance/.test(label) ? ShieldCheck
    : /pge|pg&e|electric|power|gas/.test(label) ? Zap : CreditCard
  return <Icon aria-hidden="true" />
}
export function CompanyMedallion({ event, aliases }: { event: CalendarEvent; aliases?: Record<string, string> }) {
  const logo = companyLogo(event.label, aliases)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const ready = Boolean(logo && loaded === logo.src && failed !== logo.src)
  return <span className="bb-cf-medallion" data-logo-ready={ready} style={{ '--cf-event': CALENDAR_COLORS[event.kind] } as CSSProperties}>
    <span className="bb-cf-medallion-layer">
      <span className="bb-cf-medallion-face">
        <FallbackIcon event={event} />
        {logo && failed !== logo.src && <img src={logo.src} className="bb-cf-logo" alt="" aria-hidden="true" loading="lazy" decoding="async"
          onLoad={() => setLoaded(logo.src)} onError={() => setFailed(logo.src)} />}
      </span>
      <span className="bb-cf-kind-dot" />
    </span>
  </span>
}
export function CashflowCalendar({ year, month, events, context = [], aliases, projected, onInspect }: {
  year: number; month: number; events: CalendarEvent[]; context?: CalendarMonth[]; aliases?: Record<string, string>; projected: boolean
  onInspect: (selection: CalendarSelection) => void
}) {
  const [mode, setMode] = useState<'weeks' | 'month'>('weeks')
  const [cellHeight, setCellHeight] = useState(186)
  const grid = useRef<HTMLDivElement>(null)
  const oldRects = useRef<Map<string, DOMRect> | null>(null)
  const animations = useRef<Animation[]>([])
  const today = pacificToday()
  const dates = calendarDates(year, month, mode, today)
  const days = dates.map(date => ({ date, ...eventsForDate(date, year, month, events, context) }))
  const visible = days.filter(day => mode === 'weeks' || day.date.getUTCMonth() === month - 1)
  // Keep Current/Projected summary semantics; schedules remain visible in either
  // mode, as in the existing calendar. Calendar context never changes Spent.
  const summary = calendarTotals(visible.flatMap(day => day.events).filter(item => projected || !item.projectedOnly))
  const unknown = visible.some(day => !day.available) || summary.unknown
  const rows = calendarDates(year, month, 'month', today).length / 7
  const inspect = (date: Date, items: CalendarEvent[], suffix = '') => onInspect({ key: `${dateKey(date)}${suffix}`, title: dateLabel.format(date), events: items })
  const toggle = () => {
    oldRects.current = new Map(Array.from(grid.current?.querySelectorAll<HTMLElement>('[data-date]') ?? [])
      .map(element => [element.dataset.date!, element.getBoundingClientRect()]))
    animations.current.forEach(animation => animation.cancel())
    setMode(value => value === 'weeks' ? 'month' : 'weeks')
  }
  useLayoutEffect(() => {
    const element = grid.current
    if (!element) return
    const update = () => setCellHeight((element.clientHeight - CALENDAR_LAYOUT.cellGap) / 2)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!oldRects.current || !grid.current) return
    const before = oldRects.current
    oldRects.current = null
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    animations.current = Array.from(grid.current.querySelectorAll<HTMLElement>('[data-date]')).map(element => {
      const previous = before.get(element.dataset.date!), next = element.getBoundingClientRect()
      return element.animate(previous ? [
        { transform: `translate(${previous.x - next.x}px, ${previous.y - next.y}px) scale(${previous.width / next.width}, ${previous.height / next.height})` },
        { transform: 'none' },
      ] : [{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.22,.8,.24,1)' })
    })
  }, [mode])
  useLayoutEffect(() => () => animations.current.forEach(animation => animation.cancel()), [])
  return <section className="bb-cashflow-calendar bb-chart-page" data-mode={mode} aria-label="Cashflow calendar"
    style={{ '--cf-icon': `${CALENDAR_LAYOUT.iconSize}px`, '--cf-overlap': CALENDAR_LAYOUT.overlap, '--cf-cutout': `${CALENDAR_LAYOUT.cutout}px`, '--cf-pitch': `${CALENDAR_LAYOUT.iconSize * (1 - CALENDAR_LAYOUT.overlap)}px`, '--cf-bottom-gap': `${CALENDAR_LAYOUT.bottomGap}px`, '--cf-rows': rows, '--cf-grid-target': `${rows * CALENDAR_LAYOUT.monthCellHeight + (rows - 1) * CALENDAR_LAYOUT.cellGap}px` } as CSSProperties}>
    <div className="bb-cf-header">
      <div><div className="bb-cf-range">{calendarRange(dates, mode === 'month', year, month)}</div>
        <div className="bb-cf-summary" aria-live="polite"><strong>{money.format(summary.outgoing)}</strong><span>{unknown ? 'known outgoing' : 'outgoing'}</span></div></div>
      <button type="button" className="bb-cf-view-toggle" data-bb-tooltip-dismiss-trigger="calendar" onClick={toggle} aria-label={mode === 'weeks' ? 'Show full month' : 'Show this week and next week'} aria-pressed={mode === 'month'}>
        {mode === 'weeks' ? <CalendarDays aria-hidden="true" /> : <Rows2 aria-hidden="true" />}
      </button>
    </div>
    <div className="bb-cf-body bb-chart-page-body">
      <div className="bb-cf-weekdays" aria-hidden="true">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => <span key={i}>{day}</span>)}</div>
      <div ref={grid} className="bb-cf-grid">
        {days.map(({ date, events: items, available }) => {
          const outside = mode === 'month' && (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1)
          const totals = calendarTotals(items)
          const capacity = logoCapacity(cellHeight, totals.incoming > 0 || totals.outgoing > 0)
          const overflow = items.length > capacity
          const shown = overflow ? items.slice(0, Math.max(0, capacity - 1)) : items
          const key = dateKey(date), isToday = key === dateKey(today), past = date < today
          return <div key={key} className="bb-cf-day" data-date={key} data-outside={outside} data-past={past} data-today={isToday} aria-hidden={outside}>
            {!outside && <>
              <button type="button" className="bb-cf-date" aria-current={isToday ? 'date' : undefined}
                aria-label={`${dateLabel.format(date)}${isToday ? ', today' : ''}${available ? `: ${items.length} ${items.length === 1 ? 'event' : 'events'}` : ': schedule unavailable'}`}
                disabled={!available || items.length === 0} onClick={() => inspect(date, items)}>
                <span>{date.getUTCDate()}</span>{date.getUTCDate() === 1 && <small>{date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</small>}
              </button>
              {mode === 'weeks' ? <>
                <div className="bb-cf-icons">{shown.map((item, index) => <button type="button" className="bb-cf-event" key={`${item.kind}-${item.label}-${index}`}
                  aria-label={calendarEventDescription(item)} onClick={() => inspect(date, [item], `-${index}`)}><CompanyMedallion event={item} aliases={aliases} /></button>)}
                  {overflow && <button type="button" className="bb-cf-event bb-cf-overflow" aria-label={`Show all ${items.length} events on ${dateLabel.format(date)}`} onClick={() => inspect(date, items)}>
                    <span className="bb-cf-medallion"><span className="bb-cf-medallion-layer"><span className="bb-cf-medallion-face">+{items.length - shown.length}</span></span></span>
                  </button>}
                </div>
                {(totals.outgoing > 0 || totals.incoming > 0) && <button type="button" className="bb-cf-day-totals" onClick={() => inspect(date, items)}
                  aria-label={`${dateLabel.format(date)}: ${money.format(totals.outgoing)} outgoing, ${money.format(totals.incoming)} incoming${totals.unknown ? ', some amounts not entered' : ''}`}>
                  {totals.outgoing > 0 && <span data-direction="out">−{compactCalendarAmount(totals.outgoing)}</span>}
                  {totals.incoming > 0 && <span data-direction="in">+{compactCalendarAmount(totals.incoming)}</span>}
                </button>}
              </> : items.length > 0 && <button type="button" className="bb-cf-combined-hit" onClick={() => inspect(date, items)} aria-label={`${dateLabel.format(date)}: ${items.map(calendarEventDescription).join('; ')}`}>
                <span className="bb-cf-combined" style={{ background: calendarDot(items) }} />
              </button>}
              {!available && <span className="bb-cf-unavailable" title="Schedule unavailable">—</span>}
            </>}
          </div>
        })}
      </div>
    </div>
    <div className="bb-cf-legend" aria-label="Calendar legend">{(['bill', 'subscription', 'income'] as const).map(kind => <span key={kind}><i style={{ background: CALENDAR_COLORS[kind] }} />{kind === 'bill' ? 'Bills' : kind === 'subscription' ? 'Subs' : 'Income'}</span>)}</div>
  </section>
}
export function CalendarDayDetails({ selection, aliases }: { selection: CalendarSelection; aliases?: Record<string, string> }) {
  const totals = calendarTotals(selection.events)
  return <div className="bb-cf-details">
    <div className="bb-cf-detail-totals"><span><small>Outgoing</small><strong>{money.format(totals.outgoing)}</strong></span>
      {totals.incoming > 0 && <span><small>Incoming</small><strong>{money.format(totals.incoming)}</strong></span>}</div>
    <ul>{selection.events.map((event, i) => <li key={`${event.kind}-${event.label}-${i}`}>
      <CompanyMedallion event={event} aliases={aliases} /><span><strong>{event.label}</strong>
        <small>{event.kind === 'subscription' ? (event.group === 'subscriptions_wants' ? 'Subs (Wants)' : 'Subs (Needs)') : event.kind === 'income' ? 'Income' : 'Bill'} · {calendarActivityStatus(event) === 'scheduled' || event.amountUnknown ? 'Scheduled' : 'Recorded'}{event.amountEstimated ? ' · Estimated' : ''}</small></span>
      <b>{event.amountUnknown ? 'Not entered' : money.format(event.amount)}</b>
    </li>)}</ul>
    <p>Scheduled dates do not confirm bank posting.{totals.unknown ? ' Bills without an entered amount are not included in totals.' : ''}</p>
  </div>
}
