import { cloneElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ChartNoAxesColumn, ChevronDown, RefreshCw, Search, X } from "lucide-react"
import { usePageRefresh } from "./page-refresh"
import { useAppWorkStatus } from "./app-work-guard"
import {DailySpendingChart, CategoryFilterControl} from './report-app'
import {useAppNavigation} from './app-navigation'
import {DailyTransactionDays} from './daily-transactions'
import {TransactionSwipeContext,wrapTransactionRow} from './transaction-swipe'
import {displayedAmount,recordedDays,recordedChart,recordedChartWindow,recordedDateLabel,recordedCategoryColors,spendingCategories,transactionFilter,type RecordedDay} from './recorded-transaction-view'
import { type TransactionChangeSummary, type TransactionOperation } from "./transaction-change-summary"
import {InlineTransactionEditor,transactionMotion,type InlineSnapshot} from './transaction-inline-editor'
import {ChangeMotionContext,type ChangePlan} from './transaction-value-motion'
import {preparePlacement,playPlacement,discardPlacement,type Placement} from './transaction-row-placement'
import {UndoPopup,type UndoNotice} from './transaction-undo-popup'
import {confirmedRows,motionValues,settledTransactionRow,undoPresentationTarget} from './transaction-feedback'
import {allocate,type SplitMethod} from './transaction-split-model'
import type {SplitInputDraft} from "./transaction-split-control"
import {DuoTransactionPane} from "./duo-transaction-pane"
import "./transactions-screen.css"
import "./duo-transactions.css"

type Operation = TransactionOperation
export interface RecordedTransaction {
  id: string; actionId: string; month: string; version: string; date: string; title: string; location: string
  person: string; kind: string; category: string; categoryLabel: string; amountCents: number; displayAmountCents?: number; split: string; notice?: string
  fields: Record<string, string>; editableFields: string[]; capabilities: Record<Operation, boolean>; reasons: Record<string, string>
  splitOptions?: {custom: boolean; payerName: string; partnerName: string; payerBasisPoints: number; payerCents?: number; incomePayerCents?:number}
}
export interface Listing { items: RecordedTransaction[]; total: number; nextOffset: number | null; categories: string[]; persons: string[]; month: string; undo?: {id:string;month:string}; snapshotVersion?:string; days?:RecordedDay[]; listDays?:RecordedDay[]; totalAmountCents?:number; pendingCommand?: Change & {requestId:string;reviewVersion:string} }
interface Change { id: string; month: string; version?: string; operation: Operation; updates?: Record<string, string | number>; destination?: string; method?: string; payerShareCents?: number }
interface Review { item: RecordedTransaction; after: Record<string, string>; reviewVersion: string; operation: Operation; destination?: string; share?: TransactionChangeSummary["share"]; restoration?: TransactionChangeSummary["restoration"] }
interface Result { state: "running" | "done" | "uncertain"; success?: boolean; detail?: string; undo?: {month: string; id: string}; summary?: TransactionChangeSummary }
const categories: Record<string, string> = {grocery: "Grocery", gas: "Gas", food: "Food", shopping: "Shopping", need_expenses: "Other needs"}
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
function checkedDays(value:any):boolean {
  return Array.isArray(value)&&value.every((day:any)=>day&&typeof day.date==='string'&&typeof day.month==='string'&&/^\d{4}-(?:0[1-9]|1[0-2])$/.test(day.month)&&Number.isSafeInteger(day.count)&&day.count>0&&Number.isSafeInteger(day.totalCents)&&Number.isSafeInteger(day.needsCents)&&Number.isSafeInteger(day.wantsCents))
}
function checkedListing(value: any): Listing {
  if (!value || !Array.isArray(value.items) || value.items.length > 40 || !Number.isSafeInteger(value.total) || !Array.isArray(value.categories) || !Array.isArray(value.persons)
    || value.days && (!checkedDays(value.days)||!Number.isSafeInteger(value.totalAmountCents))
    || value.listDays && !checkedDays(value.listDays)
    || value.nextOffset!==null&&!value.days
    || value.items.some((row: any) => !row || typeof row.id !== "string" || typeof row.version !== "string" || !Number.isSafeInteger(row.amountCents) || !row.capabilities || !Array.isArray(row.editableFields)
      || row.displayAmountCents !== undefined && (!Number.isSafeInteger(row.displayAmountCents) || row.displayAmountCents < 0 || row.displayAmountCents > row.amountCents)
      || row.splitOptions && (typeof row.splitOptions.custom !== "boolean" || !row.splitOptions.payerName || !row.splitOptions.partnerName
        || !Number.isSafeInteger(row.splitOptions.payerBasisPoints) || row.splitOptions.payerBasisPoints < 0 || row.splitOptions.payerBasisPoints > 10_000
        || row.splitOptions.payerCents !== undefined && (!Number.isSafeInteger(row.splitOptions.payerCents) || row.splitOptions.payerCents < 0 || row.splitOptions.payerCents > row.amountCents)
        || row.splitOptions.incomePayerCents !== undefined && (!Number.isSafeInteger(row.splitOptions.incomePayerCents) || row.splitOptions.incomePayerCents < 0 || row.splitOptions.incomePayerCents > row.amountCents)))) throw new Error("Couldn't read the recorded transactions.")
  return value
}

