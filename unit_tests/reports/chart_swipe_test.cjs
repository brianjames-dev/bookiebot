const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript'),React=req('react'),{act,create}=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
let now=0,size=390,reduced=false,renders=0,starts=0,selections=[],serial=0,datasetWrites=0
const listeners=new Map(),timers=new Map(),observers=[],mediaListeners=new Set(),writes=[]
const media={get matches(){return reduced},addEventListener:(_,fn)=>mediaListeners.add(fn),removeEventListener:(_,fn)=>mediaListeners.delete(fn)}
const viewport={onscrollend:null,dataset:new Proxy({},{set(object,key,value){datasetWrites++;object[key]=value;return true}}),scrollLeft:0,get clientWidth(){return size},
 addEventListener(name,fn,options){listeners.set(name,{fn,options})},removeEventListener(name){listeners.delete(name)},
 scrollTo(options){writes.push(options);if(options.behavior==='instant')this.scrollLeft=options.left}}
const win={matchMedia:()=>media,setTimeout:fn=>{timers.set(++serial,fn);return serial},clearTimeout:id=>timers.delete(id)}
const runtime={exports:{},require:req,window:win,performance:{now:()=>now},ResizeObserver:class{constructor(fn){this.fn=fn;observers.push(this)}observe(){}disconnect(){this.disconnected=true}}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/chart-swipe.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,runtime)
const {useChartSwipe}=runtime.exports
let tree
function Harness({index=0,count=4}){renders++;const swipe=useChartSwipe({index,count,onSelect:next=>selections.push(next),onDragStart:()=>starts++,ignoreTarget:target=>target?.form});return React.createElement('div',{ref:swipe.viewportRef,onClickCapture:swipe.onClickCapture})}
const mount=(index=0,count=4)=>act(()=>{if(tree)tree.unmount();tree=create(React.createElement(Harness,{index,count}),{createNodeMock:()=>viewport})})
const update=(index,count=4)=>act(()=>tree.update(React.createElement(Harness,{index,count})))
const event=(clientX=300,clientY=100,extra={})=>{const touch={clientX,clientY,identifier:1};return {target:viewport,touches:[touch],changedTouches:[touch],stopped:0,prevented:0,stopPropagation(){this.stopped++},preventDefault(){this.prevented++},...extra}}
const fire=(name,x,y,extra)=>{const e=event(x,y,extra);act(()=>listeners.get(name).fn(e));return e}
const click=detail=>{const e=event(0,0,{detail});act(()=>tree.root.findByType('div').props.onClickCapture(e));return e}
const scroll=left=>{viewport.scrollLeft=left;fire('scroll')}
const flush=()=>act(()=>{for(const[id,fn]of [...timers]){timers.delete(id);fn()}})
try{
 mount();assert.equal(writes.at(-1).behavior,'instant');assert.equal(viewport.dataset.settling,'false')
 for(const type of ['touchstart','touchmove','touchend','touchcancel'])assert.equal(listeners.get(type).options.passive,true,'Touch observers must never block native scrolling')
 const initialRenders=renders,initialWrites=writes.length,initialDatasetWrites=datasetWrites
 fire('touchstart',300);for(let i=0;i<40;i++)fire('touchmove',290-i*5)
 assert.equal(writes.length,initialWrites,'Held touch never writes scrollLeft, transforms or an animation');assert.equal(renders,initialRenders);assert.equal(starts,1);assert.equal(datasetWrites-initialDatasetWrites,2,'Gesture state is written only once, never per touch sample')
 const moving=fire('touchmove',40);assert.equal(moving.stopped,1);assert.equal(moving.prevented,0,'Chart scrubbing is suppressed without canceling browser panning')
 scroll(275);fire('scrollend');assert.deepEqual(selections,[],'No intermediate page is published while the finger stays down')
 fire('touchend',40,100,{touches:[]});assert.deepEqual(selections,[],'Release cannot implement its own threshold or velocity animation')
 scroll(406);fire('scrollend',0,0,{target:{}});assert.equal(selections.length,0,'Nested scrollers cannot finish the carousel');fire('scrollend');assert.deepEqual(selections,[1]);assert.equal(viewport.dataset.settling,'false');assert.equal(writes.length,initialWrites)
 update(1);scroll(406);flush();assert.equal(viewport.dataset.settling,'false','A final WebKit scroll delivered after scrollend must not strand the busy state');assert.equal(writes.length,initialWrites,'Publishing native selection cannot restart the browser scroll')
 assert.equal(click(1).prevented,1);assert.equal(click(0).prevented,0,'Keyboard activation survives swipe suppression')
 fire('touchstart',180);fire('touchend',180,100,{touches:[]});assert.equal(click(1).prevented,0,'A fresh deliberate tap works immediately')
 update(2);assert.equal(writes.at(-1).left,812);assert.equal(writes.at(-1).behavior,'smooth');scroll(500);fire('scrollend');assert.equal(selections.length,1,'An aborted old smooth scroll cannot override the requested page')
 update(3);scroll(812);fire('scrollend');assert.equal(selections.length,1);scroll(1218);fire('scrollend');assert.equal(viewport.dataset.settling,'false')
 // Re-grabbing never captures/rewrites the presented position; the browser owns it.
 update(2);scroll(1000);const beforeGrab=writes.length;fire('touchstart',100);fire('touchmove',170);assert.equal(writes.length,beforeGrab)
 fire('touchend',170,100,{touches:[]});scroll(1218);fire('scrollend');assert.equal(selections.at(-1),3)
 mount();const beforeVertical=starts,beforePan=writes.length
 fire('touchstart',200);const vertical=fire('touchmove',205,200);fire('touchmove',20,210);fire('touchend',20,210,{touches:[]})
 assert.equal(vertical.stopped,0);assert.equal(vertical.prevented,0);assert.equal(starts,beforeVertical);assert.equal(writes.length,beforePan)
 fire('touchstart',200,100,{target:{form:true}});assert.equal(fire('touchmove',10).stopped,0);fire('touchend',10,100,{touches:[]});assert.equal(starts,beforeVertical)
 fire('touchstart',250);fire('touchmove',80);const multiWrites=writes.length
 fire('touchmove',80,100,{touches:[{},{}]});fire('touchcancel',80,100,{touches:[]});assert.equal(viewport.dataset.dragging,'false');assert.equal(writes.length,multiWrites,'Multi-touch/cancellation never competes with native bounce/snap')
 mount(2);size=320;scroll(0);fire('scrollend');assert.equal(viewport.scrollLeft,672,'A resize scrollend before ResizeObserver preserves the selected graph at its new stride');act(()=>observers.at(-1).fn());assert.equal(viewport.scrollLeft,672)
 reduced=true;act(()=>{for(const fn of mediaListeners)fn()});update(1);assert.equal(viewport.scrollLeft,336);assert.equal(writes.at(-1).behavior,'instant')
 // Fallback observes idle only on browsers without scrollend, and waits for release.
 delete viewport.onscrollend;mount();const fallbackRenders=renders,fallbackWrites=writes.length
 fire('touchstart',300);fire('touchmove',40);scroll(336);flush();assert.equal(viewport.dataset.settling,'true')
 fire('touchend',40,100,{touches:[]});flush();assert.equal(selections.at(-1),1);assert.equal(viewport.dataset.settling,'false');assert.equal(renders,fallbackRenders);assert.equal(writes.length,fallbackWrites)
 update(1);fire('wheel',0,0,{deltaX:100,deltaY:0});scroll(672);flush();assert.equal(selections.at(-1),2,'Horizontal trackpad scroll selects its native snapped page')
 scroll(700);assert.ok(timers.size);mount();assert.equal(timers.size,0,'Unmount cancels idle fallback timers')
}finally{if(tree)act(()=>tree.unmount())}
assert.equal(listeners.size,0);assert.equal(mediaListeners.size,0);assert.equal(timers.size,0);assert.ok(observers.every(o=>o.disconnected))
console.log('PASS: native scroll ownership, passive input, no per-drag position writes/renders, settled selection, smooth marker navigation, re-grab, stale scrollend, vertical/tap/form arbitration, cancellation, fallback, resize, reduced motion and cleanup')
