import {useCallback,useEffect,useRef,useState} from 'react'
import {InlineTransactionEditor,transactionMotion,type InlineSnapshot} from './transaction-inline-editor'
import type {RecordedTransaction} from './transactions-screen'
import type {TransactionChangeSummary,TransactionOperation} from './transaction-change-summary'
import {allocate,type SplitMethod} from './transaction-split-model'
import type {SplitInputDraft} from './transaction-split-control'
import {useAppWorkStatus} from './app-work-guard'

export type CurrentBillIntent={id:string;month:string;name:string;amountCents:number|null;method:'none'|SplitMethod;basis:number;requestId?:string;stage?:'configuration'|'adopt'|'charge';needsAdoption?:boolean}
type Command={operation:TransactionOperation;id:string;month:string;version:string;updates?:{amount:number};method?:SplitMethod;payerShareCents?:number;requestId?:string;reviewVersion?:string}
type Checked={reviewVersion:string;operation:TransactionOperation;after:Record<string,string>;share?:TransactionChangeSummary['share']}
type Result={state:string;success?:boolean;detail?:string}
class RequestError extends Error{constructor(message:string,readonly status:number){super(message)}}
async function billRequest(path:string,body?:unknown){
 const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),30_000)
 try{const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',mode:'same-origin',referrerPolicy:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:body?JSON.stringify(body):undefined,signal:controller.signal});const value=await response.json();if(!response.ok)throw new RequestError(value.error||'Could not load this charge.',response.status);return value}finally{window.clearTimeout(timer)}
}

