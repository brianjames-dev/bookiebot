import type {LedgerSnapshot,LedgerAllocation} from './reimbursement-ledger'
import {createAppResource} from './app-resource-state'

export const reimbursementDisplay=createAppResource<LedgerSnapshot>()
export const reimbursementLedgerState=createAppResource<{
 snapshot:LedgerSnapshot
 immediate?:ReimbursementDisplayChange
 acknowledgement?:{body:Record<string,unknown>;result:LedgerSnapshot}
}>()
export interface ReimbursementDisplayChange {
 allocations:(Pick<LedgerAllocation,'id'|'version'|'settledCents'|'outstandingCents'|'status'>&{clearedCents:number})[]
 eventIds:string[]
 reset?:{id:string;version:number;status:'active'|'undone'}
}
/** Only presentation changes here. Writers always receive the canonical snapshot. */
export function inverseDisplay(snapshot:LedgerSnapshot,body:Record<string,unknown>):ReimbursementDisplayChange|null {
 const action=body.operation==='queue_undo'?body.action:body.operation
 const byId=new Map(snapshot.allocations.map(row=>[row.id,row])),deltas=new Map<string,number>()
 let eventIds:string[]=[],reset:ReimbursementDisplayChange['reset']
 if(action==='reverse_operation'){
  const events=snapshot.events.filter(event=>event.operationId===body.operationId||event.confirmationOperationId===body.operationId)
  if(!events.length||events.some(event=>event.status==='reversed'))return null
  eventIds=events.map(event=>event.id)
  for(const event of events)if(event.status==='confirmed')deltas.set(event.allocationId,(deltas.get(event.allocationId)??0)-event.amountCents)
  for(const event of events)if(!deltas.has(event.allocationId))deltas.set(event.allocationId,0)
 }else if(action==='undo_reset'||action==='redo_reset'){
  const current=snapshot.resets?.find(reset=>reset.id===body.resetId)
  if(!current||current.version!==body.version||current.status!==(action==='undo_reset'?'active':'undone'))return null
  reset={id:current.id,version:current.version,status:action==='undo_reset'?'undone':'active'}
  for(const entry of current.entries)deltas.set(entry.allocationId,entry.amountCents*(action==='undo_reset'?-1:1))
 }else return null
 const allocations:ReimbursementDisplayChange['allocations']=[]
 for(const [id,delta]of deltas){
  const row=byId.get(id);if(!row||row.accounting!=='cash_v1')return null
  const settledCents=row.settledCents+(reset?0:delta),clearedCents=(row.clearedCents??0)+(reset?delta:0),outstandingCents=row.partnerShareCents-settledCents-clearedCents
  if([settledCents,clearedCents,outstandingCents].some(n=>!Number.isSafeInteger(n)||n<0))return null
  allocations.push({id,version:row.version,settledCents,clearedCents,outstandingCents,status:outstandingCents>0?'outstanding':clearedCents>0?'cleared':'settled'})
 }
 return {allocations,eventIds,...(reset?{reset}:{})}
}
export function validDisplayChange(value:unknown):value is ReimbursementDisplayChange {
 if(!value||typeof value!=='object')return false
 const change=value as ReimbursementDisplayChange
 return Array.isArray(change.allocations)&&change.allocations.length>0&&change.allocations.every(row=>Boolean(row.id)&&['outstanding','cleared','settled'].includes(row.status)&&[row.version,row.settledCents,row.clearedCents,row.outstandingCents].every(n=>Number.isSafeInteger(n)&&n>=0))
  &&Array.isArray(change.eventIds)&&change.eventIds.every(id=>typeof id==='string')
  &&(!change.reset||Boolean(change.reset.id)&&Number.isSafeInteger(change.reset.version)&&['active','undone'].includes(change.reset.status))
}
export function applyDisplayChange(snapshot:LedgerSnapshot,change:ReimbursementDisplayChange):LedgerSnapshot {
 if(!validDisplayChange(change)||change.allocations.some(expected=>!snapshot.allocations.some(row=>row.id===expected.id&&row.version===expected.version&&row.partnerShareCents===expected.settledCents+expected.clearedCents+expected.outstandingCents)||snapshot.displayAllocationIds?.includes(expected.id)))return snapshot
 const rows=new Map(change.allocations.map(row=>[row.id,row])),events=new Set(change.eventIds)
 return {...snapshot,displayPending:true,displayAllocationIds:[...new Set([...(snapshot.displayAllocationIds??[]),...rows.keys()])],projectionPending:true,
  allocations:snapshot.allocations.map(row=>rows.has(row.id)?{...row,...rows.get(row.id)}:row),
  events:snapshot.events.map(event=>events.has(event.id)?{...event,status:'reversed'}:event),
  resets:snapshot.resets?.map(reset=>reset.id===change.reset?.id?{...reset,status:change.reset.status,canUndo:false,canRedo:false}:reset),
 }
}
export function pendingDisplay(snapshot:LedgerSnapshot):LedgerSnapshot {
 return (snapshot.undoJobs??[]).reduce((view,job)=>job.status==='queued'&&job.display?applyDisplayChange(view,job.display):view,snapshot)
}

/** One accepted ledger and one presentation for all of this owner's tabs. */
export function publishReimbursementSnapshot(snapshot:LedgerSnapshot, options:{
 immediate?:ReimbursementDisplayChange
 body?:Record<string,unknown>
}={}) {
 const {ownerKey}=snapshot
 const acknowledgement=options.body?{body:options.body,result:snapshot}:reimbursementLedgerState.read(ownerKey)?.acknowledgement
 reimbursementDisplay.publish(ownerKey,options.immediate?applyDisplayChange(snapshot,options.immediate):pendingDisplay(snapshot))
 reimbursementLedgerState.publish(ownerKey,{snapshot,immediate:options.immediate,acknowledgement})
}

export function clearReimbursementSnapshot(owner:string) {
 reimbursementLedgerState.clear(owner)
 reimbursementDisplay.clear(owner)
}
