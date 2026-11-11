const assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json'));
const code=req('esbuild').buildSync({entryPoints:['web/expense-report/src/page-scroll.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const style=()=>({overflow:'',paddingRight:'',setProperty(name,value){this[name]=value;}});
const root={style:style(),dataset:{},scrollHeight:1200,clientWidth:390},body={style:style()};
const listeners=new Map(),writes=[];
const win={scrollX:2,scrollY:300,innerHeight:700,innerWidth:390,
  scrollTo(options){writes.push(['window',options]);this.scrollX=options.left??this.scrollX;this.scrollY=options.top??this.scrollY;},
  addEventListener(name,callback,options){listeners.set(name,{callback,options});},
  removeEventListener(name,callback,capture){assert.equal(listeners.get(name).callback,callback);assert.equal(capture,true);listeners.delete(name);},
  getComputedStyle:()=>({paddingRight:'16px'})};
let surface=null;
const doc={documentElement:root,body,querySelector:()=>surface};
const runtime={module:{exports:{}},window:win,document:doc};vm.runInNewContext(code,runtime);
const {readPageScroll,scrollPageTo,observePageScroll,lockPageScroll}=runtime.module.exports;
assert.deepEqual({...readPageScroll()},{x:2,y:300,maxY:500});
scrollPageTo({top:250});assert.equal(win.scrollY,250);
let calls=0;const stop=observePageScroll(()=>calls++);
assert.equal(listeners.get('scroll').options.passive,true);assert.equal(listeners.get('scroll').options.capture,true);
const send=target=>listeners.get('scroll').callback({target});
send(win);send(doc);send({scrollTop:20});assert.equal(calls,2,'nested chart/dialog scrolls do not compact the app dock');
let unlock=lockPageScroll();assert.equal(root.style.overflow,'hidden');assert.equal(root.dataset.bbModalScrollLock,'true');
win.scrollY=400;unlock();assert.equal(win.scrollY,250);assert.equal(root.style.overflow,'');assert.equal(root.dataset.bbModalScrollLock,undefined);
surface={scrollLeft:0,scrollTop:420,scrollHeight:1800,clientHeight:657,offsetWidth:382,clientWidth:382,style:style(),scrollTo(options){writes.push(['surface',options]);this.scrollTop=options.top??this.scrollTop;this.scrollLeft=options.left??this.scrollLeft;}};
assert.deepEqual({...readPageScroll()},{x:0,y:420,maxY:1143});send(surface);assert.equal(calls,3,'the native Duo page emits navigation scroll updates');
scrollPageTo({top:120,behavior:'instant'});assert.equal(surface.scrollTop,120);assert.equal(win.scrollY,250,'Duo restoration never scrolls the document');
surface.scrollTop=-38;assert.equal(readPageScroll().y,-38,'preserve native bounce for refresh release');surface.scrollTop=120;
const oldRootOverflow=root.style.overflow;unlock=lockPageScroll();assert.equal(surface.style.overflow,'hidden');assert.equal(root.style.overflow,oldRootOverflow,'Duo dialogs lock the actual page surface');
const nestedUnlock=lockPageScroll();nestedUnlock();assert.equal(surface.style.overflow,'hidden');assert.equal(root.dataset.bbModalScrollLock,'true','nested locks preserve the outer lock');
surface.scrollTop=600;unlock();assert.equal(surface.scrollTop,120);assert.equal(surface.style.overflow,'');assert.equal(root.dataset.bbModalScrollLock,undefined);
surface.clientHeight=669;assert.equal(readPageScroll().maxY,1131,'orientation changes read the same live surface');
stop();assert.equal(listeners.size,0);
console.log('Document/Duo scrolling, nested event filtering, native bounce and dialog lock/position restoration pass');