export function TransactionsScreen({active, ownerName, initialMonth, aliases, headerActions, onUpdated}: {active: boolean; ownerName: string; initialMonth: string;aliases?:Record<string,string>;headerActions?:HTMLElement|null;onUpdated?:(time:number|null)=>void}) {
  const navigation=useAppNavigation()
  // Keep the closed graph preference independent of the unfolded workspace.
  const duoWide=navigation?.duoLandscape===true
  const [closedGraphOpen,setClosedGraphOpen]=useState(false),[duoGraphOpen,setDuoGraphOpen]=useState(true)
  const graphOpen=duoWide?duoGraphOpen:closedGraphOpen
  const setGraphOpen=duoWide?setDuoGraphOpen:setClosedGraphOpen
  const [month, setMonth] = useState(initialMonth)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  useEffect(() => { onUpdated?.(updatedAt) }, [updatedAt, onUpdated])
  const [search, setSearch] = useState("")
  useEffect(()=>{const request=navigation?.sourceRequest;if(active&&request?.section==='activity')navigation?.consumeSource?.(request.id)},[active,navigation?.sourceRequest?.id])
  const [filter,setFilter]=useState("all"),[day,setDay]=useState("")
  useEffect(()=>{setMonth(initialMonth);setDay('')},[initialMonth])
  const [chartMonths,setChartMonths]=useState(0),[graphRevision,setGraphRevision]=useState(0)
  const [graphHistory,setGraphHistory]=useState<{key:string;days:RecordedDay[]}|null>(null)
  const [graphLoading,setGraphLoading]=useState(false),[graphError,setGraphError]=useState('')
  const historyFreshRevision=useRef(0)
  const {kind,category,split,scope,bucket}=transactionFilter(filter)
  const manager=useRef<{close?:(instant?:boolean)=>void}>({})
  const [listing, setListing] = useState<Listing | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("")
  const [displayScope, setDisplayScope] = useState({filter:"all",month:initialMonth})
  const [selected, setSelected] = useState<RecordedTransaction | null>(null)
  const [operation, setOperation] = useState<Operation | null>(null), [draft, setDraft] = useState<Record<string, string>>({})
  const [destination, setDestination] = useState(""), [method, setMethod] = useState<SplitMethod>("income")
  const [payerShareCents, setPayerShareCents] = useState(0), [customValid, setCustomValid] = useState(true)
  const [splitInput,setSplitInput]=useState<SplitInputDraft>(null)
  const [review, setReview] = useState<Review | null>(null), [reviewBody, setReviewBody] = useState<Change | null>(null)
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Result | null>(null), [pending, setPending] = useState<(Change & {requestId: string; reviewVersion: string}) | null>(null)
  const [revision, setRevision] = useState(0)
  const [needsFresh,setNeedsFresh]=useState(false)
  const [announcement,setAnnouncement]=useState('')
  const inFlight = useRef(false), generation = useRef(0), mounted = useRef(true)
  const product = useRef<HTMLElement>(null),sequence=useRef(0),placement=useRef<Placement|null>(null),placementPlayer=useRef<ReturnType<typeof playPlacement>|null>(null)
  const [commit,setCommit]=useState<{token:number;id:string;before:Listing;after:Listing;result:Result;phase:'reading'|'closing'|'animating'|'placing';fresh?:boolean;targetId?:string}|null>(null)
  const [notice,setNotice]=useState<(UndoNotice&{undo?:{id:string;month:string}})|null>(null),[autoUndo,setAutoUndo]=useState(false)
  const ownChange=useRef(false)
  const facets = useRef<{categories:string[];persons:string[]}>({categories:[],persons:[]})
  const freshNext = useRef(false)
  const listingRef=useRef(listing);listingRef.current=listing
  const loadAbort = useRef<AbortController | null>(null)
  const storageKey = `bookiebot:transaction-request:${ownerName}`
  const uncertain = Boolean(pending && result?.state !== "done")
  const discard = useCallback(() => { setSelected(null); setOperation(null); setReview(null); setReviewBody(null); setAutoUndo(false); setDraft({});setSplitInput(null) }, [])
  const duoSelection=useRef(false)
  useEffect(()=>{
    if(!duoWide){duoSelection.current=false;return}
    if(selected){if(!duoSelection.current)setDuoGraphOpen(false);duoSelection.current=true}
    else if(duoSelection.current){duoSelection.current=false;setDuoGraphOpen(true)}
  },[duoWide,selected?.id])
  const manageDuo=(row:RecordedTransaction)=>{discard();setSelected(row);setDuoGraphOpen(false)}
  const updateWork = useAppWorkStatus({label: "Transaction changes", pending: busy||Boolean(commit), uncertain, dirty: Boolean(operation), onDiscard: discard})
  const clearAccess = () => { ++sequence.current;placementPlayer.current?.finish();setCommit(null);setNotice(null);setNeedsFresh(false);setListing(null);setUpdatedAt(null); discard(); setPending(null); setResult(null); try { sessionStorage.removeItem(storageKey) } catch {} }
  const handleError = (failure: unknown) => {
    if (failure instanceof RequestError && [401,403].includes(failure.status)) clearAccess()
    setError(failure instanceof Error ? failure.message : "Couldn't load transactions.")
  }
  useEffect(() => {
    mounted.current = true
    try { const saved = sessionStorage.getItem(storageKey); if (saved) { const body = JSON.parse(saved); if (body.requestId && body.id) {setPending(body); setResult({state: "running"})} } } catch {}
    return () => { mounted.current = false; ++sequence.current; placementPlayer.current?.finish(); discardPlacement(placement.current); loadAbort.current?.abort() }
  }, [storageKey])
  const load = useCallback(async (offset = 0, append = false, fresh = false, stage?: (next:Listing)=>void) => {
    const token = ++generation.current
    loadAbort.current?.abort(); const controller = new AbortController(); loadAbort.current = controller
    const query = new URLSearchParams({month, search, kind, category, split, scope, bucket, day:day==='Undated'?'undated':day, view:"daily", offset: String(offset),fresh:fresh ? "1" : ""})
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
      if(stage)stage(next)
      else {
        setListing(previous => append && previous ? {...next, items: [...previous.items, ...next.items]} : next)
        setDisplayScope({filter,month})
        setNeedsFresh(false)
        setUpdatedAt(Date.now())
        if(fresh)setGraphRevision(value=>value+1)
      }
      return true
    } catch (failure) { if (mounted.current && token === generation.current && !controller.signal.aborted) handleError(failure) }
    finally { if (mounted.current && token === generation.current) setLoading(false) }
    return false
  }, [month, search, kind, category, split, scope, bucket, filter, day])
  useEffect(() => {
    if (!active||commit) return
    setLoading(true)
    const timer = window.setTimeout(() => { const fresh=freshNext.current; freshNext.current=false; void load(0,false,fresh) }, search ? 250 : 0)
    return () => { window.clearTimeout(timer); ++generation.current; loadAbort.current?.abort() }
  }, [active, load, revision])
  const historyEnabled=chartMonths>0,historyKey=JSON.stringify([ownerName,filter,search,graphRevision])
  useEffect(()=>{
    if(!active||!historyEnabled)return
    const controller=new AbortController();let live=true
    setGraphLoading(true);setGraphError('')
    const timer=window.setTimeout(()=>{
      const fresh=historyFreshRevision.current!==graphRevision;historyFreshRevision.current=graphRevision
      const query=new URLSearchParams({month:'all',view:'daily',search,kind,category,split,scope,bucket,fresh:fresh?'1':''})
      void request('/app/transactions?'+query,undefined,controller.signal).then(checkedListing).then(next=>{
        if(!live||controller.signal.aborted)return
        if(!next.days)throw new Error("Couldn't read the graph's recorded days.")
        setGraphHistory({key:historyKey,days:next.days});setUpdatedAt(Date.now())
      }).catch(failure=>{if(live&&!controller.signal.aborted){if(failure instanceof RequestError&&[401,403].includes(failure.status)){setGraphHistory(null);handleError(failure)}setGraphError(failure instanceof Error?failure.message:"Couldn't load the graph.")}})
      .finally(()=>{if(live)setGraphLoading(false)})
    },search?250:0)
    return()=>{live=false;window.clearTimeout(timer);controller.abort()}
  },[active,historyEnabled,historyKey])
  useEffect(() => {
    const refresh = () => { if(ownChange.current)return; freshNext.current=true; setRevision(value => value + 1) }
    window.addEventListener("bookiebot:reimbursements-changed", refresh)
    return () => window.removeEventListener("bookiebot:reimbursements-changed", refresh)
  }, [])
  const changed = () => { ownChange.current=true; window.dispatchEvent(new Event("bookiebot:transactions-changed")); window.dispatchEvent(new Event("bookiebot:reimbursements-changed")); ownChange.current=false }
  const begin = (row: RecordedTransaction, op: Operation) => {
    setAnnouncement('')
    setSelected(row); setOperation(op); setDraft({...row.fields, amount: (row.amountCents / 100).toFixed(2)})
    setDestination(row.category); setMethod((row.split || 'income') as SplitMethod); setReview(null); setReviewBody(null); setError(""); setResult(null);setNotice(null)
    setSplitInput(null);setCustomValid(true); setPayerShareCents(row.splitOptions?.payerCents ?? (row.split==='fronted'?0:row.split==='custom'?allocate(row.amountCents,row.splitOptions?.payerBasisPoints??5000):row.split==='equal'?allocate(row.amountCents,5000):row.splitOptions?.incomePayerCents??allocate(row.amountCents,5000)))
  }
  const preview = async (undo?: {id: string; month: string}, directUndo=false) => {
    if (inFlight.current || uncertain || commit) return
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
      if(undo){setSelected(data.review.item);setAutoUndo(directUndo)}
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
      if (next.success) {
        setNeedsFresh(true)
        const before=listingRef.current,id=selected?.id
        manager.current.close?.();discard()
        if(before&&next.summary?.operation==='undo'){
          // Restore the canonical saved rows, including deleted entries and moved
          // categories, through the same value-motion path as a forward edit.
          const token=++sequence.current
          setCommit({token,id:id??'',before,after:before,result:next,phase:'reading',fresh:true})
          void load(0,false,true,after=>{
            if(!mounted.current||sequence.current!==token)return
            if(after.pendingCommand){setCommit(null);return}
            setCommit({token,id:id??'',before,after,result:next,phase:'closing',fresh:true,targetId:undoPresentationTarget(before.items,after.items,id??'',next.summary!)})
          }).then(loaded=>{
            if(!loaded&&mounted.current&&sequence.current===token){setCommit(null);setResult(null);setError('Your change was saved. Refresh Transactions to see the current rows.')}
          })
        }else if(before&&id&&before.items.some(row=>row.id===id)&&next.summary){
          const afterItems=confirmedRows(before.items,id,next.summary)
          const old=before.items.find(row=>row.id===id)!,after=afterItems.find(row=>row.id===id),delta=(after?displayedAmount(after):0)-displayedAmount(old)
          const updateDays=(days:RecordedDay[]|undefined)=>days?.flatMap(day=>day.date===old.date&&day.month===old.month?day.count===1&&!after?[]:[{...day,count:day.count-(after?0:1),totalCents:day.totalCents+delta}]:[day])
          const periodDelta=before.month==='all'||before.month===old.month?delta:0
          // Keep identities inert during feedback; only the subsequent fresh
          // listing can make new versions/rows available for another command.
          setCommit({token:++sequence.current,id,before,after:{...before,items:afterItems,days:updateDays(before.days),listDays:updateDays(before.listDays),totalAmountCents:(before.totalAmountCents??0)+periodDelta},result:next,phase:'closing'})
        }else void finishFeedback(next)
      }
    }
  }
  const confirm = async () => {
    if (inFlight.current || pending || !review || !reviewBody || commit) return
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
  useEffect(()=>{if(autoUndo&&review?.operation==='undo'&&!busy){setAutoUndo(false);void confirm()}},[autoUndo,review,busy])
  const plan=useMemo<ChangePlan|null>(()=>{
    if(!commit||commit.phase!=='animating')return null
    const before=motionValues(commit.before.items,commit.before.listDays??commit.before.days??[],aliases),after=motionValues(commit.after.items,commit.after.listDays??commit.after.days??[],aliases)
    if(commit.targetId&&commit.targetId!==commit.id){
      const target='row:'+commit.targetId+':',source='row:'+commit.id+':'
      for(const [key,value]of Object.entries(after.values))if(key.startsWith(target))after.values[source+key.slice(target.length)]=value
      for(const [key,value]of Object.entries(after.colors))if(key.startsWith(target))after.colors[source+key.slice(target.length)]=value
    }
    if(commit.fresh)for(const key of Object.keys(after.values))if(!(key in before.values))before.values[key]=key.endsWith(':amount')?'$0.00':''
    return {token:commit.token,from:before.values,to:after.values,fromColors:before.colors,toColors:after.colors,timing:transactionMotion,promises:new Set()}
  },[commit?.token,commit?.phase])
  async function finishFeedback(saved:Result,readBack?:Listing){
    setCommit(null);setResult(null);changed()
    setAnnouncement(saved.summary?.operation==='undo'?'Change undone':saved.summary?.operation==='delete'?'Purchase deleted':saved.summary?.operation==='split'?'Split saved':'Change saved')
    const currentSequence=sequence.current
    const loaded=readBack?true:await load(0,false,true)
    if(readBack){setListing(readBack);setDisplayScope({filter,month});setNeedsFresh(false);setUpdatedAt(Date.now());setGraphRevision(value=>value+1)}
    if(!mounted.current||currentSequence!==sequence.current)return
    if(saved.undo&&loaded){const seconds=transactionMotion.undoSeconds;setNotice({id:++sequence.current,title:saved.summary?.operation==='delete'?'Purchase deleted':saved.summary?.operation==='split'?'Split updated':'Purchase updated',deadline:Date.now()+seconds*1000,seconds,undo:saved.undo})}
    else if(!loaded)setError('Your change was saved. Refresh Transactions to see the current rows.')
  }
  useEffect(()=>{
    if(!commit)return
    let live=true
    if(commit.phase==='closing')void settledTransactionRow(product.current,commit.id).then(()=>{if(live&&sequence.current===commit.token){if(commit.fresh&&(!commit.targetId||!commit.before.items.some(row=>row.id===commit.id)))setListing(commit.after);setCommit({...commit,phase:'animating'})}})
    else if(commit.phase==='animating')void Promise.allSettled([...(plan?.promises??[])]).then(()=>{
      if(!live||sequence.current!==commit.token)return
      placement.current=preparePlacement(product.current,commit.targetId??commit.id,commit.after.items,transactionMotion,commit.id)
      setListing(commit.after)
      if(placement.current)setCommit({...commit,phase:'placing'})
      else void finishFeedback(commit.result,commit.fresh?commit.after:undefined)
    })
    return()=>{live=false}
  },[commit?.token,commit?.phase])
  useLayoutEffect(()=>{
    if(commit?.phase!=='placing'||!placement.current)return
    let live=true;const player=playPlacement(placement.current);placementPlayer.current=player
    void player.finished.then(()=>{if(live&&sequence.current===commit.token){placement.current=null;placementPlayer.current=null;void finishFeedback(commit.result,commit.fresh?commit.after:undefined)}})
    return()=>{live=false;player.finish();placementPlayer.current=null;discardPlacement(placement.current);placement.current=null}
  },[commit?.token,commit?.phase])
  const categoryOptions = {...categories, ...Object.fromEntries((listing?.categories ?? facets.current.categories).filter(value=>!(value in categories)).map(value=>[value,value]))}
  const locked = busy || uncertain || Boolean(commit) || needsFresh
  const refreshDisabled=busy||uncertain||Boolean(commit)||loading||Boolean(operation)||Boolean(notice)
  const pageRefresh = usePageRefresh("transactions", { refresh: () => load(0, false, true), disabled: refreshDisabled })
  const filterCount = Number(filter!=="all")
  const days=useMemo(()=>listing?.days??[],[listing])
  const listDays=listing?.listDays??days
  const groups=useMemo(()=>recordedDays(listing?.items??[],listDays,displayScope.month).filter(group=>!day||group.day===day||group.key===day||day==='Undated'&&!Number.isFinite(Number(group.day))),[listing,listDays,displayScope.month,day])
  const periodChart=useMemo(()=>recordedChart(days,displayScope.month),[days,displayScope.month])
  const historyChart=useMemo(()=>recordedChartWindow(graphHistory?.key===historyKey?graphHistory.days:[],initialMonth,chartMonths),[graphHistory,historyKey,initialMonth,chartMonths])
  const chart=historyEnabled?historyChart:periodChart
  const rows=useMemo(()=>new Map(listing?.items.map(row=>[row.id,row])??[]),[listing])
  const filtersList=[{value:'all',label:'All'},{value:'needs',label:'Needs'},{value:'wants',label:'Wants'},{value:'shared',label:'Shared'},...Object.entries(categoryOptions).map(([value,label])=>({value:'category:'+value,label:spendingCategories[value]??label})),{value:'income',label:'Income'},{value:'savings',label:'Savings'}]
  const changeFilter=(value:string)=>{if(locked||operation||notice)return;manager.current.close?.();setDay('');setFilter(value)}
  const displayedFilter=displayScope.filter,graphFilter=historyEnabled?filter:displayedFilter
  const metricLabel=displayedFilter==='income'?'Total Income':displayedFilter==='savings'?'Total Saved':'Total Spent'
  const total=listing?.totalAmountCents??listing?.items.reduce((sum,row)=>sum+displayedAmount(row),0)??0
  useEffect(()=>{manager.current.close?.(true);setDay('')},[month,search,active])
  const inspectGraphDay=(value:string)=>{
    if(locked||operation||notice)return
    const date=/^\d{4}-\d{2}-\d{2}$/.test(value)?value:/^\d{1,2}$/.test(value)?`${month==='all'?initialMonth:month}-${value.padStart(2,'0')}`:value
    setDay(date)
  }
  const periodMonth=listing?displayScope.month:initialMonth
  const graphPending=historyEnabled&&(graphLoading||!graphError&&(graphHistory?.key!==historyKey))
  const graphControls=<div className="bb-recorded-graph-controls">
    <label className="bb-recorded-graph-range"><span className="sr-only">Graph period</span><select aria-label="Graph period" title={chartMonths?'Calendar months through '+new Date(initialMonth+'-01T12:00:00').toLocaleDateString(undefined,{month:'long',year:'numeric'}):periodMonth==='all'?'All recorded months':'Selected report month'} value={chartMonths} disabled={locked||Boolean(notice)} onChange={event=>setChartMonths(Number(event.target.value))}>
      <option value="0">{periodMonth==='all'?'All months':'Selected month'}</option><option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option>
    </select><ChevronDown aria-hidden="true"/></label>
  </div>
  const graphStatus=historyEnabled&&(graphError?<div className="bb-recorded-graph-status" role="alert"><span>{graphError}</span><button type="button" onClick={()=>setGraphRevision(value=>value+1)}>Retry graph</button></div>:graphPending?<div className="bb-recorded-graph-status" role="status">Loading graph…</div>:chart.length===0?<div className="bb-recorded-graph-status" role="status">No recorded activity in this period.</div>:null)
  const amountValue=Number(draft.amount),validAmount=/^\d+(?:\.\d{1,2})?$/.test(draft.amount??'')&&amountValue>0&&Number.isSafeInteger(Math.round(amountValue*100))
  const validFields=selected?.editableFields.every(field=>field==='amount'||draft[field]===selected.fields[field]||Boolean(draft[field]?.trim())&&draft[field].length<=200)
  const canReview=Boolean(selected&&operation&&(operation==='update'?validAmount&&validFields&&(destination!==selected.category||selected.editableFields.some(field=>field==='amount'?Math.round(amountValue*100)!==selected.amountCents:(draft[field]??'').trim()!==(selected.fields[field]??'').trim())):operation==='split'?customValid&&(method!=='custom'||Boolean(selected.splitOptions?.custom))&&(method!=='fronted'||selected.kind==='expense')&&(selected.split?method!==selected.split||payerShareCents!==(selected.splitOptions?.payerCents??selected.amountCents):payerShareCents!==selected.amountCents):true))
  const summary:TransactionChangeSummary|null=review?{operation:review.operation,title:review.item.title,date:review.item.date,category:review.item.categoryLabel,location:review.item.location,person:review.item.person,amountCents:review.item.amountCents,before:review.item.fields,after:review.after,destination:review.destination,share:review.share,restoration:review.restoration}:null
  const snapshot:InlineSnapshot|null=selected&&operation?{row:selected,operation,draft,destination,method,payerCents:payerShareCents,splitInput,review:summary,canReview,locked,busy,categories:{...categories,...(selected.category in categories?{}:{[selected.category]:selected.categoryLabel})},persons:['Hannah','Brian (BofA)','Brian (AL)'],error}:null
  const editorFor=(row:RecordedTransaction)=><InlineTransactionEditor key={row.id} snapshot={selected?.id===row.id?snapshot:null} onField={(key,value)=>setDraft(previous=>({...previous,[key]:value}))} onCategory={setDestination} onShare={(value,method)=>{setPayerShareCents(value);setMethod(method);setCustomValid(true)}} onValidity={setCustomValid} onSplitInput={setSplitInput} onReview={()=>void preview()} onConfirm={()=>void confirm()} onBack={()=>{setReview(null);setReviewBody(null)}} onCancel={discard} onRemoveSplit={()=>begin(row,'cancel_split')}/>
  const wrap=(entry:Parameters<typeof wrapTransactionRow>[0],position:number,children:ReactNode,standalone=false)=>{
    const row=rows.get(entry.id??'')
    return <div className="bi-selected-row" data-entry-id={entry.id} data-editing={selected?.id===entry.id&&Boolean(operation)} data-design="levels" data-duo-selected={duoWide&&selected?.id===entry.id}>
      {wrapTransactionRow(entry,position,cloneElement(children as ReactElement<{className:string}>,{className:(children as ReactElement<{className:string}>).props.className+' bi-editable-row'}),standalone)}
      {row&&!duoWide&&editorFor(row)}
    </div>
  }
  const status=<>
{error && <div role="alert" className="bb-transaction-notice"><p>{error}</p>{listing&&<button type="button" disabled={refreshDisabled} onClick={()=>void load(0,false,true)}>Refresh transactions</button>}</div>}
    {result && !result.success && !(busy&&selected&&operation!=='undo'&&result.state==='running') && <div role="status" className="bb-transaction-notice"><p>{result.detail || (result.state === "running" ? "Checking the saved change…" : "This change needs inspection in saved history. It will not be submitted again.")}</p>{uncertain && <><button type="button" disabled={busy} onClick={()=>void checkStatus()}>Check saved status</button><button type="button" disabled={busy} onClick={()=>void checkStatus(true)}>Retry same confirmation</button></>}</div>}
  </>
  function dayToggle(event:React.MouseEvent){
    const header=(event.target as Element).closest('.bb-daily-day-header'),group=header?.closest('.bb-daily-day-group')
    if(!header||!group)return
    placementPlayer.current?.finish()
    if(header.getAttribute('aria-expanded')==='true'){
      manager.current.close?.();if(group.querySelector('.bi-selected-row[data-editing="true"]')&&!busy&&!uncertain)discard()
    }else group.querySelectorAll<HTMLElement>('.bi-expansion[data-open="false"]').forEach(element=>element.getAnimations().forEach(animation=>animation.finish()))
  }
  return <TransactionSwipeContext.Provider value={{manager:manager.current,rows,locked:locked||loading||Boolean(notice),onAction:begin,onManage:duoWide?manageDuo:undefined,selectedId:duoWide?selected?.id:undefined}}><section ref={product} className="bb-transactions bb-daily-spending-content bi-product" data-tone="sage" data-save-phase={commit?.phase??'idle'} onClickCapture={dayToggle} aria-label="Recorded transactions" aria-busy={loading||Boolean(commit)} onPointerDownCapture={event=>{if(!(event.target as Element).closest('.bb-recorded-swipe'))manager.current.close?.()}}>
    <div className="bi-workspace" inert={Boolean(notice)} data-duo-pane={duoWide&&selected&&!graphOpen?"editor":"graph"}>
    {duoWide&&selected&&<DuoTransactionPane row={selected} operation={operation} reviewing={Boolean(review)} graphOpen={graphOpen} locked={locked||loading} onOptions={()=>{setOperation(null);setReview(null);setReviewBody(null)}} onAction={op=>{begin(selected,op);setDuoGraphOpen(false)}} onGraph={()=>setDuoGraphOpen(value=>!value)} onClose={discard} editor={editorFor(selected)} status={status} aliases={aliases}/>}
    <header className="bb-transactions-heading" hidden={navigation?.monthHeader}><h1>Transactions</h1>{!pageRefresh && <button type="button" aria-label="Refresh transactions" disabled={refreshDisabled} onClick={() => void load(0,false,true)}><RefreshCw size={18}/></button>}</header>
    {headerActions && createPortal(<button type="button" className="bb-transaction-all-months" aria-label="All recorded months" aria-pressed={month==='all'} disabled={locked||Boolean(operation)||Boolean(notice)} onClick={()=>{setDay('');setMonth(month==='all'?initialMonth:'all')}}>All months</button>,headerActions)}
    {navigation?.monthHeader?<div className="bb-transaction-period bb-transaction-scope"><span>{periodMonth==='all'?'All months':new Date(periodMonth+'-01T12:00:00').toLocaleDateString(undefined,{month:'long',year:'numeric'})}</span></div>:
    <details className="bb-transaction-period"><summary>{month==='all'?'All months':new Date(month+'-01T12:00:00').toLocaleDateString(undefined,{month:'long',year:'numeric'})}<ChevronDown aria-hidden="true"/></summary><div><label>Month<input aria-label="Recorded month" type="month" max={new Date().toISOString().slice(0,7)} value={month==='all'?initialMonth:month} disabled={locked||Boolean(operation)||Boolean(notice)} onChange={event=>{if(event.target.value){setMonth(event.target.value);event.target.closest('details')?.removeAttribute('open')}}}/></label><button type="button" disabled={locked||Boolean(operation)||Boolean(notice)} onClick={event=>{setMonth(month==='all'?initialMonth:'all');event.currentTarget.closest('details')?.removeAttribute('open')}}>{month==='all'?'Selected month':'All months'}</button></div></details>}
    {listing && <DailySpendingChart graphOpen={graphOpen} graphControls={graphControls} graphStatus={graphStatus} graphBusy={graphPending} data={chart} total={total/100} filter={graphFilter==='needs'||graphFilter==='wants'?graphFilter:'all'} detailsOpen detailsId="bb-recorded-days" onToggleDetails={()=>{}} onInspectDay={inspectGraphDay} metricLabel={metricLabel} legendLabel={graphFilter==='income'?'Income':graphFilter==='savings'?'Savings':undefined}
      transactionControl={<div className="bb-recorded-summary-controls"><CategoryFilterControl filter={filter} onFilterChange={changeFilter} filters={filtersList} label="Filter transactions" dismissTrigger="recorded-transactions"/><button type="button" className="bb-recorded-graph-toggle" aria-label={graphOpen?'Hide spending graph':'Show spending graph'} aria-expanded={graphOpen} aria-controls="bb-recorded-days-graph" onClick={()=>setGraphOpen(value=>!value)}><ChartNoAxesColumn aria-hidden="true"/></button></div>}/>}
    <label className="bb-recorded-search"><Search aria-hidden="true"/><input type="text" role="searchbox" enterKeyHint="search" aria-label="Search transactions" placeholder="Search transactions" maxLength={200} value={search} disabled={locked||Boolean(operation)||Boolean(notice)} onChange={event=>setSearch(event.target.value)}/>{search&&<button type="button" aria-label="Clear search" disabled={locked||Boolean(operation)||Boolean(notice)} onClick={()=>setSearch('')}><X aria-hidden="true"/></button>}</label>
    {day&&<button type="button" className="bb-recorded-day-chip" aria-label={'Clear date filter '+recordedDateLabel(day,true)} onClick={()=>setDay('')}>{recordedDateLabel(day,true)}<X aria-hidden="true"/></button>}
    <div className="bb-recorded-results">
    {(!duoWide||!selected)&&status}
    {loading && !listing && <p role="status" className="bb-recorded-loading">Loading recorded transactions…</p>}
    {!loading && !listing && !error && <p className="bb-transaction-empty">Open Transactions to load your recorded activity.</p>}
    {listing?.items.length===0&&<div className="bb-transaction-empty"><p>{search||filterCount?'No transactions match these filters.':'No recorded transactions in this period.'}</p>{(search||filterCount>0)&&<button type="button" onClick={()=>{setSearch('');setFilter('all')}}>Clear search and filters</button>}</div>}
    <div className="bb-transaction-list bb-daily-transactions" id="bb-recorded-days"><ChangeMotionContext.Provider value={plan}><DailyTransactionDays groups={groups} year={Number(initialMonth.slice(0,4))} month={Number(initialMonth.slice(5))} flatSingles wrapRow={wrap} aliases={aliases} categoryColors={recordedCategoryColors}/></ChangeMotionContext.Provider></div>
    {listing?.nextOffset !== null && listing?.nextOffset !== undefined && <button className="bb-transaction-load" type="button" disabled={loading||locked||Boolean(operation)||Boolean(notice)} onClick={()=>void load(listing.nextOffset!,true)}>{loading ? "Loading…" : "Load more transactions"}</button>}
    {error && !listing && <button type="button" disabled={loading} onClick={()=>void load(0,false,true)}>Try again</button>}
    </div>
    </div>
    <span className="bi-sr-only" role="status" aria-live="polite">{announcement}</span>
    {notice&&<UndoPopup notice={notice} onUndo={()=>{const undo=notice.undo;setNotice(null);if(undo)void preview(undo,true)}} onDismiss={()=>setNotice(null)} returnFocus={()=>product.current?.querySelector<HTMLButtonElement>('.bb-daily-day-header,.bb-recorded-row-access')??null}/>}
  </section></TransactionSwipeContext.Provider>
}
