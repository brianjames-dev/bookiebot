import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, RefreshCw, Search, X } from "lucide-react"
import { usePageRefresh } from "./page-refresh"
import { useAppWorkStatus } from "./app-work-guard"
import {DailySpendingChart, CategoryFilterControl} from './report-app'
import {useAppNavigation} from './app-navigation'
import {DailyTransactionDays} from './daily-transactions'
import {TransactionSwipeContext,wrapTransactionRow} from './transaction-swipe'
import {recordedDays,recordedChart,recordedCategoryColors,spendingCategories,transactionFilter,type RecordedDay} from './recorded-transaction-view'
import { TransactionChangeDetails, TransactionCompletion, type TransactionChangeSummary, type TransactionOperation } from "./transaction-change-summary"
import { CustomSplitControl } from "./custom-split"
import "./transactions-screen.css"

type Operation = TransactionOperation
export interface RecordedTransaction {
  id: string; actionId: string; month: string; version: string; date: string; title: string; location: string
  person: string; kind: string; category: string; categoryLabel: string; amountCents: number; split: string; notice?: string
  fields: Record<string, string>; editableFields: string[]; capabilities: Record<Operation, boolean>; reasons: Record<string, string>
  splitOptions?: {custom: boolean; payerName: string; partnerName: string; payerBasisPoints: number; payerCents?: number}
}
interface Listing { items: RecordedTransaction[]; total: number; nextOffset: number | null; categories: string[]; persons: string[]; month: string; undo?: {id:string;month:string}; snapshotVersion?:string; days?:RecordedDay[]; totalAmountCents?:number; pendingCommand?: Change & {requestId:string;reviewVersion:string} }
interface Change { id: string; month: string; version?: string; operation: Operation; updates?: Record<string, string | number>; destination?: string; method?: string; payerShareCents?: number }
interface Review { item: RecordedTransaction; after: Record<string, string>; reviewVersion: string; operation: Operation; destination?: string; share?: TransactionChangeSummary["share"]; restoration?: TransactionChangeSummary["restoration"] }
interface Result { state: "running" | "done" | "uncertain"; success?: boolean; detail?: string; undo?: {month: string; id: string}; summary?: TransactionChangeSummary }
const labels: Record<Operation, string> = {update: "Update", move: "Update", delete: "Delete", split: "Split", cancel_split: "Cancel split", undo: "Undo"}
const reviewTitles: Record<Operation, string> = {update:"Update transaction",move:"Update transaction",delete:"Delete transaction",split:"Split transaction",cancel_split:"Remove split",undo:"Undo change"}
const categories: Record<string, string> = {grocery: "Grocery", gas: "Gas", food: "Food", shopping: "Shopping", need_expenses: "Other needs"}
const money = (cents: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(cents / 100)
class RequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener("abort", abort, {once:true})
  const deadline = window.setTimeout(abort, 30_000)
  try {
  // Keep Safari's real Origin under the private page's no-referrer policy.
  const response = await fetch(path, {method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", mode: "same-origin", referrerPolicy: "same-origin", redirect: "error", signal:controller.signal,
    headers: {"X-BookieBot-App": "1", "Content-Type": "application/json"}, body: body ? JSON.stringify(body) : undefined})
  const data = await response.json()
  if (!response.ok) throw new RequestError(response.status === 401 ? "Reconnect BookieBot using /expense_app in Discord." : typeof data?.error === "string" ? data.error : "Couldn't finish this request.", response.status)
  return data
  } finally { window.clearTimeout(deadline); signal?.removeEventListener("abort", abort) }
}
function checkedListing(value: any): Listing {
  if (!value || !Array.isArray(value.items) || value.items.length > 40 || !Number.isSafeInteger(value.total) || !Array.isArray(value.categories) || !Array.isArray(value.persons)
    || value.days && (!Array.isArray(value.days)||!Number.isSafeInteger(value.totalAmountCents)||value.days.some((day:any)=>!Number.isSafeInteger(day.count)||day.count<1||!Number.isSafeInteger(day.totalCents)||!Number.isSafeInteger(day.needsCents)||!Number.isSafeInteger(day.wantsCents)))
    || value.nextOffset!==null&&!value.days
    || value.items.some((row: any) => !row || typeof row.id !== "string" || typeof row.version !== "string" || !Number.isSafeInteger(row.amountCents) || !row.capabilities || !Array.isArray(row.editableFields)
      || row.splitOptions && (typeof row.splitOptions.custom !== "boolean" || !row.splitOptions.payerName || !row.splitOptions.partnerName
        || !Number.isSafeInteger(row.splitOptions.payerBasisPoints) || row.splitOptions.payerBasisPoints < 0 || row.splitOptions.payerBasisPoints > 10_000
        || row.splitOptions.payerCents !== undefined && (!Number.isSafeInteger(row.splitOptions.payerCents) || row.splitOptions.payerCents < 0 || row.splitOptions.payerCents > row.amountCents)))) throw new Error("Couldn't read the recorded transactions.")
  return value
}

