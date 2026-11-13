import {useCallback,useEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,ChevronDown,ChevronRight,Plus,Trash2,RefreshCw} from 'lucide-react'
import {TransactionIcon} from './daily-transactions'
import {useAppNavigation} from './app-navigation'
import {useAppWorkStatus} from './app-work-guard'
import {NotchedSplitControl,type SplitInputDraft} from './transaction-split-control'
import type {SplitMethod} from './transaction-split-model'
import {transactionMotion} from './transaction-inline-editor'
import {EditorExpansion,EditorScenes} from './transaction-editor-workspace'
import {StepMotion} from './transaction-step-motion'
import './bill-settings.css'

type Charge={available:boolean;month:string;amountCents?:number;recorded?:boolean;virtual?:boolean;date?:string|null;version?:string}
export type Bill={id:string;type:'subscription'|'variable'|'fixed';name:string;amountCents:number|null;cadence:'monthly'|'quarterly'|'yearly';pullDay:number|null;pullMonths:number[];category:string;account:string;active:boolean;effectiveFrom:string;effectiveUntil:string;splitMethod:'none'|SplitMethod;payerBasisPoints:number;version:string;nextDate:string|null;needsSetup:boolean;earliestEffectiveMonth:string;charge:Charge;nextChange?:Bill|null}
type Snapshot={month:string;today:string;settingsVersion:string;ownerName:string;partnerName:string;incomeBasisPoints:number;splitsEnabled:boolean;bills:Bill[];pendingCommand?:Command}
type Form={name:string;type:Bill['type'];amount:string;cadence:Bill['cadence'];pullDay:number;firstMonth:number;category:string;account:string;effectiveFrom:string;splitMethod:Bill['splitMethod'];payerBasisPoints:number}
type Command=Record<string,unknown>&{operation:string;requestId?:string;reviewVersion?:string}
type Review={operation:string;reviewVersion:string;name?:string;amountCents?:number;month?:string;date?:string;effectiveFrom?:string;before?:Bill|null;after?:Bill;share?:{method:string;payerName?:string;partnerName?:string;payerCents:number;partnerCents:number};replacesScheduledChanges?:boolean}
type Result={state:string;success?:boolean;detail?:string;splitPending?:boolean;transaction?:{id:string;month:string}}
type Draft={form:Form;mode:'settings'|'amount'|'stop'|'adopt';amount:string;review:Review|null;reviewBody:Command|null;splitInput:SplitInputDraft;valid:boolean;draftId:string}
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
function newForm(snapshot:Snapshot,bill?:Bill):Form{return {name:bill?.name??'',type:bill?.type??'subscription',amount:bill?.amountCents==null?'':(bill.amountCents/100).toFixed(2),cadence:bill?.cadence??'monthly',pullDay:bill?.pullDay??1,firstMonth:bill?.pullMonths[0]??Number(snapshot.month.slice(5)),category:bill?.category??'static_bills_subscriptions_needs',account:bill?.account??'',effectiveFrom:[snapshot.month,bill?.earliestEffectiveMonth??'',bill?.effectiveFrom??''].sort()[2],splitMethod:bill?.splitMethod??'none',payerBasisPoints:bill?.payerBasisPoints??snapshot.incomeBasisPoints}}

