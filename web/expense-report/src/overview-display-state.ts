import type {LedgerAllocation,LedgerEvent,LedgerSnapshot} from './reimbursement-ledger'
import type {BreakdownItem,BurnRate,CalendarEvent,ExpenseEntry,ExpenseReportData,ReportModeView} from './types'
import {cascadeCategoryBalances,projectedBurnRateFromIncome} from './report-financial-math'
import {billLabelKey} from './bill-comparison'
import {activityDay} from './report-activity'

type Allocation=Pick<LedgerAllocation,'id'|'payerOwner'|'partnerOwner'|'payerPerson'|'item'|'location'|'expenseDate'|'category'|'grossCents'|'partnerShareCents'|'settledCents'|'clearedCents'|'outstandingCents'|'version'|'accounting'|'sourceYear'|'sourceSheetTitle'|'sourceWorksheet'|'lifecycle'>
type Event=Pick<LedgerEvent,'id'|'allocationId'|'kind'|'amountCents'|'status'|'date'>
interface Bill {allocationId:string;label:string;displayName:string;group:string;payer:boolean;dueDate:string;schedulePaid:boolean;currentEligible:boolean;date:string;forecast:boolean;forecastDate:string;historyAtZero?:boolean;historyTemplate?:ExpenseReportData['utilityHistory'][number]}
export interface OverviewBasis {ownerKey:string;period:string;asOf:string;versions:Record<string,number>;allocations:Allocation[];events:Event[];bills:Bill[];categories:Record<string,{label:string;color:string;hasItem?:boolean}>}
interface Cash {id:string;allocationId:string;group:string;date:string;current:number;projected:number;entry?:ExpenseEntry;calendar?:CalendarEvent}
const money=(n:number)=>Math.round((n+Number.EPSILON)*100)/100
const wants=(group:string)=>['food','shopping','subscriptions_wants'].includes(group)
const monthOf=(a:Allocation)=>a.sourceYear&&a.sourceSheetTitle?`${a.sourceYear}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(a.sourceSheetTitle)+1).padStart(2,'0')}`:a.expenseDate.slice(0,7)
function advanceBasis(basis:OverviewBasis,snapshot:LedgerSnapshot):OverviewBasis{
 const live=new Map(snapshot.allocations.filter(a=>a.accounting==='cash_v1'&&a.version>=(basis.versions[a.id]??Infinity)).map(a=>[a.id,a]))
 return {...basis,versions:{...basis.versions,...Object.fromEntries([...live].map(([id,a])=>[id,a.version]))},allocations:basis.allocations.map(a=>({...a,...live.get(a.id)})),events:[...basis.events.filter(e=>!live.has(e.allocationId)),...snapshot.events.filter(e=>live.has(e.allocationId))]}
}
function cashView(basis:OverviewBasis,snapshot?:LedgerSnapshot):Cash[]{
 if(snapshot)basis=advanceBasis(basis,snapshot)
 const allocations=basis.allocations,byId=new Map(allocations.map(a=>[a.id,a])),events=basis.events
 const result:Cash[]=[]
 for(const a of allocations){
  if(a.accounting!=='cash_v1'||a.lifecycle&&a.lifecycle!=='active')continue
  if(a.payerOwner===basis.ownerKey&&a.sourceWorksheet==='expense'&&monthOf(a)===basis.period){
   const amount=a.grossCents-a.settledCents,id='source:'+a.id
   result.push({id,allocationId:a.id,group:a.category,date:a.expenseDate,current:amount,projected:amount,entry:{canonicalCashId:id,date:a.expenseDate,category:basis.categories[a.category]?.label??a.category,amount:amount/100,person:a.payerPerson,item:basis.categories[a.category]?.hasItem?a.item:'',location:a.location}})
  }
 }
 for(const e of events){const a=byId.get(e.allocationId);if(!a||a.accounting!=='cash_v1'||a.lifecycle&&a.lifecycle!=='active'||a.partnerOwner!==basis.ownerKey||a.sourceWorksheet!=='expense'||!e.date.startsWith(basis.period))continue
  const amount=e.status==='confirmed'?e.amountCents:0,id='receipt:'+e.id,group=basis.categories[a.category]?a.category:'need_expenses',prefix=e.kind==='offset'?'Offset':'Reimbursement'
  result.push({id,allocationId:a.id,group,date:e.date,current:amount,projected:amount,entry:{canonicalCashId:id,date:e.date,category:basis.categories[group]?.label??group,amount:amount/100,person:basis.ownerKey==='brian'?'Brian (BofA)':'Hannah',item:basis.categories[group]?.hasItem?`${prefix} · ${a.item}`:'',location:`${prefix} to ${a.payerOwner[0].toUpperCase()+a.payerOwner.slice(1)} · ${a.location}`}})
 }
 for(const b of basis.bills){const a=byId.get(b.allocationId);if(!a||a.accounting!=='cash_v1')continue
  const paid=events.filter(e=>e.allocationId===a.id&&e.status==='confirmed'&&e.date<=basis.asOf),total=paid.reduce((n,e)=>n+e.amountCents,0),latest=paid.map(e=>e.date).sort().slice(-1)[0]
  const received=Boolean(!b.payer&&a.settledCents>0&&a.partnerShareCents>0&&a.expenseDate<=basis.asOf&&monthOf(a)===a.expenseDate.slice(0,7)&&total===a.settledCents&&latest?.startsWith(basis.period))
  const eligible=b.payer?b.schedulePaid:b.schedulePaid||received,date=received?latest!:b.dueDate,amount=b.payer?a.grossCents-a.settledCents:a.settledCents,id='bill:'+a.id
  result.push({id,allocationId:a.id,group:b.group,date,current:eligible?amount:0,projected:amount,calendar:date.startsWith(basis.period)?{canonicalCashId:id,kind:'bill',label:b.displayName,amount:amount/100,day:Number(date.slice(8)),group:b.group,projectedOnly:!eligible}:undefined})
  if(!b.payer&&b.forecast){const id='bill:'+a.id+':forecast',amount=a.outstandingCents
   result.push({id,allocationId:a.id,group:b.group,date:b.forecastDate,current:0,projected:amount,calendar:b.forecastDate.startsWith(basis.period)?{canonicalCashId:id,kind:'bill',label:b.displayName,amount:amount/100,day:Number(b.forecastDate.slice(8)),group:b.group,projectedOnly:true,sharedBillForecast:true}:undefined})
  }
 }
 return result.filter(c=>c.current||c.projected).sort((a,b)=>a.id.localeCompare(b.id))
}
function differences(before:Cash[],after:Cash[],mode:'current'|'projected'){
 const result=new Map<string,number>()
 for(const [rows,sign]of [[before,-1],[after,1]] as const)for(const row of rows)result.set(row.group,(result.get(row.group)??0)+sign*row[mode])
 return result
}
function breakdown(items:BreakdownItem[],delta:Map<string,number>,basis:OverviewBasis){
 const values=new Map(items.map(item=>[item.key,{...item}]))
 for(const [key,change]of delta){if(!change)continue;const item=values.get(key)??{key,label:basis.categories[key]?.label??key,color:basis.categories[key]?.color??'#64748b',amount:0,percentage:0};values.set(key,{...item,amount:money(item.amount+change/100)})}
 const total=[...values.values()].reduce((n,i)=>n+i.amount,0)
 return [...values.values()].filter(i=>i.amount>0).map(i=>({...i,percentage:total?money(i.amount/total*100):0}))
}
function burnRate(report:ExpenseReportData,spent:number):BurnRate|null{
 const old=report.burnRate;if(!old)return null
 const days=new Map<number,number>(),discretionary=Math.max(0,money(spent-(report.breakdown.find(i=>i.key==='subscriptions_wants')?.amount??0)))
 for(const entry of report.dailyEntries){if(!['Food','Shopping'].includes(entry.category))continue;const day=activityDay(entry.date,report.year,report.month);if(day!==null)days.set(day,(days.get(day)??0)+entry.amount)}
 const raw=[...days.values()].reduce((a,b)=>a+b,0)
 if(raw>0){for(const [day,amount]of days)days.set(day,money(amount*discretionary/raw));const last=Math.max(...days.keys());days.set(last,money(days.get(last)!+discretionary-[...days.values()].reduce((a,b)=>a+b,0)))}else if(discretionary&&old.elapsedDays)days.set(old.elapsedDays,discretionary)
 let scheduled=0
 for(const event of report.calendarEvents)if(event.kind==='subscription'&&event.group==='subscriptions_wants'&&!event.projectedOnly&&event.day<=old.elapsedDays){days.set(event.day,money((days.get(event.day)??0)+event.amount));scheduled+=event.amount}
 const remainder=money((report.breakdown.find(i=>i.key==='subscriptions_wants')?.amount??0)-scheduled)
 if(remainder>0&&old.elapsedDays)days.set(old.elapsedDays,money((days.get(old.elapsedDays)??0)+remainder))
 if(days.size){const last=Math.max(...days.keys());days.set(last,money(days.get(last)!+spent-[...days.values()].reduce((a,b)=>a+b,0)))}
 let actual=0
 return {...old,spent,series:old.series.map(point=>{const daily=money(days.get(point.day)??0);actual=money(actual+daily);return {...point,dailySpend:daily,actualSpend:actual,variance:money(actual-point.expectedSpend)}})}
}
function view(old:ReportModeView,items:BreakdownItem[],delta:Map<string,number>,burn:BurnRate|null){
 const needs=[...delta].filter(([k])=>!wants(k)).reduce((n,[,v])=>n+v,0)/100,want=[...delta].filter(([k])=>wants(k)).reduce((n,[,v])=>n+v,0)/100
 const spending={...old.categorySpending,needs:money(old.categorySpending.needs+needs),wants:money(old.categorySpending.wants+want)}
 const balances=cascadeCategoryBalances({needs:money(old.categoryBudgets.needs-spending.needs),wants:money(old.categoryBudgets.wants-spending.wants),savings:money(old.categoryBudgets.savings-spending.savings)})
 return {...old,metrics:{...old.metrics,totalExpenses:money(old.metrics.totalExpenses+needs+want),incomeAfterExpenses:money(Object.values(balances.remaining).reduce((a,b)=>a+b,0))},categorySpending:spending,categoryBalances:balances,breakdown:items,burnRate:projectedBurnRateFromIncome(burn,balances)}
}
export function overviewComparisonDelta(basis:OverviewBasis|undefined,snapshot:LedgerSnapshot|null,mode:'current'|'projected',throughDay:number){
 if(!basis||!snapshot||snapshot.ownerKey!==basis.ownerKey)return 0
 const total=(rows:Cash[])=>rows.filter(row=>!row.date||Number(row.date.slice(8))<=throughDay).reduce((n,row)=>n+row[mode],0)
 return (total(cashView(basis,snapshot))-total(cashView(basis)))/100
}
/** Presentation only. Raw reports and every financial command remain untouched. */
export function displayOverview(report:ExpenseReportData|null,snapshot:LedgerSnapshot|null):ExpenseReportData|null{
 const basis=report?.reimbursementBasis
 if(!report||!basis||!snapshot||snapshot.ownerKey!==basis.ownerKey||!report.modeViews)return report
 const before=cashView(basis),after=cashView(basis,snapshot)
 if(JSON.stringify(before)===JSON.stringify(after))return report
 const current=differences(before,after,'current'),projected=differences(before,after,'projected'),ids=new Set([...before,...after].map(r=>r.id))
 const previous=new Map(report.dailyEntries.filter(e=>e.canonicalCashId).map(e=>[e.canonicalCashId,e]))
 const entries=[...report.dailyEntries.filter(e=>!ids.has(e.canonicalCashId??'')),...after.filter(c=>c.entry&&c.current>0).map(c=>({...c.entry!,date:previous.get(c.id)?.date??c.entry!.date}))].sort((a,b)=>(activityDay(b.date,report.year,report.month)??0)-(activityDay(a.date,report.year,report.month)??0)||b.amount-a.amount)
 const calendar=[...report.calendarEvents.filter(e=>!ids.has(e.canonicalCashId??'')),...after.filter(c=>c.calendar&&c.projected>0).map(c=>c.calendar!)]
 const changed={...report,reimbursementBasis:advanceBasis(basis,snapshot),dailyEntries:entries,calendarEvents:calendar,breakdown:breakdown(report.breakdown,current,basis),budgetBreakdown:breakdown(report.budgetBreakdown??report.breakdown,projected,basis)}
 const spent=money(changed.breakdown.filter(i=>wants(i.key)).reduce((n,i)=>n+i.amount,0)),burn=burnRate(changed,spent)
 const views={current:view(report.modeViews.current,changed.breakdown,current,burn),projected:view(report.modeViews.projected,changed.budgetBreakdown,projected,burn)}
 for(const v of Object.values(views))v.calendarEvents=calendar
 const histories=(items:ExpenseReportData['utilityHistory'],utility:boolean)=>{
  const values=new Map(items.map(item=>[billLabelKey(item.label),item]))
  for(const context of basis.bills){
   if(utility?context.group!=='bills_utilities':!['rent','bills_utilities','static_bills_subscriptions_needs'].includes(context.group))continue
   const key=billLabelKey(context.displayName),id='bill:'+context.allocationId,amount=(after.find(c=>c.id===id)?.current??0)/100,entered=(after.find(c=>c.id===id)?.projected??0)>0
   const old=values.get(key)??values.get(billLabelKey(context.label))??context.historyTemplate
   if(!old)continue
   if(!entered&&!context.historyAtZero){values.delete(billLabelKey(old.label));continue}
   const prior=old.history.some(point=>point.month<report.month&&point.amount!==null&&point.amount>0)
   const pointAmount=amount||basis.period<basis.asOf.slice(0,7)?amount:null
   values.set(billLabelKey(old.label),{...old,currentAmount:amount,deltaAmount:prior?money(amount-old.averageAmount):0,history:old.history.map(point=>point.month===report.month?{...point,amount:pointAmount}:point)})
  }
  return [...values.values()].sort((a,b)=>a.label.localeCompare(b.label))
 }
 changed.utilityHistory=histories(report.utilityHistory,true);if(report.billComparisonHistory)changed.billComparisonHistory=histories(report.billComparisonHistory,false)
 for(const v of Object.values(views)){v.utilityHistory=changed.utilityHistory;v.billComparisonHistory=changed.billComparisonHistory}
 const raw=views.current.categoryBalances.raw
 changed.modeViews=views;changed.burnRate=views.current.burnRate;changed.categoryBalances=views.current.categoryBalances;changed.categorySpending=views.current.categorySpending
 const currentTotal=[...current.values()].reduce((n,v)=>n+v,0)/100,sharedDelta=[...after].filter(c=>c.entry).reduce((n,c)=>n+c.current,0)-before.filter(c=>c.entry).reduce((n,c)=>n+c.current,0)
 changed.metrics={...report.metrics,totalExpenses:views.current.metrics.totalExpenses,personalOutflows:money(report.metrics.personalOutflows+currentTotal),sharedExpenses:money(report.metrics.sharedExpenses+sharedDelta/100),fixedCommitments:money(changed.breakdown.filter(i=>['rent','bills_utilities','static_bills_subscriptions_needs','subscriptions_wants'].includes(i.key)).reduce((n,i)=>n+i.amount,0)),incomeAfterExpenses:views.current.metrics.incomeAfterExpenses,remainingBudget:raw.needs,remainingNeedsBudget:raw.needs,remainingWantsBudget:raw.wants,remainingSavingsBudget:raw.savings}
 const aggregate=(key:(entry:ExpenseEntry)=>string)=>{const values=new Map<string,number>();for(const e of entries)values.set(key(e),money((values.get(key(e))??0)+e.amount));return [...values].map(([label,amount])=>({label,amount})).sort((a,b)=>b.amount-a.amount)}
 changed.dailyTotals=aggregate(e=>e.date);changed.personTotals=aggregate(e=>e.person);changed.merchantTotals=aggregate(e=>e.location||e.item).slice(0,10)
 changed.merchantOccurrences=changed.merchantTotals.map(item=>({...item,count:entries.filter(e=>(e.location||e.item)===item.label).length}))
 changed.budgetGroups=[{label:'Needs',amount:changed.categorySpending.needs},{label:'Wants',amount:changed.categorySpending.wants}]
 changed.topEntries=[...report.topEntries.filter(e=>!ids.has(e.canonicalCashId??'')),...after.filter(c=>c.current>0&&c.group!=='rent').map(c=>c.entry??{canonicalCashId:c.id,date:c.date,category:basis.categories[c.group]?.label??c.group,amount:c.current/100,person:report.ownerName,item:c.calendar?.label??'',location:''})].sort((a,b)=>b.amount-a.amount)
 if(report.metricExplanations){changed.metricExplanations={...report.metricExplanations};for(const mode of ['current','projected'] as const){const old=report.metricExplanations[mode],v=views[mode];changed.metricExplanations[mode]={...old,spent:{...old.spent,value:v.metrics.totalExpenses,components:v.breakdown.map(i=>({label:i.label,amount:i.amount,source:'calculated'}))},left:{...old.left,value:v.metrics.incomeAfterExpenses,components:Object.entries(v.categoryBalances.remaining).map(([key,amount])=>({label:key[0].toUpperCase()+key.slice(1)+' remaining',amount,source:'calculated'})),notes:old.left.notes.slice(0,1)}}}}
 return changed
}
