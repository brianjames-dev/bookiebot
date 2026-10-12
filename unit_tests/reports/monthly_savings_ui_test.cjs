const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), {createRequire} = require('node:module')
const req = createRequire(require('node:path').resolve('web/expense-report/package.json'))
const React = req('react'), {renderToStaticMarkup} = req('react-dom/server'), ts = req('typescript')
const exportsObject = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/monthly-savings.tsx','utf8'), {
  compilerOptions:{target:ts.ScriptTarget.ES2020, module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX},
}).outputText, {exports:exportsObject,require:req})
const plan = {status:'active',source:'xAI',rate:.05,cashIdealRate:.15,cashMinimumRate:.075,otherCashIdealRate:.2}
const current = {cashSaved:1200,cashIdeal:1400,cashMinimum:700,esppContribution:400,combinedContributions:1600,combinedRate:1600/9000,estimatedEsppContribution:0,warnings:[]}
const projected = {...current,esppContribution:600,combinedContributions:1800,combinedRate:.15,estimatedEsppContribution:200}
const report = {monthLabel:'October 2026',savingsPlan:plan,savingsInvesting:{current,projected,history:{totalContributed:400,throughMonth:'2026-10',coverage:'partial',unavailableMonths:['2026-09']}}}
const render = (mode='current',extra={}) => renderToStaticMarkup(React.createElement(exportsObject.MonthlySavings,{report,mode,...extra}))
const actual = render()
for (const expected of ['Cash saved','$1,200.00','$1,400.00','$700.00','$400.00','17.78%','7.5%','20%','2026-09']) assert.ok(actual.includes(expected),expected)
assert.ok(!actual.includes('includes estimate'))
const future = render('projected')
assert.ok(future.includes('ESPP · includes estimate'))
assert.ok(future.includes('$200.00 from expected paychecks'))
assert.ok(future.includes('$1,200.00'))
const stale = render('current',{ready:false})
assert.ok(stale.includes('Load the selected month'))
assert.ok(!stale.includes('$1,200.00'))
assert.equal(render('current',{report:{monthLabel:'October 2026'}}),'')
assert.ok(render('current',{report:{...report,savingsPlan:{...plan,status:'pending'}}}).includes('enrollment pending'))
assert.ok(render('current',{report:{...report,savingsPlan:{...plan,status:'invalid'}}}).includes('Check your ESPP settings'))
console.log('Monthly savings separates cash, ESPP estimates, partial history and stale-month state.')
