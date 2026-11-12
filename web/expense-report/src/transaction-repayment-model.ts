import type {RecordedTransaction} from './transactions-screen'
import {splitMethodLabel,type SplitMethod} from './transaction-split-model'

export interface TransactionRepayment {
 id:string;version:number;direction:'incoming'|'outgoing';accounting:'cash_v1'|'legacy_net';payerName:string;partnerName:string
 grossCents:number;payerShareCents:number;partnerShareCents:number;settledCents:number;clearedCents:number;outstandingCents:number;pendingCents:number
 method:string;canEdit:boolean;editReason:string
}
export function validRepayment(value:any):value is TransactionRepayment {
 return !!value&&typeof value.id==='string'&&Number.isSafeInteger(value.version)&&value.version>0&&['incoming','outgoing'].includes(value.direction)
  &&['cash_v1','legacy_net'].includes(value.accounting)&&typeof value.payerName==='string'&&typeof value.partnerName==='string'&&typeof value.canEdit==='boolean'&&typeof value.editReason==='string'
  &&['income','equal','fronted','custom'].includes(value.method)
  &&['grossCents','payerShareCents','partnerShareCents','settledCents','clearedCents','outstandingCents','pendingCents'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)
  &&value.grossCents===value.payerShareCents+value.partnerShareCents&&value.partnerShareCents===value.settledCents+value.clearedCents+value.outstandingCents&&value.pendingCents<=value.outstandingCents
}
export const repaymentLabel=(row:RecordedTransaction)=>row.repayment?splitMethodLabel(row.repayment.method as SplitMethod,0,row.repayment.partnerName).replace(' · 0/100',''): 'Not split'
