import type {LedgerSnapshot,LedgerAllocation} from './reimbursement-ledger'
import type {Listing,RecordedTransaction} from './transactions-screen'
import type {RecordedDay} from './recorded-transaction-view'

export interface RepaymentRowState {id:string;allocationId:string;eventId?:string;allocationVersion?:number;cashKind:'purchase'|'context'|'bill'|'receipt';date:string;month:string;category:string;amountCents:number;index:number}
const pending=(snapshot:LedgerSnapshot,row:LedgerAllocation)=>Boolean(snapshot.displayAllocationIds?.includes(row.id)||row.version!==row.projectedVersion)
function cash(row:RepaymentRowState,snapshot:LedgerSnapshot):number|null {
 const allocation=snapshot.allocations.find(a=>a.id===row.allocationId)
 if(!allocation||allocation.accounting!=='cash_v1'||(row.allocationVersion??0)>allocation.version)return row.amountCents
 if(row.eventId){const event=snapshot.events.find(e=>e.id===row.eventId);return event?(event.status==='confirmed'?event.amountCents:null):row.amountCents}
 if(row.cashKind==='context')return 0
 return row.cashKind==='bill'?allocation.settledCents:allocation.grossCents-allocation.settledCents
}
export function rowState(row:RecordedTransaction,index:number):RepaymentRowState|null {
 const id=row.canonicalAllocationId??row.repayment?.id
 return id?{id:row.id,allocationId:id,eventId:row.canonicalEventId,allocationVersion:row.canonicalAllocationVersion??row.repayment?.version,cashKind:row.canonicalEventId?'receipt':row.contextOnly?'context':row.canonicalBillCash?'bill':'purchase',date:row.date,month:row.month,category:row.category,amountCents:row.contextOnly?0:row.displayAmountCents??row.amountCents,index}:null
}
export function displayTransaction(row:RecordedTransaction,snapshot:LedgerSnapshot):RecordedTransaction|null {
 const state=rowState(row,0),allocation=state&&snapshot.allocations.find(a=>a.id===state.allocationId)
 if(!state||!allocation||allocation.accounting!=='cash_v1'||(state.allocationVersion??0)>allocation.version)return row
 const amount=cash(state,snapshot);if(amount===null)return null
 const locked=pending(snapshot,allocation)
 const repayment=row.repayment?{...row.repayment,version:allocation.version,grossCents:allocation.grossCents,payerShareCents:allocation.payerShareCents,partnerShareCents:allocation.partnerShareCents,settledCents:allocation.settledCents,clearedCents:allocation.clearedCents??0,outstandingCents:allocation.outstandingCents,method:allocation.method,pendingCents:snapshot.events.filter(e=>e.allocationId===allocation.id&&e.status==='pending').reduce((n,e)=>n+e.amountCents,0),...(locked?{canEdit:false,editReason:'This entry is being updated.'}:{})}:undefined
 return {...row,displayAmountCents:state.cashKind==='context'?allocation.settledCents:amount,...(repayment?{repayment}:{}),...(locked?{capabilities:Object.fromEntries(Object.keys(row.capabilities).map(key=>[key,false])) as RecordedTransaction['capabilities']}:{} )}
}
export function displayDays(days:RecordedDay[],rows:RepaymentRowState[],snapshot:LedgerSnapshot):RecordedDay[]{
 const updates=new Map<string,{amount:number;count:number;wants:number;needs:number}>()
 for(const row of rows){const next=cash(row,snapshot),delta=(next??0)-row.amountCents;if(!delta&&next!==null)continue
  const key=row.date||row.month+':undated',change=updates.get(key)??{amount:0,count:0,wants:0,needs:0};change.amount+=delta;change.count+=next===null?-1:0;change[['food','shopping','subscriptions_wants'].includes(row.category)?'wants':'needs']+=delta;updates.set(key,change)
 }
 return days.map(day=>{const delta=updates.get(day.date||day.month+':undated');return delta?{...day,totalCents:day.totalCents+delta.amount,count:day.count+delta.count,wantsCents:day.wantsCents+delta.wants,needsCents:day.needsCents+delta.needs}:day}).filter(day=>day.count>0)
}
export function displayListing(listing:Listing|null,snapshot:LedgerSnapshot|null):Listing|null {
 if(!listing||!snapshot)return listing
 const rows=listing.repaymentRows??listing.items.flatMap((row,index)=>{const state=rowState(row,index);return state?[state]:[]})
 if(!rows.length)return listing
 const listRows=listing.repaymentListRows??rows
 const removed=listRows.filter(row=>cash(row,snapshot)===null),delta=rows.reduce((n,row)=>n+(cash(row,snapshot)??0)-row.amountCents,0)
 return {...listing,items:listing.items.flatMap(row=>{const shown=displayTransaction(row,snapshot);return shown?[shown]:[]}),
  total:listing.total-removed.length,nextOffset:listing.nextOffset===null?null:listing.nextOffset-removed.filter(row=>row.index<listing.nextOffset!).length,
  days:listing.days?displayDays(listing.days,rows,snapshot):undefined,
  listDays:listing.listDays?displayDays(listing.listDays,listing.repaymentListRows??rows,snapshot):undefined,
  totalAmountCents:listing.totalAmountCents===undefined?undefined:listing.totalAmountCents+delta,
 }
}
