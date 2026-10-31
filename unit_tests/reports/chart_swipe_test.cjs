const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript'),React=req('react'),{act,create}=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
let now=0,size=390,reduced=false,serial=0,renders=0,starts=0,selections=[],motions=[]
const frames=new Map(),observers=[],mediaListeners=new Set()
const media={get matches(){return reduced},addEventListener:(_,fn)=>mediaListeners.add(fn),removeEventListener:(_,fn)=>mediaListeners.delete(fn)}
const viewport={dataset:{},getBoundingClientRect:()=>({width:size})}
const track={style:{},motionX:null,animate(keyframes,options){const motion={keyframes,options,canceled:false,cancel(){this.canceled=true;track.motionX=null}};motions.push(motion);return motion}}
const x=()=>Number(track.style.transform?.match(/translate3d\(([-\d.]+)/)?.[1]??0)
const win={get innerWidth(){return size},matchMedia:()=>media,getComputedStyle:()=>({transform:`matrix(1,0,0,1,${track.motionX??x()},0)`}),requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial},cancelAnimationFrame:id=>frames.delete(id)}
const runtime={exports:{},require:req,window:win,performance:{now:()=>now},ResizeObserver:class{constructor(fn){this.fn=fn;observers.push(this)}observe(){}disconnect(){this.disconnected=true}}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/chart-swipe.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,runtime)
const {chartDragOffset,chartReleaseIndex,chartReleaseVelocity,chartSpring,useChartSwipe}=runtime.exports
for(const width of [320,390,1280]){
 for(const offset of [-300,-220,0,220,300])if(Math.abs(offset)<=width+16)assert.equal(chartDragOffset(offset,width,1,4),offset,'Interior drag follows the finger without the old 220px stop')
 const edges=[20,80,160,300,600].map(d=>chartDragOffset(d,width,0,4));assert.ok(edges.every((v,i)=>v>0&&(!i||v>edges[i-1])),'Rubber band keeps moving progressively at the edge')
 assert.equal(chartReleaseIndex(0,4,width,300,1),0);assert.equal(chartReleaseIndex(3,4,width,-300,-1),3)
}
assert.equal(chartReleaseIndex(1,4,390,-32,-.7),2,'A short quick flick advances')
assert.equal(chartReleaseIndex(1,4,390,-32,0),1,'The same short drag held still returns')
assert.equal(chartReleaseIndex(1,4,390,-150,0),2,'A slow deliberate drag advances')
assert.equal(chartReleaseIndex(1,4,390,-75,.8),1,'A reversal can cancel the page change')
assert.equal(chartReleaseVelocity([{x:0,time:0},{x:40,time:40}],50),1)
assert.equal(chartReleaseVelocity([{x:0,time:0},{x:40,time:40}],200),0,'A held finger has no stale release velocity')
for(const [from,to,velocity]of [[-300,-406,-1],[65,0,0],[-100,-406,-2],[1000,0,0]]){
 const spring=chartSpring(from,to,velocity)
 assert.equal(spring.frames[0].transform,`translate3d(${from}px, 0, 0)`);assert.equal(spring.frames.at(-1).transform,`translate3d(${to}px, 0, 0)`)
 assert.ok(spring.duration>=200&&spring.duration<=700);assert.ok(spring.frames.every((f,i)=>f.offset>=0&&f.offset<=1&&(!i||f.offset>spring.frames[i-1].offset)))
}
let tree
function Harness({index=0}){renders++;const swipe=useChartSwipe({index,count:4,onSelect:next=>selections.push(next),onDragStart:()=>starts++,ignoreTarget:target=>target?.form});const{viewportRef,trackRef,...events}=swipe;return React.createElement('div',{ref:viewportRef,...events},React.createElement('div',{ref:trackRef,'data-track':true}))}
const mount=index=>act(()=>{if(tree)tree.unmount();tree=create(React.createElement(Harness,{index}),{createNodeMock:element=>element.props['data-track']?track:viewport})})
const props=()=>tree.root.findAllByType('div')[0].props
const event=(clientX,clientY=100,extra={})=>{const touch={clientX,clientY,identifier:1};return {target:{},touches:[touch],changedTouches:[touch],stopped:0,prevented:0,stopPropagation(){this.stopped++},preventDefault(){this.prevented++},...extra}}
const fire=(name,x,y,extra)=>{const e=event(x,y,extra);act(()=>props()[name](e));return e}
const flush=()=>{for(const [id,fn]of [...frames]){frames.delete(id);fn()}}
try{
 mount(0);const initialRenders=renders
 fire('onTouchStartCapture',350);now=20;fire('onTouchMoveCapture',250);now=40;fire('onTouchMoveCapture',150);now=60;fire('onTouchMoveCapture',50)
 assert.equal(frames.size,1,'Moves coalesce into one compositor write');flush();assert.equal(x(),-300);assert.equal(renders,initialRenders,'Dragging cannot rerender the graph tree');assert.equal(viewport.dataset.dragging,'true');assert.equal(starts,1)
 now=200;fire('onTouchEndCapture',50);assert.deepEqual(selections,[1]);assert.equal(x(),-406);assert.equal(motions.at(-1).keyframes[0].transform,'translate3d(-300px, 0, 0)')
 const before=motions.length;act(()=>tree.update(React.createElement(Harness,{index:0})));assert.equal(x(),-406,'An unrelated render with the previous selection cannot rewind the pending release');assert.equal(motions.length,before);act(()=>tree.update(React.createElement(Harness,{index:1})));assert.equal(motions.length,before,'Selection does not restart the same settling animation')
 track.motionX=-350;fire('onTouchStartCapture',150);assert.equal(x(),-350,'Regrab begins at the visible spring position');now+=20;fire('onTouchMoveCapture',180);flush();assert.equal(x(),-320)
 fire('onTouchCancelCapture',180);assert.deepEqual(selections,[1],'Canceled/reversed drags never select a new page')
 const blocked=fire('onClickCapture',180,100,{detail:1});assert.equal(blocked.prevented,1);assert.equal(blocked.stopped,1)
 assert.equal(fire('onClickCapture',180,100,{detail:0}).prevented,0,'Keyboard activation survives swipe suppression')
 fire('onTouchStartCapture',180);fire('onTouchEndCapture',180);assert.equal(fire('onClickCapture',180,100,{detail:1}).prevented,0,'The next deliberate tap works immediately')
 mount(0);selections=[];const startCount=starts
 fire('onTouchStartCapture',200);now+=20;const vertical=fire('onTouchMoveCapture',205,200);now+=20;fire('onTouchMoveCapture',20,210);flush();assert.equal(x(),0);assert.equal(vertical.stopped,0);assert.equal(vertical.prevented,0);fire('onTouchEndCapture',20,210);assert.deepEqual(selections,[]);assert.equal(starts,startCount,'Vertical axis locks without stealing a later diagonal')
 fire('onTouchStartCapture',200,100,{target:{form:true}});fire('onTouchMoveCapture',0);fire('onTouchEndCapture',0);assert.deepEqual(selections,[],'Native form controls never start a swipe')
 fire('onTouchStartCapture',250);now+=20;fire('onTouchMoveCapture',80);flush();fire('onTouchMoveCapture',80,100,{touches:[{},{}]});assert.equal(viewport.dataset.dragging,'false');assert.deepEqual(selections,[],'Multi-touch cancels safely')
 fire('onTouchStartCapture',250);now+=20;fire('onTouchMoveCapture',80);flush();fire('onTouchStartCapture',80,100,{touches:[{},{}]});assert.equal(viewport.dataset.dragging,'false');assert.equal(frames.size,0);assert.equal(x(),0,'A second-finger touchstart cannot strand the track mid-page');assert.deepEqual(selections,[]);
 mount(2);size=320;act(()=>observers.at(-1).fn());assert.equal(x(),-672,'Resize stays on the selected page without the old stride');assert.equal(frames.size,0)
 reduced=true;act(()=>{for(const listener of mediaListeners)listener()});const motionCount=motions.length;fire('onTouchStartCapture',250);now+=20;fire('onTouchMoveCapture',60);flush();fire('onTouchEndCapture',60);assert.equal(motions.length,motionCount,'Reduced motion settles immediately')
}finally{if(tree)act(()=>tree.unmount())}
assert.equal(frames.size,0);assert.equal(mediaListeners.size,0);assert.ok(observers.every(o=>o.disconnected));assert.ok(motions.every(m=>m.canceled),'Unmount releases compositor animations')
console.log('PASS: full-width drag, rubber band, velocity spring, interruption, coalesced writes without renders, vertical lock, tap arbitration, controls, multi-touch, resize and cleanup')
