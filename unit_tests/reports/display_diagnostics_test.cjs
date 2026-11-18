const assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json'));
const code=req('esbuild').buildSync({entryPoints:['web/expense-report/src/display-diagnostics.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
let time=0,y=0,height=669,reads=0;
const privateValue=()=>{throw Error('Display reports must not read personal data')};
const element=(top=()=>y)=>({dataset:{},get textContent(){return privateValue()},get value(){return privateValue()},getBoundingClientRect(){reads++;return {x:0,y:top(),width:951,height}},scrollTop:0,scrollLeft:0});
const safe=element(),nodes=new Map(),page=Object.assign(element(),{dataset:{screen:'overview',duoLandscape:'true'},querySelector:selector=>nodes.get(selector)??element()});
const root=Object.assign(element(()=>0),{dataset:{},clientWidth:951,clientHeight:669,scrollWidth:951,scrollHeight:669});
let parent=page;for(let i=0;i<8;i++){parent.parentElement=Object.assign(element(()=>0),{tagName:'DIV',parentElement:null});parent=parent.parentElement}
const doc={documentElement:root,body:element(()=>0),visibilityState:'visible',activeElement:{matches:()=>false},querySelector:selector=>selector.includes('bb-page')?page:selector==='[data-bb-safe-area]'?safe:element(),get cookie(){return privateValue()}};
const win={innerWidth:951,innerHeight:669,outerWidth:951,outerHeight:669,scrollX:0,scrollY:0,devicePixelRatio:2,screen:{width:951,height:669,availWidth:951,availHeight:669,orientation:{type:'landscape-primary'}},visualViewport:{width:951,height:669,offsetLeft:0,offsetTop:0,pageLeft:0,pageTop:0,scale:1},matchMedia:()=>({matches:true}),get location(){return privateValue()},get localStorage(){return privateValue()}};
const runtime={module:{exports:{}},window:win,document:doc,navigator:{userAgent:'iPhone test browser',standalone:true},performance:{now:()=>time},getComputedStyle:el=>({position:'fixed',height:height+'px',paddingTop:el===safe?'18px':'0px',paddingRight:el===safe?'84px':'0px',paddingBottom:'12px',paddingLeft:'0px',transform:'none',gridTemplateRows:'72px 48px 533px'})};
vm.runInNewContext(code,runtime);const {recordDisplayFrame:record,displayReport:report}=runtime.module.exports;
record('mount');time=5000;const idleReads=reads;record('measure');assert.equal(reads,idleReads,'No continuous layout work outside the bounded resume capture');
record('focus','focus');assert.equal(JSON.parse(report('test-build')).resumeChanges[0].reason,'focus','Capture a focus-only app return without depending on hidden/pageshow');
doc.visibilityState='hidden';record('visibilitychange','background');
doc.visibilityState='visible';time=6000;y=82;height=587;win.innerHeight=587;win.visualViewport.height=587;record('visibilitychange','resume');
for(let i=0;i<30;i++){time+=10;y++;record('measure')}
time=10000;page.dataset.screen='settings';y=0;height=669;win.innerHeight=669;record('focusout');
const output=report('test-build'),data=JSON.parse(output);assert.equal(data.format,'BookieBot display report 1');assert.equal(data.beforeBackground.screen,'overview');assert.equal(data.beforeBackground.boxes.page[1],0);assert.equal(data.resumeChanges[0].boxes.page[1],82,'Pin the bad foreground geometry even after opening Settings');assert.equal(data.resumeChanges.length,10,'Bound the capture');assert.equal(data.current.screen,'settings');assert.equal(data.current.ancestors.length,6,'Bound ancestor measurements');assert.equal(data.resumeChanges[0].window[1],587);assert.equal(data.resumeChanges[0].visual[3],0,'Record height loss even when iOS reports zero offset');assert.equal(data.current.boxes.page[1],0);assert.equal(data.baseline.safe[1],84);assert(data.device.standalone);assert(output.length<10000,'Compact deltas stay easy to paste');
assert(!output.includes('secret')&&!output.includes('bookie.test')&&!output.includes('http'),'No URLs, cookies, text, input values or storage');
win.scrollY=Infinity;assert.equal(JSON.parse(report('test-build')).current.window[5],null,'Nonfinite measurements serialize safely');
for(let i=0;i<40;i++)record('focus');assert.equal(JSON.parse(report('test-build')).events.length,20,'Bound lifecycle event metadata independently of geometry');
doc.querySelector=()=>null;record('measure','resume');assert.equal(JSON.parse(report('test-build')).current,null,'Copy is safe without an active DUO surface');
console.log('Private bounded before/after geometry, pinned resume deltas, idle cost and copy safety pass');
