import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, DollarSign, Droplets, Flame, Fuel, GraduationCap, House, Package, PiggyBank, ReceiptText, Repeat2, ShieldCheck, ShoppingBag, ShoppingBasket, Utensils, Wifi, Zap } from 'lucide-react'
import { createDailyDayMotion, DAILY_PREVIEW_COUNT } from './daily-transactions-motion'
import { transactionCategory, transactionMerchant, transactionText, type DailyTransaction } from './transaction-identity'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const categoryOrder = new Intl.Collator('en-US', { sensitivity: 'base' })
const icons: Record<string, typeof House> = { house: House, basket: ShoppingBasket, fuel: Fuel, utensils: Utensils, bag: ShoppingBag, package: Package, repeat: Repeat2, receipt: ReceiptText, dollar: DollarSign, piggy: PiggyBank, droplets: Droplets, wifi: Wifi, zap: Zap, flame: Flame, shield: ShieldCheck, graduation: GraduationCap }

export function TransactionIcon({ entry, aliases, eager = false }: { entry: DailyTransaction; aliases?: Record<string, string>; eager?: boolean }) {
  const merchant = transactionMerchant(entry, aliases)
  const fallback = transactionCategory(entry)
  const Icon = icons[fallback.icon]
  const [loaded, setLoaded] = useState('')
  const [failed, setFailed] = useState('')
  const ready = Boolean(merchant && loaded === merchant.src && failed !== merchant.src)
  return <span className="bb-transaction-icon" data-merchant={merchant?.id || 'fallback'} data-token={fallback.token} data-ready={ready} aria-hidden="true"
    style={{ '--bb-merchant-bg': merchant?.background || 'transparent', '--bb-merchant-inset': `${merchant?.inset ?? 0}px` } as CSSProperties}>
    <span className="bb-transaction-fallback"><Icon strokeWidth={1.7} /></span>
    {merchant && failed !== merchant.src && <img key={merchant.src} src={merchant.src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={() => setLoaded(merchant.src)} onError={() => setFailed(merchant.src)} />}
  </span>
}

export type DailyTransactionGroup = { day: string; entries: DailyTransaction[]; today: boolean }
export function DailyTransactionDays({ groups, categoryColors, year, month, aliases }: {
  groups: DailyTransactionGroup[]; categoryColors: Record<string, string>; year: number; month: number; aliases?: Record<string, string>
}) {
  return <div className="bb-daily-days">{groups.map(group => <DailyTransactionDay key={`${year}-${month}-${group.day}`} {...group} categoryColors={categoryColors} year={year} month={month} aliases={aliases} />)}</div>
}

function DailyTransactionDay({ day, entries, today, categoryColors, year, month, aliases }: DailyTransactionGroup & {
  categoryColors: Record<string, string>; year: number; month: number; aliases?: Record<string, string>
}) {
  const [open, setOpen] = useState(false)
  const opened = useRef(false)
  const section = useRef<HTMLElement>(null)
  const motion = useRef<ReturnType<typeof createDailyDayMotion> | null>(null)
  const id = useId()
  const dated = Number.isFinite(Number(day))
  const weekday = useMemo(() => dated ? new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(year, month - 1, Number(day), 12)) : '', [dated, day, year, month])
  // Sort once per data change; toggling a day doesn't rebuild its transaction rows.
  const sorted = useMemo(() => entries.map((entry, index) => ({ entry, index, category: transactionCategory(entry).label }))
    .sort((a, b) => categoryOrder.compare(a.category, b.category) || a.index - b.index), [entries])
  const total = useMemo(() => money.format(entries.reduce((sum, entry) => sum + entry.amount, 0)), [entries])
  useLayoutEffect(() => {
    if (!section.current) return
    const scene = createDailyDayMotion(section.current, open)
    motion.current = scene
    return () => { scene.dispose(); motion.current = null }
  }, [sorted, aliases])
  useLayoutEffect(() => { motion.current?.setOpen(open) }, [open, sorted, aliases])
  return <section className="bb-daily-day-group" ref={section} data-entry-count={sorted.length}>
    <button type="button" className="bb-daily-day-header" data-undated={!dated} aria-expanded={open} aria-controls={id} aria-current={today ? 'date' : undefined} aria-label={`${today ? 'Today, ' : ''}${weekday} ${day}, ${total}, ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`} onClick={() => { opened.current = true; setOpen(value => !value) }}>
      <span className="bb-daily-day-date" data-today={today}><span className="bb-daily-day">{day}</span>{weekday && <span className="bb-daily-date-weekday">{today ? 'Today' : weekday}</span>}</span>
      <span className="bb-daily-date-copy">
        <TransactionPreview entries={sorted} aliases={aliases} />
        <span className="bb-daily-day-count" aria-hidden="true">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
      </span>
      <span className="bb-daily-day-total">{total}</span><ChevronDown aria-hidden="true" />
    </button>
    <div className="bb-details-content bb-daily-day-panel" id={id} role="region" aria-label={`${weekday} ${day} transactions`} aria-hidden={!open} inert={!open}>
      <div className="bb-details-content-inner">{opened.current && <TransactionRows entries={sorted} aliases={aliases} categoryColors={categoryColors} />}</div>
    </div>
    <TransactionBeads entries={opened.current ? sorted : sorted.slice(0, DAILY_PREVIEW_COUNT)} total={sorted.length} aliases={aliases} categoryColors={categoryColors} />
  </section>
}

