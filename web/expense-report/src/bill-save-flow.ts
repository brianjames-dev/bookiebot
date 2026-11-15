import type {RecordedTransaction} from './transactions-screen'

export type BillCurrentChange={id:string;month:string;source:RecordedTransaction;adopt:boolean;amountChanged:boolean;splitChanged:boolean;blockedReason:string;target:{amountCents:number;method:string;payerCents:number;partnerCents:number;payerName:string;partnerName:string}}
type Command=Record<string,unknown>&{operation:string;requestId?:string}
type Write={kind:'bill'|'transaction';body:Command;result?:any}
export type BillSaveFlow={version:1;stage:'configuration'|'adopt'|'update'|'split'|'done';configuration?:Command;current?:BillCurrentChange;expected?:RecordedTransaction;pending?:Write;failed?:string;presentation?:unknown;rowOrder?:string[]}
type Request=(path:string,body?:unknown)=>Promise<any>
export const billFlowKey=(owner:string)=>`bookiebot:bill-flow:${owner.toLowerCase()}`
export const billFlow=(configuration?:Command,current?:BillCurrentChange):BillSaveFlow=>({version:1,stage:configuration?'configuration':current?.adopt?'adopt':'update',configuration,current,expected:current?.source})
const cents=(value:unknown)=>Math.round(Number(value)*100)
const method=(row:RecordedTransaction)=>row.split||'none'
const receipt=(row:RecordedTransaction)=>row.repayment?JSON.stringify([row.repayment.id,row.repayment.direction,row.repayment.accounting,row.repayment.settledCents,row.repayment.clearedCents,row.repayment.pendingCents]):''
const stable=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
function sameSource(row:RecordedTransaction,previous:RecordedTransaction,amount=previous.amountCents,split=method(previous),allowNewSplit=false){
 const canceled=split==='none'&&!row.repayment&&previous.repayment&&!previous.repayment.settledCents&&!previous.repayment.clearedCents&&!previous.repayment.pendingCents
 // A successful canonical split creates its first unpaid allocation. Accept
 // that postcondition only after our own split command, never on a fresh read
 // before writing or when money has been received/reported/cleared meanwhile.
 const created=allowNewSplit&&method(previous)==='none'&&!previous.repayment&&split!=='none'&&row.repayment?.direction==='incoming'&&row.repayment.accounting==='cash_v1'&&[row.repayment.settledCents,row.repayment.clearedCents,row.repayment.pendingCents].every(value=>value===0)
 if(row.month!==previous.month||row.date!==previous.date||row.amountCents!==amount||method(row)!==split||receipt(row)!==receipt(previous)&&!canceled&&!created)throw Error('The recorded charge changed. Review its current amount and split before continuing.')
}
function checkReview(value:any,row:RecordedTransaction){if(!value?.reviewVersion||value.item?.id!==row.id||value.item?.version!==row.version)throw Error('The recorded charge review changed. Reload it before saving.')}

/** One visible confirmation, existing individually claimed canonical writes.
 * Every exact command is durable before POST; recovery never invents a retry.
 * Each later operation rechecks the original/owned source and receipt facts. */
