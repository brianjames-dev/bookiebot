const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),Renderer=req('react-test-renderer'),ts=req('typescript'),{act}=Renderer;
global.IS_REACT_ACT_ENVIRONMENT=true;
const timers=new Map(),requests=[];let serial=0,work={pending:false,uncertain:false,dirty:false},tree,blocked=false,otherDialog=false,entered;
class Element{focus(){}}
class Dialog extends Element{open=false;showModal(){if(otherDialog)throw Error('another modal');this.open=true}close(){this.open=false}}
let dialog=new Dialog();const document=new EventTarget();Object.assign(document,{visibilityState:'visible',documentElement:{},activeElement:new Element(),querySelector:()=>otherDialog||dialog.open?{}:null});
const window=new EventTarget();Object.assign(window,{setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial},clearTimeout:id=>timers.delete(id)});
const exportsObject={},code=ts.transpileModule(fs.readFileSync('web/expense-report/src/bill-checkin.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
vm.runInNewContext(code,{exports:exportsObject,require:name=>name.endsWith('.css')?{}:name==='./app-work-guard'?{useAppWorkGuard:()=>work}:req(name),window,document,HTMLElement:Element,MutationObserver:class{observe(){}disconnect(){}},AbortController,Intl,Date,Error,crypto:{randomUUID:()=>`checkin-request-${++serial}`},fetch:(url,options)=>new Promise((resolve,reject)=>{const request={url,options,resolve,reject};requests.push(request);options.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true})})});
const {BillCheckin}=exportsObject,day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),due={day,bills:[{id:'pge',name:'PG&E',month:'2026-11',date:'2026-11-22',overdue:false}]};
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve()},run=fn=>act(async()=>{fn();await flush()}),last=()=>requests.at(-1),body=()=>JSON.parse(last().options.body),respond=data=>run(()=>last().resolve({ok:true,json:async()=>data}));
const render=()=>React.createElement(BillCheckin,{owner:'Brian',enabled:true,blocked,onEnter:value=>entered=value});
const mount=()=>run(()=>{dialog=new Dialog();tree=Renderer.create(render(),{createNodeMock:node=>node.type==='dialog'?dialog:null})}),update=()=>run(()=>tree.update(render())),tick=()=>run(()=>{for(const [id,t] of [...timers])if(t.ms===1200){timers.delete(id);t.fn()}}),unmount=()=>run(()=>tree.unmount());
const text=node=>typeof node==='string'?node:node?.children?.map(text).join('')??'';
(async()=>{
 for(const kind of ['dirty','pending','uncertain']){
  requests.length=0;work={pending:false,uncertain:false,dirty:false,[kind]:true};await mount();await tick();assert.equal(requests.length,0,kind+' defers all check-in reads');
  work={pending:false,uncertain:false,dirty:false};await update();await tick();assert.equal(last().options.method,'GET');await respond(due);assert.equal(body().action,'claim');await respond({...due,claimed:true});assert(dialog.open);assert.equal(body().action,'shown','A visible modal is acknowledged separately');await respond({day,shown:true});
  await run(()=>tree.root.findAllByType('button').find(n=>text(n)==='Later').props.onClick());assert(!dialog.open);const count=requests.length;await run(()=>document.dispatchEvent(new Event('visibilitychange')));await tick();assert.equal(requests.length,count,'Later remains dismissed through resume');await unmount();
 }
 requests.length=0;await mount();await tick();await respond(due);assert.equal(body().action,'claim');work={pending:false,uncertain:false,dirty:true};await update();assert(!dialog.open);assert.equal(body().action,'release','A blocked in-flight reservation releases rather than using the day');await respond({day,claimed:false});
 work={pending:false,uncertain:false,dirty:false};await update();await tick();assert.equal(last().options.method,'GET','Clearing work cannot strand the check-in after cancelling an in-flight claim');await respond(due);await respond({...due,claimed:true});await respond({day,shown:true});
 await run(()=>tree.root.findAllByType('button').find(n=>text(n).includes('PG&E')).props.onClick());assert(!dialog.open);assert.equal(entered.id,'pge');assert.equal(entered.month,'2026-11');assert(entered.nonce);await unmount();
 // Hidden/resumed pages and another native dialog defer without claiming.
 requests.length=0;document.visibilityState='hidden';await mount();await tick();assert.equal(requests.length,0);document.visibilityState='visible';otherDialog=true;await run(()=>document.dispatchEvent(new Event('visibilitychange')));await tick();assert.equal(requests.length,0);otherDialog=false;await run(()=>window.dispatchEvent(new Event('focus')));await tick();await respond(due);await respond({...due,claimed:false});assert(!dialog.open);await unmount();
 assert.equal(timers.size,0);console.log('PASS bill check-in idle deferral, visible acknowledgement, resume, claim release and native handoff');
})().catch(error=>{console.error(error);process.exitCode=1});
