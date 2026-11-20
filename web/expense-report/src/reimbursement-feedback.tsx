import {createContext,useContext,useEffect,useRef,useState,type ButtonHTMLAttributes,type ReactNode} from 'react'
import type {LedgerSnapshot} from './reimbursement-ledger'
import {reimbursementReceipt,reimbursementSyncPending,resolveReimbursementReceipt,type ReimbursementReceipt} from './reimbursement-undo'
import type {UndoNotice} from './transaction-undo-popup'
import {transactionMotion} from './transaction-inline-editor'
import {SavingButton} from './report-loading'

export const ReimbursementSavingContext=createContext<string|undefined>(undefined)
export function ReimbursementSaveButton({operation,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{operation:string;children:ReactNode}){
 const saving=useContext(ReimbursementSavingContext)===operation
 return <SavingButton {...props} saving={saving}/>
}
type Phase='syncing'|'ready'|'changed'|'queued'|'undone-syncing'|'undone'|'failed'
interface Feedback {notice:UndoNotice;receipt:ReimbursementReceipt|null;phase:Phase;dismissed:boolean;jobId?:string;detail?:string}
export function useReimbursementFeedback(snapshot:LedgerSnapshot|null){
 const [feedback,setFeedback]=useState<Feedback|null>(null),serial=useRef(0)
 const notice=(title:string):UndoNotice=>({id:++serial.current,title,seconds:transactionMotion.undoSeconds,deadline:Date.now()+transactionMotion.undoSeconds*1000})
 useEffect(()=>{
  if(!snapshot){setFeedback(null);return}
  setFeedback(previous=>{
   const pending=reimbursementSyncPending(snapshot)
   const job=snapshot.undoJobs?.find(j=>j.id===previous?.jobId)??(!previous?snapshot.undoJobs?.find(j=>j.status==='queued'):undefined)
   if(job){
    const phase:Phase=job.status==='queued'?'queued':job.status==='failed'?'failed':pending?'undone-syncing':'undone'
    if(previous?.phase===phase&&previous.jobId===job.id)return previous
    // A durable acceptance is the user-facing completion. Projection progress
    // neither changes the copy nor restarts/reopens the success toast.
    const failed=phase==='failed'
    return {notice:previous&&!failed?previous.notice:notice(failed?'Couldn’t undo':'Undone'),receipt:null,phase,dismissed:failed?false:previous?.dismissed??false,jobId:job.id,detail:job.error}
   }
   if(previous?.receipt){const resolved=resolveReimbursementReceipt(previous.receipt,snapshot);if(previous.dismissed&&resolved.phase!=='syncing')return null;if(previous.phase===resolved.phase)return previous
    return {...previous,phase:resolved.phase,...(resolved.phase==='changed'?{dismissed:false,notice:notice(previous.receipt.title)}:{})}
   }
   if(previous?.phase==='undone-syncing'&&!pending)return {...previous,phase:'undone'}
   if(previous?.phase==='syncing'&&!pending)return {...previous,phase:'ready'}
   return previous
  })
 },[snapshot])
 const acknowledge=(body:Record<string,unknown>,result:LedgerSnapshot)=>{
  if(body.operation==='queue_undo'&&result.undoJob){const phase:Phase='queued';setFeedback({notice:notice('Undone'),receipt:null,phase,dismissed:false,jobId:result.undoJob.id});return}
  const receipt=reimbursementReceipt(body,result),pending=reimbursementSyncPending(result)
  const inverse=['reverse_operation','reverse'].includes(String(body.operation))
  const phase:Phase=inverse?(pending?'undone-syncing':'undone'):pending?'syncing':'ready'
  if(!receipt&&!pending&&!inverse){setFeedback(null);return}
  setFeedback({notice:notice(receipt?.title??(inverse?'Undone':'Saved')),receipt,phase,dismissed:false})
 }
 const resolution=feedback?.receipt&&snapshot?resolveReimbursementReceipt(feedback.receipt,snapshot):null
 const command=resolution?.undo?.command??null,visible=Boolean(feedback&&!feedback.dismissed)
 return {acknowledge,dismiss:()=>setFeedback(previous=>previous&&['syncing','queued','undone-syncing'].includes(previous.phase)?{...previous,dismissed:true}:null),
  notice:visible?feedback!.notice:null,command,modal:false,
  detail:feedback?.phase==='failed'?feedback.detail:feedback?.phase==='changed'?'Balances changed. Review history to undo.':undefined}
}
