import type {RecordedTransaction} from './transactions-screen'
import type {DailyTransaction} from './transaction-identity'
import type {DailyTransactionGroup} from './daily-transactions'

export interface RecordedDay {date:string;month:string;count:number;totalCents:number;needsCents:number;wantsCents:number}
export const displayedAmount=(row:RecordedTransaction)=>row.displayAmountCents??row.amountCents
export const spendingCategories:Record<string,string>={grocery:'Groceries',gas:'Gas',food:'Food',shopping:'Shopping',need_expenses:'Other needs',rent:'Rent',pge:'PG&E',water:'Water',recology:'Recology',static_bills_subscriptions_needs:'Subs (Needs)',subscriptions_wants:'Subs (Wants)'}
export function transactionFilter(value:string){
 return {scope:['income','savings'].includes(value)?'':'spending',kind:['income','savings'].includes(value)?value:'',bucket:['needs','wants'].includes(value)?value:'',category:value.startsWith('category:')?value.slice(9):'',split:value==='shared'?'shared':''}
}
export function recordedEntry(row:RecordedTransaction):DailyTransaction{
 const category=row.kind==='income'?'Income':row.kind==='savings'?'Savings':({grocery:'Grocery',gas:'Gas',food:'Food',shopping:'Shopping',need_expenses:'Other needs',rent:'Rent'}[row.category]??(row.kind==='subscription'?spendingCategories[row.category]:row.kind==='payment'?'Bills & Utilities':row.categoryLabel))
 return {id:row.id,date:row.date,item:row.fields.item||row.title,location:row.location,person:row.person,category,amount:displayedAmount(row)/100,status:'recorded',kind:row.kind as DailyTransaction['kind']}
}
export const recordedCategoryColors:Record<string,string>=Object.fromEntries(Object.entries({Grocery:'category-grocery',Gas:'category-gas',Food:'category-food',Shopping:'category-shopping','Other needs':'category-need',Rent:'category-rent','Bills & Utilities':'category-bills','Subs (Needs)':'category-subs-needs','Subs (Wants)':'category-subs-wants',Income:'success',Savings:'chart-3'}).map(([name,token])=>[name,`hsl(var(--${token}))`]))
export function recordedDays(rows:RecordedTransaction[],days:RecordedDay[],month:string):DailyTransactionGroup[]{
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]))
 const today=`${parts.year}-${parts.month}-${parts.day}`
 const grouped=new Map<string,RecordedTransaction[]>()
 for(const row of rows){const key=row.date||row.month+':undated';grouped.set(key,[...(grouped.get(key)??[]),row])}
 return [...grouped].map(([key,entries])=>{const period=entries[0].month,meta=days.find(d=>(d.date||d.month+':undated')===key);return{key,day:entries[0].date?String(Number(entries[0].date.slice(-2))):'No date',entries:entries.map(recordedEntry),today:key===today,count:meta?.count??entries.length,total:(meta?.totalCents??entries.reduce((sum,row)=>sum+displayedAmount(row),0))/100,year:Number(period.slice(0,4)),month:Number(period.slice(5)),caption:month==='all'?new Date(period+'-01T12:00:00').toLocaleDateString(undefined,{month:'short',year:'2-digit'}):undefined}})
}
export function recordedChart(days:RecordedDay[],month:string){
 return [...days].sort((a,b)=>(a.date||a.month+'-99').localeCompare(b.date||b.month+'-99')).map(day=>({label:day.date?(month==='all'?day.date:String(Number(day.date.slice(-2)))):month==='all'?day.month+':undated':'Undated',amount:day.totalCents/100,needsAmount:day.needsCents/100,wantsAmount:day.wantsCents/100}))
}

/** Calendar months ending in the selected report month; never paginate the graph. */
export function recordedChartWindow(days:RecordedDay[],endingMonth:string,months:number){
 const [year,month]=endingMonth.split('-').map(Number),end=year*12+month-1,start=end-months+1
 return recordedChart(days.filter(day=>{const [y,m]=day.month.split('-').map(Number),index=y*12+m-1;return index>=start&&index<=end}),'all')
}

export function recordedDateLabel(value:string,full=false){
 if(/^\d{4}-\d{2}(?:-\d{2}|:undated)$/.test(value)){
  const undated=value.endsWith(':undated'),date=new Date((undated?value.slice(0,7)+'-01':value)+'T12:00:00')
  return date.toLocaleDateString(undefined,{month:'short',...(!undated?{day:'numeric' as const}:{}),...(full?{year:'numeric' as const}:{})})+(undated?' · undated':'')
 }
 return full&&/^\d{1,2}$/.test(value)?'Day '+value:value
}
