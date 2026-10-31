const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),Renderer=req('react-test-renderer'),ts=req('typescript'),{act}=Renderer
global.IS_REACT_ACT_ENVIRONMENT=true
const listeners=new Set(),media={matches:false,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)}
const motions=[],math=Object.create(Math);let seed=427
math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296)
const runtime={exports:{},require:req,Math:math,window:{matchMedia:()=>media},getComputedStyle:node=>({...node.style,...node.motion?.frame})}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/category-mix-motion.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
const {categoryCenterStyle,CategoryRingCenterSync,createCategoryCalloutCascade,useCategoryCalloutFireworks,CATEGORY_CALLOUT_CASCADE_MS,CATEGORY_RING_DURATION_MS,CATEGORY_RING_REVEAL_MS,categoryRingSpring}=runtime.exports
assert.ok(CATEGORY_RING_REVEAL_MS<=220&&CATEGORY_RING_REVEAL_MS<CATEGORY_RING_DURATION_MS,'Stems launch early while the ring retains its spring tail')
assert.equal(categoryRingSpring(0),0);assert.equal(categoryRingSpring(1),1)
const spring=Array.from({length:101},(_,i)=>categoryRingSpring(i/100));assert.ok(Math.max(...spring)>1.02&&Math.max(...spring)<1.04,'A subtle, bounded overshoot settles instead of stopping rigidly');assert.ok(categoryRingSpring(.3)>.95)
const ids=['food','shopping','rent','grocery','gas','left']
for(const count of [0,1,2,6])for(const span of [0,80,240,600]){
 const result=createCategoryCalloutCascade(ids.slice(0,count),span),times=[...result.values()]
 assert.equal(result.size,count);assert.ok(times.every(n=>n>=0&&n<=span));if(count)assert.equal(Math.min(...times),0);if(count>1)assert.equal(Math.max(...times),span)
}
assert.notDeepEqual([...createCategoryCalloutCascade(ids)],[...createCategoryCalloutCascade(ids)],'Each reveal gets a fresh randomized pairing and timing')
const large={cx:195,cy:182,outerRadius:159,innerRadius:111},compact={cx:195,cy:198,outerRadius:109.5,innerRadius:83.5}
assert.equal(categoryCenterStyle(large)['--bb-category-center-number-size'],'30px');assert.equal(categoryCenterStyle(compact)['--bb-category-center-number-size'],'24px')
const center={style:{setProperty(key,value){this[key]=value}}},centerRef={current:center}
let tree
try{
 act(()=>{tree=Renderer.create(React.createElement(CategoryRingCenterSync,{geometry:large,centerRef},'center'))})
 for(const progress of [.1,.33,.7,.25,0,1]){
  const geometry=Object.fromEntries(Object.keys(large).map(key=>[key,large[key]+(compact[key]-large[key])*progress]))
  act(()=>tree.update(React.createElement(CategoryRingCenterSync,{geometry,centerRef},'center')))
  assert.equal(parseFloat(center.style.top),geometry.cy);assert.equal(parseFloat(center.style.width),geometry.innerRadius*1.7)
  const number=30-6*progress,caption=12-progress,gap=4*(1-progress)
  assert.ok(Math.abs(parseFloat(center.style.height)-(number*1.1+caption*1.5+gap+16))<1e-8,'Center type and box height use the same ring frame through reversal')
 }
}finally{if(tree)act(()=>tree.unmount());tree=null}
const nodes=ids.flatMap(id=>['stem','label'].map(kind=>{
 const node={dataset:{category:id},isConnected:true,classList:{contains:value=>value===`bb-contour-${kind}`},style:{opacity:'0',transform:'matrix(.01,0,0,.01,0,0)',strokeDashoffset:'1',getPropertyValue:key=>key.endsWith('-x')?'4px':'8px'}}
 node.animate=(frames,options)=>{
  let resolve,reject;const finished=new Promise((yes,no)=>{resolve=yes;reject=no})
  const motion={node,frames,options,finished,frame:{...frames[0]},canceled:false,finish(){this.frame={...frames.at(-1)};resolve()},cancel(){this.canceled=true;node.motion=null;reject(new Error('canceled'))}};node.motion=motion;motions.push(motion);return motion
 }
 return node
}))
const ref={current:{style:{opacity:'0'},querySelectorAll:selector=>selector.includes(',')?nodes:nodes.filter(node=>node.classList.contains('bb-contour-label'))}}
function Host({active,onExitComplete}){useCategoryCalloutFireworks(ref,active,JSON.stringify(ids),onExitComplete);return null}
;(async()=>{
 let completions=0;const complete=()=>completions++,update=active=>act(()=>tree.update(React.createElement(Host,{active,onExitComplete:active?undefined:complete})))
 const finish=async list=>{await act(async()=>{list.forEach(m=>m.finish());await Promise.resolve()})}
 try{
  act(()=>{tree=Renderer.create(React.createElement(Host,{active:false,onExitComplete:complete}))});assert.equal(motions.length,0);assert.equal(completions,1,'An empty initial view has no artificial exit hold')
  update(true)
  const first=motions.slice();assert.equal(first.length,ids.length*2)
  const stemDelays=first.filter(m=>m.node.classList.contains('bb-contour-stem')).map(m=>m.options.delay)
  assert.equal(Math.min(...stemDelays),0);assert.equal(Math.max(...stemDelays),CATEGORY_CALLOUT_CASCADE_MS)
  for(const id of ids){const pair=first.filter(m=>m.node.dataset.category===id),stem=pair[0],card=pair[1];assert.ok(card.options.delay>stem.options.delay&&card.options.delay<stem.options.delay+stem.options.duration);assert.equal(stem.frames.at(-1).strokeDashoffset,'0');assert.match(card.frames[0].transform,/scale\(\.01\)/)}
  update(true);assert.equal(motions.length,first.length,'An unrelated render cannot reshuffle or restart the cascade')
  first.forEach(m=>{m.frame={...m.frame,opacity:'.4',transform:'matrix(.4,0,0,.4,1,2)',strokeDashoffset:'.6'}})
  update(false)
  assert.ok(first.every(m=>m.canceled));const exit=motions.slice(first.length)
  assert.ok(exit.every(m=>m.frames[0].opacity==='.4'),'Exit freezes the current frame and cancels pending launches')
  assert.equal(ref.current.style.opacity,'1','The parent cannot fade away before the reverse cascade finishes')
  for(const id of ids){const original=first.find(m=>m.node.dataset.category===id),pair=exit.filter(m=>m.node.dataset.category===id),stem=pair[0],card=pair[1];assert.equal(card.options.delay,CATEGORY_CALLOUT_CASCADE_MS-original.options.delay,'Closing unwinds the previous reveal order');assert.equal(stem.options.delay,card.options.delay+60);assert.equal(stem.frames.at(-1).strokeDashoffset,'1');assert.equal(card.frames.length,2,'A partially opened card contracts from its current scale without inflating first')}
  update(true);await Promise.resolve();assert.equal(completions,1,'An interrupted exit must never grow the ring later');assert.ok(exit.every(m=>m.canceled))
  const second=motions.slice(-ids.length*2);assert.notDeepEqual(second.map(m=>m.options.delay),first.map(m=>m.options.delay),'A later reveal receives a new order');await finish(second)
  update(false);const fullExit=motions.slice(-ids.length*2)
  assert.ok(fullExit.filter(m=>!m.node.classList.contains('bb-contour-stem')).every(m=>m.frames.length===3&&m.frames[1].transform.includes('1.035')),'Fully opened cards reverse their spring pop before contracting')
  await finish(fullExit.slice(0,-1));assert.equal(completions,1,'The ring waits for the last retracting pair');assert.equal(ref.current.style.opacity,'1')
  await finish(fullExit.slice(-1));assert.equal(completions,2);assert.equal(ref.current.style.opacity,'0')
  update(true);await finish(motions.slice(-ids.length*2));update(false)
  const reducedExit=motions.slice(-ids.length*2);media.matches=true;await act(async()=>{[...listeners].forEach(fn=>fn());await Promise.resolve()});assert.equal(completions,3,'Turning Reduce Motion on finishes an exit and releases its ring hold')
  const before=motions.length;update(true);assert.equal(motions.length,before,'Reduced motion reveals final cards without a cascade');assert.ok(nodes.every(node=>node.style.opacity===(node.classList.contains('bb-contour-stem')?'.65':'1')))
  update(false);assert.equal(completions,4,'Reduced motion closes immediately')
 }finally{if(tree)act(()=>tree.unmount())}
 assert.equal(listeners.size,0);assert.ok(motions.every(m=>m.canceled),'Unmount releases every animation and media listener')
 console.log('PASS: fast bounded ring spring, randomized launches, reverse pair order/retraction, frame-continuous interruption, completion-driven ring hold, reduced motion and cleanup')
})().catch(error=>{console.error(error);process.exitCode=1})
