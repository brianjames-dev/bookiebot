import {useCallback,useEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,ChevronDown,ChevronRight,Plus,Trash2,RefreshCw,Clock3,Check} from 'lucide-react'
import {TransactionIcon} from './daily-transactions'
import {useAppNavigation} from './app-navigation'
import {useAppWorkGuard,useAppWorkStatus} from './app-work-guard'
import {NotchedSplitControl,type SplitInputDraft} from './transaction-split-control'
import type {SplitMethod} from './transaction-split-model'
import {transactionMotion} from './transaction-inline-editor'
import {EditorScenes} from './transaction-editor-workspace'
import {StepMotion} from './transaction-step-motion'
import {BillCurrentCharge,type CurrentBillIntent} from './bill-current-charge'
import {BillCurrentOffer} from './bill-current-offer'
import {BillEditorWorkspace} from './bill-editor-workspace'
import {billListAmount,currentBillHasHit,recurringStartMonth} from './bill-settings-model'
import {usePageRefresh,usePageRefreshRegistry} from './page-refresh'
import {BillPredictionInfo} from './bill-prediction-info'
import type {BillPrediction} from './types'
import type {BillAmountRequest} from './bill-checkin'
import './bill-checkin.css'
import './bill-settings.css'

type Charge={available:boolean;month:string;amountCents?:number;billAmountCents?:number;status?:'unconfirmed'|'confirmed'|'paid';canConfirmAmount?:boolean;splitPending?:boolean;recorded?:boolean;virtual?:boolean;date?:string|null;version?:string}
export type Bill={id:string;type:'subscription'|'variable'|'fixed';name:string;amountCents:number|null;cadence:'monthly'|'quarterly'|'yearly';pullDay:number|null;pullMonths:number[];category:string;account:string;active:boolean;effectiveFrom:string;effectiveUntil:string;splitMethod:'none'|SplitMethod;payerBasisPoints:number;version:string;nextDate:string|null;needsSetup:boolean;earliestEffectiveMonth:string;charge:Charge;nextChange?:Bill|null;prediction?:BillPrediction|null;checkInLeadDays?:number|null}
type Snapshot={month:string;today:string;settingsVersion:string;ownerName:string;partnerName:string;incomeBasisPoints:number;splitsEnabled:boolean;bills:Bill[];pendingCommand?:Command}
type Form={name:string;type:Bill['type'];amount:string;cadence:Bill['cadence'];pullDay:number;firstMonth:number;category:string;account:string;effectiveFrom:string;splitMethod:Bill['splitMethod'];payerBasisPoints:number}
type Command=Record<string,unknown>&{operation:string;requestId?:string;reviewVersion?:string}
type Review={operation:string;reviewVersion:string;name?:string;amountCents?:number;month?:string;date?:string;effectiveFrom?:string;before?:Bill|null;after?:Bill;share?:{method:string;payerName?:string;partnerName?:string;payerCents:number;partnerCents:number};replacesScheduledChanges?:boolean}
type Result={state:string;success?:boolean;detail?:string;splitPending?:boolean;transaction?:{id:string;month:string}}
type Mode='settings'|'amount'|'monthly'|'stop'|'adopt'|'split'|'offer'|'charge'
type Draft={form:Form;mode:Mode;amount:string;review:Review|null;reviewBody:Command|null;splitInput:SplitInputDraft;valid:boolean;draftId:string;splitBefore:{method:Form['splitMethod'];basis:number}|null}
const money=(cents:number|null|undefined)=>cents===null||cents===undefined?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
const monthLabel=(value:string)=>new Date(value+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})
const kindLabel={subscription:'Subscription',variable:'Variable bill',fixed:'Fixed bill'}
const categoryLabels:Record<string,string>={rent:'Rent',bills_utilities:'Bills & utilities',static_bills_subscriptions_needs:'Needs',subscriptions_wants:'Wants'}
class BillRequestError extends Error {constructor(message:string,public status:number){super(message)}}
async function request(path:string,body?:unknown,signal?:AbortSignal){
 const controller=new AbortController();let timedOut=false
 const cancel=()=>controller.abort();if(signal?.aborted)cancel();signal?.addEventListener('abort',cancel,{once:true})
 const deadline=window.setTimeout(()=>{timedOut=true;controller.abort()},30_000)
 try{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',mode:'same-origin',referrerPolicy:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:body?JSON.stringify(body):undefined,signal:controller.signal})
  const value=await response.json();if(!response.ok)throw new BillRequestError(value.error||'Could not load Bills.',response.status);return value
 }catch(error){if(timedOut)throw new BillRequestError('Bills took too long to respond. Check saved status before repeating a change.',0);throw error}
 finally{window.clearTimeout(deadline);signal?.removeEventListener('abort',cancel)}
}
function newForm(snapshot:Snapshot,source?:Bill):Form{const bill=source?.nextChange??source;return {name:bill?.name??'',type:bill?.type??'subscription',amount:bill?.amountCents==null?'':(bill.amountCents/100).toFixed(2),cadence:bill?.cadence??'monthly',pullDay:bill?.pullDay??1,firstMonth:bill?.pullMonths[0]??Number(snapshot.month.slice(5)),category:bill?.category??'static_bills_subscriptions_needs',account:bill?.account??'',effectiveFrom:recurringStartMonth(snapshot.month,source?.earliestEffectiveMonth),splitMethod:bill?.splitMethod??'none',payerBasisPoints:bill?.payerBasisPoints??snapshot.incomeBasisPoints}}

