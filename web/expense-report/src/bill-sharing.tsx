import {useEffect,useRef,useState} from 'react'
import {StepMotion} from './transaction-step-motion'
import {transactionMotion} from './transaction-inline-editor'
import {useAppWorkStatus} from './app-work-guard'
import {useAppNavigation} from './app-navigation'
import type {Bill} from './bill-settings'

export interface BillMembership {
 id:string;revision:number;status:'pending'|'active'|'declined'|'revoked';role:'payer'|'member';payerName:string;memberName:string
 state?:{purchaseTotalCents:number|null;payerShareCents:number;memberShareCents:number;receivedCents:number;remainingCents:number;clearedCents?:number;repaymentStatus:string;paymentStatus:string;paymentDate:string|null;predicted:boolean;allocationIds:string[];month:string}
}
type Action='invite'|'accept'|'decline'|'stop'
type Change={action:Action;billId?:string;shareId?:string;reviewVersion?:string;requestId?:string}
type Review={action:Action;reviewVersion:string;payerName:string;memberName:string;name:string|null;bill?:{type:Bill['type'];amountCents:number|null;cadence:string;pullDay:number|null;splitMethod:string;effectiveFrom?:string}|null;currentCharge?:{month:string;amountCents:number;date:string|null}|null}
export const sharingJournalKey=(owner:string)=>`bookiebot:bill-sharing:${owner.toLowerCase()}`
export interface SharingJournal {billId:string;command:Change}
export function readSharingJournal(owner:string):SharingJournal|null {
 try{const item=JSON.parse(sessionStorage.getItem(sharingJournalKey(owner))||'null') as SharingJournal|null
  return item&&typeof item.billId==='string'&&typeof item.command?.requestId==='string'&&typeof item.command?.reviewVersion==='string'?item:null
 }catch{return null}
}
const money=(cents:number|null|undefined)=>cents==null?'Amount needed':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
const titles:Record<Action,string>={invite:'Share bill',accept:'Accept shared bill',decline:'Decline shared bill',stop:'Stop sharing'}

async function api(path:string,body?:Change) {
 const controller=new AbortController(),deadline=window.setTimeout(()=>controller.abort(),30000)
 try{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal,
   headers:body?{'Content-Type':'application/json','X-BookieBot-App':'1'}:undefined,body:body?JSON.stringify(body):undefined})
  const result=await response.json()
  if(!response.ok)throw Object.assign(new Error(result.error||'Could not verify this shared bill.'),{notApplied:result.notApplied===true,status:response.status})
  return result
 }finally{window.clearTimeout(deadline)}
}