export function TransactionsScreen({active, ownerName, initialMonth, aliases}: {active: boolean; ownerName: string; initialMonth: string;aliases?:Record<string,string>}) {
  const navigation=useAppNavigation()
  const [month, setMonth] = useState(initialMonth)
  const [search, setSearch] = useState("")
  useEffect(()=>{const request=navigation?.sourceRequest;if(active&&request?.section==='activity')navigation?.consumeSource?.(request.id)},[active,navigation?.sourceRequest?.id])
  const [filter,setFilter]=useState("all"),[day,setDay]=useState("")
  const {kind,category,split,scope,bucket}=transactionFilter(filter)
  const manager=useRef<{close?:(instant?:boolean)=>void}>({})
  const [listing, setListing] = useState<Listing | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("")
  const [displayScope, setDisplayScope] = useState({filter:"all",month:initialMonth})
  const [selected, setSelected] = useState<RecordedTransaction | null>(null)
  const [operation, setOperation] = useState<Operation | null>(null), [draft, setDraft] = useState<Record<string, string>>({})
  const [destination, setDestination] = useState(""), [method, setMethod] = useState("income")
  const [payerShareCents, setPayerShareCents] = useState(0), [customValid, setCustomValid] = useState(true)
  const [review, setReview] = useState<Review | null>(null), [reviewBody, setReviewBody] = useState<Change | null>(null)
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Result | null>(null), [pending, setPending] = useState<(Change & {requestId: string; reviewVersion: string}) | null>(null)
  const [revision, setRevision] = useState(0)
  const inFlight = useRef(false), generation = useRef(0), mounted = useRef(true)
  const editor = useRef<HTMLElement>(null)
  const facets = useRef<{categories:string[];persons:string[]}>({categories:[],persons:[]})
  const freshNext = useRef(false)
  const listingRef=useRef(listing);listingRef.current=listing
  const loadAbort = useRef<AbortController | null>(null)
  const storageKey = `bookiebot:transaction-request:${ownerName}`
  const uncertain = Boolean(pending && result?.state !== "done")
  const discard = useCallback(() => { setSelected(null); setOperation(null); setReview(null); setDraft({}) }, [])
  const updateWork = useAppWorkStatus({label: "Transaction changes", pending: busy, uncertain, dirty: Boolean(operation), onDiscard: discard})
  const clearAccess = () => { setListing(null); discard(); setPending(null); setResult(null); try { sessionStorage.removeItem(storageKey) } catch {} }
  const handleError = (failure: unknown) => {
    if (failure instanceof RequestError && [401,403].includes(failure.status)) clearAccess()
    setError(failure instanceof Error ? failure.message : "Couldn't load transactions.")
  }
  useEffect(() => {
    mounted.current = true
    try { const saved = sessionStorage.getItem(storageKey); if (saved) { const body = JSON.parse(saved); if (body.requestId && body.id) {setPending(body); setResult({state: "running"})} } } catch {}
    return () => { mounted.current = false; loadAbort.current?.abort() }
  }, [storageKey])
  const load = useCallback(async (offset = 0, append = false, fresh = false) => {
    const token = ++generation.current
    loadAbort.current?.abort(); const controller = new AbortController(); loadAbort.current = controller
    const query = new URLSearchParams({month, search, kind, category, split, scope, bucket, view:"daily", offset: String(offset),fresh:fresh ? "1" : ""})
    setLoading(true); setError("")
    try {
      const next = checkedListing(await request(`/app/transactions?${query}`, undefined, controller.signal))
      if (!mounted.current || token !== generation.current) return
      facets.current = {categories:next.categories,persons:next.persons}
      if (next.pendingCommand) {
        setPending(next.pendingCommand); setResult({state:"running",detail:"A saved change still needs verification."})
        try { sessionStorage.setItem(storageKey,JSON.stringify(next.pendingCommand)) } catch {}
      }
      if(append&&listingRef.current?.snapshotVersion&&next.snapshotVersion!==listingRef.current.snapshotVersion)throw new Error("Recorded activity changed. Refresh Transactions before loading more.")
      manager.current.close?.(true)
      setListing(previous => append && previous ? {...next, items: [...previous.items, ...next.items]} : next)
      setDisplayScope({filter,month})
      return true
    } catch (failure) { if (mounted.current && token === generation.current && !controller.signal.aborted) handleError(failure) }
    finally { if (mounted.current && token === generation.current) setLoading(false) }
    return false
  }, [month, search, kind, category, split, scope, bucket, filter])
  useEffect(() => {
    if (!active) return
    setLoading(true)
    const timer = window.setTimeout(() => { const fresh=freshNext.current; freshNext.current=false; void load(0,false,fresh) }, search ? 250 : 0)
    return () => { window.clearTimeout(timer); ++generation.current; loadAbort.current?.abort() }
  }, [active, load, revision])
  useEffect(() => {
    const refresh = () => { freshNext.current=true; setRevision(value => value + 1) }
    window.addEventListener("bookiebot:reimbursements-changed", refresh)
    return () => window.removeEventListener("bookiebot:reimbursements-changed", refresh)
  }, [])
  const changed = () => { window.dispatchEvent(new Event("bookiebot:transactions-changed")); window.dispatchEvent(new Event("bookiebot:reimbursements-changed")); setRevision(value => value + 1) }
  const begin = (row: RecordedTransaction, op: Operation) => {
    setSelected(row); setOperation(op); setDraft({...row.fields, amount: (row.amountCents / 100).toFixed(2)})
    setDestination(row.category); setMethod(row.split || "income"); setReview(null); setReviewBody(null); setError(""); setResult(null)
    setCustomValid(true); setPayerShareCents(row.splitOptions?.payerCents ?? Math.floor((row.amountCents * (row.splitOptions?.payerBasisPoints ?? 5000) + 5000) / 10_000))
  }
  const preview = async (undo?: {id: string; month: string}) => {
    if (inFlight.current || uncertain) return
    const row = selected
    if (!undo && (!row || !operation)) return
    let body: Change
    if (undo) body = {...undo, operation: "undo"}
    else {
      body = {id: row!.id, month: row!.month, version: row!.version, operation: operation === "update" && destination !== row!.category ? "move" : operation!}
      if (operation === "update" || operation === "move") {
        const fields = [...row!.editableFields, ...(["food","shopping","need_expenses"].includes(destination) && !row!.editableFields.includes("item") ? ["item"] : [])]
        body.updates = {}
        for (const field of fields) {
          const value = draft[field]
          if (!value || (field !== "amount" && value === row!.fields[field])) continue
          if (field === "amount") {
            if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0) { setError("Enter a positive amount with up to two decimal places."); return }
            if (Math.round(Number(value) * 100) !== row!.amountCents) body.updates.amount = Math.round(Number(value) * 100)
          } else body.updates[field] = value
        }
        if (body.operation === "move") body.destination = destination
      }
      if (operation === "split") {
        body.method = method
        if (method === "custom") {
          if (!customValid) { setError("Enter a valid dollar amount for the custom share."); return }
          if (!row!.splitOptions?.custom) { setError("Custom percentages are unavailable for this recorded split."); return }
          body.payerShareCents = payerShareCents
        }
      }
    }
    inFlight.current = true; setBusy(true); setError("")
    try {
      const data = await request("/app/transactions/review", body)
      if (!mounted.current) return
      if (!data?.review?.reviewVersion || !data.review.item?.version) throw new Error("Couldn't read the change review.")
      setReview(data.review); setReviewBody({...body, version: data.review.item.version})
      setOperation(body.operation === "move" ? "update" : body.operation)
    } catch (failure) { if (mounted.current) handleError(failure) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const acceptResult = (next: Result) => {
    if (!next || !["running", "done", "uncertain"].includes(next.state)) throw new Error("Couldn't verify the saved result.")
    setResult(next)
    if (next.state === "done") {
      setPending(null); try { sessionStorage.removeItem(storageKey) } catch {}
      if (next.success) { discard(); changed() }
    }
  }
  const confirm = async () => {
    if (inFlight.current || pending || !review || !reviewBody) return
    const command = {...reviewBody, reviewVersion: review.reviewVersion, requestId: crypto.randomUUID()}
    inFlight.current = true; setBusy(true); setPending(command); setResult({state:"running"}); setError("")
    updateWork({label: "Transaction changes", pending:true, uncertain:true})
    try { sessionStorage.setItem(storageKey, JSON.stringify(command)) } catch {}
    try { const next = await request("/app/transactions", command); if (mounted.current) acceptResult(next) }
    catch (failure) { if (mounted.current) { handleError(failure); setResult({state:"uncertain", detail:"The change may already be saved. Check its saved status before another change."}) } }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const checkStatus = async (retry = false) => {
    if (!pending || inFlight.current) return
    inFlight.current = true; setBusy(true); setError("")
    try { const next = await request(retry ? "/app/transactions" : `/app/transactions/commands/${encodeURIComponent(pending.requestId)}`, retry ? pending : undefined); if (mounted.current) acceptResult(next) }
    catch (failure) { if (mounted.current) handleError(failure) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    if (active && operation) editor.current?.scrollIntoView({block:"start", behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"})
  }, [active, operation])
  const categoryOptions = {...categories, ...Object.fromEntries((listing?.categories ?? facets.current.categories).filter(value=>!(value in categories)).map(value=>[value,value]))}
  const locked = busy || uncertain
  const pageRefresh = usePageRefresh("transactions", { refresh: () => load(0, false, true), disabled: locked || loading })
  const filterCount = Number(filter!=="all")
  const days=useMemo(()=>listing?.days??[],[listing])
  const groups=useMemo(()=>recordedDays(listing?.items??[],days,displayScope.month).filter(group=>!day||group.day===day||group.key===day||day==='Undated'&&!Number.isFinite(Number(group.day))),[listing,days,displayScope.month,day])
  const chart=useMemo(()=>recordedChart(days,displayScope.month),[days,displayScope.month])
  const rows=useMemo(()=>new Map(listing?.items.map(row=>[row.id,row])??[]),[listing])
  const filtersList=[{value:'all',label:'All'},{value:'needs',label:'Needs'},{value:'wants',label:'Wants'},{value:'shared',label:'Shared'},...Object.entries(categoryOptions).map(([value,label])=>({value:'category:'+value,label:spendingCategories[value]??label})),{value:'income',label:'Income'},{value:'savings',label:'Savings'}]
  const changeFilter=(value:string)=>{manager.current.close?.();setDay('');setFilter(value)}
  const displayedFilter=displayScope.filter
  const metricLabel=displayedFilter==='income'?'Total Income':displayedFilter==='savings'?'Total Saved':'Total Spent'
  const total=listing?.totalAmountCents??listing?.items.reduce((sum,row)=>sum+row.amountCents,0)??0
  useEffect(()=>{manager.current.close?.(true);setDay('')},[month,search,active])
  return <TransactionSwipeContext.Provider value={{manager:manager.current,rows,locked:locked||loading||Boolean(operation),onAction:begin}}><section className="bb-transactions bb-daily-spending-content" aria-label="Recorded transactions" aria-busy={loading} onPointerDownCapture={event=>{if(!(event.target as Element).closest('.bb-recorded-swipe'))manager.current.close?.()}}>
    <header className="bb-transactions-heading"><h1>Transactions</h1>{!pageRefresh && <button type="button" aria-label="Refresh transactions" disabled={locked || loading} onClick={() => void load(0,false,true)}><RefreshCw size={18}/></button>}</header>
    <details className="bb-transaction-period"><summary>{month==='all'?'All months':new Date(month+'-01T12:00:00').toLocaleDateString(undefined,{month:'long',year:'numeric'})}<ChevronDown aria-hidden="true"/></summary><div><label>Month<input aria-label="Recorded month" type="month" max={new Date().toISOString().slice(0,7)} value={month==='all'?initialMonth:month} disabled={locked||Boolean(operation)} onChange={event=>{if(event.target.value){setMonth(event.target.value);event.target.closest('details')?.removeAttribute('open')}}}/></label><button type="button" disabled={locked||Boolean(operation)} onClick={event=>{setMonth(month==='all'?initialMonth:'all');event.currentTarget.closest('details')?.removeAttribute('open')}}>{month==='all'?'Selected month':'All months'}</button></div></details>
    {listing && <DailySpendingChart data={chart} total={total/100} filter={displayedFilter==='needs'||displayedFilter==='wants'?displayedFilter:'all'} detailsOpen detailsId="bb-recorded-days" onToggleDetails={()=>{}} onInspectDay={value=>{if(!loading)setDay(previous=>previous===value?'':value)}} metricLabel={metricLabel} legendLabel={displayedFilter==='income'?'Income':displayedFilter==='savings'?'Savings':undefined}
      transactionControl={<CategoryFilterControl filter={filter} onFilterChange={changeFilter} filters={filtersList} label="Filter transactions" dismissTrigger="recorded-transactions"/>}/>}
    <label className="bb-recorded-search"><Search aria-hidden="true"/><input type="text" role="searchbox" enterKeyHint="search" aria-label="Search transactions" placeholder="Search transactions" maxLength={200} value={search} onChange={event=>setSearch(event.target.value)}/>{search&&<button type="button" aria-label="Clear search" onClick={()=>setSearch('')}><X aria-hidden="true"/></button>}</label>
    {day&&<button type="button" className="bb-recorded-day-chip" onClick={()=>setDay('')}>Day {day}<X aria-hidden="true"/></button>}
    {error && <div role="alert" className="bb-transaction-notice"><p>{error}</p>{listing&&<button type="button" disabled={locked||loading} onClick={()=>void load(0,false,true)}>Refresh transactions</button>}</div>}
    {result?.state === "done" && result.success ? <TransactionCompletion moveAsUpdate summary={result.summary} canUndo={Boolean(result.undo)} disabled={locked}
      onUndo={()=>{if(result.undo)void preview(result.undo)}} onDismiss={()=>setResult(null)}/>
      : result && <div role="status" className="bb-transaction-notice"><p>{result.detail || (result.state === "running" ? "Checking the saved change…" : "This change needs inspection in saved history. It will not be submitted again.")}</p>{uncertain && <><button type="button" disabled={busy} onClick={()=>void checkStatus()}>Check saved status</button><button type="button" disabled={busy} onClick={()=>void checkStatus(true)}>Retry same confirmation</button></>}</div>}
    {operation && <section ref={editor} className="bb-transaction-editor" aria-label="Edit transaction" aria-busy={busy}>
      <p className="bb-transaction-eyebrow">{review ? "Review change" : labels[operation]}</p><h2>{review ? reviewTitles[review.operation] : selected?.title}</h2>
      {review ? <><TransactionChangeDetails summary={{operation:review.operation,title:review.item.title,date:review.item.date,category:review.item.categoryLabel,
        location:review.item.location,person:review.item.person,amountCents:review.item.amountCents,before:review.item.fields,after:review.after,destination:review.destination,share:review.share,restoration:review.restoration}}/>
        {review.operation === "delete" && <p>The recorded transaction will be removed. Its saved history is retained.</p>}
        {review.item.split && !review.share && <p>The bank amount and shared repayment remain separate. Existing repayment safeguards apply.</p>}
        <div className="bb-transaction-form-actions"><button type="button" disabled={locked} onClick={()=>{setReview(null);setReviewBody(null)}}>Back</button><button className="bb-transaction-primary" type="button" disabled={locked} onClick={()=>void confirm()}>{busy ? "Saving…" : `Confirm ${labels[review.operation].toLowerCase()}`}</button></div></>
      : <form onSubmit={event=>{event.preventDefault();void preview()}}>
        {operation === "update" && selected?.editableFields.map(field=><label key={field}>{field === "amount" && selected.split ? "Full purchase amount" : field === "person" ? "Person / card" : field[0].toUpperCase()+field.slice(1)}{field === "person" ? <select value={draft[field] ?? ""} onChange={e=>setDraft(value=>({...value,[field]:e.target.value}))}>{["Hannah","Brian (BofA)","Brian (AL)"].map(value=><option key={value}>{value}</option>)}</select> : <input required maxLength={200} inputMode={field === "amount" ? "decimal" : "text"} value={draft[field] ?? ""} onChange={e=>setDraft(value=>({...value,[field]:e.target.value}))}/>}</label>)}
        {operation === "update" && selected?.capabilities.move && <><label>Category<select aria-label="Update category" value={destination} onChange={e=>setDestination(e.target.value)}>{Object.entries(categories).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>{["food","shopping","need_expenses"].includes(destination)&&!selected.editableFields.includes('item')&&<label>Item name<input required maxLength={200} value={draft.item??''} onChange={e=>setDraft(value=>({...value,item:e.target.value}))}/></label>}</>}
        {operation === "split" && <><label>Split method<select value={method} onChange={e=>{setMethod(e.target.value);setCustomValid(true)}}><option value="income">By income</option><option value="equal">50/50</option>{selected?.kind === "expense" && <option value="fronted">Fronted</option>}{(selected?.splitOptions?.custom || method === "custom") && <option value="custom" disabled={!selected?.splitOptions?.custom}>Custom</option>}</select></label>
          {method === "custom" && selected?.splitOptions?.custom && <CustomSplitControl grossCents={selected.amountCents} payerName={selected.splitOptions.payerName}
            partnerName={selected.splitOptions.partnerName} payerCents={payerShareCents} disabled={locked} onChange={setPayerShareCents} onValidityChange={setCustomValid}/>}</>}
        {operation === "delete" && <p>Review this deletion before removing the recorded transaction.</p>}{operation === "cancel_split" && <p>Remove the split and keep the full purchase recorded. No repayment will be marked received.</p>}
        {operation==='split'&&selected?.capabilities.cancel_split&&<button type="button" disabled={locked} onClick={()=>begin(selected,'cancel_split')}>Remove split</button>}
        <button className="bb-transaction-primary" type="submit" disabled={locked || operation === "split" && method === "custom" && !customValid}>{busy ? "Preparing review…" : "Review change"}</button>
      </form>}
      <button type="button" disabled={locked} onClick={discard}>Cancel</button>
    </section>}
    {listing?.undo && !operation && !result?.undo && <button type="button" className="bb-recorded-undo" disabled={locked} onClick={()=>void preview(listing.undo)}>Undo last change</button>}
    {loading && <p role="status" className="bb-recorded-loading">Loading recorded transactions…</p>}
    {!loading && !listing && !error && <p className="bb-transaction-empty">Open Transactions to load your recorded activity.</p>}
    {listing?.items.length===0&&<div className="bb-transaction-empty"><p>{search||filterCount?'No transactions match these filters.':'No recorded transactions in this period.'}</p>{(search||filterCount>0)&&<button type="button" onClick={()=>{setSearch('');setFilter('all')}}>Clear search and filters</button>}</div>}
    <div className="bb-transaction-list bb-daily-transactions" id="bb-recorded-days"><DailyTransactionDays groups={groups} year={Number(initialMonth.slice(0,4))} month={Number(initialMonth.slice(5))} flatSingles wrapRow={wrapTransactionRow} aliases={aliases} categoryColors={recordedCategoryColors}/></div>
    {listing?.nextOffset !== null && listing?.nextOffset !== undefined && <button className="bb-transaction-load" type="button" disabled={loading} onClick={()=>void load(listing.nextOffset!,true)}>{loading ? "Loading…" : "Load more transactions"}</button>}
    {error && !listing && <button type="button" disabled={loading} onClick={()=>void load(0,false,true)}>Try again</button>}
  </section></TransactionSwipeContext.Provider>
}
