import {useCallback,useEffect,useRef,useState} from 'react'
import {ArrowLeft,ChevronRight,Plus,ReceiptText,Trash2,RefreshCw} from 'lucide-react'
import {useAppNavigation} from './app-navigation'
import {useAppWorkStatus} from './app-work-guard'
import {NotchedSplitControl} from './transaction-split-control'
import type {SplitMethod} from './transaction-split-model'
import './bill-settings.css'

type Charge={available:boolean;month:string;amountCents?:number;recorded?:boolean;virtual?:boolean;date?:string|null;version?:string}
export type Bill={id:string;type:'subscription'|'variable'|'fixed';name:string;amountCents:number|null;cadence:'monthly'|'quarterly'|'yearly';pullDay:number|null;pullMonths:number[];category:string;account:string;active:boolean;effectiveFrom:string;effectiveUntil:string;splitMethod:'none'|SplitMethod;payerBasisPoints:number;version:string;nextDate:string|null;needsSetup:boolean;earliestEffectiveMonth:string;charge:Charge;nextChange?:Bill|null}
type Snapshot={month:string;today:string;settingsVersion:string;ownerName:string;partnerName:string;incomeBasisPoints:number;splitsEnabled:boolean;bills:Bill[];pendingCommand?:Command}
type Form={name:string;type:Bill['type'];amount:string;cadence:Bill['cadence'];pullDay:number;firstMonth:number;category:string;account:string;effectiveFrom:string;splitMethod:Bill['splitMethod'];payerBasisPoints:number}
type Command=Record<string,unknown>&{operation:string;requestId?:string;reviewVersion?:string}
type Review={operation:string;reviewVersion:string;name?:string;amountCents?:number;month?:string;date?:string;effectiveFrom?:string;before?:Bill|null;after?:Bill;share?:{method:string;payerName?:string;partnerName?:string;payerCents:number;partnerCents:number};replacesScheduledChanges?:boolean}
type Result={state:string;success?:boolean;detail?:string;splitPending?:boolean;transaction?:{id:string;month:string}}
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

