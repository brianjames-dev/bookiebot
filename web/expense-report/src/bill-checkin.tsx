import {useEffect,useRef,useState} from 'react'
import {ChevronRight,Clock3} from 'lucide-react'
import {useAppWorkGuard} from './app-work-guard'
import './bill-checkin.css'

export type BillAmountRequest={id:string;month:string;nonce:string}
type DueBill={id:string;name:string;month:string;date:string;overdue:boolean}
type Checkin={day:string;claimed?:boolean;bills:DueBill[];token?:string}
const pacificDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
async function checkinRequest(body?:{action:string;token:string},signal?:AbortSignal):Promise<Checkin>{
 const response=await fetch('/app/bills/check-in',{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',mode:'same-origin',redirect:'error',referrerPolicy:'same-origin',headers:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:body?JSON.stringify(body):undefined,signal})
 if(!response.ok)throw new Error('Bill check-in unavailable')
 return response.json()
}

// The server reserves the person/day only while we can display it, and records
// "shown" after showModal succeeds. Failed/blocked attempts retain tomorrow's
// eligibility and an abandoned reservation expires for the other device.
export function BillCheckin({owner,enabled,blocked,onEnter}:{owner:string;enabled:boolean;blocked:boolean;onEnter:(request:BillAmountRequest)=>void}){
 const work=useAppWorkGuard(),dialog=useRef<HTMLDialogElement>(null)
 const [wake,setWake]=useState(0),[offer,setOffer]=useState<Checkin|null>(null)
 const acknowledged=useRef(''),checked=useRef(''),flight=useRef(false),previousFocus=useRef<HTMLElement|null>(null)
 const safe=useRef(false)
 safe.current=enabled&&!blocked&&!work.pending&&!work.uncertain&&!work.dirty&&document.visibilityState==='visible'
 useEffect(()=>{
  checked.current='';acknowledged.current=''
  const resume=()=>{if(document.visibilityState==='visible')setWake(n=>n+1)}
  const changed=()=>{checked.current='';resume()}
  const observer=new MutationObserver(resume);observer.observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['open']})
  document.addEventListener('visibilitychange',resume);window.addEventListener('pageshow',resume);window.addEventListener('focus',resume);window.addEventListener('bookiebot:transactions-changed',changed)
  return()=>{observer.disconnect();document.removeEventListener('visibilitychange',resume);window.removeEventListener('pageshow',resume);window.removeEventListener('focus',resume);window.removeEventListener('bookiebot:transactions-changed',changed)}
 },[owner])
 useEffect(()=>{
  const day=pacificDay()
  if(!safe.current||offer||acknowledged.current===day||checked.current===day)return
  const controller=new AbortController()
  const timer=window.setTimeout(async()=>{
   if(!safe.current||flight.current||document.querySelector('dialog[open]'))return
   flight.current=true
   const token=crypto.randomUUID()
   const deadline=window.setTimeout(()=>controller.abort(),30_000)
   let reserved=false
   try{
    const due=await checkinRequest(undefined,controller.signal)
    if(!safe.current||controller.signal.aborted||document.querySelector('dialog[open]'))return
    if(!due.bills?.length){checked.current=due.day;return}
    reserved=true
    const next=await checkinRequest({action:'claim',token},controller.signal)
    reserved=next.claimed===true
    if(!reserved){checked.current=next.day;return}
    if(!safe.current||controller.signal.aborted||document.querySelector('dialog[open]'))return
    setOffer({...next,token})
    reserved=false
   }catch{/* An optional check-in must not interrupt the app or financial work. */}
   finally{window.clearTimeout(deadline);if(reserved)void checkinRequest({action:'release',token}).catch(()=>{});flight.current=false}
  },1200)
  return()=>{window.clearTimeout(timer);controller.abort()}
 },[owner,enabled,blocked,work.pending,work.uncertain,work.dirty,wake,offer])
 useEffect(()=>{
  const element=dialog.current
  if(!offer||!element)return
  const token=offer.token!
  if(!safe.current||document.querySelector('dialog[open]')){setOffer(null);void checkinRequest({action:'release',token}).catch(()=>{});return}
  try{
   previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null
   element.showModal();acknowledged.current=offer.day
   void checkinRequest({action:'shown',token}).catch(()=>{})
  }catch{setOffer(null);void checkinRequest({action:'release',token}).catch(()=>{})}
  return()=>{if(element.open)element.close()}
 },[offer])
 const close=()=>{setOffer(null);previousFocus.current?.focus({preventScroll:true})}
 return <dialog ref={dialog} className="bb-work-guard-dialog bb-bill-checkin" aria-labelledby="bb-bill-checkin-title" onCancel={e=>{e.preventDefault();close()}}>
  <h2 id="bb-bill-checkin-title">Confirm upcoming bills</h2>
  <p>Enter the amount on your bill. It enters Transactions on its saved autopay date.</p>
  <div className="bb-bill-checkin-list">{offer?.bills.map(bill=><button type="button" key={bill.id} onClick={()=>{close();onEnter({id:bill.id,month:bill.month,nonce:crypto.randomUUID()})}}>
   <Clock3 aria-hidden="true"/><span><strong>{bill.name}</strong><small>{bill.overdue?'Amount needed · ':''}{new Date(bill.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}</small></span><ChevronRight aria-hidden="true"/>
  </button>)}</div>
  <div className="bb-work-guard-actions"><button type="button" onClick={close}>Later</button></div>
 </dialog>
}
