import {ChangedText,ChangedMoney,ChangedItem} from './transaction-value-motion'
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, DollarSign, Droplets, Flame, Fuel, GraduationCap, House, Package, PiggyBank, ReceiptText, Repeat2, ShieldCheck, ShoppingBag, ShoppingBasket, Utensils, Wifi, Zap } from 'lucide-react'
import { createDailyDayMotion, DAILY_PREVIEW_COUNT } from './daily-transactions-motion'
import { transactionCategory, transactionMerchant, transactionText, type DailyTransaction } from './transaction-identity'

const decodedLogos = new Set<string>()
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const categoryOrder = new Intl.Collator('en-US', { sensitivity: 'base' })
const icons: Record<string, typeof House> = { house: House, basket: ShoppingBasket, fuel: Fuel, utensils: Utensils, bag: ShoppingBag, package: Package, repeat: Repeat2, receipt: ReceiptText, dollar: DollarSign, piggy: PiggyBank, droplets: Droplets, wifi: Wifi, zap: Zap, flame: Flame, shield: ShieldCheck, graduation: GraduationCap }

export function TransactionIcon({ entry, aliases, eager = false }: { entry: DailyTransaction; aliases?: Record<string, string>; eager?: boolean }) {
  const merchant = transactionMerchant(entry, aliases)
  const fallback = transactionCategory(entry)
  const Icon = icons[fallback.icon]
  const [loaded, setLoaded] = useState(() => merchant && decodedLogos.has(merchant.src) ? merchant.src : '')
  const [failed, setFailed] = useState('')
  const ready = Boolean(merchant && loaded === merchant.src && failed !== merchant.src)
  return <span className="bb-transaction-icon" data-merchant={merchant?.id || 'fallback'} data-token={fallback.token} data-ready={ready} aria-hidden="true"
    style={{ '--bb-merchant-bg': merchant?.background || 'transparent', '--bb-merchant-inset': `${merchant?.inset ?? 0}px` } as CSSProperties}>
    <span className="bb-transaction-fallback"><Icon strokeWidth={1.7} /></span>
    {merchant && failed !== merchant.src && <img key={merchant.src} src={merchant.src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={() => { decodedLogos.add(merchant.src); setLoaded(merchant.src) }} onError={() => setFailed(merchant.src)} />}
  </span>
}

export type DailyTransactionGroup = { day: string; entries: DailyTransaction[]; today: boolean; count?: number; total?: number; key?:string; year?:number; month?:number; caption?:string }
type RowWrapper = (entry:DailyTransaction,position:number,children:ReactNode,standalone?:boolean)=>ReactNode
export function DailyTransactionDays({ groups, categoryColors, year, month, aliases, flatSingles=false, wrapRow }: {
  groups: DailyTransactionGroup[]; categoryColors: Record<string, string>; year: number; month: number; aliases?: Record<string, string>; flatSingles?:boolean; wrapRow?:RowWrapper
}) {
  return <div className="bb-daily-days">{groups.map(group => flatSingles && (group.count??group.entries.length)===1
    ? <SingleTransactionDay key={group.key??`${year}-${month}-${group.day}`} {...group} categoryColors={categoryColors} year={group.year??year} month={group.month??month} aliases={aliases} wrapRow={wrapRow}/>
    : <DailyTransactionDay key={group.key??`${year}-${month}-${group.day}`} {...group} categoryColors={categoryColors} year={group.year??year} month={group.month??month} aliases={aliases} wrapRow={wrapRow}/>)}</div>
}

function DailyTransactionDay({ day, entries, today, categoryColors, year, month, aliases, count, total: groupTotal, wrapRow, caption }: DailyTransactionGroup & {
  categoryColors: Record<string, string>; year: number; month: number; aliases?: Record<string, string>; wrapRow?:RowWrapper
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
  const motionKey = sorted.map(({entry,index}) => (entry.id ?? index) + ':' + Boolean(transactionMerchant(entry, aliases))).join('|')
  const total = useMemo(() => money.format(groupTotal??entries.reduce((sum, entry) => sum + entry.amount, 0)), [entries,groupTotal])
  useLayoutEffect(() => {
    if (!section.current) return
    const scene = createDailyDayMotion(section.current, open)
    motion.current = scene
    const content = section.current.querySelector('.bb-details-content-inner')!
    const contentObserver = new ResizeObserver(() => {
      const group = section.current
      if (!group || group.querySelector('.bb-daily-day-header')?.getAttribute('aria-expanded') !== 'true' || group.dataset.moving === 'true' || group.dataset.rowReordering === 'true') return
      const origin = group.querySelector('.bb-daily-icon-layer')!.getBoundingClientRect()
      group.querySelectorAll<HTMLElement>('.bb-daily-row-icon-anchor').forEach((anchor, index) => {
        const bead = group.querySelector<HTMLElement>('.bb-daily-bead[data-entry="' + index + '"]')
        if (!bead) return
        const rect = anchor.getBoundingClientRect()
        bead.style.transform = 'translate3d(' + (rect.left-origin.left) + 'px,' + (rect.top-origin.top) + 'px,0) scale(1)'
      })
    })
    contentObserver.observe(content)
    return () => { contentObserver.disconnect(); scene.dispose(); motion.current = null }
  }, [motionKey, aliases])
  useLayoutEffect(() => { motion.current?.setOpen(open) }, [open, sorted, aliases])
  useLayoutEffect(() => { motion.current?.refit() }, [total, sorted])
  return <section className="bb-daily-day-group" ref={section} data-entry-count={sorted.length}>
    <button type="button" className="bb-daily-day-header" data-undated={!dated} aria-expanded={open} aria-controls={id} aria-current={today ? 'date' : undefined} aria-label={`${today ? 'Today, ' : ''}${weekday} ${day}, ${total}, ${count??entries.length} ${(count??entries.length) === 1 ? 'entry' : 'entries'}`} onClick={() => { opened.current = true; setOpen(value => !value) }}>
      <span className="bb-daily-day-date" data-today={today}><span className="bb-daily-day">{day}</span>{weekday && <span className="bb-daily-date-weekday">{caption??weekday}</span>}</span>
      <span className="bb-daily-date-copy">
        <TransactionPreview entries={sorted} aliases={aliases} total={count??sorted.length} />
        <span className="bb-daily-day-count" aria-hidden="true">{count??entries.length} {(count??entries.length) === 1 ? 'entry' : 'entries'}</span>
      </span>
      <span className="bb-daily-day-total">{<ChangedMoney value={total} motionKey={'day:'+year+'-'+month+'-'+day+':amount'}/>}</span><ChevronDown aria-hidden="true" />
    </button>
    <div className="bb-details-content bb-daily-day-panel" id={id} role="region" aria-label={`${weekday} ${day} transactions`} aria-hidden={!open} inert={!open}>
      <div className="bb-details-content-inner">{opened.current && <TransactionRows entries={sorted} aliases={aliases} categoryColors={categoryColors} wrapRow={wrapRow} />}{(count??entries.length)>entries.length&&<p className="bb-daily-page-note">{entries.length} of {count} entries loaded. Load more below to see the rest.</p>}</div>
    </div>
    <TransactionBeads entries={opened.current ? sorted : sorted.slice(0, DAILY_PREVIEW_COUNT)} total={count??sorted.length} aliases={aliases} categoryColors={categoryColors} />
  </section>
}

type SortedTransaction = { entry: DailyTransaction; index: number; category: string }
const TransactionPreview = memo(function TransactionPreview({ entries, aliases, total }: {
  entries: SortedTransaction[]; aliases?: Record<string, string>; total:number
}) {
  const shown = entries.slice(0, DAILY_PREVIEW_COUNT)
  const remaining = total - shown.length
  const names = shown.map(({ entry }) => transactionText(entry, transactionMerchant(entry, aliases)).primary)
  return <span className="bb-daily-preview" role="img" aria-label={`${total} ${total === 1 ? 'transaction' : 'transactions'}: ${names.join(', ')}${remaining ? `, ${remaining} more` : ''}`}>
    {shown.map(({ index }) => <span className="bb-daily-preview-item" key={index} aria-hidden="true" />)}
    {remaining > 0 && <span className="bb-daily-preview-item" aria-hidden="true" />}
  </span>
})

const TransactionBeads = memo(function TransactionBeads({ entries, total, aliases, categoryColors }: {
  entries: SortedTransaction[]; total: number; aliases?: Record<string, string>; categoryColors: Record<string, string>
}) {
  return <span className="bb-daily-icon-layer" aria-hidden="true">
    {entries.map(({ entry, index }, position) => <span className="bb-recorded-swipe-icon-viewport" key={index} style={{ zIndex: total + 1 - position }}><span className="bb-daily-bead" data-entry={position} data-logo={Boolean(transactionMerchant(entry, aliases))} key={index} style={{ zIndex: total + 1 - position, '--bb-preview-category': categoryColors[entry.category] || 'hsl(var(--muted-foreground))' } as CSSProperties}>
      <TransactionCutouts entries={entries} before={Math.min(position, DAILY_PREVIEW_COUNT)} aliases={aliases}>
      <span className="bb-daily-bead-paint"><span className="bb-daily-bead-body"><TransactionIcon entry={entry} aliases={aliases} eager={position < DAILY_PREVIEW_COUNT} /></span>{position < DAILY_PREVIEW_COUNT && <span className="bb-daily-preview-dot" />}</span>
      </TransactionCutouts>
    </span></span>)}
    {total > Math.min(entries.length,DAILY_PREVIEW_COUNT) && <span className="bb-daily-overflow"><TransactionCutouts entries={entries} before={DAILY_PREVIEW_COUNT} aliases={aliases}><span className="bb-daily-preview-more">+{total - Math.min(entries.length,DAILY_PREVIEW_COUNT)}</span></TransactionCutouts></span>}
  </span>
})

// Separate clips intersect, so overlapping circle/badge holes stay transparent.
// Circle windows move with a counter-translated child, keeping their size fixed.
function TransactionCutouts({ entries, before, aliases, children }: { entries: SortedTransaction[]; before: number; aliases?: Record<string, string>; children: ReactNode }) {
  const cutouts = entries.slice(0, before).flatMap(({ entry }, index) => transactionMerchant(entry, aliases) ? [`${index}-circle`, `${index}-badge`] : [`${index}-circle`])
  return cutouts.reduceRight<ReactNode>((content, key) => <span className="bb-daily-clip" data-cutout={key} key={key}>{key.endsWith('-circle') ? <span className="bb-daily-clip-content">{content}</span> : content}</span>, children)
}

const TransactionRows = memo(function TransactionRows({ entries, aliases, categoryColors, wrapRow }: {
  entries: SortedTransaction[]; aliases?: Record<string, string>; categoryColors: Record<string, string>; wrapRow?:RowWrapper
}) {
  return <div className="bb-daily-day-entries">
    {entries.map(({ entry, index }, position) => {
      const text = transactionText(entry, transactionMerchant(entry, aliases))
      const row = <div className="bb-daily-transaction" key={index} data-category={entry.category} data-scheduled={entry.status === 'scheduled'}>
        <span className="bb-daily-row-icon-anchor" aria-hidden="true" />
        <span className="bb-daily-transaction-name">{<ChangedText value={text.primary} motionKey={'row:'+entry.id+':primary'}/>}</span><span className="bb-daily-transaction-money">{<ChangedMoney value={money.format(entry.amount)} motionKey={'row:'+entry.id+':amount'}/>}</span>
        <span className="bb-daily-transaction-meta"><span className="bb-daily-transaction-category" style={{ color: categoryColors[entry.category] }}>{<ChangedText value={text.category} motionKey={'row:'+entry.id+':category'}/>}</span><ChangedItem value={text.item} motionKey={'row:'+entry.id+':item'}/></span>
        {entry.status === 'scheduled' && <small className="bb-daily-transaction-status">Scheduled</small>}
      </div>
      return <span className="bb-daily-row-shell" key={index}>{wrapRow?wrapRow(entry,position,row):row}</span>
    })}
  </div>
})

function SingleTransactionDay({day,entries,today,year,month,categoryColors,aliases,wrapRow,caption}:DailyTransactionGroup & {year:number;month:number;categoryColors:Record<string,string>;aliases?:Record<string,string>;wrapRow?:RowWrapper}){
 const entry=entries[0],text=transactionText(entry,transactionMerchant(entry,aliases))
 const dated=Number.isFinite(Number(day))
 const weekday=dated?new Intl.DateTimeFormat('en-US',{weekday:'short'}).format(new Date(year,month-1,Number(day),12)):'Undated'
 const row = <div className="bb-daily-transaction" data-category={entry.category} data-scheduled={entry.status==='scheduled'}>
    <span className="bb-daily-row-icon-anchor" aria-hidden="true" style={{'--bb-preview-category':categoryColors[entry.category]} as React.CSSProperties}><span className="bb-daily-bead-paint"><span className="bb-daily-bead-body" style={{clipPath:'path(evenodd, "M0 0H28V28H0Z M21 25A4 4 0 1 0 29 25A4 4 0 1 0 21 25Z")'}}><TransactionIcon entry={entry} aliases={aliases} eager/></span><span className="bb-daily-preview-dot"/></span></span>
    <span className="bb-daily-transaction-name">{<ChangedText value={text.primary} motionKey={'row:'+entry.id+':primary'}/>}</span><span className="bb-daily-day-total">{<ChangedMoney value={money.format(entry.amount)} motionKey={'row:'+entry.id+':amount'}/>}</span>
    <span className="bb-daily-transaction-meta"><span className="bb-daily-transaction-category" style={{color:categoryColors[entry.category]}}>{<ChangedText value={text.category} motionKey={'row:'+entry.id+':category'}/>}</span><ChangedItem value={text.item} motionKey={'row:'+entry.id+':item'}/></span>
    {entry.status==='scheduled'&&<small className="bb-daily-transaction-status">Scheduled</small>}
   </div>
 return <section className="bb-daily-day-group bb-daily-single-day" aria-label={`${today?'Today':weekday} ${day}, one transaction`} data-single-entry="true">
  <div className="bb-daily-day-date bb-daily-single-date" data-today={today} aria-current={today?'date':undefined}><span className="bb-daily-day">{dated?day:'—'}</span><span className="bb-daily-date-weekday">{caption??weekday}</span></div>
  {wrapRow?wrapRow(entry,0,row,true):row}
 </section>
}
