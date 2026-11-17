import type {LedgerSnapshot} from './reimbursement-ledger'
export interface ReimbursementUndo {title:string;command:Record<string,unknown>}
export interface ReimbursementReceipt {
 title:string;operation:string;operationId?:string;resetId?:string;resetVersion?:number;state:string;undoState?:string
}
const money=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100)
/** Projection progress may change; financial versions, reports and resets may not. */
const financialState=(snapshot:LedgerSnapshot)=>JSON.stringify([
 snapshot.ownerKey,
 snapshot.allocations.map(r=>[r.id,r.version,r.grossCents,r.payerShareCents,r.partnerShareCents,r.settledCents,r.clearedCents??0,r.outstandingCents,r.accounting]).sort(),
 snapshot.events.map(e=>[e.id,e.status,e.amountCents,e.operationId,e.confirmationOperationId??'']).sort(),
 (snapshot.resets??[]).map(r=>[r.id,r.version,r.status]).sort(),
])
export const reimbursementSyncPending=(snapshot:LedgerSnapshot)=>Boolean(snapshot.projectionPending||snapshot.allocations.some(r=>r.version!==r.projectedVersion))
/** Capture the acknowledged lineage even when its sheet projection is pending. */
export function reimbursementReceipt(body:Record<string,unknown>,result:LedgerSnapshot):ReimbursementReceipt|null {
 const operation=String(body.operation),state=financialState(result),undoState=result.undoState
 if(['reset','undo_reset','redo_reset'].includes(operation)){
  const reset=result.resets?.find(r=>r.id===result.reset?.id)
  if(!reset)return null
  return {title:operation==='undo_reset'?'Reset undone':'Balances reset',operation,resetId:reset.id,resetVersion:reset.version,state,undoState}
 }
 if(!['receive','receive_all','confirm_payment','offset','report_payment','report_all'].includes(operation)||!result.operationId)return null
 const events=result.events.filter(e=>e.status!=='reversed'&&(e.confirmationOperationId===result.operationId||e.operationId===result.operationId))
 if(!events.length)return null
 const total=events.reduce((n,e)=>n+e.amountCents,0),sent=operation==='report_payment'||operation==='report_all'
 return {title:operation==='offset'?money(total/2)+' offset each way':sent?'Payment reported':money(total)+' received',operation,operationId:result.operationId,state,undoState}
}
export function resolveReimbursementReceipt(receipt:ReimbursementReceipt,current:LedgerSnapshot):{phase:'syncing'|'ready'|'changed';undo:ReimbursementUndo|null}{
 if(receipt.state!==financialState(current))return {phase:'changed',undo:null}
 if(reimbursementSyncPending(current))return {phase:'syncing',undo:receipt.undoState?{title:receipt.title,command:{operation:'queue_undo',expectedUndoState:receipt.undoState,...(receipt.resetId?{action:receipt.operation==='undo_reset'?'redo_reset':'undo_reset',resetId:receipt.resetId,version:receipt.resetVersion}:{action:'reverse_operation',operationId:receipt.operationId})}}:null}
 if(!current.resetState)return {phase:'changed',undo:null}
 if(receipt.resetId){
  const reset=current.resets?.find(r=>r.id===receipt.resetId),restore=receipt.operation==='undo_reset'
  if(!reset||reset.version!==receipt.resetVersion||(restore?!reset.canRedo:!reset.canUndo))return {phase:'changed',undo:null}
  return {phase:'ready',undo:{title:receipt.title,command:{operation:restore?'redo_reset':'undo_reset',resetId:reset.id,version:reset.version}}}
 }
 return {phase:'ready',undo:{title:receipt.title,command:{operation:'reverse_operation',operationId:receipt.operationId,expectedState:current.resetState}}}
}
export function reimbursementUndo(body:Record<string,unknown>,result:LedgerSnapshot):ReimbursementUndo|null {
 const receipt=reimbursementReceipt(body,result)
 return receipt&&!reimbursementSyncPending(result)?resolveReimbursementReceipt(receipt,result).undo:null
}
