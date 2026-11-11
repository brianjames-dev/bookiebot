const assert=require('node:assert/strict');
const {duoLandscapeGeometry,duoRingGeometry,duoPreferenceKey}=require('./load_frontend_module.cjs')('duo-layout.ts');
assert.equal(duoPreferenceKey(' Brian '),'bookiebot:duo-layout:brian');
for(const [width,height,inset,expected] of [[867,669,0,0],[951,648,0,84],[867,669,84,84]]){
 const geometry=duoLandscapeGeometry(width,height,inset);
 assert.equal(geometry.landscape,true);assert.equal(geometry.overlay,expected);assert.equal(geometry.rail,84);
}
for(const [width,height] of [[382,657],[466,678],[669,951],[1280,800],[800,900],[867,400]])assert.equal(duoLandscapeGeometry(width,height,0).landscape,false);
for(const [width,height] of [[320,219],[240,100],[0,0]]){
 const ring=duoRingGeometry({width,height});
 assert(ring.outerRadius>0);assert(ring.innerRadius>0);assert(ring.innerRadius<ring.outerRadius);
 if(height)assert(ring.outerRadius*2<=Math.min(width,height));
 assert(Math.abs(ring.innerRadius/ring.outerRadius-(1-52/219))<.00001);
}
console.log('Duo viewport geometry, legacy preference identity and bounded ring geometry pass');

// Execute the real preference/resize lifecycle without a browser or backend.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT=true;
const listeners=new Map(),storage=new Map();let appended=0,removed=0,layout;
const win={innerHeight:669,localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)},removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
const doc={documentElement:{clientWidth:867},body:{append(){appended++}},createElement:()=>({style:{},setAttribute(){},remove(){removed++}})};
const code=req('esbuild').buildSync({entryPoints:[path.resolve('web/expense-report/src/duo-layout.ts')],bundle:true,write:false,format:'cjs',platform:'node',external:['react'],logLevel:'silent'}).outputFiles[0].text;
const runtime={module:{exports:{}},require:req,window:win,document:doc,getComputedStyle:()=>({paddingRight:'0px'})};vm.runInNewContext(code,runtime);
function Harness({owner}){layout=runtime.module.exports.useDuoLayout(owner);return null;}
let tree;act(()=>{tree=create(React.createElement(Harness,{owner:'Brian'}))});assert.equal(layout.enabled,false);assert.equal(appended,0,'Default/closed main adds no safe-area probe');
act(()=>layout.toggle());assert.equal(layout.landscape,true);assert.equal(layout.overlay,0);assert.equal(storage.get('bookiebot:duo-layout:brian'),'true');
doc.documentElement.clientWidth=382;win.innerHeight=657;act(()=>listeners.get('resize').forEach(fn=>fn()));assert.equal(layout.enabled,true);assert.equal(layout.landscape,false,'Folding keeps the choice and restores normal main layout');
act(()=>tree.update(React.createElement(Harness,{owner:'Hannah'})));assert.equal(layout.enabled,false,'The device preference is isolated by owner');assert.equal(removed,1);
win.localStorage.setItem=()=>{throw Error('Storage blocked')};act(()=>layout.toggle());assert.equal(layout.enabled,true,'Blocked storage retains the session choice');
act(()=>tree.unmount());assert.equal(removed,2);assert([...listeners.values()].every(set=>set.size===0),'Unmount clears owned listeners');
console.log('Duo preference isolation, folding, blocked storage and listener cleanup pass');
