const assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT=true;
const events=()=>{const listeners=new Map();return {listeners,addEventListener(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)},removeEventListener(name,fn){listeners.get(name)?.delete(fn)},send(name){listeners.get(name)?.forEach(fn=>fn())}}};
const frames=new Map(),style=new Map(),win={...events(),scrollY:0,innerHeight:669,visualViewport:{...events(),height:669,offsetTop:0}};
let serial=0,renders=0,writes=0;
const parent={clientTop:0,getBoundingClientRect:()=>({top:-win.scrollY})};
const host={offsetParent:parent,style:{getPropertyValue:key=>style.get(key),setProperty(key,value){writes++;style.set(key,value)},removeProperty:key=>style.delete(key)}};
const code=req('esbuild').buildSync({entryPoints:['web/expense-report/src/navigation-viewport.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text;
const runtime={module:{exports:{}},require:req,window:win,requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id)};
vm.runInNewContext(code,runtime);
const {navigationViewportBottom,useNavigationViewport}=runtime.module.exports;
assert.equal(navigationViewportBottom(210,669,{offsetTop:0,height:657}),867,'Use the visible height when the layout viewport retains the old orientation');
assert.equal(navigationViewportBottom(210,669,{offsetTop:25,height:600}),835,'Visual viewport offsets participate in the document anchor');
assert.equal(navigationViewportBottom(210,657,null),867,'Older engines use the window viewport');
assert.equal(navigationViewportBottom(210,657,{offsetTop:0,height:156,scale:4.2}),867,'Rotation/zoom coordinates cannot strand a normal-sized dock at the zoomed height');
assert.equal(navigationViewportBottom(210,657,{offsetTop:0,height:0,scale:1}),867,'An intermediate empty viewport uses the valid layout height');
const ref={current:host};function Harness({enabled}){renders++;useNavigationViewport(ref,enabled);return null;}
let tree;act(()=>{tree=create(React.createElement(Harness,{enabled:false}))});assert.equal(style.size,0,'Standard devices keep the existing fixed dock');assert.equal(win.listeners.size,0);
act(()=>tree.update(React.createElement(Harness,{enabled:true})));
assert.equal(style.get('--bb-nav-viewport-bottom'),'669px');
const before=renders;
win.scrollY=210;win.visualViewport.height=657;win.send('orientationchange');win.visualViewport.send('resize');win.visualViewport.send('scroll');
assert.equal(frames.size,1,'Fold and viewport events coalesce into one frame');
for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(style.get('--bb-nav-viewport-bottom'),'867px','A scrolled folded page anchors to its visible bottom');assert.equal(renders,before,'Viewport changes do not rerender report or navigation');
const beforeWrites=writes;win.send('scroll');for(const [id,fn] of [...frames]){frames.delete(id);fn()}assert.equal(writes,beforeWrites,'Unchanged geometry does not rewrite styles');
win.scrollY=310;win.visualViewport.offsetTop=20;win.visualViewport.height=600;win.visualViewport.send('scroll');
for(const [id,fn] of [...frames]){frames.delete(id);fn()}
assert.equal(style.get('--bb-nav-viewport-bottom'),'930px','Late viewport movement updates without another window resize');
win.send('resize');assert.equal(frames.size,1);act(()=>tree.unmount());
assert.equal(frames.size,0);assert.equal(style.size,0);assert([...win.listeners.values(),...win.visualViewport.listeners.values()].every(set=>set.size===0),'Unmount clears every owned listener and pending frame');
console.log('Visible viewport anchoring, scrolled folds, late visual resize, event coalescing and cleanup pass');
