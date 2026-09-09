const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const React = req('react'), Renderer = req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const output = req('esbuild').buildSync({entryPoints:['web/expense-report/src/app-navigation.tsx'],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime']}).outputFiles[0].text
const moduleObject = {exports:{}}
vm.runInNewContext(output,{module:moduleObject,exports:moduleObject.exports,require:req})
const {nextScrollNavigation,screenForReportSource,ReportScreen,AppNavigationContext} = moduleObject.exports
let state={lastY:0,travel:0,compact:false}
for(const y of [5,9,18,23]) state=nextScrollNavigation(state,y,1000)
assert.equal(state.compact,false,'Tiny top-of-page movements leave full navigation visible')
for(const y of [45,55,75]) state=nextScrollNavigation(state,y,1000)
assert.equal(state.compact,true,'Sustained downward travel compacts navigation')
for(const y of [74,76,73,75]) state=nextScrollNavigation(state,y,1000)
assert.equal(state.compact,true,'Small direction reversals do not twitch the bar')
state=nextScrollNavigation(state,50,1000)
assert.equal(state.compact,false,'Upward travel restores the full navigation')
state=nextScrollNavigation({lastY:990,travel:0,compact:true},1080,1000)
state=nextScrollNavigation(state,1000,1000)
assert.equal(state.compact,true,'Bottom rubber-band bounce is not upward navigation')
assert.equal(nextScrollNavigation(state,-20,1000).compact,false)
assert.equal(nextScrollNavigation(state,100,0).compact,false,'A short screen has no compact scroll state')
assert.equal(screenForReportSource('activity'),'spending')
assert.equal(screenForReportSource('reimbursements'),'shared')
for(const source of ['overview','categories','cash_flow','commitments','burn_rate']) assert.equal(screenForReportSource(source),'overview')

let mounts=0,unmounts=0,setDraft
function Draft() {
 const [value,setValue]=React.useState('');setDraft=setValue
 React.useEffect(()=>{mounts++;return()=>{unmounts++}},[])
 return React.createElement('input',{value,onChange:event=>setValue(event.target.value)})
}
function Screen({screen}) {
 return React.createElement(AppNavigationContext.Provider,{value:{screen}},React.createElement(ReportScreen,{name:'spending'},React.createElement(Draft)))
}
;(async()=>{
 let tree
 await React.act(async()=>{tree=Renderer.create(React.createElement(Screen,{screen:'spending'}))})
 await React.act(async()=>setDraft('Unfinished expense detail'))
 for(const screen of ['overview','shared','savings','settings','spending']) {
  await React.act(async()=>tree.update(React.createElement(Screen,{screen})))
  assert.equal(tree.root.findByType('input').props.value,'Unfinished expense detail')
  assert.equal(tree.root.findByType('section').props.hidden,screen!=='spending')
 }
 assert.equal(mounts,1);assert.equal(unmounts,0,'Tab changes preserve child/controller identity')
 await React.act(async()=>tree.unmount());assert.equal(unmounts,1)
 console.log('Navigation state, rubber-band thresholds, source mapping and retained drafts passed')
})().catch(error=>{console.error(error);process.exitCode=1})
