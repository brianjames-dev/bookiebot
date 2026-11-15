import {useEffect,useRef,useState} from 'react'
import type {RecordedTransaction} from './transactions-screen'
import {transactionMotion} from './transaction-inline-editor'
import {NotchedSplitControl,type SplitInputDraft} from './transaction-split-control'
import {allocate,type SplitMethod} from './transaction-split-model'
import {ratioShareCents} from './split-ratio'
import {StepMotion} from './transaction-step-motion'
import {useAppWorkStatus} from './app-work-guard'
import {billFlow,billFlowKey,runBillFlow,type BillCurrentChange,type BillSaveFlow} from './bill-save-flow'
import {currentReviewLines} from './bill-review'

export type CurrentBillIntent={id:string;month:string;name:string;amountCents:number|null;method:'none'|SplitMethod;basis:number;requestId?:string;stage?:'configuration'|'offer'|'adopt'|'charge';needsAdoption?:boolean;offerCurrent?:boolean;recordedAmountCents?:number;editAmount?:boolean}
const amountCents=(value:string)=>{const cents=/^\d+(?:\.\d{1,2})?$/.test(value)?Math.round(Number(value)*100):0;return Number.isSafeInteger(cents)?cents:0}
async function billRequest(path:string,body?:unknown){
 const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),30_000)
 try{const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',mode:'same-origin',referrerPolicy:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:body?JSON.stringify(body):undefined,signal:controller.signal});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'Could not load this charge.'),{status:response.status});return value}finally{window.clearTimeout(timer)}
}