export function BillSettings({active,ownerName,onBack,onTransaction}:{active:boolean;ownerName:string;onBack:()=>void;onTransaction:(target:{month:string;id:string})=>void}){
 const navigation=useAppNavigation(),wide=navigation?.duoLandscape===true
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[filter,setFilter]=useState('all'),[selected,setSelected]=useState<Bill|null>(null),[form,setForm]=useState<Form|null>(null)
 const [mode,setMode]=useState<'settings'|'amount'|'stop'|'adopt'>('settings'),[amount,setAmount]=useState(''),[review,setReview]=useState<Review|null>(null),[reviewBody,setReviewBody]=useState<Command|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null),[pending,setPending]=useState<Command|null>(null),[valid,setValid]=useState(true)
 const flight=useRef(false),alive=useRef(true),generation=useRef(0),draftId=useRef(''),abort=useRef<AbortController|null>(null)
 const storageKey=`bookiebot:bills-request:${ownerName.toLowerCase()}`
 const reset=useCallback(()=>{setForm(null);setSelected(null);setReview(null);setReviewBody(null);setMode('settings');setAmount('');setError('');setValid(true)},[])
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
 const choose=(bill?:Bill)=>{if(busy||pending||!snapshot)return;reset();setSelected(bill??null);setForm(newForm(snapshot,bill));draftId.current=crypto.randomUUID();setResult(null)}
 const change=(patch:Partial<Form>)=>{setForm(previous=>previous?{...previous,...patch}:null);setReview(null);setReviewBody(null);setError('')}
 const prepare=async(operation=mode==='settings'?(selected?'update':'create'):mode==='stop'?'delete':mode)=>{
  if(flight.current||pending||!form||!snapshot)return
  flight.current=true;setBusy(true);setError('');setResult(null)
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
  if(flight.current||pending||!review||!reviewBody)return
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
 return <div className="bb-bills" data-wide={wide} aria-busy={busy}>
  <div className="bb-settings-heading"><button className="bb-settings-back" type="button" disabled={busy||Boolean(pending)} onClick={()=>{reset();onBack()}}><ArrowLeft aria-hidden="true"/>Settings</button><h1>Bills</h1><button type="button" className="bb-bills-refresh" aria-label="Refresh bills" disabled={busy||Boolean(form)||Boolean(pending)} onClick={()=>{setResult(null);void load()}}><RefreshCw aria-hidden="true"/></button></div>
  {error&&<p className="bb-bills-error" role="alert">{error}</p>}
  {result?.detail&&<p role="status" className="bb-bills-status">{result.detail}</p>}
  {pending&&<div className="bb-bills-recovery"><p role="status">Check the saved status before making another change.</p><button className="bb-bills-primary" type="button" disabled={busy} onClick={()=>void checkSaved()}>Check saved status</button><button type="button" className="bb-settings-action" disabled={busy} onClick={()=>void checkSaved(true)}>Retry same confirmation</button></div>}
  {!snapshot&&busy&&<p role="status" className="bb-bills-empty">Loading bills…</p>}
  {!snapshot&&!busy&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Reload Bills</button>}
  {snapshot&&<div className="bb-bills-panes">
   <section className="bb-bills-list" aria-label="Your bills">
    <div className="bb-bills-toolbar"><select aria-label="Bill type" disabled={busy||Boolean(form)||Boolean(pending)} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All bills</option><option value="subscription">Subscriptions</option><option value="variable">Variable bills</option><option value="fixed">Fixed bills</option></select><button type="button" className="bb-bills-add" disabled={busy||Boolean(pending)||Boolean(form)} onClick={()=>choose()}><Plus aria-hidden="true"/>Add bill</button></div>
    {visible.map((bill,index)=><button style={{order:index*2+2}} type="button" className="bb-bills-row" aria-pressed={bill.id===selected?.id} disabled={busy||Boolean(pending)||Boolean(form)} key={bill.id} onClick={()=>choose(bill)}><ReceiptText aria-hidden="true"/><span className="bb-bills-row-text"><strong>{bill.name}</strong><small>{!bill.active?'Stopped':bill.needsSetup?'Finish setup':`${kindLabel[bill.type]} · ${bill.cadence}`}{bill.effectiveFrom>snapshot.month?` · From ${monthLabel(bill.effectiveFrom)}`:bill.nextChange?` · ${bill.nextChange.active?'Changes':'Stops'} ${monthLabel(bill.nextChange.effectiveFrom)}`:''}</small></span><span className="bb-bills-row-amount">{bill.type==='variable'&&bill.charge.recorded?money(bill.charge.amountCents):bill.amountCents===null?'Enter amount':money(bill.amountCents)}{bill.type==='variable'&&(bill.charge.recorded||bill.amountCents!==null)&&<small>{bill.charge.recorded?'this month':'estimate'}</small>}</span><ChevronRight aria-hidden="true"/></button>)}
    {!visible.length&&<p className="bb-bills-empty">No bills here yet.</p>}
   </section>
   <section className="bb-bills-editor" aria-label="Bill editor" inert={busy||Boolean(pending)} style={{order:selected?visible.findIndex(bill=>bill.id===selected.id)*2+3:1}}>
   {!form?<p className="bb-bills-empty">Choose a bill to manage it.</p>:review?<div className="bb-bills-review"><h2>{review.operation==='delete'?'Stop bill':review.operation==='adopt'?'Edit recorded charge':review.operation==='amount'?'Record amount':'Review bill'}</h2>
    <h3>{review.after?.name??review.name??selected?.name}</h3>
    {review.after?<><div className="bb-bills-summary"><strong>{review.after.type==='variable'?'Estimate':'Amount'}</strong><span>{money(review.after.amountCents)}</span><strong>Repeats</strong><span>{review.after.cadence} · day {review.after.pullDay}</span><strong>Starts</strong><span>{monthLabel(review.effectiveFrom!)}</span><strong>Split new charges</strong><span>{review.after.splitMethod==='none'?'No split':review.after.splitMethod==='income'?'By income':review.after.splitMethod==='equal'?'50 / 50':review.after.splitMethod==='fronted'?`100% ${snapshot.partnerName}`:`${(review.after.payerBasisPoints/100).toFixed(2)}% ${snapshot.ownerName}`}</span></div><p className="bb-bills-note">Earlier months and existing splits stay unchanged.</p>{review.replacesScheduledChanges&&<p className="bb-bills-note">Replaces later scheduled changes for this bill.</p>}</>:<><p className="bb-bills-review-amount">{money(review.amountCents)}</p>{review.share&&review.share.method!=='none'&&<div className="bb-bills-summary"><strong>{snapshot.ownerName}</strong><span>{money(review.share.payerCents)}</span><strong>{snapshot.partnerName}</strong><span>{money(review.share.partnerCents)}</span></div>}{review.operation==='adopt'&&<p className="bb-bills-note">Makes this charge editable in Transactions. The purchase total stays unchanged.</p>}</>}
    <div className="bb-bills-actions"><button type="button" disabled={busy||Boolean(pending)} onClick={()=>{setReview(null);setReviewBody(null)}}>Back</button><button type="button" className="bb-bills-primary" disabled={busy||Boolean(pending)} onClick={()=>void save()}>{busy?'Saving…':review.operation==='delete'?'Stop bill':review.operation==='amount'?'Record amount':'Confirm'}</button></div>
   </div>:mode==='amount'||mode==='adopt'?<form onSubmit={e=>{e.preventDefault();void prepare()}}><h2>{mode==='amount'?'Monthly amount':'Recorded charge'}</h2><h3>{selected?.name}</h3>{mode==='amount'?<label>Amount paid<input className="bb-bills-input" autoFocus inputMode="decimal" required value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label>:<p className="bb-bills-note">Open this {money(selected?.amountCents)} charge in the existing transaction editor.</p>}<div className="bb-bills-actions"><button type="button" disabled={busy} onClick={()=>setMode('settings')}>Cancel</button><button className="bb-bills-primary" type="submit" disabled={busy||Boolean(pending)}>{busy?'Preparing…':'Review'}</button></div></form>:<form onSubmit={e=>{e.preventDefault();void prepare()}}>
    <h2>{mode==='stop'?'Stop bill':selected?(selected.active?'Edit bill':'Restart bill'):'New bill'}</h2>
    {selected&&mode==='settings'&&<div className="bb-bills-charge-actions"><h3>{monthLabel(snapshot.month)}</h3>{selected.active&&selected.charge.available&&selected.type==='variable'&&!selected.charge.recorded&&!selected.charge.amountCents&&<button type="button" className="bb-settings-action" disabled={busy||Boolean(pending)} onClick={()=>{setMode('amount');setAmount('')}}>Enter monthly amount</button>}
     {(selected.charge.recorded||Boolean(selected.charge.amountCents))&&<button type="button" className="bb-settings-action" disabled={busy||Boolean(pending)} onClick={()=>void openCharge()}>Edit this charge / split<ChevronRight aria-hidden="true"/></button>}
     {selected.charge.virtual&&selected.charge.date&&selected.charge.date<=snapshot.today&&<button type="button" className="bb-settings-action" disabled={busy||Boolean(pending)} onClick={()=>setMode('adopt')}>Edit this charge / split<ChevronRight aria-hidden="true"/></button>}
     {selected.active&&<button type="button" className="bb-bills-stop" disabled={busy||Boolean(pending)} onClick={()=>setMode('stop')}><Trash2 aria-hidden="true"/>Stop bill</button>}
    </div>}
    {mode==='stop'?<p>{selected?.name}</p>:<>
     <label>Name<input className="bb-bills-input" required maxLength={100} value={form.name} onChange={e=>change({name:e.target.value})}/></label>
     <div className="bb-bills-fields"><label>Type<select aria-label="Type" value={form.type} disabled={Boolean(selected)} onChange={e=>change({type:e.target.value as Form['type'],category:e.target.value==='subscription'?'static_bills_subscriptions_needs':'bills_utilities'})}><option value="subscription">Subscription</option><option value="variable">Variable bill</option><option value="fixed">Fixed bill</option></select></label><label>{form.type==='variable'?'Estimate (optional)':'Amount'}<input className="bb-bills-input" required={form.type!=='variable'} inputMode="decimal" placeholder="0.00" value={form.amount} onChange={e=>change({amount:e.target.value})}/></label></div>
     <div className="bb-bills-fields"><label>Repeats<select aria-label="Repeats" value={form.cadence} onChange={e=>change({cadence:e.target.value as Form['cadence']})}><option value="monthly">Monthly</option>{form.type!=='subscription'&&<option value="quarterly">Quarterly</option>}<option value="yearly">Yearly</option></select></label><label>Payment day<input className="bb-bills-input" type="number" min={1} max={31} required value={form.pullDay} onChange={e=>change({pullDay:Number(e.target.value)})}/></label></div>
     {form.cadence!=='monthly'&&<label>{form.cadence==='yearly'?'Billing month':'First billing month'}<select aria-label={form.cadence==='yearly'?'Billing month':'First billing month'} value={form.firstMonth} onChange={e=>change({firstMonth:Number(e.target.value)})}>{Array.from({length:12},(_,i)=><option value={i+1} key={i}>{new Date(2026,i,1).toLocaleDateString('en-US',{month:'long'})}</option>)}</select></label>}
     <div className="bb-bills-fields"><label>Budget category<select aria-label="Budget category" value={form.category} onChange={e=>change({category:e.target.value})}>{Object.entries(categoryLabels).filter(([key])=>form.type==='subscription'||key!=='subscriptions_wants').map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><label>Account<input className="bb-bills-input" maxLength={80} value={form.account} placeholder="Optional" onChange={e=>change({account:e.target.value})}/></label></div>
    </>}
    <label>{mode==='stop'?'Stop from':'Starting month'}<input className="bb-bills-input" type="month" required min={selected?.earliestEffectiveMonth??snapshot.month} value={form.effectiveFrom} onChange={e=>change({effectiveFrom:e.target.value})}/></label>
    {mode!=='stop'&&<><label className="bb-bills-toggle"><span>Split new charges</span><input className="bb-bills-input" type="checkbox" checked={form.splitMethod!=='none'} disabled={!snapshot.splitsEnabled&&form.splitMethod==='none'} onChange={e=>change({splitMethod:e.target.checked?'income':'none',payerBasisPoints:snapshot.incomeBasisPoints})}/></label>
     {form.splitMethod!=='none'&&<div className="bi-product"><div className="bi-editor bi-editor-embedded sp-management"><NotchedSplitControl unit="percent" total={10000} payerCents={selectedIncome} method={form.splitMethod} incomeBasis={snapshot.incomeBasisPoints} capture={6} payerName={snapshot.ownerName} partnerName={snapshot.partnerName} disabled={busy} onChange={(payerBasisPoints,splitMethod)=>change({payerBasisPoints,splitMethod})} onValidityChange={setValid}/></div></div>}
    </>}
    <div className="bb-bills-actions"><button type="button" disabled={busy||Boolean(pending)} onClick={mode==='stop'?()=>setMode('settings'):reset}>Cancel</button><button className="bb-bills-primary" type="submit" disabled={busy||Boolean(pending)||!valid}>{busy?'Preparing…':'Review'}</button></div>

   </form>}
   </section>
  </div>}
 </div>
}
