const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),Renderer=req('react-test-renderer'),ts=req('typescript'),{act}=Renderer
global.IS_REACT_ACT_ENVIRONMENT=true
const listeners=new Set(),media={matches:false,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)}
const motions=[],math=Object.create(Math);let seed=427
math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296)
const runtime={exports:{},require:req,Math:math,window:{matchMedia:()=>media},getComputedStyle:node=>({...node.style,...node.motion?.frame})}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/category-mix-motion.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
const {categoryCenterStyle,CategoryRingCenterSync,createCategoryCalloutCascade,useCategoryCalloutFireworks,CATEGORY_CALLOUT_CASCADE_MS}=runtime.exports
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
 node.animate=(frames,options)=>{const motion={node,frames,options,frame:{...frames[0]},canceled:false,finish(){this.frame={...frames.at(-1)};this.finished=true},cancel(){this.canceled=true;node.motion=null}};node.motion=motion;motions.push(motion);return motion}
 return node
}))
const ref={current:{querySelectorAll:selector=>selector.includes(',')?nodes:nodes.filter(node=>node.classList.contains('bb-contour-label'))}}
function Host({active}){useCategoryCalloutFireworks(ref,active,JSON.stringify(ids));return null}
try{
 act(()=>{tree=Renderer.create(React.createElement(Host,{active:false}))});assert.equal(motions.length,0)
 act(()=>tree.update(React.createElement(Host,{active:true})))
 const first=motions.slice();assert.equal(first.length,ids.length*2)
 const stemDelays=first.filter(m=>m.node.classList.contains('bb-contour-stem')).map(m=>m.options.delay)
 assert.equal(Math.min(...stemDelays),0);assert.equal(Math.max(...stemDelays),CATEGORY_CALLOUT_CASCADE_MS)
 for(const id of ids){const pair=first.filter(m=>m.node.dataset.category===id),stem=pair[0],card=pair[1];assert.ok(card.options.delay>stem.options.delay&&card.options.delay<stem.options.delay+stem.options.duration);assert.equal(stem.frames.at(-1).strokeDashoffset,'0');assert.match(card.frames[0].transform,/scale\(\.01\)/)}
 act(()=>tree.update(React.createElement(Host,{active:true})));assert.equal(motions.length,first.length,'An unrelated render cannot reshuffle or restart the cascade')
 first.forEach(m=>{m.frame={...m.frame,opacity:'.4',transform:'matrix(.4,0,0,.4,1,2)',strokeDashoffset:'.6'}})
 act(()=>tree.update(React.createElement(Host,{active:false})))
 assert.ok(first.every(m=>m.canceled));const exit=motions.slice(first.length)
 assert.ok(exit.every(m=>m.frames[0].opacity==='.4'&&m.options.delay===0),'Exit freezes the current frame and cancels every delayed launch')
 media.matches=true;act(()=>[...listeners].forEach(fn=>fn()));assert.ok(exit.every(m=>m.finished),'Turning Reduce Motion on completes all pending motion immediately')
 act(()=>tree.update(React.createElement(Host,{active:true})));assert.equal(motions.length,first.length+exit.length,'Reduced motion reveals final cards without a cascade')
 assert.ok(nodes.every(node=>node.style.opacity===(node.classList.contains('bb-contour-stem')?'.65':'1')))
 media.matches=false;act(()=>tree.update(React.createElement(Host,{active:false})));act(()=>tree.update(React.createElement(Host,{active:true})))
 const last=motions.slice(-ids.length*2);assert.notDeepEqual(last.map(m=>m.options.delay),first.map(m=>m.options.delay),'A later reveal receives a new order')
}finally{if(tree)act(()=>tree.unmount())}
assert.equal(listeners.size,0);assert.ok(motions.every(m=>m.canceled),'Unmount releases every animation and media listener')
console.log('PASS: tunable bounded randomized launch window, shared ring/center frames, interrupted exit/re-entry, reduced motion and cleanup')
