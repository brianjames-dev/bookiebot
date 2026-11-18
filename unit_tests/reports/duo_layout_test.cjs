const assert=require('node:assert/strict');
const {duoLandscapeGeometry,duoRingGeometry,duoPreferenceKey}=require('./load_frontend_module.cjs')('duo-layout.ts');
assert.equal(duoPreferenceKey(' Brian '),'bookiebot:duo-layout:brian');
for(const [width,height,inset,expected] of [[867,669,0,0],[951,648,0,84],[867,669,84,0],[951,648,84,84]]){
 const geometry=duoLandscapeGeometry(width,height,inset);
 assert.equal(geometry.landscape,true);assert.equal(geometry.overlay,expected);assert.equal(geometry.rail,84);
}
for(const [width,height] of [[382,657],[466,678],[669,951],[1280,800],[800,900],[867,400]])assert.equal(duoLandscapeGeometry(width,height,0).landscape,false);
for(const [width,height] of [[320,219],[360,280],[240,100],[0,0]]){
 const ring=duoRingGeometry({width,height});
 assert(ring.outerRadius>0);assert(ring.innerRadius>0);assert(ring.innerRadius<ring.outerRadius);
 if(height)assert(ring.outerRadius*2<=Math.min(width,height));
 assert(Math.abs(ring.innerRadius/ring.outerRadius-(1-52/219))<.00001);
}
assert.equal(duoRingGeometry({width:360,height:280}).outerRadius,138,'unfolded ring fills its available row without the former fixed-size cap');
console.log('Duo viewport geometry, legacy preference identity and bounded ring geometry pass');

// Execute the real preference/resize lifecycle without a browser or backend.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT=true;
const listeners=new Map(),storage=new Map(),frames=new Map(),timers=new Map();let appended=0,removed=0,layout,serial=0,resets=0;
const listen=(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)};
const win={innerHeight:669,scrollX:0,scrollY:0,scrollTo(){resets++;this.scrollX=this.scrollY=0},requestAnimationFrame(fn){frames.set(++serial,fn);return serial},cancelAnimationFrame(id){frames.delete(id)},setTimeout(fn){timers.set(++serial,fn);return serial},clearTimeout(id){timers.delete(id)},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},addEventListener:listen,removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
const doc={visibilityState:'visible',activeElement:null,addEventListener:(name,fn)=>listen('document:'+name,fn),removeEventListener:(name,fn)=>listeners.get('document:'+name)?.delete(fn),documentElement:{clientWidth:867},body:{append(){appended++}},createElement:()=>({style:{},setAttribute(){},remove(){removed++}})};
const code=req('esbuild').buildSync({entryPoints:[path.resolve('web/expense-report/src/duo-layout.ts')],bundle:true,write:false,format:'cjs',platform:'node',external:['react'],logLevel:'silent'}).outputFiles[0].text;
const runtime={module:{exports:{}},require:req,window:win,document:doc,getComputedStyle:()=>({paddingRight:'0px'})};vm.runInNewContext(code,runtime);
function Harness({owner}){layout=runtime.module.exports.useDuoLayout(owner);return null;}
let tree;act(()=>{tree=create(React.createElement(Harness,{owner:'Brian'}))});assert.equal(layout.enabled,false);assert.equal(appended,0,'Default/closed main adds no safe-area probe');
act(()=>layout.toggle());assert.equal(layout.landscape,true);assert.equal(layout.overlay,0);assert.equal(storage.get('bookiebot:duo-layout:brian'),'true');
doc.documentElement.clientWidth=382;win.innerHeight=657;act(()=>listeners.get('resize').forEach(fn=>fn()));assert.equal(layout.enabled,true);assert.equal(layout.landscape,false,'Folding keeps the choice and restores normal main layout');
doc.visibilityState='hidden';doc.documentElement.clientWidth=951;win.innerHeight=669;win.scrollY=28;
act(()=>listeners.get('document:visibilitychange').forEach(fn=>fn()));assert.equal(layout.landscape,false);assert.equal(win.scrollY,28,'Hidden pages do not interfere with OS restoration');
doc.visibilityState='visible';act(()=>listeners.get('pageshow').forEach(fn=>fn()));assert.equal(layout.landscape,true,'Resume remeasures a fold even without a resize');assert.equal(win.scrollY,0);assert.equal(resets,1);
win.scrollY=20;act(()=>{const fn=[...timers.values()][0];fn()});assert.equal(win.scrollY,0,'A late restored document pan is repaired after the initial frame');
win.visualViewport={height:400,scale:1,addEventListener(){},removeEventListener(){}};doc.activeElement={matches:()=>true};win.scrollY=80;act(()=>listeners.get('focus').forEach(fn=>fn()));assert.equal(win.scrollY,80,'The keyboard can pan a focused field');
doc.activeElement=null;win.visualViewport={height:669,scale:2,addEventListener(){},removeEventListener(){}};act(()=>listeners.get('focus').forEach(fn=>fn()));assert.equal(win.scrollY,80,'Pinch zoom keeps its pan');
win.visualViewport.scale=.8;act(()=>listeners.get('focus').forEach(fn=>fn()));assert.equal(win.scrollY,80,'Zooming out also keeps its pan');
win.visualViewport={height:669,scale:1,addEventListener(){},removeEventListener(){}};act(()=>listeners.get('orientationchange').forEach(fn=>fn()));assert.equal(win.scrollY,0);
act(()=>tree.update(React.createElement(Harness,{owner:'Hannah'})));assert.equal(layout.enabled,false,'The device preference is isolated by owner');assert.equal(removed,1);
win.localStorage.setItem=()=>{throw Error('Storage blocked')};act(()=>layout.toggle());assert.equal(layout.enabled,true,'Blocked storage retains the session choice');
act(()=>tree.unmount());assert.equal(removed,2);assert([...listeners.values()].every(set=>set.size===0),'Unmount clears owned listeners');assert.equal(frames.size,0);assert.equal(timers.size,0);
console.log('Duo preference isolation, folding, blocked storage and listener cleanup pass');