export function BillSharingEditor({bill,ownerName,partnerName,onClose,onSaved,onBlock}:{bill:Bill;ownerName:string;partnerName:string;onClose:()=>void;onSaved:()=>void;onBlock:(blocked:boolean)=>void}){
 const [review,setReview]=useState<Review|null>(null),[change,setChange]=useState<Change|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ready,setReady]=useState(false)
 const [pending,setPending]=useState<Change|null>(()=>{const value=readSharingJournal(ownerName);return value?.billId===bill.id?value.command:null})
 const mounted=useRef(true),flight=useRef(false),navigation=useAppNavigation()
 const membership=bill.sharing,state=membership?.state,member=bill.readOnly===true,locked=busy||Boolean(pending)
 const configuration=bill.nextChange?.active?bill.nextChange:bill
 const journal=sharingJournalKey(ownerName)
 useAppWorkStatus({label:'Shared bill',pending:busy,uncertain:Boolean(pending)})
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;onBlock(false)}},[onBlock])
 useEffect(()=>onBlock(locked),[locked,onBlock])
 useEffect(()=>{setReady(false);if(!review)return;const timer=window.setTimeout(()=>setReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review])
 const done=()=>{sessionStorage.removeItem(journal);setPending(null);onSaved()}
 const check=async()=>{
  if(!pending||flight.current)return
  flight.current=true;setBusy(true);setError('')
  try{await api('/app/bills/sharing/commands/'+encodeURIComponent(pending.requestId!));if(mounted.current)done()}
  catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Could not check the saved result.')}
  finally{flight.current=false;if(mounted.current)setBusy(false)}
 }
 const prepare=async(action:Action)=>{
  if(locked||flight.current)return
  flight.current=true;setBusy(true);setError('')
  const body:Change=action==='invite'?{action,billId:bill.id}:{action,shareId:membership!.id}
  try{const next=await api('/app/bills/sharing/review',body);if(mounted.current){setReview(next.review);setChange({...body,reviewVersion:next.review.reviewVersion,requestId:crypto.randomUUID()})}}
  catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Could not review this shared bill.')}
  finally{flight.current=false;if(mounted.current)setBusy(false)}
 }
 const confirm=async(body=change)=>{
  if(!body||flight.current||(!pending&&!ready))return
  flight.current=true;setBusy(true);setError('')
  try{
   // Persist the exact owner/bill-scoped command before sending. Recovery GETs
   // never create a membership; only explicit Confirm/Retry submits this body.
   sessionStorage.setItem(journal,JSON.stringify({billId:bill.id,command:body} satisfies SharingJournal));setPending(body)
   await api('/app/bills/sharing',body)
   if(mounted.current)done()
  }catch(reason){if(mounted.current){
   if((reason as {notApplied?:boolean}).notApplied){sessionStorage.removeItem(journal);setPending(null);setReview(null);setChange(null)}
   setError(reason instanceof Error?reason.message:'Check this sharing request before trying again.')
  }}finally{flight.current=false;if(mounted.current)setBusy(false)}
 }
 const invoiceMonth=member&&state?.allocationIds.length?state.month:bill.nextChange?configuration.effectiveFrom:null
 const monthText=(month:string)=>new Date(month+'-01T12:00:00').toLocaleDateString('en-US',{month:'short',year:'numeric'})
 const summary=<div className="bb-shared-bill-content">
  <header className="sp-flow-heading bb-bill-heading"><h2>{member?'Shared bill':'Bill sharing'}</h2></header>
  <div className="bb-shared-bill-name"><strong title={bill.name}>{bill.name}</strong><span>{membership?.status==='pending'?'Invitation pending':membership?.status==='active'?'Shared':`Share with ${partnerName}`}{invoiceMonth?` · ${monthText(invoiceMonth)}`:''}</span></div>
  {member&&membership&&<>
   <div className="bb-shared-bill-people">{[{name:membership.payerName,label:'Pays the bill',cents:state?.purchaseTotalCents==null?null:state.payerShareCents},{name:membership.memberName,label:'Your share',cents:state?.purchaseTotalCents==null?null:state.memberShareCents}].map(person=><div key={person.name}><span className="bb-shared-bill-initial" aria-hidden="true">{person.name.slice(0,1)}</span><span><strong>{person.name}</strong><small>{person.label}</small></span><strong>{money(person.cents)}</strong></div>)}</div>
   {state&&<dl className="bb-shared-bill-facts">
    <div><dt>{state.predicted?'Estimated bill total':'Bill total'}</dt><dd>{money(state.purchaseTotalCents)}</dd></div>
    <div><dt>Autopay</dt><dd>{state.paymentDate||bill.nextDate?new Date((state.paymentDate||bill.nextDate)+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'Date needed'} · {state.paymentStatus==='paid'?'Paid':state.paymentStatus==='confirmed'?'Amount confirmed':'Upcoming'}</dd></div>
    <div><dt>Received by {membership.payerName}</dt><dd>{money(state.receivedCents)}</dd></div>
    <div><dt>{state.repaymentStatus==='cancelled'?'Not split this month':state.repaymentStatus==='not-billed'?state.predicted?'Estimated share':'Planned share':state.repaymentStatus==='reported'?'Awaiting confirmation':state.repaymentStatus==='cleared'?'Balance cleared':'Remaining to repay'}</dt><dd>{money(state.purchaseTotalCents==null?null:state.repaymentStatus==='not-billed'?state.memberShareCents:state.repaymentStatus==='cleared'?state.clearedCents:state.remainingCents)}</dd></div>
   </dl>}
   <p className="bb-settings-note">Your recurring share{bill.nextChange?` from ${monthText(configuration.effectiveFrom)}`:''} · {configuration.type==='variable'?'Variable amount':money(configuration.amountCents)} · {configuration.cadence}</p>
  </>}
  {!member&&<p className="bb-settings-note">{membership?.status==='active'?`${partnerName} sees this bill’s schedule and repayment status.`:membership?.status==='pending'?`${partnerName} can accept this bill in their Bills screen.`:`${partnerName} can accept your invitation to see this bill’s schedule and repayments. You keep managing its recurring settings.`}</p>}
  <footer className="bi-editor-footer">
   <button type="button" className="bi-cancel" disabled={locked} onClick={onClose}>Close</button>
   {member&&membership?.status==='pending'?<><button type="button" className="bi-cancel" disabled={locked} onClick={()=>void prepare('decline')}>Decline</button><button type="button" className="bi-primary" disabled={locked} onClick={()=>void prepare('accept')}>Review</button></>
    : member&&membership?.status==='active'?<><button type="button" className="bi-cancel" aria-label="Stop sharing" disabled={locked} onClick={()=>void prepare('stop')}>Leave</button>{Boolean(state?.allocationIds.length)&&<button type="button" className="bi-primary" disabled={locked} onClick={()=>navigation?.selectScreen('shared')}>View repayments</button>}</>
    : !member&&(membership?.status==='active'||membership?.status==='pending')?<button type="button" className="bi-cancel" disabled={locked} onClick={()=>void prepare('stop')}>Stop sharing</button>
    :!member&&<button type="button" className="bi-primary" disabled={locked||configuration.splitMethod==='none'&&bill.splitMethod==='none'} onClick={()=>void prepare('invite')}>Review invitation</button>}
  </footer>
  {!member&&configuration.splitMethod==='none'&&bill.splitMethod==='none'&&<p className="bb-settings-note">Save a recurring split before sharing this bill.</p>}
 </div>
 const confirmView=<div className="bb-shared-bill-content">
  <header className="sp-flow-heading bb-bill-heading"><h2>{review?titles[review.action]:'Review sharing'}</h2></header>
  <strong>{bill.name}</strong>
  {review&&<><p>{review.action==='invite'?`${review.memberName} will receive an invitation.`:review.action==='accept'?`Share ${review.payerName}’s bill schedule and repayment status.`:review.action==='decline'?'Decline this invitation.':'Remove this bill from the shared Bills view.'}</p>
   {review.bill&&<dl className="bb-shared-bill-facts">
    {review.bill.type==='variable'&&review.currentCharge&&<div><dt>{monthText(review.currentCharge.month)} bill total</dt><dd>{money(review.currentCharge.amountCents)}</dd></div>}
    <div><dt>{review.bill.type==='variable'?'Future amount':'Recurring total'}</dt><dd>{review.bill.type==='variable'?`Entered ${review.bill.cadence}`:money(review.bill.amountCents)}</dd></div>
    {review.bill.type==='variable'&&review.bill.amountCents!=null&&<div><dt>Estimate</dt><dd>{money(review.bill.amountCents)}</dd></div>}
    <div><dt>Repeats</dt><dd>{review.bill.cadence}</dd></div><div><dt>Payment day</dt><dd>{review.bill.pullDay??'Not set'}</dd></div></dl>}
   <p className="bb-settings-note">Existing transactions, splits and received repayments stay unchanged.</p>
  </>}
  <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={()=>{setReview(null);setChange(null);setError('')}}>Back</button><button type="button" className="bi-primary" disabled={locked||!ready} onClick={()=>void confirm()}>Confirm</button></footer>
 </div>
 return <div className="bb-bill-sharing" aria-busy={busy}>
  <StepMotion open mode="slide" duration={transactionMotion.duration} review={Boolean(review)} edit={summary} confirm={confirmView}/>
  {error&&<p className="bb-bills-error" role="alert">{error}</p>}
  {pending&&<div className="bb-bills-recovery"><button type="button" className="bi-cancel" disabled={busy} onClick={()=>void check()}>Check saved change</button><button type="button" className="bi-cancel" disabled={busy} onClick={()=>void confirm(pending)}>Retry same confirmation</button></div>}
 </div>
}

export function BillSharingRecovery({journal,ownerName,onSaved,onBlock}:{journal:SharingJournal;ownerName:string;onSaved:()=>void;onBlock:(value:boolean)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[rejected,setRejected]=useState(false)
 const flight=useRef(false)
 useAppWorkStatus({label:'Shared bill',pending:busy,uncertain:!rejected})
 useEffect(()=>{onBlock(!rejected);return()=>onBlock(false)},[onBlock,rejected])
 const run=async(retry=false)=>{
  if(flight.current)return
  flight.current=true;setBusy(true);setError('')
  try{await api(retry?'/app/bills/sharing':'/app/bills/sharing/commands/'+encodeURIComponent(journal.command.requestId!),retry?journal.command:undefined)
   sessionStorage.removeItem(sharingJournalKey(ownerName));onSaved()
  }catch(reason){
   if((reason as {notApplied?:boolean}).notApplied){sessionStorage.removeItem(sharingJournalKey(ownerName));setRejected(true)}
   setError(reason instanceof Error?reason.message:'Could not check the sharing request.')
  }
  finally{flight.current=false;setBusy(false)}
 }
 if(rejected)return <div className="bb-bills-recovery" role="alert"><p>This sharing change was not applied.</p><p>{error}</p><button type="button" className="bi-cancel" onClick={onSaved}>Close</button></div>
 return <div className="bb-bills-recovery" role="status"><p>A bill-sharing change needs verification.</p>{error&&<p>{error}</p>}
  <button type="button" className="bi-cancel" disabled={busy} onClick={()=>void run()}>Check saved change</button>
  <button type="button" className="bi-cancel" disabled={busy} onClick={()=>void run(true)}>Retry same confirmation</button>
 </div>
}
