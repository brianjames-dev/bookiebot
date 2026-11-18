const assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json'));
const code=req('esbuild').buildSync({entryPoints:['web/expense-report/src/duo-list-scroll.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text;
function fixture(){
 const targets=[],frames=new Map(),timers=new Map(),cuts=[];let serial=0,drift=0;
 const eventTarget=()=>{const listeners=new Map();const target={addEventListener(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)},removeEventListener(name,fn){listeners.get(name)?.delete(fn)},send(name,event={}){listeners.get(name)?.forEach(fn=>fn(event))},listeners};targets.push(target);return target};
 const page={...eventTarget(),dataset:{screen:'transactions'},clientHeight:657,scrollHeight:3000,getBoundingClientRect:()=>({top:0,height:657})};
 const list={clientHeight:400,scrollHeight:1800,getBoundingClientRect:()=>({top:page.dataset.duoLandscape?120:0,height:page.dataset.duoLandscape?400:0}),contains:row=>rows.includes(row),querySelectorAll:()=>rows};
 for(const owner of [page,list]){let y=0;const style={overflow:''};owner.style=new Proxy(style,{set(target,key,value){target[key]=value;if(key==='overflow'&&value==='clip'){cuts.push(owner);y=0}return true}});Object.defineProperty(owner,'offsetHeight',{get:()=>owner.clientHeight});Object.defineProperty(owner,'scrollTop',{get:()=>owner===page&&page.dataset.duoLandscape?0:owner===list&&!page.dataset.duoLandscape?0:y,set:value=>{y=Math.max(0,Math.min(value,owner.scrollHeight-owner.clientHeight))}})}
 const rows=Array.from({length:30},(_,i)=>({isConnected:true,getBoundingClientRect(){const top=page.dataset.duoLandscape?120+i*64+drift-list.scrollTop:240+i*64+drift-page.scrollTop;return {top,bottom:top+64}}}));page.querySelector=()=>list;
 const win={...eventTarget(),innerHeight:657,visualViewport:{...eventTarget(),height:657,scale:1},requestAnimationFrame(fn){frames.set(++serial,fn);return serial},cancelAnimationFrame(id){frames.delete(id)},setTimeout(fn){timers.set(++serial,fn);return serial},clearTimeout(id){timers.delete(id)}};
 const doc={...eventTarget(),visibilityState:'visible',activeElement:null,documentElement:{dataset:{}}};
 const runtime={module:{exports:{}},require:req,window:win,document:doc};vm.runInNewContext(code,runtime);
 const controller=runtime.module.exports.createDuoListScroll(page);
 const paint=()=>{for(let i=0;frames.size&&i<10;i++){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn())}assert.equal(frames.size,0,'No unbounded frame loop')};
 const finish=()=>{paint();const batch=[...timers.values()];timers.clear();batch.forEach(fn=>fn());paint()};
 return {page,list,win,doc,controller,rows,cuts,targets,frames,timers,paint,finish,drift(value){drift=value}};
}
const f=fixture();f.controller.layout(false,'transactions');f.finish();f.page.scrollTop=500;f.page.send('scroll',{target:f.page});f.paint();const row=f.rows[4],offset=row.getBoundingClientRect().top;
f.page.dataset.duoLandscape='true';f.controller.layout(true,'transactions');assert.equal(f.page.scrollTop,0);assert.equal(row.getBoundingClientRect().top-120,offset);
f.drift(12);f.finish();assert.equal(row.getBoundingClientRect().top-120,offset,'Late responsive measurements retain the original visible row');
f.list.scrollTop=800;f.page.send('scroll',{target:f.list});f.paint();const row2=f.rows[12],offset2=row2.getBoundingClientRect().top-120;
f.win.send('pagehide');f.doc.visibilityState='hidden';f.doc.send('visibilitychange');delete f.page.dataset.duoLandscape;f.controller.layout(false,'transactions');f.finish();
f.doc.visibilityState='visible';f.doc.send('visibilitychange');f.win.send('pageshow');f.finish();assert.equal(row2.getBoundingClientRect().top,offset2,'Background folds hand the same row back to the compact page');assert(f.cuts.includes(f.page)&&f.cuts.includes(f.list));
let cuts=f.cuts.length;f.doc.activeElement={matches:()=>true};f.win.visualViewport.height=300;f.win.send('focus');f.finish();assert.equal(f.cuts.length,cuts,'Keyboard panning is not interrupted');
f.doc.activeElement=null;f.win.visualViewport.height=657;f.win.visualViewport.scale=2;f.win.send('focus');f.finish();assert.equal(f.cuts.length,cuts,'Pinch panning is not interrupted');
f.win.visualViewport.scale=1;f.doc.documentElement.dataset.bbModalScrollLock='true';f.win.send('focus');f.finish();assert.equal(f.cuts.length,cuts,'Modal scroll locks remain authoritative');delete f.doc.documentElement.dataset.bbModalScrollLock;
f.page.dataset.duoLandscape='true';f.controller.layout(true,'transactions');f.page.send('pointerdown');f.list.scrollTop=420;f.page.send('scroll',{target:f.list});f.finish();assert.equal(f.list.scrollTop,420,'A new user scroll cancels pending alignment rather than fighting it');
delete f.page.dataset.duoLandscape;f.page.dataset.screen='shared';f.page.scrollTop=180;f.controller.layout(false,'shared');f.finish();f.page.dataset.screen='transactions';f.page.scrollTop=70;f.controller.layout(false,'transactions');f.finish();assert.equal(f.page.scrollTop,70,'Existing shell tab restoration is not overridden by a saved fold anchor');
f.controller.dispose();assert(f.targets.every(t=>[...t.listeners.values()].every(set=>set.size===0)));assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);
console.log('Actual scroll-owner handoff, late layout, background fold, motion reset, interaction guards and cleanup pass');
