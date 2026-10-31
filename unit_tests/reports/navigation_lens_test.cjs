const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer'),ts=req('typescript')
global.IS_REACT_ACT_ENVIRONMENT=true
let serial=0,renders=0,contactWrites=0,reduced=false,box={left:22,width:346,height:60},width=75.2,layout={width:346,height:60}
const frames=new Map(),timers=new Map(),listeners=new Set(),style=new Map()
const host={dataset:new Proxy({},{set(target,key,value){if(key==='navContact')contactWrites++;target[key]=value;return true}}),getBoundingClientRect:()=>box,style:{setProperty:(k,v)=>style.set(k,v),removeProperty:k=>style.delete(k)}}
const media={get matches(){return reduced},addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)}
const runtime={exports:{},require:req,window:{matchMedia:()=>media,setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id)},getComputedStyle:()=>({width:`${layout.width}px`,height:`${layout.height}px`,getPropertyValue:()=>String(width)}),requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id)}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/navigation-lens.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,runtime)
let lens,view;const ref={current:host}
function Harness({value}){renders++;lens=runtime.exports.useNavigationLens(ref,value);return null}
act(()=>{view=create(React.createElement(Harness,{value:'overview'}))})
assert.equal(timers.size,0,'Initial placement has no fabricated transition')
host.dataset.selectionReady='true'
act(()=>view.update(React.createElement(Harness,{value:'transactions'})))
assert.equal(host.dataset.navMoving,'true');assert.equal(timers.size,1)
const before=renders
for(let i=0;i<100;i++)lens.move(100+i*2)
assert.equal(renders,before,'Live finger travel never publishes React state')
assert.equal(frames.size,1,'Pointer samples coalesce into one display frame')
assert.equal(contactWrites,1,'Holding does not rewrite the same contact attribute')
for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.ok(Math.abs(parseFloat(style.get('--bb-nav-lens-center'))-(298-22))<.001)
lens.move(-200);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(parseFloat(style.get('--bb-nav-lens-center')),5+width/2,'The moving lens stays inside the leading glass rim')
lens.move(2000);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.ok(Math.abs(parseFloat(style.get('--bb-nav-lens-center'))-(346-width/2-5))<.001)
lens.move(160);lens.release();assert.equal(frames.size,0);assert.equal(style.has('--bb-nav-lens-center'),false);assert.equal(host.dataset.navContact,'false')
act(()=>view.update(React.createElement(Harness,{value:'shared'})))
assert.equal(timers.size,1,'Retargeting replaces the old settle completion')
for(const [id,t] of [...timers]){timers.delete(id);t.fn()}
assert.equal(host.dataset.navMoving,'false')
box={left:18.54,width:346*1.02,height:60*1.02}
lens.move(box.left+120*1.02);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.ok(Math.abs(parseFloat(style.get('--bb-nav-lens-center'))-120)<.001,'Finger coordinates normalize the held bar scale instead of drifting')
box={left:47.5,width:255,height:44};layout={width:255,height:44};width=55.8
lens.move(-100);for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(parseFloat(style.get('--bb-nav-lens-center')),4+width/2,'Compact tracking uses its own concentric rim')
reduced=true;for(const fn of listeners)fn()
act(()=>view.update(React.createElement(Harness,{value:'savings'})))
assert.equal(timers.size,0,'Reduce Motion does not create an elastic settle timer')
lens.move(180)
act(()=>view.unmount())
assert.equal(frames.size,0);assert.equal(timers.size,0);assert.equal(listeners.size,0);assert.equal(style.has('--bb-nav-lens-center'),false)
console.log('PASS: reference-sized lens, coalesced render-free finger tracking, edge clamping, release/retarget, Reduce Motion and cleanup')
