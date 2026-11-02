import { memo, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, DollarSign, Droplets, Flame, Fuel, GraduationCap, House, Package, PiggyBank, ReceiptText, Repeat2, ShieldCheck, ShoppingBag, ShoppingBasket, Utensils, Wifi, Zap } from 'lucide-react'
import { CollapsibleContent } from './components/ui/motion'
import { transactionCategory, transactionMerchant, transactionText, type DailyTransaction } from './transaction-identity'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const categoryOrder = new Intl.Collator('en-US', { sensitivity: 'base' })
const icons: Record<string, typeof House> = { house: House, basket: ShoppingBasket, fuel: Fuel, utensils: Utensils, bag: ShoppingBag, package: Package, repeat: Repeat2, receipt: ReceiptText, dollar: DollarSign, piggy: PiggyBank, droplets: Droplets, wifi: Wifi, zap: Zap, flame: Flame, shield: ShieldCheck, graduation: GraduationCap }

export function TransactionIcon({ entry, aliases }: { entry: DailyTransaction; aliases?: Record<string, string> }) {
  const merchant = transactionMerchant(entry, aliases)
  const fallback = transactionCategory(entry)
  const Icon = icons[fallback.icon]
  const [loaded, setLoaded] = useState('')
  const [failed, setFailed] = useState('')
  const ready = Boolean(merchant && loaded === merchant.src && failed !== merchant.src)
  return <span className="bb-transaction-icon" data-merchant={merchant?.id || 'fallback'} data-token={fallback.token} data-ready={ready} aria-hidden="true"
    style={{ '--bb-merchant-bg': merchant?.background || 'transparent', '--bb-merchant-inset': `${merchant?.inset ?? 0}px` } as CSSProperties}>
    <span className="bb-transaction-fallback"><Icon strokeWidth={1.7} /></span>
    {merchant && failed !== merchant.src && <img key={merchant.src} src={merchant.src} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(merchant.src)} onError={() => setFailed(merchant.src)} />}
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
  const id = useId()
  const dated = Number.isFinite(Number(day))
  const weekday = useMemo(() => dated ? new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(year, month - 1, Number(day), 12)) : '', [dated, day, year, month])
  // Sort once per data change; toggling a day doesn't rebuild its transaction rows.
  const sorted = useMemo(() => entries.map((entry, index) => ({ entry, index, category: transactionCategory(entry).label }))
    .sort((a, b) => categoryOrder.compare(a.category, b.category) || a.index - b.index), [entries])
  const total = useMemo(() => money.format(entries.reduce((sum, entry) => sum + entry.amount, 0)), [entries])
  return <section className="bb-daily-day-group">
    <button type="button" className="bb-daily-day-header" data-undated={!dated} aria-expanded={open} aria-controls={id} aria-current={today ? 'date' : undefined} title={today ? 'Today' : undefined} onClick={() => { opened.current = true; setOpen(value => !value) }}>
      <span className="bb-daily-day-date"><span className={today ? 'bb-daily-day bb-daily-day-today' : 'bb-daily-day'}>{day}</span><span className="bb-daily-date-copy">
        {weekday && <strong>{weekday}</strong>}<TransactionPreview entries={sorted} aliases={aliases} categoryColors={categoryColors} />
      </span></span>
      <span className="bb-daily-day-total">{total}</span><ChevronDown aria-hidden="true" />
    </button>
    <CollapsibleContent open={open} id={id} lazy={!opened.current}>
      <TransactionRows entries={sorted} aliases={aliases} categoryColors={categoryColors} />
    </CollapsibleContent>
  </section>
}

type SortedTransaction = { entry: DailyTransaction; index: number; category: string }
const TransactionPreview = memo(function TransactionPreview({ entries, aliases, categoryColors }: {
  entries: SortedTransaction[]; aliases?: Record<string, string>; categoryColors: Record<string, string>
}) {
  const shown = entries.slice(0, 2)
  const remaining = entries.length - shown.length
  const names = shown.map(({ entry }) => transactionText(entry, transactionMerchant(entry, aliases)).primary)
  return <span className="bb-daily-preview" role="img" aria-label={`${entries.length} ${entries.length === 1 ? 'transaction' : 'transactions'}: ${names.join(', ')}${remaining ? `, ${remaining} more` : ''}`}>
    {shown.map(({ entry, index }) => <span className="bb-daily-preview-item" key={index} aria-hidden="true">
      <span className="bb-daily-preview-layer" style={{ '--bb-preview-category': categoryColors[entry.category] || 'hsl(var(--muted-foreground))' } as CSSProperties}>
        <TransactionIcon entry={entry} aliases={aliases} /><span className="bb-daily-preview-dot" />
      </span>
    </span>)}
    {remaining > 0 && <span className="bb-daily-preview-item" aria-hidden="true"><span className="bb-daily-preview-layer"><span className="bb-daily-preview-more">+{remaining}</span></span></span>}
  </span>
})

const TransactionRows = memo(function TransactionRows({ entries, aliases, categoryColors }: {
  entries: SortedTransaction[]; aliases?: Record<string, string>; categoryColors: Record<string, string>
}) {
  return <div className="bb-daily-day-entries">
    {entries.map(({ entry, index }) => {
      const text = transactionText(entry, transactionMerchant(entry, aliases))
      return <div className="bb-daily-transaction" key={index} data-category={entry.category} data-scheduled={entry.status === 'scheduled'}>
        <TransactionIcon entry={entry} aliases={aliases} />
        <span className="bb-daily-transaction-name">{text.primary}</span><span className="bb-daily-transaction-money">{money.format(entry.amount)}</span>
        <span className="bb-daily-transaction-meta"><span className="bb-daily-transaction-category" style={{ color: categoryColors[entry.category] }}>{text.category}</span>{text.item && <><span aria-hidden="true">·</span><span className="bb-daily-transaction-item">{text.item}</span></>}</span>
        {entry.status === 'scheduled' && <small className="bb-daily-transaction-status">Scheduled</small>}
      </div>
    })}
  </div>
})
