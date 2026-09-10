const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const path = require('node:path')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript')
const {renderToStaticMarkup} = req('react-dom/server')
const names = new Set([
  'projectedBreakdown','projectedSubscriptionTotals','projectedBillTotals',
  'subscriptionDayInMonth','roundCurrency','amountRowsTotal',
  'dailyEntriesWithCalendarEvents','dailyCalendarEventBucket','billsUtilitiesEvents',
  'money','formatMoney','CATEGORY_CHART_COLORS','CALENDAR_EVENT_STYLES',
  'calendarEventLabel','calendarEventStyle','calendarEventKindLabel',
  'calendarEventKey','CalendarEventTooltip','FixedBillItemsTable',
])
const source = fs.readFileSync('web/expense-report/src/report-app.tsx','utf8')
const file = ts.createSourceFile('report-app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const declarations = file.statements.filter(node =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d=>names.has(d.name.getText(file))))
assert.equal(declarations.length,names.size)
const activityFile = ts.createSourceFile('report-activity.ts',fs.readFileSync('web/expense-report/src/report-activity.ts','utf8'),ts.ScriptTarget.Latest,true)
const activityDeclarations = activityFile.statements.filter(node => ts.isFunctionDeclaration(node) && ['calendarActivityCategory','calendarActivityStatus'].includes(node.name?.text))
const runtime = vm.createContext({exports:{}, require:req, Date})
vm.runInContext(ts.transpileModule([
  ...activityDeclarations.map(node=>node.getText(activityFile).replace('export ','')),
  ...declarations.map(node=>node.getText(file)),
].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
const loan = {kind:'bill',group:'static_bills_subscriptions_needs',label:'Student Loan',amount:59.96,day:12,projectedOnly:true,amountEstimated:true}
const actual = {...loan,amount:119.92,amountEstimated:false}
const utility = {...loan,label:'Water',group:'bills_utilities',amount:25,amountEstimated:false}
const rows = (fixed=59.96,bills=110) => [
  {key:'static_bills_subscriptions_needs',amount:fixed},
  {key:'bills_utilities',amount:bills},
  {key:'rent',amount:2000},
]
const report = {
  year:2026,month:9,breakdown:rows(0),
  subscriptionsNeeds:[{name:'Internet',amount:60,cadence:'monthly',pullDay:18}],subscriptionsWants:[],
  utilityHistory:[{label:'Water',currentAmount:25}],calendarEvents:[loan,utility],
}
const amount = (values,key) => values.find(item=>item.key===key).amount
const staticKey = loan.group
const canonical = rows(119.96,169.96)
const full = runtime.projectedBreakdown({...report,budgetBreakdown:canonical})
assert.equal(amount(full,staticKey),119.96,'Canonical fixed bill plus subscriptions is never replaced by subscription details')
assert.equal(amount(full,'bills_utilities'),169.96,'Optional history cannot truncate canonical bills')
assert.equal(amount(full,'rent'),2000)
const zero = runtime.projectedBreakdown({...report,budgetBreakdown:rows(0,0)})
assert.equal(amount(zero,staticKey),0,'Canonical zero does not revive stale details')
assert.equal(amount(zero,'bills_utilities'),0)
const fallback = runtime.projectedBreakdown(report)
assert.equal(amount(fallback,staticKey),119.96)
assert.equal(amount(fallback,'bills_utilities'),110,'Legacy fallback retains actual bills absent from optional history')
const replaced = runtime.projectedBreakdown({...report,breakdown:rows(119.92),calendarEvents:[actual,utility]})
assert.equal(amount(replaced,staticKey),179.92,'Actual loan replaces, rather than adds to, the expectation')
assert.equal(amount(runtime.projectedBreakdown({...report,breakdown:rows(500)}),staticKey),500,'Incomplete details cannot discard known category costs')
assert.equal(runtime.billsUtilitiesEvents([loan,actual,utility]).length,1)
const daily = runtime.dailyEntriesWithCalendarEvents([], [loan],9)[0]
assert.equal(daily.category,'Static Bills & Subscriptions')
assert.equal(daily.status,'scheduled')
assert.equal(daily.person,'Need bill')
assert.match(runtime.calendarEventLabel(loan),/Student Loan - Bill - \$59\.96 - Scheduled/)
assert.match(runtime.calendarEventLabel(actual),/Bill - \$119\.92 - Recorded/)
const palette = vm.runInContext('CATEGORY_CHART_COLORS',runtime)
assert.equal(runtime.calendarEventStyle(loan).color,palette[staticKey])
for (const [event,status] of [[loan,'Scheduled'],[actual,'Recorded']]) {
  const tooltip = renderToStaticMarkup(runtime.CalendarEventTooltip({event}))
  assert.ok(tooltip.includes(`Bill · ${status}`))
  const details = renderToStaticMarkup(runtime.FixedBillItemsTable({items:[event],month:9}))
  assert.ok(details.includes('aria-label="Fixed bills"'))
  assert.ok(details.includes('9/12 · scheduled date'))
  assert.ok(details.includes(status))
  assert.ok(details.includes('Student Loan'))
}
console.log('Fixed-bill totals, category identity, scheduled provenance and calendar details passed')
