const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire } = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const React = req('react'), Renderer = req('react-test-renderer'), ts = req('typescript'), {act} = Renderer
const h = React.createElement
// Execute production state/memo boundaries and callbacks with chart drawing and
// financial calculations replaced by counted leaves. This makes render work a
// deterministic regression contract rather than a machine-speed assertion.
global.IS_REACT_ACT_ENVIRONMENT = true
const source = fs.readFileSync(process.argv[2] || 'web/expense-report/src/report-app.tsx', 'utf8')
const file = ts.createSourceFile('report-app.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(['reportSpentTotal', 'ExpenseReportApp', 'OverviewCharts', 'DailySpendingCard', 'ExpenseInsightsCard',
  'MemoizedBurnRateChart', 'MemoizedCalendarAnalyticsPanel', 'MemoizedBillsUtilitiesPanel', 'MemoizedExpenseInsightsCard'])
const declarations = file.statements.filter(node => ts.isFunctionDeclaration(node) ? names.has(node.name?.text)
  : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.has(item.name.getText(file))))
const compiled = ts.transpileModule(declarations.map(node => node.getText(file)).join('\n') + '\nexports.Highlights = ExpenseInsightsCard', {
  compilerOptions: {target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText
const counts = {}, timers = new Map(); let serial = 0
const count = key => { counts[key] = (counts[key] || 0) + 1 }
const Navigation = React.createContext(null)
const window = {innerWidth:390,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
  setTimeout(callback, delay) { const id=++serial;timers.set(id,{callback,delay});return id }, clearTimeout(id) {timers.delete(id)},
}
window.requestAnimationFrame=callback=>window.setTimeout(callback,16)
window.cancelAnimationFrame=id=>window.clearTimeout(id)
const sourceTargets = []
const document = {querySelector:selector=>({focus(){},scrollIntoView(){sourceTargets.push(selector)}})}
const passthrough = ({children}) => h(React.Fragment,null,children)
const leaf = name => {const fn = props => { count(name);return h(TooltipProbe,{name}) };return fn}
const CategoryMixChartLeaf = leaf('category'), CategoryMixChart = React.memo(CategoryMixChartLeaf), CalendarAnalyticsPanel = leaf('calendar'), BurnRateChart = leaf('burn'), BillsUtilitiesPanel = leaf('bills')
const DailySpendingSection = leaf('daily'), TopExpensesChart = leaf('highlights'), MerchantChart = leaf('merchants')
const ChartCarouselNavigation = props => h('nav',null)
const DailySpendingFilterControl = props => h('daily-filter',null)
const Tabs = props => passthrough(props)
const ReportViews = {exports:{},require:req}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/report-view-preferences.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS},
}).outputText,ReportViews)
const chartFile = ts.createSourceFile('chart.tsx', fs.readFileSync('web/expense-report/src/components/ui/chart.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const chartNames = new Set(['ChartTooltipDismissContext','ChartTooltipDismissControllerContext','ChartTooltipDismissProvider','useChartTooltipDismiss'])
const chartDeclarations = chartFile.statements.filter(node => ts.isFunctionDeclaration(node) ? chartNames.has(node.name?.text)
  : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => chartNames.has(item.name.getText(chartFile))))
const chartRuntime = {exports:{},require:req,React}
vm.runInNewContext(ts.transpileModule(chartDeclarations.map(node=>node.getText(chartFile)).join('\n')+'\nexports.context=ChartTooltipDismissContext;exports.Provider=ChartTooltipDismissProvider;exports.dismiss=useChartTooltipDismiss',{
  compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText,chartRuntime)
const TooltipContext = chartRuntime.exports.context, ChartTooltipDismissProvider = chartRuntime.exports.Provider, useChartTooltipDismiss = chartRuntime.exports.dismiss, revisions = {}
function TooltipProbe({name}) { revisions[name] = React.useContext(TooltipContext); return h('leaf', {'data-kind':name}) }

const runtime = { exports:{}, require:req, window, document,
  memo:React.memo,useCallback:React.useCallback,useMemo:React.useMemo,useState:React.useState,useEffect:React.useEffect,useRef:React.useRef,
  useAppNavigation:()=>React.useContext(Navigation),useReportViewPreferences:ReportViews.exports.useReportViewPreferences,
  useExpenseReportTheme:()=>({theme:'light',toggleTheme:()=>{}}),useViewportScrollbarWidth:()=>{},
  buildReportView:(report,projected)=>{count('viewCalculation');return projected?report.projectedView:report.currentView},
  reportActivity:report=>{count('activityCalculation');return report.activity},
  filterDailyEntries:(entries,filter)=>{count('dailyCalculation');return filter==='all'?entries:entries.filter(e=>(['Food','Shopping'].includes(e.category)?'wants':'needs')===filter)},
  dailySpendingCalendarEvents:()=>[], dailyEntriesWithCalendarEvents:entries=>entries,
  dailyTotalsForEntries:()=>[],dailySpendingTotal:entries=>entries.reduce((sum,e)=>sum+e.amount,0),
  dailyEntryFilter:entry=>['Food','Shopping'].includes(entry.category)?'wants':'needs',
  amountRowsTotal:rows=>rows.reduce((sum,e)=>sum+e.amount,0),activitySummary:entries=>({total:entries.reduce((sum,e)=>sum+e.amount,0)}),
  roundCurrency:value=>Math.round(value*100)/100,
  activityMatchesCategory:(entry,item)=>entry.category===item.label,monthOnlyLabel:label=>label.split(' ')[0],
  expenseEntryItemLabel:entry=>{count('highlightLabels');return entry.item||entry.location||'Transaction'},
  CATEGORY_CHART_COLORS:{food:'red',grocery:'green'},CHART_CAROUSEL_GAP:16,clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
  isInteractiveTouchTarget:()=>false,
  CategoryMixChart,CalendarAnalyticsPanel,BurnRateChart,BillsUtilitiesPanel,DailySpendingSection,DailySpendingFilterControl,ChartCarouselNavigation,
  TopExpensesChart,MerchantChart,Tabs,ChartTooltipDismissProvider,useChartTooltipDismiss,
}
for(const name of ['Card','CardHeader','CardTitle','CardContent','ReportScreen','ReportMenu','TabsList','TabsTrigger','TabsContent','HiddenListPanel'])runtime[name]=passthrough
for(const name of ['MetricCard','RemainingCategoryBars','SavingsMetricCard','ReportBrand','ReportHeader','ThemeToggle','SharedReimbursementsCard','ReimbursementLedger','Investments','SavingsGoals','ReportQuestions','PhoneNotifications','ActivityDetails','MetricExplanationDetails','TopExpensesTable','MerchantOccurrencesTable'])runtime[name]=leaf(name)
runtime.ModalDetails=passthrough
runtime.FittedAmount=passthrough
runtime.generatedTimeLabel=()=>''
const swipeRuntime={exports:{},require:req,window,performance:{now:()=>0},ResizeObserver:class{observe(){} disconnect(){}}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/chart-swipe.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,swipeRuntime)
runtime.useChartSwipe=swipeRuntime.exports.useChartSwipe
vm.runInNewContext(compiled,runtime)
const App=runtime.exports.ExpenseReportApp
const activity=[{day:1,date:'10/1/2026',category:'Food',item:'Lunch',amount:12},{day:1,date:'10/1/2026',category:'Shopping',item:'Shirt',amount:30},{day:1,date:'10/1/2026',category:'Grocery',item:'Groceries',amount:20}]
const breakdown=[{key:'food',label:'Food',amount:42},{key:'grocery',label:'Grocery',amount:20}]
const view={metrics:{monthlyIncome:5000,totalExpenses:72,incomeAfterExpenses:4428,amountSaved:500,savingsMinimum:500,savingsIdeal:1000},breakdown,categoryBalances:{},categoryBudgets:{},calendarEvents:[],utilityHistory:[],burnRate:{}}
let report={ownerName:'Brian',year:2026,month:10,monthLabel:'October 2026',generatedAt:'2026-10-25',elapsedDays:25,dailyEntries:activity,activity,topEntries:activity,merchantOccurrences:[],currentView:view,projectedView:{...view,metrics:{...view.metrics,monthlyIncome:6000,totalExpenses:172,amountSaved:600}},burnRate:{},metricExplanations:{current:{spent:{value:72}},projected:{spent:{value:172}}}}
const appSession = {signOut:()=>{},signingOut:false}
let renderer
act(()=>{renderer=Renderer.create(h(App,{report,appSession}))})
assert.deepEqual(renderer.root.findAllByType('h2').map(title=>title.findByType(runtime.FittedAmount).props.children),['Category Mix','Burn Rate','Calendar','Bills & Utilities'],'Every sliding page owns its own heading')
const spentCard=()=>renderer.root.findAllByType(runtime.MetricCard).find(card=>card.props.label==='Spent')
assert.equal(spentCard().props.value,72,'Spent uses authoritative expenses without cash or ESPP savings')
assert.equal(renderer.root.findByType(CategoryMixChartLeaf).props.allSpentTotal,72,'Category Mix receives the same authoritative Current headline')
act(()=>spentCard().props.onExplain())
assert.equal(renderer.root.findByType(runtime.MetricExplanationDetails).props.detail.value,72,'The modal matches the canonical expense-only card')
assert.equal(renderer.root.findByType(runtime.MetricExplanationDetails).props.detail.view,view)
const snapshot=()=>({...counts})
const unchanged=(before,keys)=>keys.forEach(key=>assert.equal(counts[key],before[key],`${key} must stay untouched by an unrelated filter`))
let before=snapshot()
act(()=>renderer.root.findByType(CategoryMixChartLeaf).props.onFilterChange('wants'))
assert.equal(renderer.root.findByType(CategoryMixChartLeaf).props.filter,'wants')
assert.equal(revisions.category,1);assert.equal(revisions.daily,1);assert.equal(revisions.highlights,1)
unchanged(before,['viewCalculation','activityCalculation','dailyCalculation','daily','highlights','highlightLabels','calendar','burn','bills'])
before=snapshot()
act(()=>renderer.root.findByType(CalendarAnalyticsPanel).props.onFilterChange('subscription'))
unchanged(before,['viewCalculation','activityCalculation','dailyCalculation','daily','highlights','highlightLabels','category','burn','bills'])
before=snapshot()
act(()=>renderer.root.findByType(DailySpendingFilterControl).props.onFilterChange('wants'))
assert.equal(renderer.root.findByType(DailySpendingSection).props.entries.length,2)
assert.equal(revisions.daily,3);assert.equal(revisions.category,3);assert.equal(revisions.highlights,3)
unchanged(before,['viewCalculation','activityCalculation','highlights','highlightLabels','category','calendar','burn','bills'])
before=snapshot()
act(()=>renderer.root.findByType(Tabs).props.onValueChange('merchants'))
assert.equal(revisions.highlights,4);assert.equal(revisions.daily,4);assert.equal(revisions.category,4)
unchanged(before,['viewCalculation','activityCalculation','dailyCalculation','daily','highlightLabels','category','calendar','burn','bills'])
// Actual page-level changes must still recompute fresh values and inspections.
act(()=>renderer.root.findByType(runtime.ReportHeader).props.onToggle())
assert.equal(renderer.root.findAllByType(runtime.MetricCard)[0].props.value,6000)
assert.equal(spentCard().props.value,172,'Projected Spent uses its own expenses without Saved')
assert.equal(renderer.root.findByType(CategoryMixChartLeaf).props.allSpentTotal,172,'Category Mix receives the same Projected headline')
act(()=>spentCard().props.onExplain())
assert.equal(renderer.root.findByType(runtime.MetricExplanationDetails).props.detail.value,172)
assert.equal(revisions.highlights,5);assert.equal(revisions.daily,5);assert.equal(revisions.category,5)
assert.equal(counts.viewCalculation,before.viewCalculation+1)
assert.equal(counts.activityCalculation,before.activityCalculation+1)
assert.equal(renderer.root.findByType(CategoryMixChartLeaf).props.filter,'wants','Mode changes retain the chart filter')
assert.equal(renderer.root.findByType(DailySpendingSection).props.filter,'wants','Mode changes retain the daily bucket')
before=snapshot()
act(()=>renderer.root.findByType(DailySpendingSection).props.onInspectDay('1','Shopping'))
const detail=renderer.root.findByType(runtime.ActivityDetails).props
assert.deepEqual(detail.entries.map(e=>e.item),['Shirt'])
assert.equal(detail.total,30)
unchanged(before,['viewCalculation','activityCalculation','dailyCalculation','highlightLabels'])
const extra={day:1,date:'10/1/2026',category:'Shopping',item:'New item',amount:10}
report={...report,activity:[...activity,extra],dailyEntries:[...activity,extra]}
act(()=>renderer.update(h(App,{report,appSession})))
act(()=>renderer.root.findByType(DailySpendingSection).props.onInspectDay('1','Shopping'))
assert.deepEqual(renderer.root.findByType(runtime.ActivityDetails).props.entries.map(e=>e.item),['Shirt','New item'],'Refresh invalidates cached activity')
act(()=>renderer.root.findByType(runtime.ReportQuestions).props.onShowSource('categories'))
act(()=>{for(const [id,timer] of [...timers]) if(timer.delay===0){timers.delete(id);timer.callback()}})
assert.equal(renderer.root.findByType(ChartCarouselNavigation).props.activeIndex,0,'Ask source selection crosses the chart boundary')
assert.equal(sourceTargets.at(-1),'.bb-chart-carousel-band')
assert.ok([...timers.values()].every(timer=>timer.delay!==0),'Source selection is consumed only once')
act(()=>renderer.root.findByType(runtime.ReportQuestions).props.onShowSource('reimbursements'))
act(()=>{for(const [id,timer] of [...timers]) if(timer.delay===0){timers.delete(id);timer.callback()}})
assert.equal(sourceTargets.at(-1),'.bb-reimbursement-section','Standalone Ask retains reimbursement scrolling; the app routes it through Shared')
const nav=renderer.root.findByType(ChartCarouselNavigation)
act(()=>nav.props.onSelect(0))
assert.equal(renderer.root.findByType(ChartCarouselNavigation).props.activeIndex,0)
assert.equal(renderer.root.findByType(CategoryMixChartLeaf).props.filter,'wants','Changing graph preserves its local filter')
let carousel=renderer.root.findByProps({className:'bb-chart-carousel'})
act(()=>carousel.props.onTouchStartCapture({target:{},touches:[{clientX:250,clientY:100}]}))
act(()=>carousel.props.onTouchMoveCapture({stopPropagation(){},touches:[{clientX:40,clientY:104}]}))
assert.equal(renderer.root.findByType(ChartCarouselNavigation).props.activeIndex,0,'Dragging does not select/re-render the destination early')
act(()=>renderer.root.findByProps({className:'bb-chart-carousel'}).props.onTouchEndCapture({stopPropagation(){},changedTouches:[{clientX:40,clientY:104}]}))
assert.equal(renderer.root.findByType(ChartCarouselNavigation).props.activeIndex,1,'Horizontal swipes still select the next chart')
assert.equal(renderer.root.findByType(CategoryMixChartLeaf).props.filter,'wants')
act(()=>renderer.unmount())
assert.equal(timers.size,0,'Unmount releases carousel cooldown timers')
console.log('Overview render isolation: independent graph/daily/highlight filters, cached calculations, fresh modes/report and scoped day inspection passed')