// A follow-up is an individually reviewed canonical transaction change, never
// a second schedule write. Its original request ID owns uncertainty/recovery.
export function BillCurrentCharge({intent,ownerName,onDone}:{intent:CurrentBillIntent;ownerName:string;onDone:()=>void}){
 const [row,setRow]=useState<RecordedTransaction|null>(null),[operation,setOperation]=useState<TransactionOperation>('update')
 const [draft,setDraft]=useState(''),[method,setMethod]=useState<SplitMethod>(intent.method==='none'?'income':intent.method),[payerCents,setPayerCents]=useState(0),[splitInput,setSplitInput]=useState<SplitInputDraft>(null)
 const [valid,setValid]=useState(true),[review,setReview]=useState<Checked|null>(null),[reviewBody,setReviewBody]=useState<Command|null>(null),[pending,setPending]=useState<Command|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[ready,setReady]=useState(false),[finished,setFinished]=useState(false)
 const flight=useRef(false),alive=useRef(true),completed=useRef(new Set<TransactionOperation>())
 const storageKey=`bookiebot:transaction-request:${ownerName}`
 useAppWorkStatus({label:'This month’s bill',pending:busy,uncertain:Boolean(pending),dirty:!finished,onDiscard:onDone})
 const load=useCallback(async()=>{
  if(flight.current)return;flight.current=true;setBusy(true);setError('');setReview(null);setReviewBody(null)
  try{
   const value=await billRequest(`/app/bills/${encodeURIComponent(intent.id)}/charge?month=${intent.month}`),next=value.item as RecordedTransaction
   if(!alive.current)return
   if(!next||next.month!==intent.month||!next.version)throw new Error('The recorded charge could not be read. Reload Bills before trying again.')
   setRow(next)
   const amountChange=intent.amountCents!==null&&intent.amountCents!==next.amountCents&&!completed.current.has('update')
   const targetShare=intent.method==='income'?(next.splitOptions?.incomePayerCents??allocate(next.amountCents,intent.basis)):allocate(next.amountCents,intent.method==='none'?10000:intent.method==='equal'?5000:intent.method==='fronted'?0:intent.basis)
   const splitChange=!completed.current.has('split')&&!completed.current.has('cancel_split')&&((intent.method==='none'?'':intent.method)!==next.split||intent.method!=='none'&&next.splitOptions?.payerCents!==undefined&&targetShare!==next.splitOptions.payerCents)
   const action=amountChange?'update':splitChange?(intent.method==='none'?'cancel_split':'split'):null
   if(!action){setFinished(true);return}
   setOperation(action);setDraft(((intent.amountCents??next.amountCents)/100).toFixed(2))
   const wanted=intent.method==='none'?'income':intent.method;setMethod(wanted);setPayerCents(targetShare);setSplitInput(null);setValid(true)
   if(!next.capabilities[action])setError(next.reasons[action]||'This charge needs to be reviewed in Transactions. Its recorded amount and repayments have been preserved.')
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not load this charge.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 },[intent])
 useEffect(()=>{alive.current=true;let recovery:Command|null=null;try{const saved=sessionStorage.getItem(storageKey);if(saved)recovery=JSON.parse(saved)}catch{}
  if(recovery){setPending(recovery);setError('Check the saved transaction status before continuing.')}else void load()
  return()=>{alive.current=false}
 },[load,storageKey])
 useEffect(()=>{setReady(false);if(!review)return;const timer=window.setTimeout(()=>setReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review])
 const prepare=async()=>{
  if(flight.current||pending||!row||!row.capabilities[operation])return
  const cents=/^\d+(?:\.\d{1,2})?$/.test(draft)?Math.round(Number(draft)*100):0
  if(operation==='update'&&(!Number.isSafeInteger(cents)||cents<=0||cents===row.amountCents)){setError('Enter a positive amount.');return}
  const body:Command={id:row.id,month:row.month,version:row.version,operation,...(operation==='update'?{updates:{amount:cents}}:operation==='split'?{method,...(method==='custom'?{payerShareCents:payerCents}:{})}:{})}
  flight.current=true;setBusy(true);setError('')
  try{const value=await billRequest('/app/transactions/review',body);if(alive.current){setReview(value.review);setReviewBody(body)}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not review this charge.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const accept=async(result:Result,command:Command)=>{
  if(result.state!=='done'){setError(result.detail||'Check saved status before another change.');return}
  setPending(null);sessionStorage.removeItem(storageKey)
  window.dispatchEvent(new Event('bookiebot:reimbursements-changed'))
  if(!result.success){setError(result.detail||'The charge was not changed.');return}
  completed.current.add(command.operation)
  window.dispatchEvent(new Event('bookiebot:transactions-changed'))
  setRow(null);setReview(null);setReviewBody(null)
  // Release only the local in-flight flag; the completed owner claim remains
  // durable. Re-read canonical cash/shares before reviewing the next operation.
  flight.current=false;await load()
 }
 const save=async()=>{
  if(flight.current||pending||!review||!reviewBody||!ready)return
  const command={...reviewBody,reviewVersion:review.reviewVersion,requestId:crypto.randomUUID()}
  try{sessionStorage.setItem(storageKey,JSON.stringify(command))}catch{setError('Saved-status storage is unavailable. Reopen BookieBot before confirming this charge.');return}
  setPending(command);setBusy(true);flight.current=true;setError('')
  try{await accept(await billRequest('/app/transactions',command),command)}catch(e){if(alive.current){if(e instanceof RequestError&&[400,403,409].includes(e.status)){setPending(null);sessionStorage.removeItem(storageKey)}setError(e instanceof Error?e.message:'Check saved status before repeating this change.')}}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const recover=async(retry=false)=>{
  if(flight.current||!pending?.requestId)return;flight.current=true;setBusy(true);setError('')
  try{await accept(await billRequest(retry?'/app/transactions':`/app/transactions/commands/${encodeURIComponent(pending.requestId)}`,retry?pending:undefined),pending)}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not check saved status.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const summary=review&&row?{...review,title:row.title,date:row.date,category:row.categoryLabel,location:row.location,person:row.person,amountCents:row.amountCents,before:row.fields,after:review.after} as TransactionChangeSummary:null
 const locked=busy||Boolean(pending)
 const amountCents=/^\d+(?:\.\d{1,2})?$/.test(draft)?Math.round(Number(draft)*100):0
 const canReview=Boolean(row&&row.capabilities[operation]&&valid&&(operation!=='update'||Number.isSafeInteger(amountCents)&&amountCents>0&&amountCents!==row.amountCents)&&(operation!=='split'||method!=='fronted'||row.kind==='expense'))
 const inline:InlineSnapshot|null=row?{row:{...row,editableFields:['amount']},operation,draft:{amount:draft},destination:row.category,method,payerCents,splitInput,review:summary,canReview,locked:locked||Boolean(review)&&!ready,busy,categories:{},persons:[],error:''}:null
 return <div className="bi-editor bb-bills-current" data-design="levels">
  <header className="sp-flow-heading bb-bill-heading"><h2>{finished?'This month is up to date':'This month’s charge'}</h2><p className="sp-flow-context">{row?.title??intent.name} · {new Date(intent.month+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})}</p></header>
  {finished?<><p className="bi-footnote">The recorded amount and split match your changes. Recurring settings are saved separately.</p><footer className="bi-editor-footer"><button type="button" className="bi-primary" onClick={onDone}>Close</button></footer></>:<>
   <p className="bi-footnote">{operation==='update'?'Review the recorded amount, then its split.':'Review the recorded split.'} Future settings are already saved.</p>
   {inline&&<InlineTransactionEditor embedded snapshot={inline} onField={(_,value)=>{setDraft(value);setReview(null)}} onCategory={()=>{}} onShare={(value,next)=>{setPayerCents(value);setMethod(next);setReview(null)}} onSplitInput={setSplitInput} onValidity={setValid} onReview={()=>void prepare()} onConfirm={()=>void save()} onBack={()=>setReview(null)} onCancel={onDone} onRemoveSplit={()=>{setOperation('cancel_split');setReview(null)}}/>}
   {!row&&!busy&&!pending&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Reload charge</button>}
   {busy&&!row&&<p role="status">Loading charge…</p>}
   {pending&&<div className="bb-bills-current-recovery"><button type="button" className="bb-settings-action" disabled={busy} onClick={()=>void recover()}>Check saved status</button><button type="button" className="bb-settings-action" disabled={busy} onClick={()=>void recover(true)}>Retry same confirmation</button></div>}
  </>}
  {error&&<p className="bs-error" role="alert">{error}</p>}
  {!finished&&!inline&&!locked&&<footer className="bi-editor-footer"><button type="button" className="bi-cancel" onClick={onDone}>Close</button></footer>}
 </div>
}
