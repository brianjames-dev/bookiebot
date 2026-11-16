import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowLeft} from 'lucide-react'
import {useAppWorkStatus} from './app-work-guard'
import {StepMotion} from './transaction-step-motion'
export type Command=Record<string,unknown>&{operation:string}
export type Review={reviewId:string;title:string;items:{label:string;value:string}[]}
export async function api<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',mode:'same-origin',redirect:'error',signal,
    headers:body===undefined?undefined:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:body===undefined?undefined:JSON.stringify(body)})
  if(response.status===401){window.dispatchEvent(new Event('bookiebot:managed-expired'));throw new Error('Your session expired. Reopen BookieBot to sign in.')}
  const value=await response.json()
  if(!response.ok)throw Object.assign(new Error(value.error||'Could not load your budget. Try again.'),{status:response.status})
  return value as T
}

export function useReview(accountId:string,onComplete:()=>Promise<void>|void,endpoint='/app/budget'){
  const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[recovery,setRecovery]=useState(0)
  const active=useRef(false),key=`bookiebot:confirm:${endpoint}:${accountId}`,done=useRef(onComplete);done.current=onComplete
  const remember=(value:string|null)=>{try{if(value)sessionStorage.setItem(key,value);else sessionStorage.removeItem(key)}catch{/* Retry within this page still retains the exact review. */}}
  useEffect(()=>{let identity='';try{identity=sessionStorage.getItem(key)||''}catch{/* No recovery journal available. */}if(!/^[a-f0-9]{32}$/.test(identity))return
    const abort=new AbortController();setBusy(true);setUncertain(true);void api<Review&{completed?:boolean;expired?:boolean}>(`${endpoint}/reviews/${identity}`,undefined,abort.signal).then(async value=>{
      if(abort.signal.aborted)return
      if(value.completed){remember(null);setUncertain(false);await done.current()}
      else if(value.expired){remember(null);setUncertain(false);setError('The unconfirmed review expired. Review your changes again.')}
      else {setReview(value);setUncertain(true);setError('Confirmation was interrupted. Retry safely using this same review.')}
    }).catch(()=>{if(!abort.signal.aborted)setError('Could not check your last confirmation. Try checking again below.')}).finally(()=>{if(!abort.signal.aborted)setBusy(false)})
    return()=>abort.abort()
  },[key,recovery])
  useAppWorkStatus({label:'Budget change',pending:busy,uncertain,dirty:Boolean(review),onDiscard:()=>{if(!uncertain)setReview(null)}})
  const prepare=async(command:Command)=>{if(active.current||uncertain||busy)return;active.current=true;setBusy(true);setError('')
    try{const value=await api<Review&{completed?:boolean}>(`${endpoint}/review`,{...command,accountId,requestId:crypto.randomUUID()});if(value.completed)await done.current();else setReview(value)}catch(e){setError((e as Error).message)}finally{setBusy(false);active.current=false}}
  const confirm=async()=>{if(!review||active.current)return;active.current=true;setBusy(true);setError('');remember(review.reviewId);setUncertain(true)
    try{await api(`${endpoint}/confirm`,{reviewId:review.reviewId,accountId});remember(null);setUncertain(false);setReview(null);await done.current()}catch(e){if([400,403,409].includes((e as {status?:number}).status||0)){remember(null);setUncertain(false)}setError((e as Error).message)}finally{setBusy(false);active.current=false}}
  return {review,busy,error,uncertain,prepare,confirm,check:()=>setRecovery(x=>x+1),back(){if(!uncertain){setReview(null);setError('')}},clearError(){setError('')}}
}
export type Flow=ReturnType<typeof useReview>
export function ReviewPanel({flow,children}:{flow:Flow;children:ReactNode}){
  return <div className="bi-product bb-managed-editor"><div className="bi-editor" data-design="levels">
    <StepMotion review={Boolean(flow.review)} open mode="slide" duration={440} edit={children} confirm={<>
      <h2>{flow.review?.title}</h2><dl className="bi-review-changes">{flow.review?.items.map(item=><div className="bi-review-change" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
      <footer className="bi-editor-footer"><button className="bi-cancel" disabled={flow.busy||flow.uncertain} onClick={flow.back}><ArrowLeft aria-hidden="true"/>Back</button><button className="bi-primary" disabled={flow.busy} onClick={()=>void flow.confirm()}>{flow.busy?'Saving…':flow.uncertain?'Retry confirmation':'Confirm'}</button></footer>
    </>}/>{flow.error&&<p className="bb-managed-error" role="alert">{flow.error}</p>}{flow.uncertain&&!flow.review&&<button className="bi-cancel" disabled={flow.busy} onClick={flow.check}>Check last confirmation</button>}
  </div></div>
}