export async function runBillFlow(flow:BillSaveFlow,request:Request,persist:(flow:BillSaveFlow)=>void,{recover=false,retry=false}:{recover?:boolean;retry?:boolean}={}){
 const save=()=>persist(structuredClone(flow))
 const failed=(message:string):never=>{flow.failed=message;flow.pending=undefined;save();throw Error(message)}
 const verify=(row:RecordedTransaction,previous:RecordedTransaction,amount=previous.amountCents,split=method(previous),allowNewSplit=false)=>{try{sameSource(row,previous,amount,split,allowNewSplit)}catch(e){failed(e instanceof Error?e.message:'The saved charge needs inspection.')}}
 if(flow.failed)throw Error(flow.failed)
 save()
 const write=async(kind:Write['kind'],body:Command)=>{
  if(!flow.pending){flow.pending={kind,body:{...body,requestId:body.requestId??crypto.randomUUID()}};save()}
  const pending=flow.pending,url=pending.kind==='bill'?'/app/bills':'/app/transactions'
  if(!pending.result){
   let result:any
   try{result=await request(recover&&!retry?`${url}/commands/${encodeURIComponent(pending.body.requestId!)}`:url,recover&&!retry?undefined:pending.body)}
   catch(error){if((!recover||retry)&&[400,403,409].includes((error as {status?:number}).status??0))failed(error instanceof Error?error.message:'The confirmation was rejected.');throw error}
   recover=false;retry=false
   if(result.state!=='done')throw Error(result.detail||'Check saved status before continuing this change.')
   if(!result.success){flow.failed=result.detail||'The change could not be completed.';flow.pending=undefined;save();throw Error(flow.failed)}
   pending.result=result;save()
  }
  return pending.result
 }
 const advance=(stage:BillSaveFlow['stage'])=>{flow.stage=stage;flow.pending=undefined;save()}
 const charge=async()=>{
  const c=flow.current!,next=(await request(`/app/bills/${encodeURIComponent(c.id)}/charge?month=${c.month}`)).item as RecordedTransaction
  if(!next||next.month!==c.month||!next.version)throw Error('The recorded charge could not be verified.')
  return next
 }
 while(flow.stage!=='done'){
  if(flow.stage==='configuration'){
   const result=await write('bill',flow.configuration!)
   if(flow.current){
    if(!result.currentChange||stable(result.currentChange)!==stable(flow.current))failed('The recurring rule is saved, but the current-charge details need a fresh review.')
    flow.current=result.currentChange
   }
   advance(flow.current?(flow.current.adopt?'adopt':'update'):'done');continue
  }
  const current=flow.current!,target=current.target
  if(flow.stage==='adopt'){
   if(!flow.pending){
    const state=await request('/app/bills'),bill=state.bills?.find((b:any)=>b.id===current.id),info=bill?.charge
    if(!info?.virtual||info.month!==current.month||info.date!==current.source.date||info.billAmountCents!==current.source.amountCents)throw Error('The scheduled charge changed. Review it before saving.')
    const body={operation:'adopt',id:current.id,month:current.month,settingsVersion:state.settingsVersion,chargeVersion:info.version}
    const reviewed=(await request('/app/bills/review',body)).review
    if(reviewed.amountCents!==current.source.amountCents||reviewed.date!==current.source.date||reviewed.share?.method!=='none')throw Error('The scheduled charge preparation changed. Review it again.')
    flow.pending={kind:'bill',body:{...body,reviewVersion:reviewed.reviewVersion,requestId:crypto.randomUUID()}};save()
   }
   await write('bill',flow.pending.body)
   const next=await charge();verify(next,current.source)
   flow.expected=next;advance('update');continue
  }
  if(flow.stage==='update'){
   if(!flow.pending){
    const row=await charge();verify(row,flow.expected!)
    if(row.id!==flow.expected!.id||row.version!==flow.expected!.version)throw Error('The recorded charge changed. Review it again.')
    if(row.amountCents===target.amountCents){advance('split');continue}
    const body={operation:'update',id:row.id,month:row.month,version:row.version,updates:{amount:target.amountCents}}
    const reviewed=(await request('/app/transactions/review',body)).review;checkReview(reviewed,row)
    if(cents(reviewed.after?.amount)!==target.amountCents)throw Error('The reviewed amount does not match the bill change.')
    flow.pending={kind:'transaction',body:{...body,reviewVersion:reviewed.reviewVersion,requestId:crypto.randomUUID()}};save()
   }
   await write('transaction',flow.pending.body)
   const next=await charge();verify(next,flow.expected!,target.amountCents)
   flow.expected=next;advance('split');continue
  }
  if(flow.stage==='split'){
   if(!flow.pending){
    const row=await charge();verify(row,flow.expected!)
    if(row.id!==flow.expected!.id||row.version!==flow.expected!.version)throw Error('The recorded split changed. Review it again.')
    if(method(row)===target.method&&(target.method==='none'||row.splitOptions?.payerCents===target.payerCents)){advance('done');continue}
    const body={operation:target.method==='none'?'cancel_split':'split',id:row.id,month:row.month,version:row.version,...(target.method==='none'?{}:{method:target.method,...(target.method==='custom'?{payerShareCents:target.payerCents}:{})})}
    const reviewed=(await request('/app/transactions/review',body)).review;checkReview(reviewed,row)
    if(target.method!=='none'&&(reviewed.share?.method!==target.method||reviewed.share?.payerCents!==target.payerCents||reviewed.share?.partnerCents!==target.partnerCents))throw Error('The split shares changed. Review the new shares before saving.')
    flow.pending={kind:'transaction',body:{...body,reviewVersion:reviewed.reviewVersion,requestId:crypto.randomUUID()}};save()
   }
   await write('transaction',flow.pending.body)
   const next=await charge();verify(next,flow.expected!,target.amountCents,target.method,true)
   if(target.method!=='none'&&next.splitOptions?.payerCents!==target.payerCents)failed('The saved split needs verification. Check its current details.')
   flow.expected=next;advance('done')
  }
 }
 return flow
}