/** Amount and split are one draft/review, with canonical operations underneath. */
export function BillCurrentCharge({intent,ownerName,onDone,rowOrder}:{intent:CurrentBillIntent;ownerName:string;onDone:()=>void;rowOrder?:string[]}){
 const [row,setRow]=useState<RecordedTransaction|null>(null),[amount,setAmount]=useState(''),[method,setMethod]=useState<string>('none'),[payer,setPayer]=useState(0),[input,setInput]=useState<SplitInputDraft>(null),[valid,setValid]=useState(true)
 const [review,setReview]=useState<{operation:string;reviewVersion:string;currentChange:BillCurrentChange}|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[flow,setFlow]=useState<BillSaveFlow|null>(null),[legacy,setLegacy]=useState<any>(null)
 const flight=useRef(false),alive=useRef(true),ratio=useRef<[number,number]>([1,1]),key=billFlowKey(ownerName),legacyKey=`bookiebot:transaction-request:${ownerName}`
 useAppWorkStatus({label:'This month’s bill',pending:busy,uncertain:Boolean(flow?.pending||legacy),dirty:true,onDiscard:onDone})
 const load=async()=>{
  setBusy(true);setError('')
  try{const next=(await billRequest(`/app/bills/${encodeURIComponent(intent.id)}/charge?month=${intent.month}`)).item as RecordedTransaction
   if(!alive.current)return
   if(!next||next.month!==intent.month||!next.version)throw Error('The recorded charge could not be read. Reload Bills before trying again.')
   setRow(next);const cents=intent.editAmount?next.amountCents:intent.amountCents??next.amountCents
   setAmount((cents/100).toFixed(2));setMethod(intent.editAmount?next.split||'none':intent.method)
   const share=intent.editAmount?next.splitOptions?.payerCents??cents:intent.method==='income'?allocate(cents,intent.basis):allocate(cents,intent.method==='none'?10000:intent.method==='equal'?5000:intent.basis)
   setPayer(share);ratio.current=[share,cents||1]
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not load this charge.')}
  finally{if(alive.current)setBusy(false)}
 }
 useEffect(()=>{alive.current=true;try{const previous=JSON.parse(sessionStorage.getItem(key)||'null'),old=JSON.parse(sessionStorage.getItem(legacyKey)||'null');if(previous?.version===1){if(previous.stage==='done'){sessionStorage.removeItem(key);onDone()}else{setFlow(previous);setReview(previous.presentation)}}else if(old)setLegacy(old);else void load()}catch{setError('Saved-status storage is unavailable. Reopen BookieBot before editing.')};return()=>{alive.current=false}},[intent.id,intent.month])
 useEffect(()=>{setReady(false);if(!review)return;const timer=window.setTimeout(()=>setReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review])
 const total=amountCents(amount)
 const locked=busy||Boolean(flow)||Boolean(legacy)
 const amountChanged=Boolean(row&&total!==row.amountCents),splitChanged=Boolean(row&&(method!==(row.split||'none')||method!=='none'&&payer!==(row.splitOptions?.payerCents??row.amountCents)))
 const changed=amountChanged||splitChanged
 const permitted=Boolean(row&&(!amountChanged||row.capabilities.update)&&(!splitChanged||row.capabilities[method==='none'?'cancel_split':'split']))
 const prepare=async()=>{
  if(flight.current||locked||!row||!total||!valid||!changed||!permitted)return
  flight.current=true;setBusy(true);setError('')
  try{const value=await billRequest('/app/bills/review',{operation:'current',id:intent.id,month:intent.month,version:row.version,amountCents:total,method,...(method==='custom'?{payerShareCents:payer}:{})});if(alive.current)setReview(value.review)}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not review this charge.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const execute=async(next:BillSaveFlow,recover=false,retry=false)=>{
  if(flight.current)return;flight.current=true;setBusy(true);setError('')
  try{await runBillFlow(next,billRequest,value=>{sessionStorage.setItem(key,JSON.stringify(value));if(alive.current)setFlow(value)},{recover,retry});sessionStorage.removeItem(key);window.dispatchEvent(new Event('bookiebot:transactions-changed'));window.dispatchEvent(new Event('bookiebot:reimbursements-changed'));onDone()}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'Check saved status before continuing.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const save=()=>{if(!review||!ready||locked)return;const next=billFlow(undefined,review.currentChange);next.presentation=review;next.rowOrder=rowOrder;void execute(next)}
 const recoverLegacy=async(retry=false)=>{
  if(flight.current||!legacy)return;flight.current=true;setBusy(true)
  try{const result=await billRequest(retry?'/app/transactions':`/app/transactions/commands/${encodeURIComponent(legacy.requestId)}`,retry?legacy:undefined);if(result.state==='done'){sessionStorage.removeItem(legacyKey);setLegacy(null);onDone()}else setError(result.detail||'Check saved status before another change.')}
  catch(e){setError(e instanceof Error?e.message:'Could not verify the saved change.')}
  finally{flight.current=false;setBusy(false)}
 }
 const lines=review?currentReviewLines(review.currentChange):[]
 return <div className="bi-editor bb-bills-current" data-design="levels">
  <header className="sp-flow-heading bb-bill-heading"><h2>{review?'Review charge':'This month’s charge'}</h2><p className="sp-flow-context">{row?.title??intent.name} · {new Date(intent.month+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})}</p></header>
  <StepMotion review={Boolean(review)} open mode="slide" duration={transactionMotion.duration} edit={<form className="bi-fields bb-bills-current-form" onSubmit={e=>{e.preventDefault();void prepare()}}>
   <label>Amount<span className="bi-money-input"><span aria-hidden="true">$</span><input aria-label="Amount" inputMode="decimal" value={amount} disabled={locked||!row?.capabilities.update} onChange={e=>{const value=e.target.value,next=amountCents(value);setAmount(value);setPayer(method==='custom'?ratioShareCents(next,ratio.current):allocate(next,method==='none'?10000:method==='equal'?5000:intent.basis))}}/></span></label>
   {method==='none'?<button type="button" className="bb-settings-action bb-bills-split-action" disabled={locked||!row?.capabilities.split} onClick={()=>{setMethod('income');setPayer(allocate(total,intent.basis))}}>Split this charge</button>:<><button type="button" className="bb-bills-remove-split bi-cancel" disabled={locked||Boolean(row?.split)&&!row?.capabilities.cancel_split} onClick={()=>setMethod('none')}>Remove split</button><div className="sp-management"><NotchedSplitControl inputDraft={input} onInputDraft={setInput} total={total||1} payerCents={Math.min(total,payer)} method={method as SplitMethod} incomeBasis={intent.basis} payerName={row?.splitOptions?.payerName??ownerName} partnerName={row?.splitOptions?.partnerName??'Partner'} allowCustom={row?.splitOptions?.custom??false} capture={7} disabled={locked||!row?.capabilities.split} onChange={(value,next)=>{ratio.current=[value,total||1];setPayer(value);setMethod(next)}} onValidityChange={setValid}/></div></>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={onDone}>Cancel</button><button type="submit" className="bi-primary" disabled={locked||!row||!total||!valid||!changed||!permitted}>Review</button></footer>
  </form>} confirm={<><dl className="bi-review-changes" aria-label="Charge changes to review">{lines.map(line=><div className="bi-review-change" key={line.label}><dt>{line.label}</dt><dd><del>{line.before}</del><span className="bi-review-new">{line.after}</span></dd></div>)}</dl><p className="bi-footnote">This month only. Repayments and the saved autopay date stay unchanged.</p><footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={()=>setReview(null)}>Back</button><button type="button" className="bi-primary" disabled={locked||!ready} onClick={save}>{busy?'Saving…':'Save changes'}</button></footer></>}/>
  {error&&<p className="bs-error" role="alert">{error}</p>}
  {(flow?.pending||legacy)&&!busy&&<div className="bb-bills-current-recovery"><button type="button" onClick={()=>flow?void execute(flow,true):void recoverLegacy()}>Check saved status</button><button type="button" onClick={()=>flow?void execute(flow,true,true):void recoverLegacy(true)}>Retry same confirmation</button></div>}
  {flow&&!flow.pending&&!busy&&<div className="bb-bills-current-recovery">{!flow.failed&&<button type="button" onClick={()=>void execute(flow)}>Resume saved change</button>}<button type="button" className="bi-cancel" onClick={()=>{sessionStorage.removeItem(key);onDone()}}>Close</button></div>}
  {!row&&!busy&&!flow&&!legacy&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Reload charge</button>}
 </div>
}