export function BillSettings({active,ownerName,aliases,onBack,onTransaction}:{active:boolean;ownerName:string;aliases?:Record<string,string>;onBack:()=>void;onTransaction:(target:{month:string;id:string})=>void}){
 const navigation=useAppNavigation(),wide=navigation?.duoLandscape===true
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[filter,setFilter]=useState('all'),[selected,setSelected]=useState<Bill|null>(null),[form,setForm]=useState<Form|null>(null)
 const [mode,setMode]=useState<'settings'|'amount'|'stop'|'adopt'>('settings'),[amount,setAmount]=useState(''),[review,setReview]=useState<Review|null>(null),[reviewBody,setReviewBody]=useState<Command|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null),[pending,setPending]=useState<Command|null>(null),[valid,setValid]=useState(true)
 const [splitInput,setSplitInput]=useState<SplitInputDraft>(null)
 const [confirmReady,setConfirmReady]=useState(false)
 const drafts=useRef(new Map<string,Draft>())
 const flight=useRef(false),alive=useRef(true),generation=useRef(0),draftId=useRef(''),abort=useRef<AbortController|null>(null)
 const placement=useRef<{order:number;isNew:boolean;billId?:string}>({order:1,isNew:true})
 const storageKey=`bookiebot:bills-request:${ownerName.toLowerCase()}`
 const reset=useCallback(()=>{drafts.current.clear();setForm(null);setSelected(null);setReview(null);setReviewBody(null);setMode('settings');setAmount('');setError('');setValid(true);setSplitInput(null);setConfirmReady(false)},[])
 const updateWork=useAppWorkStatus({label:'Bill changes',pending:busy,uncertain:Boolean(pending),dirty:Boolean(form),onDiscard:reset})
 const load=useCallback(async()=>{
  const token=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('')
  try{const next=await request('/app/bills',undefined,controller.signal) as Snapshot;if(!alive.current||token!==generation.current)return
   if(next.ownerName?.toLowerCase()!==ownerName.toLowerCase())throw new Error('Your budget profile changed. Reopen BookieBot.');
   if(!Array.isArray(next.bills)||!next.settingsVersion)throw new Error('Bills could not be read completely.')
   setSnapshot(next);if(next.pendingCommand){setPending(next.pendingCommand);try{sessionStorage.setItem(storageKey,JSON.stringify(next.pendingCommand))}catch{}}
  }catch(e){if(alive.current&&token===generation.current&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Could not load Bills.')}
  finally{if(alive.current&&token===generation.current)setBusy(false)}
 },[storageKey])
 useEffect(()=>{alive.current=true;try{const saved=sessionStorage.getItem(storageKey);if(saved)setPending(JSON.parse(saved))}catch{}return()=>{alive.current=false;++generation.current;abort.current?.abort()}},[storageKey])
 useEffect(()=>{if(active&&!snapshot&&!flight.current)void load()},[active,snapshot,load])
 const choose=(bill?:Bill)=>{
  if(busy||pending||!snapshot||form&&bill?.id===selected?.id)return
  if(form)drafts.current.set(selected?.id??'new',{form,mode,amount,review,reviewBody,splitInput,valid,draftId:draftId.current})
  const draft=drafts.current.get(bill?.id??'new')
  setSelected(bill??null);setForm(draft?.form??newForm(snapshot,bill));setMode(draft?.mode??'settings');setAmount(draft?.amount??'')
  setReview(draft?.review??null);setReviewBody(draft?.reviewBody??null);setSplitInput(draft?.splitInput??null);setValid(draft?.valid??true)
  draftId.current=draft?.draftId??crypto.randomUUID();setConfirmReady(false);setError('');setResult(null)
 }
 // Confirmation is a separate action after the review's native slide settles.
 useEffect(()=>{setConfirmReady(false);if(!review)return;const timer=window.setTimeout(()=>setConfirmReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review,selected?.id])
 const change=(patch:Partial<Form>)=>{setForm(previous=>previous?{...previous,...patch}:null);setReview(null);setReviewBody(null);setError('')}
 const prepare=async(operation=mode==='settings'?(selected?'update':'create'):mode==='stop'?'delete':mode)=>{
  if(flight.current||pending||!form||!snapshot)return
  flight.current=true;setBusy(true);setConfirmReady(false);setError('');setResult(null)
  const base:Command={operation,settingsVersion:snapshot.settingsVersion,...(selected?{id:selected.id,version:selected.version}:{draftId:draftId.current})}
  let body:Command
  if(operation==='amount'||operation==='adopt')body={operation,id:selected?.id,month:snapshot.month,settingsVersion:snapshot.settingsVersion,chargeVersion:selected?.charge.version,...(operation==='amount'?{amount}: {})}
  else if(operation==='delete')body={...base,effectiveFrom:form.effectiveFrom}
  else{const {firstMonth,...fields}=form;body={...base,bill:{...fields,pullMonths:form.cadence==='monthly'?[]:form.cadence==='yearly'?[firstMonth]:[0,3,6,9].map(n=>(firstMonth-1+n)%12+1).sort((a,b)=>a-b)}}}
  try{const next=await request('/app/bills/review',body);if(alive.current){setReview(next.review);setReviewBody(body)}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not review bill.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const accept=async(next:Result)=>{
  setResult(next)
  if(next.state==='done'){setPending(null);try{sessionStorage.removeItem(storageKey)}catch{}
   reset();if(next.success){window.dispatchEvent(new Event('bookiebot:transactions-changed'));window.dispatchEvent(new Event('bookiebot:reimbursements-changed'))}await load()
  }
 }
 const save=async()=>{
  if(flight.current||pending||!review||!reviewBody||!confirmReady)return
  const command={...reviewBody,requestId:crypto.randomUUID(),reviewVersion:review.reviewVersion}
  try{sessionStorage.setItem(storageKey,JSON.stringify(command))}catch{setError('Keep this screen open until the save is verified.')}
  flight.current=true;setBusy(true);setPending(command);updateWork({label:'Bill changes',pending:true,uncertain:true})
  try{await accept(await request('/app/bills',command))}catch(e){if(alive.current){if(e instanceof BillRequestError&&[400,403,409].includes(e.status))await accept({state:'done',success:false,detail:e.message});else{if(e instanceof BillRequestError&&e.status===401){reset();setSnapshot(null)}setResult({state:'uncertain',detail:e instanceof Error?e.message:'Check saved status.'})}}}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const checkSaved=async(retry=false)=>{if(flight.current||!pending?.requestId)return;flight.current=true;setBusy(true);setError('');try{await accept(await request(retry?'/app/bills':`/app/bills/commands/${encodeURIComponent(pending.requestId)}`,retry?pending:undefined))}catch(e){setError(e instanceof Error?e.message:'Could not check saved status.')}finally{flight.current=false;setBusy(false)}}
 const openCharge=async()=>{if(!selected||!snapshot||flight.current||pending)return;flight.current=true;setBusy(true);setError('');try{const value=await request(`/app/bills/${encodeURIComponent(selected.id)}/charge?month=${snapshot.month}`);reset();onTransaction(value.transaction)}catch(e){setError(e instanceof Error?e.message:'Could not open charge.')}finally{flight.current=false;setBusy(false)}}
 const selectedIncome=form?.splitMethod==='income'?snapshot?.incomeBasisPoints??5000:form?.splitMethod==='equal'?5000:form?.splitMethod==='fronted'?0:form?.payerBasisPoints??10000
 const visible=snapshot?.bills.filter(b=>filter==='all'||b.type===filter)??[]
 // Keep the editor's row anchor through its closing expansion. Folding changes
 // only the grid placement, never the mounted scenes or controlled draft.
 if(form)placement.current={order:selected?visible.findIndex(bill=>bill.id===selected.id)*2+3:1,isNew:!selected,billId:selected?.id}
 const locked=busy||Boolean(pending),lastReview=useRef<Review|null>(null)
 if(review)lastReview.current=review
 const shownReview=review??lastReview.current
 const splitLabel=(bill:Bill)=>bill.splitMethod==='none'?'No split':bill.splitMethod==='income'?'By income':bill.splitMethod==='equal'?'50 / 50':bill.splitMethod==='fronted'?`100% ${snapshot?.partnerName}`:`${(bill.payerBasisPoints/100).toFixed(2)}% ${snapshot?.ownerName}`
 const reviewLines=shownReview?.after?[
  {label:shownReview.after.type==='variable'?'Estimate':'Amount',before:shownReview.before?money(shownReview.before.amountCents):null,after:money(shownReview.after.amountCents)},
  {label:'Repeats',before:shownReview.before?`${shownReview.before.cadence} · day ${shownReview.before.pullDay}`:null,after:`${shownReview.after.cadence} · day ${shownReview.after.pullDay}`},
  {label:shownReview.operation==='delete'?'Stops':'Starts',before:null,after:monthLabel(shownReview.effectiveFrom!)},
  {label:'Split new charges',before:shownReview.before?splitLabel(shownReview.before):null,after:splitLabel(shownReview.after)},
 ]:shownReview?.share&&shownReview.share.method!=='none'?[
  {label:snapshot?.ownerName??'',before:null,after:money(shownReview.share.payerCents)},
  {label:snapshot?.partnerName??'',before:null,after:money(shownReview.share.partnerCents)},
 ]:[]
 const heading=mode==='amount'?'Monthly amount':mode==='adopt'?'Recorded charge':mode==='stop'?'Stop bill':selected?(selected.active?'Edit bill':'Restart bill'):'New bill'
 const editView=form&&snapshot&&<>
  <header className="sp-flow-heading bb-bill-heading"><h2>{heading}</h2>{selected&&<p className="sp-flow-context">{selected.name}<span className="bb-bills-wide-month"> · {monthLabel(snapshot.month)}</span></p>}</header>
  <form className="bi-fields bb-bills-form" data-editor-mode={mode} onSubmit={e=>{e.preventDefault();void prepare()}}>
   {mode==='amount'||mode==='adopt'?<>
    {mode==='amount'?<label>Amount paid<span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label="Amount paid" inputMode="decimal" required value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></span></label>:<p className="bi-footnote">Open this {money(selected?.amountCents)} charge in the existing transaction editor.</p>}
   </>:<>
    {selected&&mode==='settings'&&<div className="bb-bills-charge-actions">
     <span className="bi-footnote">{monthLabel(snapshot.month)}</span>
     {selected.active&&selected.charge.available&&selected.type==='variable'&&!selected.charge.recorded&&!selected.charge.amountCents&&<button type="button" className="bb-settings-action" aria-label="Enter monthly amount" disabled={locked} onClick={()=>{setMode('amount');setAmount('')}}><span className="bb-bills-full-label">Enter monthly amount</span><span className="bb-bills-short-label" aria-hidden="true">Monthly amount</span><ChevronRight aria-hidden="true"/></button>}
     {(selected.charge.recorded||Boolean(selected.charge.amountCents))&&<button type="button" className="bb-settings-action" aria-label="Edit this charge / split" disabled={locked} onClick={()=>void openCharge()}><span className="bb-bills-full-label">Edit this charge / split</span><span className="bb-bills-short-label" aria-hidden="true">Charge / split</span><ChevronRight aria-hidden="true"/></button>}
     {selected.charge.virtual&&selected.charge.date&&selected.charge.date<=snapshot.today&&<button type="button" className="bb-settings-action" aria-label="Edit this charge / split" disabled={locked} onClick={()=>setMode('adopt')}><span className="bb-bills-full-label">Edit this charge / split</span><span className="bb-bills-short-label" aria-hidden="true">Charge / split</span><ChevronRight aria-hidden="true"/></button>}
     {selected.active&&<button type="button" className="bb-bills-stop" aria-label="Stop bill" title="Stop bill" disabled={locked} onClick={()=>setMode('stop')}><Trash2 aria-hidden="true"/><span className="bb-bills-full-label">Stop bill</span></button>}
    </div>}
    {mode==='stop'?<p className="bi-footnote">Earlier months stay unchanged.</p>:<>
     <label data-bill-field="name">Name<input className="bb-bills-input" required maxLength={100} value={form.name} onChange={e=>change({name:e.target.value})}/></label>
     <div className="bi-secondary-fields">
      <label data-bill-field="type">Type<span className="bi-select"><select aria-label="Type" value={form.type} onChange={e=>change({type:e.target.value as Form['type'],category:e.target.value==='subscription'?'static_bills_subscriptions_needs':'bills_utilities',cadence:e.target.value==='subscription'&&form.cadence==='quarterly'?'monthly':form.cadence})}><option value="subscription">Subscription</option><option value="variable">Variable bill</option><option value="fixed">Fixed bill</option></select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="amount"><span className="bb-bills-full-label">{form.type==='variable'?'Estimate (optional)':'Amount'}</span><span className="bb-bills-short-label" aria-hidden="true">{form.type==='variable'?'Estimate':'Amount'}</span><span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label={form.type==='variable'?'Estimate (optional)':'Amount'} required={form.type!=='variable'} inputMode="decimal" placeholder="0.00" value={form.amount} onChange={e=>change({amount:e.target.value})}/></span></label>
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
    <label data-bill-field="starting-month">{mode==='stop'?'Stop from':'Starting month'}<input className="bb-bills-input" type="month" required min={selected?.earliestEffectiveMonth??snapshot.month} value={form.effectiveFrom} onChange={e=>change({effectiveFrom:e.target.value})}/></label>
    {mode!=='stop'&&<>
     <label className="bb-bills-toggle" data-bill-field="split"><span>Split new charges</span><input type="checkbox" checked={form.splitMethod!=='none'} disabled={!snapshot.splitsEnabled&&form.splitMethod==='none'} onChange={e=>{setSplitInput(null);setValid(true);change({splitMethod:e.target.checked?'income':'none',payerBasisPoints:snapshot.incomeBasisPoints})}}/></label>
     {form.splitMethod!=='none'&&<div className="sp-management"><NotchedSplitControl unit="percent" inputDraft={splitInput} onInputDraft={setSplitInput} total={10000} payerCents={selectedIncome} method={form.splitMethod} incomeBasis={snapshot.incomeBasisPoints} capture={6} payerName={snapshot.ownerName} partnerName={snapshot.partnerName} disabled={locked} onChange={(payerBasisPoints,splitMethod)=>change({payerBasisPoints,splitMethod})} onValidityChange={setValid}/></div>}
    </>}
   </>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={mode==='settings'?reset:()=>setMode('settings')}>Cancel</button><button className="bi-primary" type="submit" disabled={locked||(mode==='settings'&&!valid)}>{busy?'Preparing…':'Review'}</button></footer>
  </form>
 </>
 const reviewView=shownReview&&<>
  <header className="sp-flow-heading bb-bill-heading"><h2>{shownReview.operation==='delete'?'Stop bill':shownReview.operation==='adopt'?'Edit recorded charge':shownReview.operation==='amount'?'Record amount':'Review bill'}</h2><p className="sp-flow-context bb-bills-review-context"><span title={shownReview.after?.name??shownReview.name??selected?.name}>{shownReview.after?.name??shownReview.name??selected?.name}</span>{shownReview.after&&<span> · {kindLabel[shownReview.after.type]}</span>}</p></header>
  {!shownReview.after&&<p className="bb-bills-review-amount">{money(shownReview.amountCents)}</p>}
  <dl className="bi-review-changes" aria-label="Bill changes to review">{reviewLines.map(line=><div className="bi-review-change" key={line.label}><dt>{line.label}</dt><dd>{line.before!==null&&line.before!==line.after&&<><del>{line.before}</del><span className="bi-review-new"><ArrowRight aria-hidden="true"/><span>{line.after}</span></span></>}{(line.before===null||line.before===line.after)&&<span className="bi-review-new">{line.after}</span>}</dd></div>)}</dl>
  {shownReview.after&&<p className="bi-footnote">Earlier months and existing splits stay unchanged.</p>}
  {shownReview.replacesScheduledChanges&&<p className="bi-footnote">Replaces later scheduled changes for this bill.</p>}
  {shownReview.operation==='adopt'&&<p className="bi-footnote">Makes this charge editable in Transactions. The purchase total stays unchanged.</p>}
  <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={()=>{setReview(null);setReviewBody(null)}}><ArrowLeft aria-hidden="true"/>Back</button><button type="button" className="bi-primary" disabled={locked||!review||!confirmReady} onClick={()=>void save()}>{busy?'Saving…':shownReview.operation==='delete'?'Stop bill':shownReview.operation==='amount'?'Record amount':'Confirm'}</button></footer>
 </>
 return <div className="bb-bills bi-product" data-tone="sage" data-wide={wide} aria-busy={busy}>
  <div className="bb-settings-heading"><button className="bb-settings-back" type="button" disabled={locked} onClick={()=>{reset();onBack()}}><ArrowLeft aria-hidden="true"/>Settings</button><h1>Bills</h1><button type="button" className="bb-bills-refresh" aria-label="Refresh bills" disabled={locked||Boolean(form)} onClick={()=>{setResult(null);void load()}}><RefreshCw aria-hidden="true"/></button></div>
  <div className="bb-bills-notices">
  {error&&(!form||wide)&&<p className="bb-bills-error" role="alert">{error}</p>}
  {result?.detail&&<p role="status" className="bb-bills-status">{result.detail}</p>}
  {pending&&<div className="bb-bills-recovery"><p role="status">Check the saved status before making another change.</p><button className="bb-bills-primary" type="button" disabled={busy} onClick={()=>void checkSaved()}>Check saved status</button><button type="button" className="bb-settings-action" disabled={busy} onClick={()=>void checkSaved(true)}>Retry same confirmation</button></div>}
  {!snapshot&&busy&&<p role="status" className="bb-bills-empty">Loading bills…</p>}
  {!snapshot&&!busy&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Reload Bills</button>}
  </div>
  {snapshot&&<div className="bb-bills-panes">
   <section className="bb-bills-list" aria-label="Your bills">
    <div className="bb-bills-toolbar"><select aria-label="Bill type" disabled={locked||Boolean(form)} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All bills</option><option value="subscription">Subscriptions</option><option value="variable">Variable bills</option><option value="fixed">Fixed bills</option></select><button type="button" className="bb-bills-add" disabled={locked||Boolean(form)} onClick={()=>choose()}><Plus aria-hidden="true"/>Add bill</button></div>
    <div className="bb-bills-rows">{visible.map((bill,index)=><button style={{order:index*2+2}} type="button" className="bb-bills-row" aria-pressed={bill.id===selected?.id} data-editor-anchor={bill.id===placement.current.billId} disabled={locked||Boolean(form)&&!wide} key={bill.id} onClick={()=>choose(bill)}><TransactionIcon entry={{date:bill.nextDate??'',category:bill.category==='bills_utilities'?'Bills & Utilities':bill.category==='rent'?'Rent':bill.category==='subscriptions_wants'?'Subs (Wants)':'Static Bills & Subscriptions',amount:(bill.amountCents??0)/100,person:ownerName,item:bill.name,location:bill.name}} aliases={aliases}/><span className="bb-bills-row-text"><strong>{bill.name}</strong><small>{!bill.active?'Stopped':bill.needsSetup?'Finish setup':`${kindLabel[bill.type]} · ${bill.cadence}`}{bill.effectiveFrom>snapshot.month?` · From ${monthLabel(bill.effectiveFrom)}`:bill.nextChange?` · ${bill.nextChange.active?'Changes':'Stops'} ${monthLabel(bill.nextChange.effectiveFrom)}`:''}</small></span><span className="bb-bills-row-amount">{bill.type==='variable'&&bill.charge.recorded?money(bill.charge.amountCents):bill.amountCents===null?'Enter amount':money(bill.amountCents)}{bill.type==='variable'&&(bill.charge.recorded||bill.amountCents!==null)&&<small>{bill.charge.recorded?'this month':'estimate'}</small>}</span><ChevronRight aria-hidden="true"/></button>)}
    {!visible.length&&<p className="bb-bills-empty">No bills here yet.</p>}</div>
   </section>
   <section className="bb-bills-editor" aria-label="Bill editor" data-new={placement.current.isNew} data-open={Boolean(form)} inert={locked} style={{order:placement.current.order}}>
    <EditorExpansion open={Boolean(form)}><EditorScenes scene={`${selected?.id??draftId.current}:${mode}`} open={Boolean(form)}>
     <div className="bi-editor" data-design="levels" data-operation={mode==='stop'?'delete':'update'}>
      <StepMotion review={Boolean(review)} open={Boolean(form)} mode="slide" duration={transactionMotion.duration} edit={editView} confirm={reviewView}/>
      {error&&!wide&&<p className="bs-error" role="alert">{error}</p>}
     </div>
    </EditorScenes></EditorExpansion>
    {!form&&<p className="bb-bills-empty">Choose a bill to manage it.</p>}
   </section>
  </div>}
 </div>
}
