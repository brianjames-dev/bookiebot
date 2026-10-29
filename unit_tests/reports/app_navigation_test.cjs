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
const {nextScrollNavigation,screenForReportSource,ReportScreen,AppNavigationContext,fitNavigationSelection} = moduleObject.exports
// All tabs share one capsule size, centered on their real unequal tracks.
for (const [pane,tabs,expectedSize] of [
 [{width:296,height:60},[
  {button:{x:16,y:4.5,width:49,height:51},content:{width:48,height:41}},
  {button:{x:65.125,y:4.5,width:71,height:51},content:{width:68.859375,height:41}},
  {button:{x:136,y:4.5,width:45,height:51},content:{width:36,height:41}},
  {button:{x:181,y:4.5,width:45,height:51},content:{width:40,height:41}},
  {button:{x:226,y:4.5,width:54,height:51},content:{width:54,height:41}},
 ],{width:77,height:52}],
 [{width:275,height:44},Array.from({length:5},(_,i)=>({button:{x:55*i,y:0,width:55,height:44},content:{width:21,height:21}})),{width:33,height:33}],
]) {
 const bubbles=tabs.map((_,i)=>fitNavigationSelection(tabs,i,pane))
 bubbles.forEach((bubble,i)=>{
  const {button,content}=tabs[i]
  assert.equal(bubble.width,bubbles[0].width,'Selecting another tab must never resize the capsule')
  assert.equal(bubble.height,bubbles[0].height)
  assert.ok(Math.abs(bubble.x+bubble.width/2-button.x-button.width/2)<1e-8)
  assert.equal(bubble.y+bubble.height/2,button.y+button.height/2)
  assert.ok(bubble.width>content.width&&bubble.height>content.height,'The full icon/label stack fits inside the bubble')
  assert.ok(bubble.x>=2&&bubble.x+bubble.width<=pane.width-2,'Edge capsules stay inside the glass')
 })
 assert.equal(bubbles[0].width,expectedSize.width)
 assert.equal(bubbles[0].height,expectedSize.height)
}
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
assert.equal(screenForReportSource('activity'),'overview')
assert.equal(screenForReportSource('reimbursements'),'shared')
for(const source of ['overview','categories','cash_flow','commitments','burn_rate']) assert.equal(screenForReportSource(source),'overview')

let mounts=0,unmounts=0,setDraft
function Draft() {
 const [value,setValue]=React.useState('');setDraft=setValue
 React.useEffect(()=>{mounts++;return()=>{unmounts++}},[])
 return React.createElement('input',{value,onChange:event=>setValue(event.target.value)})
}
function Screen({screen}) {
 return React.createElement(AppNavigationContext.Provider,{value:{screen}},React.createElement(ReportScreen,{name:'transactions'},React.createElement(Draft)))
}
;(async()=>{
 let tree
 await React.act(async()=>{tree=Renderer.create(React.createElement(Screen,{screen:'transactions'}))})
 await React.act(async()=>setDraft('Unfinished expense detail'))
 for(const screen of ['overview','shared','savings','settings','transactions']) {
  await React.act(async()=>tree.update(React.createElement(Screen,{screen})))
  assert.equal(tree.root.findByType('input').props.value,'Unfinished expense detail')
  assert.equal(tree.root.findByType('section').props.hidden,screen!=='transactions')
 }
 assert.equal(mounts,1);assert.equal(unmounts,0,'Tab changes preserve child/controller identity')
 await React.act(async()=>tree.unmount());assert.equal(unmounts,1)
 console.log('Navigation state, rubber-band thresholds, source mapping and retained drafts passed')
})().catch(error=>{console.error(error);process.exitCode=1})
