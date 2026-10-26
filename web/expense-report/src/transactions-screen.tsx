import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowDownLeft, ArrowUpRight, ChevronDown, RefreshCw, Search, SlidersHorizontal } from "lucide-react"
import { useAppWorkStatus } from "./app-work-guard"
import { CollapsibleContent } from "./components/ui/motion"
import "./transactions-screen.css"

type Operation = "update" | "move" | "delete" | "split" | "cancel_split" | "undo"
export interface RecordedTransaction {
  id: string; actionId: string; month: string; version: string; date: string; title: string; location: string
  person: string; kind: string; category: string; categoryLabel: string; amountCents: number; split: string; notice?: string
  fields: Record<string, string>; editableFields: string[]; capabilities: Record<Operation, boolean>; reasons: Record<string, string>
}
interface Listing { items: RecordedTransaction[]; total: number; nextOffset: number | null; categories: string[]; persons: string[]; month: string; undo?: {id:string;month:string}; pendingCommand?: Change & {requestId:string;reviewVersion:string} }
interface Change { id: string; month: string; version?: string; operation: Operation; updates?: Record<string, string | number>; destination?: string; method?: string }
interface Review { item: RecordedTransaction; after: Record<string, string>; reviewVersion: string; operation: Operation; destination?: string; share?: {method: string; payerCents: number; partnerCents: number} }
interface Result { state: "running" | "done" | "uncertain"; success?: boolean; detail?: string; undo?: {month: string; id: string} }
const labels: Record<Operation, string> = {update: "Update", move: "Move", delete: "Delete", split: "Split", cancel_split: "Cancel split", undo: "Undo"}
const categories: Record<string, string> = {grocery: "Grocery", gas: "Gas", food: "Food", shopping: "Shopping", need_expenses: "Needs"}
const money = (cents: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(cents / 100)
const dateLabel = (value: string) => value ? new Date(value + "T12:00:00").toLocaleDateString(undefined, {month: "short", day: "numeric"}) : "Undated"
const methodLabel = (value: string) => ({income: "By income", equal: "50/50", fronted: "Fronted"}[value] ?? value)
class RequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener("abort", abort, {once:true})
  const deadline = window.setTimeout(abort, 30_000)
  try {
  const response = await fetch(path, {method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", mode: "same-origin", redirect: "error", signal:controller.signal,
    headers: {"X-BookieBot-App": "1", "Content-Type": "application/json"}, body: body ? JSON.stringify(body) : undefined})
  const data = await response.json()
  if (!response.ok) throw new RequestError(response.status === 401 ? "Reconnect BookieBot using /expense_app in Discord." : typeof data?.error === "string" ? data.error : "Couldn't finish this request.", response.status)
  return data
  } finally { window.clearTimeout(deadline); signal?.removeEventListener("abort", abort) }
}
function checkedListing(value: any): Listing {
  if (!value || !Array.isArray(value.items) || value.items.length > 40 || !Number.isSafeInteger(value.total) || !Array.isArray(value.categories) || !Array.isArray(value.persons)
    || value.items.some((row: any) => !row || typeof row.id !== "string" || typeof row.version !== "string" || !Number.isSafeInteger(row.amountCents) || !row.capabilities || !Array.isArray(row.editableFields))) throw new Error("Couldn't read the recorded transactions.")
  return value
}

