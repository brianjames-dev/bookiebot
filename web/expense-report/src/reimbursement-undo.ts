import type {LedgerSnapshot} from './reimbursement-ledger'
export interface ReimbursementUndo {title:string;command:Record<string,unknown>}
const money=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100)
/** An acknowledged canonical command, never a locally reconstructed ledger. */
export function reimbursementUndo(body:Record<string,unknown>,result:LedgerSnapshot):ReimbursementUndo|null {
 if(result.projectionPending||!result.resetState)return null
 const operation=body.operation
 if(operation==='reset'||operation==='undo_reset'||operation==='redo_reset'){
  const reset=result.resets?.find(r=>r.id===result.reset?.id)
  const restore=operation==='undo_reset'
  if(!reset||(restore?!reset.canRedo:!reset.canUndo))return null
  return {title:restore?'Reset undone':'Balances reset',command:{operation:restore?'redo_reset':'undo_reset',resetId:reset.id,version:reset.version}}
 }
 if(!['receive','receive_all','confirm_payment','offset','report_payment','report_all'].includes(String(operation))||!result.operationId)return null
 const events=result.events.filter(e=>e.status!=='reversed'&&(e.confirmationOperationId===result.operationId||e.operationId===result.operationId))
 if(!events.length)return null
 const total=events.reduce((n,e)=>n+e.amountCents,0),sent=operation==='report_payment'||operation==='report_all'
 return {title:operation==='offset'?money(total/2)+' offset each way':sent?'Payment reported':money(total)+' received',command:{operation:'reverse_operation',operationId:result.operationId,expectedState:result.resetState}}
}
