import type {RecordedTransaction} from './transactions-screen'
import type {TransactionChangeSummary} from './transaction-change-summary'
import {transactionMerchant,transactionText} from './transaction-identity'
import {recordedDays,recordedCategoryColors,type RecordedDay} from './recorded-transaction-view'
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)

/** Resolve only the animation target; canonical request IDs/rows stay untouched. */
export function undoPresentationTarget(before:RecordedTransaction[],after:RecordedTransaction[],id:string,summary:TransactionChangeSummary){
 if(after.some(row=>row.id===id))return id
 const source=before.find(row=>row.id===id)
 const known=new Set(before.map(row=>row.id))
 const matches=after.filter(row=>(!source||row.month===source.month&&row.kind===source.kind)&&!known.has(row.id)&&Object.entries(summary.after).every(([key,value])=>key==='amount'
  ?row.amountCents===Math.round(Number(value.replace(/[$,]/g,''))*100)
  :(row.fields[key]??'').trim()===value.trim())&&(!summary.restoration||row.categoryLabel===summary.restoration.restoredCategory))
 return matches.length===1?matches[0].id:undefined
}

/** Confirmed presentation only. The workspace stays locked until its fresh read. */
export function confirmedRows(items:RecordedTransaction[],id:string,summary:TransactionChangeSummary){
 return summary.operation==='delete'?items.filter(row=>row.id!==id):items.map(row=>{
  if(row.id!==id)return row
  const after=summary.after,category=summary.destination??row.category,amountCents=after.amount?Math.round(Number(after.amount.replace(/[$,]/g,''))*100):row.amountCents
  return {...row,fields:{...row.fields,...after},category,categoryLabel:category===row.category?row.categoryLabel:category,title:after.item||after.source||row.title,location:after.location??row.location,person:after.person??row.person,amountCents,...(row.displayAmountCents===undefined?{}:{displayAmountCents:row.displayAmountCents+amountCents-row.amountCents})}
 })
}
export function motionValues(items:RecordedTransaction[],days:RecordedDay[],aliases?:Record<string,string>){
 const values:Record<string,string>={},colors:Record<string,string>={}
 for(const group of recordedDays(items,days,'all')){
  values[`day:${group.year}-${group.month}-${group.day}:amount`]=money(Math.round((group.total??group.entries.reduce((sum,row)=>sum+row.amount,0))*100))
  for(const entry of group.entries){const text=transactionText(entry,transactionMerchant(entry,aliases)),key=`row:${entry.id}:`;Object.assign(values,{[key+'primary']:text.primary,[key+'category']:text.category,[key+'item']:text.item??'',[key+'amount']:money(Math.round(entry.amount*100))});colors[key+'category']=recordedCategoryColors[entry.category]}
 }
 return {values,colors}
}
export async function settledTransactionRow(product:HTMLElement|null,id:string){
 const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
 const group=product?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)?.closest<HTMLElement>('.bb-daily-day-group')
 await frame()
 for(let pass=0;pass<8;pass++){
  const running=group?.getAnimations({subtree:true}).filter(animation=>animation.playState==='running')??[]
  if(!running.length)break
  await Promise.allSettled(running.map(animation=>animation.finished));await frame()
 }
 await frame()
}
