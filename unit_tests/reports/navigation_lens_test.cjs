const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
let geometryReads=0,serial=0,renders=0,contactWrites=0,reduced=false,box={left:22,top:600,width:346,height:60},width=75.2,layout={width:346,height:60,padding:10,inset:5}
const frames=new Map(),timers=new Map(),listeners=new Set(),style=new Map()
const host={dataset:new Proxy({},{set(target,key,value){if(key==='glassContact')contactWrites++;target[key]=value;return true}}),getBoundingClientRect:()=>{geometryReads++;return box},style:{setProperty:(k,v)=>style.set(k,v),getPropertyValue:k=>style.get(k),removeProperty:k=>style.delete(k)}}
const media={get matches(){return reduced},addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)}
const runtime={exports:{},require:req,window:{matchMedia:()=>media,setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id)},getComputedStyle:()=>({width:`${layout.width}px`,height:`${layout.height}px`,paddingLeft:`${layout.padding}px`,getPropertyValue:key=>String(key==='--bb-glass-origin-y'?1:key==='--bb-nav-count'?5:layout.inset)}),requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id)}
const output=req('esbuild').buildSync({entryPoints:['web/expense-report/src/navigation-lens.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text
runtime.module={exports:{}};runtime.exports=runtime.module.exports;vm.runInNewContext(output,runtime);runtime.exports=runtime.module.exports
let lens,view;const ref={current:host}
function Harness({value}){renders++;lens=runtime.exports.useNavigationLens(ref,value);return null}
act(()=>{view=create(React.createElement(Harness,{value:'overview'}))})
assert.equal(timers.size,0,'Initial placement has no fabricated transition')
act(()=>view.update(React.createElement(Harness,{value:'transactions'})))
assert.equal(host.dataset.navMoving,'true');assert.equal(timers.size,1)
const initialReads=geometryReads,initialRenders=renders
for(let i=0;i<20;i++){lens.start(100+i,630);lens.release()}
assert.equal(geometryReads,initialReads,'Quick taps perform no synchronous geometry reads')
assert.equal(style.size,0,'Quick taps never write a transient pointer lens/light position')
assert.equal(frames.size,0);assert.equal(timers.size,1,'Quick taps cancel their hold timer without disturbing the settle timer')
assert.equal(renders,initialRenders);assert.notEqual(host.dataset.glassContact,'true','Quick taps never trigger a grow/reverse pulse')
lens.start(100,630)
const before=renders
for(let i=0;i<100;i++)lens.move(100+i*2,642)
assert.equal(renders,before,'Live finger travel never publishes React state')
assert.equal(frames.size,1,'Pointer samples coalesce into one display frame')
assert.equal(contactWrites,0,'Contact begins together with the next paint')
for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(style.get('--bb-nav-lens-left'),'var(--bb-nav-finger-left)','CSS owns finger/lens alignment throughout animated scaling')
assert.equal(parseFloat(style.get('--bb-glass-dx')),298-22-346/2)
assert.equal(contactWrites,1,'Holding does not rewrite the same contact attribute')
lens.move(-200,620);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(parseFloat(style.get('--bb-glass-dx')),-200-22-346/2,'CSS receives the leading out-of-bounds point for clamping')
lens.move(2000,650);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(parseFloat(style.get('--bb-glass-dx')),2000-22-346/2)
lens.move(160,645);lens.release();assert.equal(frames.size,0);assert.equal(style.has('--bb-nav-lens-left'),false);assert.equal(host.dataset.glassContact,'false')
const fadingOrigin=style.get('--bb-glass-dx');assert.ok(fadingOrigin,'Release retains the last light origin during its fade')
lens.move(290,660);assert.equal(frames.size,0,'Released input cannot resurrect the light');assert.equal(style.get('--bb-glass-dx'),fadingOrigin)
act(()=>view.update(React.createElement(Harness,{value:'shared'})))
assert.equal(timers.size,1,'Retargeting replaces the old settle completion')
for(const [id,t] of [...timers]){timers.delete(id);t.fn()}
assert.equal(host.dataset.navMoving,'false')
box={left:9.89,top:595.8,width:346*1.07,height:60*1.07}
lens.start(box.left+120*1.07,box.top+18*1.07);for(const [id,t] of [...timers]){if(t.ms===100){timers.delete(id);t.fn()}};for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.ok(Math.abs(parseFloat(style.get('--bb-glass-dx'))-(120-346/2)*1.07)<.001,'Store viewport displacement so CSS can compensate for every scale frame')
assert.ok(Math.abs(parseFloat(style.get('--bb-glass-dy'))-(18-60)*1.07)<.001,'Both axes share scale-aware positioning')
box={left:47.5,top:644,width:255,height:44};layout={width:255,height:44,padding:8,inset:4};width=55.8
lens.move(-100,666);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(style.get('--bb-nav-lens-left'),'var(--bb-nav-finger-left)','Compact tracking retains CSS clamping')
reduced=true;for(const fn of listeners)fn()
act(()=>view.update(React.createElement(Harness,{value:'savings'})))
assert.equal(timers.size,0,'Reduce Motion does not create an elastic settle timer')
lens.move(180,650)
act(()=>view.unmount())
assert.equal(frames.size,0);assert.equal(timers.size,0);assert.equal(listeners.size,0);assert.equal(style.has('--bb-nav-lens-left'),false);assert.equal(style.has('--bb-glass-dx'),false);assert.equal(style.has('--bb-glass-dy'),false)
console.log('PASS: reference-sized lens, coalesced render-free finger tracking, edge clamping, release/retarget, Reduce Motion and cleanup')