export function TransactionsScreen({active, ownerName, initialMonth}: {active: boolean; ownerName: string; initialMonth: string}) {
  const [month, setMonth] = useState(initialMonth)
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState(false)
  const [kind, setKind] = useState(""), [category, setCategory] = useState(""), [person, setPerson] = useState(""), [split, setSplit] = useState("")
  const [listing, setListing] = useState<Listing | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("")
  const [selected, setSelected] = useState<RecordedTransaction | null>(null)
  const [operation, setOperation] = useState<Operation | null>(null), [draft, setDraft] = useState<Record<string, string>>({})
  const [destination, setDestination] = useState(""), [method, setMethod] = useState("income")
  const [review, setReview] = useState<Review | null>(null), [reviewBody, setReviewBody] = useState<Change | null>(null)
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Result | null>(null), [pending, setPending] = useState<(Change & {requestId: string; reviewVersion: string}) | null>(null)
  const [revision, setRevision] = useState(0)
  const inFlight = useRef(false), generation = useRef(0), mounted = useRef(true)
  const editor = useRef<HTMLElement>(null)
  const facets = useRef<{categories:string[];persons:string[]}>({categories:[],persons:[]})
  const freshNext = useRef(false)
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
    const query = new URLSearchParams({month, search, kind, category, person, split, offset: String(offset),fresh:fresh ? "1" : ""})
    setLoading(true); setError("")
    try {
      const next = checkedListing(await request(`/app/transactions?${query}`, undefined, controller.signal))
      if (!mounted.current || token !== generation.current) return
      facets.current = {categories:next.categories,persons:next.persons}
      if (next.pendingCommand) {
        setPending(next.pendingCommand); setResult({state:"running",detail:"A saved change still needs verification."})
        try { sessionStorage.setItem(storageKey,JSON.stringify(next.pendingCommand)) } catch {}
      }
      setListing(previous => append && previous ? {...next, items: [...previous.items, ...next.items]} : next)
    } catch (failure) { if (mounted.current && token === generation.current && !controller.signal.aborted) handleError(failure) }
    finally { if (mounted.current && token === generation.current) setLoading(false) }
  }, [month, search, kind, category, person, split])
  useEffect(() => {
    if (!active) return
    setListing(null); setLoading(true)
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
    setDestination(""); setMethod(row.split || "income"); setReview(null); setReviewBody(null); setError(""); setResult(null)
  }
  const preview = async (undo?: {id: string; month: string}) => {
    if (inFlight.current || uncertain) return
    const row = selected
    if (!undo && (!row || !operation)) return
    let body: Change
    if (undo) body = {...undo, operation: "undo"}
    else {
      body = {id: row!.id, month: row!.month, version: row!.version, operation: operation!}
      if (operation === "update" || operation === "move") {
        const fields = operation === "move" ? ["item"] : row!.editableFields
        body.updates = {}
        for (const field of fields) {
          const value = draft[field]
          if (!value || (field !== "amount" && value === row!.fields[field])) continue
          if (field === "amount") {
            if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0) { setError("Enter a positive amount with up to two decimal places."); return }
            if (Math.round(Number(value) * 100) !== row!.amountCents) body.updates.amount = Math.round(Number(value) * 100)
          } else body.updates[field] = value
        }
        if (operation === "move") body.destination = destination
      }
      if (operation === "split") body.method = method
    }
    inFlight.current = true; setBusy(true); setError("")
    try {
      const data = await request("/app/transactions/review", body)
      if (!mounted.current) return
      if (!data?.review?.reviewVersion || !data.review.item?.version) throw new Error("Couldn't read the change review.")
      setReview(data.review); setReviewBody({...body, version: data.review.item.version})
      setOperation(body.operation)
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
  const filterCount = [kind,category,person,split].filter(Boolean).length
  return <section className="bb-transactions" aria-label="Recorded transactions">
    <header className="bb-transactions-heading"><div><h1>Transactions</h1><p>Everything you’ve recorded, in one place.</p></div><button type="button" aria-label="Refresh transactions" disabled={locked || loading} onClick={() => void load(0,false,true)}><RefreshCw size={18} /></button></header>
    <div className="bb-transactions-toolbar"><label className="bb-transaction-search"><Search size={18} aria-hidden="true"/><input type="search" aria-label="Search transactions" placeholder="Search transactions" value={search} onChange={event=>setSearch(event.target.value)} /></label><button type="button" aria-expanded={filters} aria-controls="bb-transaction-filters" onClick={()=>setFilters(value=>!value)}><SlidersHorizontal size={18}/><span>Filters{filterCount ? ` · ${filterCount}` : ""}</span></button></div>
    <div className="bb-transaction-period"><label>Period<select aria-label="Transaction period" value={month === "all" ? "all" : "selected"} onChange={event=>setMonth(event.target.value === "all" ? "all" : initialMonth)}><option value="selected">One month</option><option value="all">All months</option></select></label>{month !== "all" && <input aria-label="Recorded month" type="month" max={new Date().toISOString().slice(0,7)} value={month} onChange={event=>{if(event.target.value)setMonth(event.target.value)}}/>}</div>
    <CollapsibleContent open={filters} id="bb-transaction-filters"><div className="bb-transaction-filters">
      <label>Type<select aria-label="Transaction type" value={kind} onChange={e=>setKind(e.target.value)}><option value="">All types</option>{["expense","income","payment","savings"].map(value=><option key={value} value={value}>{value[0].toUpperCase()+value.slice(1)}</option>)}</select></label>
      <label>Category<select aria-label="Transaction category" value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option>{Object.entries(categoryOptions).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Person / card<select aria-label="Transaction person or card" value={person} onChange={e=>setPerson(e.target.value)}><option value="">All people / cards</option>{(listing?.persons ?? facets.current.persons).map(value=><option key={value}>{value}</option>)}</select></label>
      <label>Split<select aria-label="Transaction split status" value={split} onChange={e=>setSplit(e.target.value)}><option value="">All transactions</option><option value="shared">Shared</option><option value="personal">Not split</option></select></label>
      {filterCount > 0 && <button type="button" onClick={()=>{setKind("");setCategory("");setPerson("");setSplit("")}}>Clear filters</button>}
    </div></CollapsibleContent>
    {error && <p role="alert" className="bb-transaction-notice">{error}</p>}
    {result && <div role="status" className="bb-transaction-notice"><p>{result.detail || (result.state === "running" ? "Checking the saved change…" : "This change needs inspection in saved history. It will not be submitted again.")}</p>{result.state === "done" && result.undo && <button type="button" disabled={locked} onClick={()=>void preview(result.undo)}>Undo this change</button>}{uncertain && <><button type="button" disabled={busy} onClick={()=>void checkStatus()}>Check saved status</button><button type="button" disabled={busy} onClick={()=>void checkStatus(true)}>Retry same confirmation</button></>}</div>}
    {operation && <section ref={editor} className="bb-transaction-editor" aria-label="Edit transaction" aria-busy={busy}>
      <p className="bb-transaction-eyebrow">{review ? "Review change" : labels[operation]}</p><h2>{review?.item.title ?? selected?.title}</h2>
      {review ? <><dl><div><dt>Action</dt><dd>{labels[review.operation]}{review.destination ? ` → ${categories[review.destination]}` : ""}</dd></div>{Object.entries(review.after).filter(([key])=>key !== "date").map(([key,value])=><div key={key}><dt>{key}</dt><dd>{review.operation === "update" && review.item.fields[key] !== value && <>{key === "amount" ? money(review.item.amountCents) : review.item.fields[key]} → </>}{key==="amount" ? money(Math.round(Number(value.replace(/[$,]/g,""))*100)) : value || "—"}</dd></div>)}</dl>
        {review.share && <p className="bb-transaction-notice">{methodLabel(review.share.method)} · Your share {money(review.share.payerCents)} · Partner’s share {money(review.share.partnerCents)}. No repayment will be marked received.</p>}
        {review.operation === "delete" && <p>The recorded transaction will be removed. Its saved history is retained.</p>}
        {review.item.split && !review.share && <p>The bank amount and shared repayment remain separate. Existing repayment safeguards apply.</p>}
        <div className="bb-transaction-form-actions"><button type="button" disabled={locked} onClick={()=>{setReview(null);setReviewBody(null)}}>Back</button><button className="bb-transaction-primary" type="button" disabled={locked} onClick={()=>void confirm()}>{busy ? "Saving…" : `Confirm ${labels[review.operation].toLowerCase()}`}</button></div></>
      : <form onSubmit={event=>{event.preventDefault();void preview()}}>
        {operation === "update" && selected?.editableFields.map(field=><label key={field}>{field === "amount" && selected.split ? "Full purchase amount" : field === "person" ? "Person / card" : field[0].toUpperCase()+field.slice(1)}{field === "person" ? <select value={draft[field] ?? ""} onChange={e=>setDraft(value=>({...value,[field]:e.target.value}))}>{["Hannah","Brian (BofA)","Brian (AL)"].map(value=><option key={value}>{value}</option>)}</select> : <input required maxLength={200} inputMode={field === "amount" ? "decimal" : "text"} value={draft[field] ?? ""} onChange={e=>setDraft(value=>({...value,[field]:e.target.value}))}/>}</label>)}
        {operation === "move" && <><label>Move to<select required value={destination} onChange={e=>setDestination(e.target.value)}><option value="">Choose category</option>{Object.entries(categories).filter(([key])=>key!==selected?.category).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>{["food","shopping","need_expenses"].includes(destination) && <label>Item name<input required value={draft.item ?? ""} onChange={e=>setDraft(value=>({...value,item:e.target.value}))}/></label>}</>}
        {operation === "split" && <label>Split method<select value={method} onChange={e=>setMethod(e.target.value)}><option value="income">By income</option><option value="equal">50/50</option>{selected?.kind === "expense" && <option value="fronted">Fronted</option>}</select></label>}
        {operation === "delete" && <p>Review this deletion before removing the recorded transaction.</p>}{operation === "cancel_split" && <p>Remove the split and keep the full purchase recorded. No repayment will be marked received.</p>}
        <button className="bb-transaction-primary" type="submit" disabled={locked}>{busy ? "Preparing review…" : "Review change"}</button>
      </form>}
      <button type="button" disabled={locked} onClick={discard}>Cancel</button>
    </section>}
    {listing?.undo && !operation && !result?.undo && <button type="button" disabled={locked} onClick={()=>void preview(listing.undo)}>Undo last change</button>}
    <div className="bb-transaction-list-heading"><span>{listing ? `${listing.total} ${listing.total === 1 ? "transaction" : "transactions"}` : "Recorded activity"}</span><span>Newest first</span></div>
    {loading && !listing && <p role="status" className="bb-transaction-empty">Loading recorded transactions…</p>}
    {!loading && !listing && !error && <p className="bb-transaction-empty">Open Transactions to load your recorded activity.</p>}
    {listing?.items.length === 0 && <div className="bb-transaction-empty"><p>{search || filterCount ? "No transactions match these filters." : "No recorded transactions in this period."}</p>{(search || filterCount > 0) && <button type="button" onClick={()=>{setSearch("");setKind("");setCategory("");setPerson("");setSplit("")}}>Clear search and filters</button>}</div>}
    <div className="bb-transaction-list">{listing?.items.map(row=><article key={row.id} className="bb-transaction-row" data-open={selected?.id === row.id}>
      <button className="bb-transaction-row-toggle" type="button" aria-expanded={selected?.id === row.id} disabled={locked || Boolean(operation)} onClick={()=>setSelected(value=>value?.id === row.id ? null : row)}>
        {row.kind === "income" ? <ArrowDownLeft aria-hidden="true" size={18}/> : <ArrowUpRight aria-hidden="true" size={18}/>}<span><strong>{row.title}</strong><small>{dateLabel(row.date)} · {row.categoryLabel}{month === "all" ? ` · ${row.month}` : ""}</small><small>{row.location ? row.location+" · " : ""}{row.person}{row.split ? ` · ${methodLabel(row.split)}` : ""}</small></span><strong className="bb-transaction-amount">{row.kind === "income" ? "+" : ""}{money(row.amountCents)}</strong><ChevronDown size={16}/></button>
      <CollapsibleContent open={selected?.id === row.id}><div className="bb-transaction-row-actions">{row.notice && <p>{row.notice}</p>}{(["update","move","split","delete"] as Operation[]).filter(op=>row.capabilities[op]).map(op=><button key={op} type="button" disabled={locked || Boolean(operation)} onClick={()=>begin(row,op)}>{op === "split" && row.split ? "Edit split" : labels[op]}</button>)}{row.capabilities.cancel_split && <button type="button" disabled={locked || Boolean(operation)} onClick={()=>begin(row,"cancel_split")}>Cancel split</button>}</div></CollapsibleContent>
    </article>)}</div>
    {listing?.nextOffset !== null && listing?.nextOffset !== undefined && <button className="bb-transaction-load" type="button" disabled={loading} onClick={()=>void load(listing.nextOffset!,true)}>{loading ? "Loading…" : "Load more transactions"}</button>}
    {error && !listing && <button type="button" disabled={loading} onClick={()=>void load(0,false,true)}>Try again</button>}
  </section>
}
