// Replay the geometry supplied by the physical iOS 27.2.1 DUO, not merely a
// displaced fixed element. A simulated native host only releases its top inset
// after seeing a committed alternate viewport fit followed by the original.
const assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path'),fs=require('node:fs'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json'));
const source=process.env.BOOKIEBOT_VIEWPORT_FIT_SOURCE;
const code=req('esbuild').buildSync({...(source?{stdin:{contents:fs.readFileSync(source,'utf8'),resolveDir:path.resolve('web/expense-report/src'),loader:'ts'}}:{entryPoints:['web/expense-report/src/duo-layout.ts']}),bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text;
function fixture(options={}){
 let time=0,serial=0,paints=0,sawAuto=false,content=options.content??'width=device-width, initial-scale=1, viewport-fit=cover',height=options.height??587;
 const original=content,changes=[],frames=new Map(),timers=new Map(),targets=[];
 const events=()=>{const listeners=new Map(),target={addEventListener(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)},removeEventListener(name,fn){listeners.get(name)?.delete(fn)},send(type){listeners.get(type)?.forEach(fn=>fn({type}))},listeners};targets.push(target);return target};
 const setTimeout=(fn,delay=0)=>{timers.set(++serial,{fn,at:time+delay});return serial};
 const scroll={scrollTop:640,scrollLeft:32};
 const page={dataset:{duoLandscape:options.open===false?'false':'true'},scrollTop:0,scrollLeft:0,querySelectorAll:()=>[scroll],getBoundingClientRect:()=>({top:0}),style:{getPropertyValue:()=>'',getPropertyPriority:()=>'',setProperty(){},removeProperty(){}},offsetHeight:587};
 const meta={getAttribute:()=>content,setAttribute(key,value){assert.equal(key,'content');changes.push({value,paint:paints});content=value;if(value===original&&sawAuto&&!options.unrepairable)height=669;setTimeout(()=>win.send('resize'))}};
 const win={...events(),navigator:{standalone:options.standalone??true},innerWidth:options.width??867,get innerHeight(){return height},outerWidth:options.outerWidth??951,outerHeight:options.outerHeight??669,scrollX:0,scrollY:0,scrollTo(){},visualViewport:{...events(),get height(){return options.visualHeight??height},scale:options.scale??1,offsetTop:0,offsetLeft:0},requestAnimationFrame(fn){frames.set(++serial,fn);return serial},cancelAnimationFrame(id){frames.delete(id)},setTimeout,clearTimeout(id){timers.delete(id)}};
 const doc={...events(),visibilityState:'visible',activeElement:options.focused?{matches:()=>true}:null,documentElement:{get clientWidth(){return win.innerWidth},get clientHeight(){return height},dataset:options.modal?{bbModalScrollLock:'true'}:{}},querySelector(selector){if(selector==='[data-bb-safe-area]')return {};if(selector==='meta[name="viewport"]')return options.noMeta?null:meta;return page}};
 Object.defineProperty(win,'screen',{get(){throw Error('The stale closed-display screen size must never govern recovery')}});
 const runtime={module:{exports:{}},require:req,window:win,document:doc,getComputedStyle:()=>({paddingTop:(options.safeTop??0)+'px'})};vm.runInNewContext(code,runtime);
 const stop=runtime.module.exports.watchDuoViewport(()=>{});
 const tick=(ms=16)=>{time+=ms;let guard=0;while(true){const due=[...timers].find(([,timer])=>timer.at<=time);if(!due)break;assert(++guard<100,'No timer feedback loop');timers.delete(due[0]);due[1].fn()}};
 const paint=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());paints++;if(content.includes('viewport-fit=auto'))sawAuto=true};
 const finish=()=>{for(let i=0;i<90;i++){tick();paint()}};
 const hide=()=>{doc.visibilityState='hidden';doc.send('visibilitychange')};
 const show=()=>{doc.visibilityState='visible';doc.send('visibilitychange')};
 const resize=(width,remainingHeight,outerWidth,outerHeight)=>{
  Object.assign(win,{innerWidth:width,outerWidth,outerHeight});height=remainingHeight;
  page.dataset.duoLandscape=String(width>height);win.visualViewport.send('resize');
 };
 return {win,doc,page,scroll,meta,original,changes,targets,timers,frames,stop,tick,paint,finish,hide,show,resize,get content(){return content},get height(){return height},set height(value){height=value}};
}
const f=fixture();f.finish();assert.equal(f.changes.length,0,'Cold/ordinary resize never reparses the viewport');
f.hide();f.show();
assert(f.content.includes('viewport-fit=auto'),'A known-bad resume starts recovery in the foreground event, before timers or the first paint');
f.paint();assert(f.content.includes('viewport-fit=auto'),'Keep the alternate fit for the required committed frame');
f.paint();assert.equal(f.height,669,'Finish recovery on the next frame, without waiting for 100/300ms settle timers');f.finish();
assert.equal(f.height,669,'The reported 82px native inset is reclaimed');
assert.deepEqual(f.changes.map(row=>row.value),[f.original.replace('cover','auto'),f.original]);
assert(f.changes[1].paint>f.changes[0].paint,'The alternate fit must survive a committed frame, not a same-task toggle');
assert.equal(f.scroll.scrollTop,640);assert.equal(f.scroll.scrollLeft,32);assert.equal(f.content,f.original);
f.win.send('focus');f.win.send('resize');f.win.visualViewport.send('resize');f.finish();assert.equal(f.changes.length,2,'Viewport events caused by the repair cannot start another repair');
f.hide();f.show();f.finish();assert.equal(f.changes.length,2,'Healthy subsequent app returns do nothing');f.stop();
for(const options of [{standalone:false},{open:false},{width:382,outerWidth:457},{height:669},{height:300},{height:620},{outerHeight:900},{outerWidth:1200},{visualHeight:300},{scale:2},{safeTop:82},{focused:true},{modal:true},{noMeta:true},{content:'width=device-width, initial-scale=1'}]){
 const g=fixture(options);g.finish();g.hide();g.show();g.finish();assert.equal(g.changes.length,0,'Do not change unrelated/healthy/browser/keyboard/zoom/modal geometry: '+JSON.stringify(options));g.stop();
}
const deferred=fixture({focused:true});deferred.hide();deferred.show();deferred.finish();assert.equal(deferred.changes.length,0);deferred.doc.activeElement=null;deferred.doc.send('focusout');deferred.finish();assert.equal(deferred.height,669,'A focused editor defers the repair until blur');deferred.stop();
const late=fixture({height:669});late.hide();late.show();assert.equal(late.changes.length,0);late.height=587;late.win.visualViewport.send('resize');assert(late.content.includes('viewport-fit=auto'),'Late native geometry starts recovery in its resize event, without restarting a settling delay');late.paint();late.paint();assert.equal(late.height,669);late.stop();
const transientOptions={visualHeight:669},transient=fixture(transientOptions);transient.hide();transient.show();assert.equal(transient.changes.length,0,'Inconsistent first-resume dimensions remain guarded');transientOptions.visualHeight=587;transient.paint();assert(transient.content.includes('viewport-fit=auto'),'Retry the guarded measurement on the first foreground frame');transient.paint();transient.paint();assert.equal(transient.height,669);transient.stop();
const focus=fixture();focus.hide();focus.doc.visibilityState='visible';focus.win.send('focus');assert(focus.content.includes('viewport-fit=auto'),'Focus-before-visibility begins the same immediate return');focus.doc.send('visibilitychange');focus.win.send('focus');focus.finish();assert.equal(focus.changes.length,2,'Duplicate focus/visibility events cannot restart or delay the native-fit cycle');focus.stop();
const stuck=fixture({unrepairable:true});stuck.hide();stuck.show();stuck.finish();assert.equal(stuck.height,587);assert.equal(stuck.changes.length,2,'One attempt per real resume, even if the native host refuses');stuck.win.send('resize');stuck.finish();assert.equal(stuck.changes.length,2);stuck.stop();
for(const action of ['hide','stop']){
 const g=fixture();g.hide();g.show();assert(g.content.includes('viewport-fit=auto'));
 g[action]();assert.equal(g.content,g.original,'Interrupted repair immediately restores metadata on '+action);g.finish();assert.equal(g.content,g.original);g.stop();
 assert.equal(g.frames.size,0);assert.equal(g.timers.size,0);assert(g.targets.every(target=>[...target.listeners.values()].every(set=>set.size===0)));
}
const fallback=fixture();fallback.hide();fallback.show();assert(fallback.content.includes('viewport-fit=auto'));fallback.tick(100);assert.equal(fallback.content,fallback.original,'A paused animation frame cannot leave auto fit behind');fallback.stop();
const external=fixture();external.hide();external.show();external.meta.setAttribute('content','width=device-width, viewport-fit=contain');external.stop();assert.equal(external.content,'width=device-width, viewport-fit=contain','Do not overwrite another viewport owner');
const rotated=fixture({height:669,unrepairable:true});
rotated.win.send('orientationchange'); // Orientation event precedes new geometry.
rotated.resize(669,867,669,951);rotated.finish();assert.equal(rotated.changes.length,0);
rotated.resize(867,669,951,669);assert.equal(rotated.changes.length,0,'First landscape report may be briefly healthy');
rotated.resize(867,587,951,669);
assert(rotated.content.includes('viewport-fit=auto'),'Unfolded portrait to landscape recovers without backgrounding');
rotated.paint();rotated.paint();rotated.win.send('orientationchange');rotated.win.send('resize');rotated.finish();
assert.equal(rotated.changes.length,2,'A burst of rotation and viewport events only attempts the native reset once');
assert.equal(rotated.content,rotated.original);assert.equal(rotated.scroll.scrollTop,640);
rotated.resize(669,867,669,951);rotated.resize(867,587,951,669);rotated.finish();
assert.equal(rotated.changes.length,4,'A later rotation can trigger a new repair');rotated.stop();
for(const portrait of [[457,678,457,678], [669,867,669,951]]){
 const healthy=fixture({height:669});
 healthy.resize(...portrait);healthy.resize(867,669,951,669);healthy.finish();
 assert.equal(healthy.changes.length,0,'Healthy landscape must not reset the viewport');healthy.stop();
}
console.log('Physical DUO viewport dimensions, committed native-fit recovery, state retention, one-shot guards and cleanup pass');