type SortedTransaction = { entry: DailyTransaction; index: number; category: string }
const TransactionPreview = memo(function TransactionPreview({ entries, aliases }: {
  entries: SortedTransaction[]; aliases?: Record<string, string>
}) {
  const shown = entries.slice(0, DAILY_PREVIEW_COUNT)
  const remaining = entries.length - shown.length
  const names = shown.map(({ entry }) => transactionText(entry, transactionMerchant(entry, aliases)).primary)
  return <span className="bb-daily-preview" role="img" aria-label={`${entries.length} ${entries.length === 1 ? 'transaction' : 'transactions'}: ${names.join(', ')}${remaining ? `, ${remaining} more` : ''}`}>
    {shown.map(({ index }) => <span className="bb-daily-preview-item" key={index} aria-hidden="true" />)}
    {remaining > 0 && <span className="bb-daily-preview-item" aria-hidden="true" />}
  </span>
})

const TransactionBeads = memo(function TransactionBeads({ entries, total, aliases, categoryColors }: {
  entries: SortedTransaction[]; total: number; aliases?: Record<string, string>; categoryColors: Record<string, string>
}) {
  return <span className="bb-daily-icon-layer" aria-hidden="true">
    {entries.map(({ entry, index }, position) => <span className="bb-daily-bead" data-entry={position} data-logo={Boolean(transactionMerchant(entry, aliases))} key={index} style={{ zIndex: total + 1 - position, '--bb-preview-category': categoryColors[entry.category] || 'hsl(var(--muted-foreground))' } as CSSProperties}>
      <span className="bb-daily-bead-paint"><span className="bb-daily-bead-body"><TransactionIcon entry={entry} aliases={aliases} eager={position < DAILY_PREVIEW_COUNT} /></span>{position < DAILY_PREVIEW_COUNT && <span className="bb-daily-preview-dot" />}</span>
      <span className="bb-daily-mask-host" />
    </span>)}
    {total > DAILY_PREVIEW_COUNT && <span className="bb-daily-overflow"><span className="bb-daily-preview-more">+{total - DAILY_PREVIEW_COUNT}</span><span className="bb-daily-mask-host" /></span>}
  </span>
})

const TransactionRows = memo(function TransactionRows({ entries, aliases, categoryColors }: {
  entries: SortedTransaction[]; aliases?: Record<string, string>; categoryColors: Record<string, string>
}) {
  return <div className="bb-daily-day-entries">
    {entries.map(({ entry, index }) => {
      const text = transactionText(entry, transactionMerchant(entry, aliases))
      return <div className="bb-daily-transaction" key={index} data-category={entry.category} data-scheduled={entry.status === 'scheduled'}>
        <span className="bb-daily-row-icon-anchor" aria-hidden="true" />
        <span className="bb-daily-transaction-name">{text.primary}</span><span className="bb-daily-transaction-money">{money.format(entry.amount)}</span>
        <span className="bb-daily-transaction-meta"><span className="bb-daily-transaction-category" style={{ color: categoryColors[entry.category] }}>{text.category}</span>{text.item && <><span aria-hidden="true">·</span><span className="bb-daily-transaction-item">{text.item}</span></>}</span>
        {entry.status === 'scheduled' && <small className="bb-daily-transaction-status">Scheduled</small>}
      </div>
    })}
  </div>
})
