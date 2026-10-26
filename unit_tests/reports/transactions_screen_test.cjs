const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {createRequire}=require('node:module'),req=createRequire(path.resolve('web/expense-report/package.json'))
const React=req('react'),Renderer=req('react-test-renderer'),ts=req('typescript'),{act}=Renderer
const requests=[],timers=new Map(),events=[],storage=new Map(),statuses=new Map(),cache=new Map()
let serial=0,tree,work
const update=()=>{const all=[...statuses.values()];work={pending:all.some(v=>v.pending),uncertain:all.some(v=>v.uncertain),dirty:all.some(v=>v.dirty)}}
const win={setTimeout(fn,ms){timers.set(++serial,{fn,ms});return serial},clearTimeout(id){timers.delete(id)},addEventListener(){},removeEventListener(){},dispatchEvent(e){events.push(e.type)},matchMedia(){return {matches:true}}}
global.IS_REACT_ACT_ENVIRONMENT=true
function load(file){
 if(cache.has(file))return cache.get(file)
 const exports={};cache.set(file,exports)
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText
 vm.runInNewContext(code,{exports,AbortController,URLSearchParams,Intl,Date,Error,Event:class{constructor(type){this.type=type}},window:win,crypto:{randomUUID:()=>`isolated-request-${++serial}-command`},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),require:name=>name.endsWith('.css')?{}:name==='./app-work-guard'?{useAppWorkStatus(value){const id=React.useId();statuses.set(id,value);update();React.useEffect(()=>()=>{statuses.delete(id);update()},[id]);return React.useCallback(next=>{statuses.set(id,next);update()},[id])}}:name.startsWith('.')?load(['.tsx','.ts'].map(ext=>path.resolve(path.dirname(file),name)+ext).find(fs.existsSync)):req(name)})
 return exports
}
const {TransactionsScreen}=load(path.resolve('web/expense-report/src/transactions-screen.tsx'))
const fixture=(active=true)=>React.createElement(TransactionsScreen,{active,ownerName:'Brian',initialMonth:'2026-10'})
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve()}
const run=async fn=>act(async()=>{fn();await flush()})
const tick=async()=>run(()=>{for(const [id,timer] of [...timers])if(timer.ms<1000){timers.delete(id);timer.fn()}})
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.children?n.children.map(text).join(''):''
const visible=node=>{for(let n=node;n;n=n.parent)if(n.props.hidden||n.props.inert||n.props['aria-hidden'])return false;return true}
const button=label=>tree.root.findAllByType('button').filter(visible).find(n=>text(n)===label||n.props['aria-label']===label)
const click=async label=>run(()=>{const n=button(label);assert.ok(n,`Missing ${label}`);assert.ok(!n.props.disabled,`Disabled ${label}`);n.props.onClick()})
const latest=()=>requests.at(-1)
const respond=async(data,status=200,target=latest())=>run(()=>target.resolve({ok:status<400,status,json:async()=>data}))
const reject=async(target=latest())=>run(()=>target.reject(Error('Lost connection')))
const body=()=>JSON.parse(latest().options.body)
const row={id:'2026-10:source-1',actionId:'source-1',month:'2026-10',version:'version-1',date:'2026-10-20',title:'Fixture cable',location:'Fixture shop',person:'Brian (BofA)',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:1234,split:'',fields:{date:'2026-10-20',item:'Fixture cable',amount:'12.34',location:'Fixture shop',person:'Brian (BofA)'},editableFields:['item','amount','location','person'],capabilities:{update:true,move:true,delete:true,split:true,cancel_split:false,undo:true},reasons:{}}
const listing=(items=[row],extra={})=>({items,total:items.length,nextOffset:null,categories:['shopping'],persons:['Brian (BofA)'],month:'2026-10',...extra})
const review=(change,item=row)=>({review:{item,after:{...item.fields,amount:change.updates?.amount?String(change.updates.amount/100):item.fields.amount},operation:change.operation,destination:change.destination,reviewVersion:'review-'+change.operation,share:change.operation==='split'?{method:'income',payerCents:800,partnerCents:434}:undefined}})
const expand=async()=>run(()=>tree.root.findAllByType('button').find(n=>n.props.className==='bb-transaction-row-toggle').props.onClick())
const submit=async()=>run(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
;(async()=>{
 await run(()=>{tree=Renderer.create(fixture(false))});await tick();assert.equal(requests.length,0,'Hidden Transactions does not add startup reads')
 await run(()=>tree.update(fixture(true)));await tick();assert.match(latest().url,/\/app\/transactions\?/);await respond(listing())
 await click('Refresh transactions');assert.match(latest().url,/fresh=1/);await respond(listing())
 await expand();await click('Update');assert.equal(work.dirty,true)
 await run(()=>tree.root.findAllByType('input').find(n=>n.props.value==='12.34').props.onChange({target:{value:'15.99'}}))
 assert.equal(requests.filter(r=>r.options.body).length,0,'Editing does not write')
 await submit();assert.equal(body().updates.amount,1599);assert.equal(latest().url,'/app/transactions/review');const updateBody=body();await respond(review(updateBody))
 assert.ok(button('Confirm update'));assert.equal(requests.filter(r=>r.url==='/app/transactions').length,0,'Review is not confirmation')
 await click('Cancel');assert.equal(work.dirty,false)
 for(const [label,op] of [['Move','move'],['Delete','delete'],['Split','split']]){
  await expand();await click(label)
  if(op==='move')await run(()=>tree.root.findByType('form').findByType('select').props.onChange({target:{value:'food'}}))
  await submit();const change=body();assert.equal(change.operation,op);await respond(review(change))
  if(op==='split')assert.match(text(tree.toJSON()),/No repayment will be marked received/)
  await click('Cancel')
 }
 await expand();await click('Update');await run(()=>tree.root.findAllByType('input').find(n=>n.props.value==='12.34').props.onChange({target:{value:'22.00'}}));await submit();const change=body();await respond(review(change))
 await click('Confirm update');const original=body();assert.equal(original.reviewVersion,'review-update');assert.equal(work.pending,true);assert.equal(work.uncertain,true)
 assert.ok(button('Cancel').props.disabled)
 const count=requests.filter(r=>r.url==='/app/transactions').length
 await run(()=>button('Saving…').props.onClick());assert.equal(requests.filter(r=>r.url==='/app/transactions').length,count,'Concurrent confirmation cannot submit twice')
 await reject();assert.equal(work.uncertain,true);assert.ok(button('Cancel').props.disabled)
 await click('Retry same confirmation');assert.deepEqual(body(),original,'Recovery retains the exact confirmed command and ID')
 await respond({state:'done',success:true,detail:'Updated isolated transaction',undo:{month:'2026-10',id:'2026-10:update-1'}})
 assert.equal(work.uncertain,false);assert.equal(work.pending,false);assert.ok(events.includes('bookiebot:transactions-changed'));assert.ok(events.includes('bookiebot:reimbursements-changed'))
 assert.ok(button('Undo this change'));await click('Undo this change');assert.equal(body().operation,'undo');assert.equal(body().id,'2026-10:update-1')
 await respond(review(body(),{...row,id:'2026-10:update-1'}));assert.ok(button('Confirm undo'));await click('Cancel')
 await tick();await respond(listing())
 await run(()=>tree.root.findByProps({'aria-label':'Search transactions'}).props.onChange({target:{value:'cable'}}));await tick();assert.match(latest().url,/search=cable/)
 const old=latest();await run(()=>tree.root.findByProps({'aria-label':'Search transactions'}).props.onChange({target:{value:'payroll'}}));await tick();const current=latest()
 await respond(listing([{...row,title:'Payroll fixture',id:'payroll'}]),200,current);await respond(listing(),200,old)
 assert.match(text(tree.toJSON()),/Payroll fixture/);assert.ok(!text(tree.toJSON()).includes('Fixture cable'),'Stale search responses cannot replace the latest results')
 await click('Filters');await run(()=>tree.root.findByProps({'aria-label':'Transaction type'}).props.onChange({target:{value:'income'}}));await tick();assert.match(latest().url,/kind=income/);await respond(listing([]))
 assert.match(text(tree.toJSON()),/No transactions match/)
 await click('Clear search and filters');await tick();await respond(listing())
 await expand();await click('Delete');await submit();await respond(review(body()));await click('Confirm delete');const deletion=body();await reject()
 await run(()=>tree.unmount());assert.ok(storage.size,'Uncertain confirmation survives a page reload in this owner session')
 const before=requests.filter(r=>r.options.body).length
 await run(()=>{tree=Renderer.create(fixture(false))});assert.equal(requests.filter(r=>r.options.body).length,before,'Reload never repeats a financial writer')
 await click('Check saved status');assert.match(latest().url,new RegExp('/commands/'+deletion.requestId+'$'));await respond({state:'done',success:true,detail:'Deleted isolated fixture'})
 assert.equal(storage.size,0);assert.equal(work.uncertain,false)
 await run(()=>tree.unmount())
 console.log('Transactions search/filter, stale responses, review/cancel, every action, Undo, private recovery and request identity passed')
})().catch(e=>{console.error(e);process.exitCode=1})
