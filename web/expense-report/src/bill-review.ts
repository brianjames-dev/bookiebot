import type {Bill} from './bill-settings'
import type {BillCurrentChange} from './bill-save-flow'
export const billMoney=(cents:number|null|undefined)=>cents==null?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
export const billMonth=(value:string)=>new Date(value+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})
const types={subscription:'Subscription',fixed:'Fixed bill',variable:'Variable bill'}
const categories:Record<string,string>={rent:'Rent',bills_utilities:'Bills & utilities',static_bills_subscriptions_needs:'Needs',subscriptions_wants:'Wants'}
export type BillReviewLine={label:string;before:string|null;after:string}
export const splitLabel=(bill:Pick<Bill,'splitMethod'|'payerBasisPoints'>)=>bill.splitMethod==='none'?'No split':bill.splitMethod==='income'?'By income':bill.splitMethod==='equal'?'50 / 50':bill.splitMethod==='fronted'?'Fronted':`${bill.payerBasisPoints/100}% / ${100-bill.payerBasisPoints/100}%`
export function billReviewLines(before:Bill|null|undefined,after:Bill,operation:string):BillReviewLine[]{
 const lines:BillReviewLine[]=[]
 const add=(label:string,old:string|undefined,value:string,always=false)=>{if(always||old!==value)lines.push({label,before:old??null,after:value})}
 if(operation==='end')return [{label:'Stops',before:null,after:billMonth(after.effectiveFrom)+' onward'}]
 if(operation==='restore-end')return [{label:'Status',before:'Ended',after:after.active?'Active':'Restored'}]
 if(operation==='delete')return [{label:'Status',before:'Active',after:'Stopped'},{label:'Stops',before:null,after:billMonth(after.effectiveFrom)+' onward'}]
 add('Name',before?.name,after.name)
 add('Type',before?types[before.type]:undefined,types[after.type])
 add(after.type==='variable'?'Estimate':'Recurring amount',before?billMoney(before.amountCents):undefined,billMoney(after.amountCents))
 add('Repeats',before?.cadence,after.cadence)
 add('Payment day',before?String(before.pullDay??'Not set'):undefined,String(after.pullDay??'Not set'))
 if(after.cadence!=='monthly')add(after.cadence==='yearly'?'Billing month':'First billing month',before?.cadence===after.cadence?new Date(2026,Math.min(...before.pullMonths)-1,1).toLocaleDateString('en-US',{month:'long'}):undefined,new Date(2026,Math.min(...after.pullMonths)-1,1).toLocaleDateString('en-US',{month:'long'}))
 add('Budget category',before?categories[before.category]??before.category:undefined,categories[after.category]??after.category)
 add('Account',before?before.account||'Not set':undefined,after.account||'Not set')
 add('Recurring split',before?splitLabel(before):undefined,splitLabel(after))
 if(before&&!before.active&&after.active)add('Status','Stopped','Active')
 add('Applies from',undefined,billMonth(after.effectiveFrom)+' onward',true)
 return lines
}
export function currentReviewLines(change:BillCurrentChange):BillReviewLine[]{
 const {source,target}=change,lines:BillReviewLine[]=[]
 if(change.amountChanged)lines.push({label:'Recorded amount',before:billMoney(source.amountCents),after:billMoney(target.amountCents)})
 if(change.splitChanged){
  const labels:Record<string,string>={none:'No split',income:'By income',equal:'50 / 50',custom:'Custom split',fronted:'Fronted'}
  if((source.split||'none')!==target.method)lines.push({label:'Recorded split',before:labels[source.split||'none'],after:labels[target.method]})
  lines.push({label:target.payerName,before:billMoney(source.splitOptions?.payerCents??source.amountCents),after:billMoney(target.payerCents)})
  lines.push({label:target.partnerName,before:billMoney(source.amountCents-(source.splitOptions?.payerCents??source.amountCents)),after:billMoney(target.partnerCents)})
 }
 return lines
}