export function BillSettings({active,ownerName,aliases,amountRequest,onAmountConsumed}:{active:boolean;ownerName:string;aliases?:Record<string,string>;amountRequest?:BillAmountRequest|null;onAmountConsumed?:()=>void}){
 const navigation=useAppNavigation(),wide=navigation?.duoLandscape===true
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[filter,setFilter]=useState('all'),[selected,setSelected]=useState<Bill|null>(null),[form,setForm]=useState<Form|null>(null)
 const [mode,setMode]=useState<Mode>('settings'),[amount,setAmount]=useState(''),[review,setReview]=useState<Review|null>(null),[reviewBody,setReviewBody]=useState<Command|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null),[pending,setPending]=useState<Command|null>(null),[valid,setValid]=useState(true)
 const [splitInput,setSplitInput]=useState<SplitInputDraft>(null)
 const [confirmReady,setConfirmReady]=useState(false)
 const [currentIntent,setCurrentIntent]=useState<CurrentBillIntent|null>(null),[newRequested,setNewRequested]=useState(false)
 const refreshRegistry=usePageRefreshRegistry()
 const work=useAppWorkGuard(),currentLocked=work.pending||work.uncertain
 const wasActive=useRef(false)
 const splitBefore=useRef<{method:Form['splitMethod'];basis:number}|null>(null)
 const followKey=`bookiebot:bill-current:${ownerName.toLowerCase()}`
 const drafts=useRef(new Map<string,Draft>())
 const flight=useRef(false),alive=useRef(true),generation=useRef(0),draftId=useRef(''),abort=useRef<AbortController|null>(null)
 const placement=useRef<{order:number;isNew:boolean;billId?:string}>({order:1,isNew:true})
 const storageKey=`bookiebot:bills-request:${ownerName.toLowerCase()}`
 const reset=useCallback(()=>{drafts.current.clear();setForm(null);setSelected(null);setReview(null);setReviewBody(null);setMode('settings');setAmount('');setError('');setValid(true);setSplitInput(null);setConfirmReady(false);setCurrentIntent(null);splitBefore.current=null;try{sessionStorage.removeItem(followKey)}catch{}},[followKey])
 const updateWork=useAppWorkStatus({label:'Bill changes',pending:busy,uncertain:Boolean(pending),dirty:Boolean(form),onDiscard:reset})
 const load=useCallback(async()=>{
  const token=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('')
  try{const next=await request('/app/bills',undefined,controller.signal) as Snapshot;if(!alive.current||token!==generation.current)return false
   if(next.ownerName?.toLowerCase()!==ownerName.toLowerCase())throw new Error('Your budget profile changed. Reopen BookieBot.');
   if(!Array.isArray(next.bills)||!next.settingsVersion)throw new Error('Bills could not be read completely.')
   setSnapshot(next);try{const follow=JSON.parse(sessionStorage.getItem(followKey)||'null') as CurrentBillIntent|null;if(follow&&(follow.stage==='charge'||follow.stage==='adopt'||follow.stage==='offer')){setCurrentIntent(follow);setSelected(next.bills.find(b=>b.id===follow.id)??null);setForm(newForm(next,next.bills.find(b=>b.id===follow.id)));setMode(follow.stage)}}catch{};if(next.pendingCommand){setPending(next.pendingCommand);try{sessionStorage.setItem(storageKey,JSON.stringify(next.pendingCommand))}catch{}};return true
  }catch(e){if(alive.current&&token===generation.current&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Could not load Bills.');return false}
  finally{if(alive.current&&token===generation.current)setBusy(false)}
 },[storageKey,followKey])
 usePageRefresh(active?'settings':null,{refresh:load,disabled:busy||Boolean(pending)||currentLocked})
 useEffect(()=>{alive.current=true;try{const saved=sessionStorage.getItem(storageKey);if(saved)setPending(JSON.parse(saved))}catch{}return()=>{alive.current=false;++generation.current;abort.current?.abort()}},[storageKey])
 useEffect(()=>{if(active&&!snapshot&&!flight.current)void load()},[active,snapshot,load])
 useEffect(()=>{if(wasActive.current&&!active&&!busy&&!pending&&!currentLocked){setNewRequested(false);reset()}wasActive.current=active},[active,busy,pending,currentLocked,reset])
 const choose=(bill?:Bill)=>{
  if(busy||pending||currentLocked||!snapshot)return
  if(form&&bill?.id===selected?.id){if(bill)reset();return}
  const followup=mode==='charge'||mode==='offer'||mode==='adopt'
  if(followup){setCurrentIntent(null);try{sessionStorage.removeItem(followKey)}catch{}}
  if(form&&!followup)drafts.current.set(selected?.id??'new',{form,mode,amount,review,reviewBody,splitInput,valid,draftId:draftId.current,splitBefore:splitBefore.current})
  const draft=drafts.current.get(bill?.id??'new')
  setSelected(bill??null);setForm(draft?.form??newForm(snapshot,bill));setMode(draft?.mode??'settings');setAmount(draft?.amount??'')
  setReview(draft?.review??null);setReviewBody(draft?.reviewBody??null);setSplitInput(draft?.splitInput??null);setValid(draft?.valid??true)
  draftId.current=draft?.draftId??crypto.randomUUID();setConfirmReady(false);setError('');setResult(null);splitBefore.current=draft?.splitBefore??null
 }
 const addBill=()=>{if(busy||pending||currentLocked||!snapshot){setNewRequested(true);return}choose()}
 const openMonthly=(bill:Bill)=>{
  if(locked||!snapshot)return
  if(!form||selected?.id!==bill.id)choose(bill)
  setMode(bill.charge.recorded||bill.charge.amountCents?'monthly':'amount');setReview(null);setReviewBody(null);setAmount('')
 }
 useEffect(()=>{
  if(!active||!amountRequest||!snapshot||busy||pending||currentLocked)return
  const bill=snapshot.bills.find(b=>b.id===amountRequest.id)
  if(bill&&snapshot.month===amountRequest.month&&bill.charge.canConfirmAmount!==false)openMonthly(bill)
  else setError('This bill changed. Refresh Bills to check its amount.')
  onAmountConsumed?.()
 },[active,amountRequest,snapshot,busy,pending,currentLocked])
 const setCheckin=async(value:string)=>{
  if(!selected||locked)return
  setBusy(true);setError('')
  try{const next=await request('/app/bills/check-in/preferences',{id:selected.id,leadDays:value==='off'?null:Number(value)});setSelected(previous=>previous?{...previous,checkInLeadDays:next.leadDays}:null);setSnapshot(previous=>previous?{...previous,bills:previous.bills.map(b=>b.id===selected.id?{...b,checkInLeadDays:next.leadDays}:b)}:null)}
  catch(e){setError(e instanceof Error?e.message:'Could not save check-in.')}
  finally{setBusy(false)}
 }
 const editMonthly=()=>{
  if(!selected||!snapshot||locked)return
  setCurrentIntent({id:selected.id,month:snapshot.month,name:selected.name,amountCents:null,method:selected.splitMethod,basis:selected.payerBasisPoints,stage:'charge',editAmount:!selected.charge.splitPending});setMode('charge')
 }
 useEffect(()=>{if(newRequested&&active&&!busy&&!pending&&!currentLocked&&snapshot){setNewRequested(false);choose()}},[newRequested,active,busy,pending,currentLocked,snapshot])
 // Confirmation is a separate action after the review's native slide settles.
 useEffect(()=>{setConfirmReady(false);if(!review)return;const timer=window.setTimeout(()=>setConfirmReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review,selected?.id])
 const change=(patch:Partial<Form>)=>{setForm(previous=>previous?{...previous,...patch}:null);setReview(null);setReviewBody(null);setError('')}
 const prepare=async(operation=selected?'update':'create')=>{
  if(flight.current||pending||!form||!snapshot)return
  flight.current=true;setBusy(true);setConfirmReady(false);setError('');setResult(null)
  const base:Command={operation,settingsVersion:snapshot.settingsVersion,...(selected?{id:selected.id,version:selected.version}:{draftId:draftId.current})}
  let body:Command
  if(operation==='amount'||operation==='adopt')body={operation,id:selected?.id,month:snapshot.month,settingsVersion:snapshot.settingsVersion,chargeVersion:selected?.charge.version,...(operation==='amount'?{amount}: {})}
  else if(operation==='delete')body={...base,effectiveFrom:form.effectiveFrom}
  else{const {firstMonth,...fields}=form;body={...base,bill:{...fields,effectiveFrom:[fields.effectiveFrom,selected?.earliestEffectiveMonth??snapshot.month].sort()[1],pullMonths:form.cadence==='monthly'?[]:form.cadence==='yearly'?[firstMonth]:[0,3,6,9].map(n=>(firstMonth-1+n)%12+1).sort((a,b)=>a-b)}}}
  try{const next=await request('/app/bills/review',body);if(alive.current){setReview(next.review);setReviewBody(body)}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not review bill.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const accept=async(next:Result,command:Command)=>{
  setResult(next)
  if(next.state==='done'){
   let follow:CurrentBillIntent|null=null;try{follow=JSON.parse(sessionStorage.getItem(followKey)||'null')}catch{}
   const ownsFollow=follow&&(follow.stage==='configuration'&&command.operation==='update'&&follow.requestId===command.requestId&&command.id===follow.id||follow.stage==='adopt'&&command.operation==='adopt'&&command.id===follow.id)
   if(next.success&&follow&&ownsFollow){
    const stage={...follow,stage:follow.stage==='configuration'&&follow.offerCurrent?'offer' as const:follow.stage==='configuration'&&follow.needsAdoption?'adopt' as const:'charge' as const};sessionStorage.setItem(followKey,JSON.stringify(stage));setCurrentIntent(stage)
    // Adoption is separately reviewed before opening a virtual occurrence.
    setMode(stage.stage);setReview(null);setReviewBody(null)
   }else reset()
   setPending(null);try{sessionStorage.removeItem(storageKey)}catch{}
   if(next.success){window.dispatchEvent(new Event('bookiebot:transactions-changed'));window.dispatchEvent(new Event('bookiebot:reimbursements-changed'))}
   await load()
  }
 }
 const save=async()=>{
  if(flight.current||pending||!review||!reviewBody||!confirmReady)return
  const command={...reviewBody,requestId:crypto.randomUUID(),reviewVersion:review.reviewVersion}
  try{if(selected&&snapshot&&form&&command.operation==='update'&&currentBillHasHit(selected.charge,snapshot.month,snapshot.today,selected.amountCents)){const plan=review.after;const follow:CurrentBillIntent={id:selected.id,month:snapshot.month,name:plan?.name??form.name,amountCents:(plan?.type??form.type)==='variable'?null:plan?.amountCents??Math.round(Number(form.amount)*100),method:plan?.splitMethod??form.splitMethod,basis:plan?.payerBasisPoints??selectedIncome,requestId:command.requestId,stage:'configuration',offerCurrent:true,recordedAmountCents:selected.charge.virtual?selected.amountCents??0:selected.charge.amountCents,needsAdoption:selected.charge.virtual};sessionStorage.setItem(followKey,JSON.stringify(follow));setCurrentIntent(follow)};sessionStorage.setItem(storageKey,JSON.stringify(command))}catch{try{const follow=JSON.parse(sessionStorage.getItem(followKey)||'null');if(follow?.requestId===command.requestId)sessionStorage.removeItem(followKey)}catch{}setCurrentIntent(null);setError('Saved-status storage is unavailable. Reopen BookieBot before confirming this change.');return}
  flight.current=true;setBusy(true);setPending(command);updateWork({label:'Bill changes',pending:true,uncertain:true})
  try{await accept(await request('/app/bills',command),command)}catch(e){if(alive.current){if(e instanceof BillRequestError&&[400,403,409].includes(e.status))await accept({state:'done',success:false,detail:e.message},command);else{if(e instanceof BillRequestError&&e.status===401){reset();setSnapshot(null)}setResult({state:'uncertain',detail:e instanceof Error?e.message:'Check saved status.'})}}}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const checkSaved=async(retry=false)=>{if(flight.current||!pending?.requestId)return;flight.current=true;setBusy(true);setError('');try{await accept(await request(retry?'/app/bills':`/app/bills/commands/${encodeURIComponent(pending.requestId)}`,retry?pending:undefined),pending)}catch(e){setError(e instanceof Error?e.message:'Could not check saved status.')}finally{flight.current=false;setBusy(false)}}
 const reviewCurrent=()=>{if(!currentIntent||busy||pending||currentLocked)return;const next={...currentIntent,stage:currentIntent.needsAdoption?'adopt' as const:'charge' as const};try{sessionStorage.setItem(followKey,JSON.stringify(next))}catch{setError('Keep this screen open and retry the current-charge review.');return}setCurrentIntent(next);setMode(next.stage);setReview(null);setReviewBody(null)}
 const selectedIncome=form?.splitMethod==='income'?snapshot?.incomeBasisPoints??5000:form?.splitMethod==='equal'?5000:form?.splitMethod==='fronted'?0:form?.payerBasisPoints??10000
 const visible=snapshot?.bills.filter(b=>filter==='all'||(b.nextChange??b).type===filter)??[]
 // Keep the editor's row anchor through its closing expansion. Folding changes
 // only the grid placement, never the mounted scenes or controlled draft.
 if(form)placement.current={order:selected?visible.findIndex(bill=>bill.id===selected.id)*2+3:1,isNew:!selected,billId:selected?.id}
 const locked=busy||Boolean(pending)||currentLocked,lastReview=useRef<Review|null>(null)
 if(review)lastReview.current=review
 const shownReview=review??lastReview.current
 const splitLabel=(bill:Bill)=>bill.splitMethod==='none'?'No split':bill.splitMethod==='income'?'By income':bill.splitMethod==='equal'?'50 / 50':bill.splitMethod==='fronted'?`100% ${snapshot?.partnerName}`:`${(bill.payerBasisPoints/100).toFixed(2)}% ${snapshot?.ownerName}`
 const reviewLines=shownReview?.after?[
  {label:shownReview.after.type==='variable'?'Estimate':'Recurring amount',before:shownReview.before?money(shownReview.before.amountCents):null,after:money(shownReview.after.amountCents)},
  {label:'Repeats',before:shownReview.before?`${shownReview.before.cadence} · day ${shownReview.before.pullDay}`:null,after:`${shownReview.after.cadence} · day ${shownReview.after.pullDay}`},
  {label:shownReview.operation==='delete'?'Stops':'Applies from',before:null,after:monthLabel(shownReview.effectiveFrom!)+' onward'},
  {label:'Recurring split',before:shownReview.before?splitLabel(shownReview.before):null,after:splitLabel(shownReview.after)},
 ]:shownReview?.share&&shownReview.share.method!=='none'?[
  {label:snapshot?.ownerName??'',before:null,after:money(shownReview.share.payerCents)},
  {label:snapshot?.partnerName??'',before:null,after:money(shownReview.share.partnerCents)},
 ]:[]
 const heading=mode==='split'?'Recurring split':mode==='amount'?'Monthly amount':mode==='monthly'?'This month’s bill':mode==='adopt'?'Recorded charge':mode==='stop'?'Stop bill':selected?((selected.nextChange??selected).active?'Edit bill':'Restart bill'):'New bill'
 const dueLabel=selected?.charge.date?new Date(selected.charge.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'Set a payment day'
 const reminder=selected&&selected.charge.canConfirmAmount!==false&&<label className="bb-bills-reminder">Amount check-in<span className="bi-select"><select aria-label="Amount check-in" disabled={locked} value={selected.checkInLeadDays===null?'off':selected.checkInLeadDays??7} onChange={e=>void setCheckin(e.target.value)}>{[1,3,7,14,30].map(n=><option key={n} value={n}>{n} {n===1?'day':'days'} before</option>)}<option value="off">Off</option></select><ChevronDown aria-hidden="true"/></span></label>
 const editView=form&&snapshot&&(mode==='offer'&&currentIntent?<BillCurrentOffer intent={currentIntent} locked={locked} onKeep={()=>{reset();void load()}} onReview={reviewCurrent}/>:<>
  <header className="sp-flow-heading bb-bill-heading bb-bill-edit-heading"><h2>{heading}</h2>{mode==='split'&&<button type="button" className="bi-cancel bb-bills-remove-split" disabled={locked} onClick={()=>{change({splitMethod:'none'});setSplitInput(null);setValid(true);setMode('settings')}}>Remove split</button>}{selected&&mode==='settings'&&(selected.nextChange??selected).active&&<button type="button" className="bb-bills-stop" aria-label="Stop bill" disabled={locked} onClick={()=>setMode('stop')}><Trash2 aria-hidden="true"/></button>}</header>
  <form className="bi-fields bb-bills-form" data-editor-mode={mode} onSubmit={e=>{e.preventDefault();if(mode==='split'){if(valid&&!locked)setMode('settings');return}void prepare(mode==='stop'?'delete':mode==='amount'?'amount':mode==='adopt'?'adopt':selected?'update':'create')}}>
   {mode==='split'?<>
    <div className="sp-management"><NotchedSplitControl unit="percent" inputDraft={splitInput} onInputDraft={setSplitInput} total={10000} payerCents={selectedIncome} method={form.splitMethod==='none'?'income':form.splitMethod} incomeBasis={snapshot.incomeBasisPoints} capture={6} payerName={snapshot.ownerName} partnerName={snapshot.partnerName} disabled={locked} onChange={(payerBasisPoints,splitMethod)=>change({payerBasisPoints,splitMethod})} onValidityChange={setValid}/></div>
   </>:mode==='amount'||mode==='monthly'||mode==='adopt'?<>
    {mode==='amount'?<><label>Bill amount<span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label="Bill amount" inputMode="decimal" required value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></span></label><p className="bb-bills-month-status"><Clock3 aria-hidden="true"/>Autopay · {dueLabel}</p>{reminder}</>:mode==='monthly'?<><p className="bb-bills-month-amount">{money(selected?.charge.billAmountCents??selected?.charge.amountCents)}</p><p className="bb-bills-month-status">{selected?.charge.status==='paid'?<Check aria-hidden="true"/>:<Clock3 aria-hidden="true"/>}{selected?.charge.status==='paid'?'Paid':'Autopay'} · {dueLabel}</p><p className="bi-footnote">{selected?.charge.status==='paid'?'Included in Transactions.':'Amount confirmed. Appears in Transactions on the autopay date.'}</p>{reminder}</>:<p className="bi-footnote">Review this {money(selected?.amountCents)} recorded charge here. Its purchase total is preserved.</p>}
   </>:<>
    {selected&&mode==='settings'&&selected.active&&selected.charge.available&&selected.type==='variable'&&selected.charge.canConfirmAmount!==false&&<div className="bb-bills-charge-actions">
     <button type="button" className="bb-settings-action" aria-label={selected.charge.recorded||selected.charge.amountCents?'This month’s bill':'Enter monthly amount'} disabled={locked} onClick={()=>openMonthly(selected)}><span className="bb-bills-full-label">{selected.charge.recorded||selected.charge.amountCents?'This month’s bill':'Enter monthly amount'}</span><span className="bb-bills-short-label" aria-hidden="true">Monthly amount</span><ChevronRight aria-hidden="true"/></button>
    </div>}
    {mode==='stop'?<p className="bi-footnote">Earlier months stay unchanged.</p>:<>
     <label data-bill-field="name">Name<input className="bb-bills-input" required maxLength={100} value={form.name} onChange={e=>change({name:e.target.value})}/></label>
     <div className="bi-secondary-fields">
      <label data-bill-field="type">Type<span className="bi-select"><select aria-label="Type" value={form.type} onChange={e=>change({type:e.target.value as Form['type'],category:e.target.value==='subscription'?'static_bills_subscriptions_needs':'bills_utilities',cadence:e.target.value==='subscription'&&form.cadence==='quarterly'?'monthly':form.cadence})}><option value="subscription">Subscription</option><option value="variable">Variable bill</option><option value="fixed">Fixed bill</option></select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="amount"><span className="bb-bills-full-label">{form.type==='variable'?'Estimate (optional)':'Recurring amount'}</span><span className="bb-bills-short-label" aria-hidden="true">{form.type==='variable'?'Estimate':'Recurring amount'}</span><span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label={form.type==='variable'?'Estimate (optional)':'Recurring amount'} required={form.type!=='variable'} inputMode="decimal" placeholder="0.00" value={form.amount} onChange={e=>change({amount:e.target.value})}/></span></label>
     </div>
     <div className="bi-secondary-fields">
      <label data-bill-field="cadence">Repeats<span className="bi-select"><select aria-label="Repeats" value={form.cadence} onChange={e=>change({cadence:e.target.value as Form['cadence']})}><option value="monthly">Monthly</option>{form.type!=='subscription'&&<option value="quarterly">Quarterly</option>}<option value="yearly">Yearly</option></select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="day">Payment day<input className="bb-bills-input" type="number" min={1} max={31} required value={form.pullDay} onChange={e=>change({pullDay:Number(e.target.value)})}/></label>
     </div>
     {form.cadence!=='monthly'&&<label data-bill-field="billing-month"><span className="bb-bills-full-label">{form.cadence==='yearly'?'Billing month':'First billing month'}</span><span className="bb-bills-short-label" aria-hidden="true">{form.cadence==='yearly'?'Billing month':'First month'}</span><span className="bi-select"><select aria-label={form.cadence==='yearly'?'Billing month':'First billing month'} value={form.firstMonth} onChange={e=>change({firstMonth:Number(e.target.value)})}>{Array.from({length:12},(_,i)=><option value={i+1} key={i}>{new Date(2026,i,1).toLocaleDateString('en-US',{month:'long'})}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>}
     <div className="bi-secondary-fields">
      <label data-bill-field="category"><span className="bb-bills-full-label">Budget category</span><span className="bb-bills-short-label" aria-hidden="true">Category</span><span className="bi-select"><select aria-label="Budget category" value={form.category} onChange={e=>change({category:e.target.value})}>{Object.entries(categoryLabels).filter(([key])=>form.type==='subscription'||key!=='subscriptions_wants').map(([key,label])=><option value={key} key={key}>{label}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="account">Account<input className="bb-bills-input" maxLength={80} value={form.account} placeholder="Optional" onChange={e=>change({account:e.target.value})}/></label>
     </div>
    </>}
    {mode==='stop'&&<label data-bill-field="starting-month">Stop from<input className="bb-bills-input" type="month" required min={selected?.earliestEffectiveMonth??snapshot.month} value={form.effectiveFrom} onChange={e=>change({effectiveFrom:e.target.value})}/></label>}
    {mode!=='stop'&&<button type="button" className="bb-settings-action bb-bills-split-action" data-bill-field="split" disabled={locked||!snapshot.splitsEnabled&&form.splitMethod==='none'} onClick={()=>{splitBefore.current={method:form.splitMethod,basis:form.payerBasisPoints};if(form.splitMethod==='none')change({splitMethod:'income',payerBasisPoints:snapshot.incomeBasisPoints});setMode('split')}}><span>Recurring split<small>{form.splitMethod==='none'?'No split':splitLabel({...selected,...form} as Bill)}</small></span><ChevronRight aria-hidden="true"/></button>}
   </>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={mode==='settings'?reset:()=>{if(mode==='split'&&splitBefore.current){change({splitMethod:splitBefore.current.method,payerBasisPoints:splitBefore.current.basis});setSplitInput(null);setValid(true)}setMode('settings')}}>{mode==='monthly'?'Back':'Cancel'}</button>{mode==='monthly'?selected?.charge.canConfirmAmount!==false&&<button className="bi-primary" type="button" disabled={locked} onClick={editMonthly}>{selected?.charge.splitPending?'Review split':'Edit amount'}</button>:mode==='split'?<button className="bi-primary" type="button" disabled={locked||!valid} onClick={()=>setMode('settings')}>Use split</button>:<button className="bi-primary" type="submit" disabled={locked||!valid}>{busy?'Preparing…':'Review'}</button>}</footer>
  </form>
 </>)
 const reviewView=shownReview&&<>
  <header className="sp-flow-heading bb-bill-heading"><h2>{shownReview.operation==='delete'?'Stop bill':shownReview.operation==='adopt'?'Edit recorded charge':shownReview.operation==='amount'?'Confirm amount':'Review bill'}</h2><p className="sp-flow-context bb-bills-review-context"><span title={shownReview.after?.name??shownReview.name??selected?.name}>{shownReview.after?.name??shownReview.name??selected?.name}</span>{shownReview.after&&<span> · {kindLabel[shownReview.after.type]}</span>}</p></header>
  {!shownReview.after&&<p className="bb-bills-review-amount">{money(shownReview.amountCents)}</p>}
  <dl className="bi-review-changes" aria-label="Bill changes to review">{reviewLines.map(line=><div className="bi-review-change" key={line.label}><dt>{line.label}</dt><dd>{line.before!==null&&line.before!==line.after&&<><del>{line.before}</del><span className="bi-review-new"><ArrowRight aria-hidden="true"/><span>{line.after}</span></span></>}{(line.before===null||line.before===line.after)&&<span className="bi-review-new">{line.after}</span>}</dd></div>)}</dl>
  {shownReview.after&&<p className="bi-footnote">Recorded charges need a separate confirmation.</p>}
  {shownReview.replacesScheduledChanges&&<p className="bi-footnote">Replaces later scheduled changes for this bill.</p>}
  {shownReview.operation==='amount'&&<p className="bi-footnote">Appears in Transactions on the saved autopay date. Early repayments stay in Shared.</p>}
  {shownReview.operation==='adopt'&&<p className="bi-footnote">Prepares this recorded charge for editing here. The purchase total stays unchanged.</p>}
  <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={()=>{setReview(null);setReviewBody(null)}}><ArrowLeft aria-hidden="true"/>Back</button><button type="button" className="bi-primary" disabled={locked||!review||!confirmReady} onClick={()=>void save()}>{busy?'Saving…':shownReview.operation==='delete'?'Stop bill':shownReview.operation==='amount'?'Confirm amount':'Confirm'}</button></footer>
 </>
 return <div className="bb-bills bi-product" data-tone="sage" data-wide={wide} aria-busy={busy}>

  <div className="bb-bills-notices">
  {newRequested&&<p className="bb-bills-status" role="status">New bill will open after the current change is verified.</p>}
  {error&&(!form||wide)&&<p className="bb-bills-error" role="alert">{error}</p>}
  {result?.detail&&<p role="status" className="bb-bills-status">{result.detail}</p>}
  {pending&&<div className="bb-bills-recovery"><p role="status">Check the saved status before making another change.</p><button className="bb-bills-primary" type="button" disabled={busy} onClick={()=>void checkSaved()}>Check saved status</button><button type="button" className="bb-settings-action" disabled={busy} onClick={()=>void checkSaved(true)}>Retry same confirmation</button></div>}
  {!snapshot&&busy&&<p role="status" className="bb-bills-empty">Loading bills…</p>}
  {!snapshot&&!busy&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Reload Bills</button>}
  </div>
  {snapshot&&<div className="bb-bills-panes">
   <section className="bb-bills-list" aria-label="Your bills">
    <div className="bb-bills-toolbar"><select aria-label="Bill type" disabled={locked||Boolean(form)} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All bills</option><option value="subscription">Subscriptions</option><option value="variable">Variable bills</option><option value="fixed">Fixed bills</option></select><button type="button" className="bb-bills-add" aria-busy={newRequested} onClick={addBill}><Plus aria-hidden="true"/>Add bill</button>{wide&&<button type="button" className="bb-bills-refresh" aria-label="Refresh bills" disabled={locked} onClick={()=>{setResult(null);void refreshRegistry?.refresh('settings')}}><RefreshCw aria-hidden="true"/></button>}</div>
    <div className="bb-bills-rows"><div className="bb-bills-row-stack">{visible.map((bill,index)=>{
     const configured=bill.nextChange??bill,{cents:value,prediction,known}=billListAmount(bill)
     return <div className="bb-bills-row-shell" style={{order:index*2+2}} key={bill.id}>
      <button type="button" className="bb-bills-row" data-predicted={Boolean(prediction)} aria-pressed={bill.id===selected?.id} data-bill-id={bill.id} data-editor-anchor={bill.id===placement.current.billId} disabled={locked} onClick={()=>choose(bill)}>
       <TransactionIcon entry={{date:bill.nextDate??'',category:bill.category==='bills_utilities'?'Bills & Utilities':bill.category==='rent'?'Rent':bill.category==='subscriptions_wants'?'Subs (Wants)':'Static Bills & Subscriptions',amount:(value??0)/100,person:ownerName,item:configured.name,location:configured.name}} aliases={aliases}/>
       <span className="bb-bills-row-text"><strong>{configured.name}</strong><small>{!configured.active?'Stopped':configured.needsSetup?'Finish setup':`${kindLabel[configured.type]} · ${configured.cadence}`}{bill.effectiveFrom>snapshot.month?` · From ${monthLabel(bill.effectiveFrom)}`:bill.nextChange?` · ${bill.nextChange.active?'Changes':'Stops'} ${monthLabel(bill.nextChange.effectiveFrom)}`:''}</small></span>
       <span className="bb-bills-row-amount">{value==null?'Amount needed':money(value)}</span><ChevronRight aria-hidden="true"/>
      </button>
      {prediction&&<BillPredictionInfo items={[{label:configured.name,prediction}]}/>}
      {known&&bill.type==='variable'&&bill.charge.status==='confirmed'&&<button type="button" className="bb-bills-scheduled-icon" aria-label={`Scheduled ${bill.name}`} title={`Amount confirmed · autopay ${bill.charge.date??'date needed'}`} disabled={locked} onClick={()=>openMonthly(bill)}><Clock3 aria-hidden="true"/></button>}
     </div>
    })}
    {!visible.length&&<p className="bb-bills-empty">No bills here yet.</p>}</div></div>
   </section>
   <BillEditorWorkspace billId={selected?.id??'new'} order={placement.current.order} isNew={placement.current.isNew} open={Boolean(form)} wide={wide} locked={busy||Boolean(pending)}>
    <EditorScenes scene={`${selected?.id??draftId.current}:${mode}`} open={Boolean(form)}>
     <>{mode==='charge'&&currentIntent?<BillCurrentCharge intent={currentIntent} ownerName={ownerName} onDone={()=>{reset();void load()}}/>:<div className="bi-editor" data-design="levels" data-operation={mode==='stop'?'delete':'update'}>
      <StepMotion review={Boolean(review)} open={Boolean(form)} mode="slide" duration={transactionMotion.duration} edit={editView} confirm={reviewView}/>
      {error&&!wide&&<p className="bs-error" role="alert">{error}</p>}
     </div>}</>
    </EditorScenes>
   </BillEditorWorkspace>
  </div>}
 </div>
}
