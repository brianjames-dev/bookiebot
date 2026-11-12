const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {createRequire}=require('node:module'),req=createRequire(path.resolve('web/expense-report/package.json'))
const React=req('react'),Renderer=req('react-test-renderer'),ts=req('typescript'),{act}=Renderer
const plans=[],requests=[],timers=new Map(),events=[],storage=new Map(),statuses=new Map(),cache=new Map()
let serial=0,tree,work,duoWide=false,now=Date.UTC(2026,10,11,12)
const updates=[],onUpdated=time=>updates.push(time)
class TestDate extends Date { constructor(...args){super(...(args.length?args:[now]))} static now(){return now} }
const SwipeContext=React.createContext(null)
function ActionFixture({entry}){const ctx=React.useContext(SwipeContext),row=ctx.rows.get(entry.id);return ctx.onManage?React.createElement('button',{'aria-label':'Manage '+entry.id,disabled:ctx.locked,onClick:()=>ctx.onManage(row)},'Manage entry'):React.createElement('div',null,entry.item,['update','split','delete'].filter(op=>row.capabilities[op]).map(op=>React.createElement('button',{key:op,disabled:ctx.locked,onClick:()=>ctx.onAction(row,op)},op==='split'&&row.split?'Edit split':op[0].toUpperCase()+op.slice(1))))}
const presentation={
 './transaction-step-motion':{StepMotion:({review,edit,confirm})=>React.createElement(React.Fragment,null,React.createElement('div',{inert:review},edit),React.createElement('div',{inert:!review},confirm))},
 './transaction-undo-popup':{UndoPopup:({notice,onUndo,onDismiss})=>React.createElement('div',{'aria-label':'Undo popup'},notice.title,React.createElement('button',{onClick:onUndo},'Undo'),React.createElement('button',{onClick:onDismiss},'Dismiss undo'))},
 './app-navigation':{useAppNavigation:()=>duoWide?{duoLandscape:true}:null},
 './transaction-swipe':{TransactionSwipeContext:SwipeContext,wrapTransactionRow:(entry)=>React.createElement(ActionFixture,{entry})},
 './daily-transactions':{TransactionIcon:()=>null,DailyTransactionDays:({groups,wrapRow})=>{const plan=React.useContext(load(path.resolve('web/expense-report/src/transaction-value-motion.tsx')).ChangeMotionContext);if(plan&&plan!==plans.at(-1))plans.push(plan);return React.createElement('div',null,groups.flatMap(group=>group.entries.map(entry=>React.createElement(React.Fragment,{key:entry.id},wrapRow(entry,0,React.createElement('div',{className:'bb-daily-transaction'},entry.item))))))}},
 './report-app':{DailySpendingChart:props=>React.createElement('div',{'data-graph-open':props.graphOpen},props.metricLabel,props.total,props.transactionControl),CategoryFilterControl:props=>React.createElement('select',{'aria-label':props.label,value:props.filter,onChange:event=>props.onFilterChange(event.target.value)},props.filters.map(option=>React.createElement('option',{key:option.value,value:option.value},option.label)))}
}
const update=()=>{const all=[...statuses.values()];work={pending:all.some(v=>v.pending),uncertain:all.some(v=>v.uncertain),dirty:all.some(v=>v.dirty)}}
const win={setTimeout(fn,ms){timers.set(++serial,{fn,ms});return serial},clearTimeout(id){timers.delete(id)},addEventListener(){},removeEventListener(){},dispatchEvent(e){events.push(e.type)},matchMedia(){return {matches:true}}}
global.IS_REACT_ACT_ENVIRONMENT=true
function load(file){
 if(cache.has(file))return cache.get(file)
 const exports={};cache.set(file,exports)
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText
 vm.runInNewContext(code,{exports,AbortController,URLSearchParams,Intl,Date:TestDate,Error,Event:class{constructor(type){this.type=type}},window:win,matchMedia:win.matchMedia,requestAnimationFrame:fn=>{queueMicrotask(fn);return 1},cancelAnimationFrame(){},crypto:{randomUUID:()=>`isolated-request-${++serial}-command`},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),require:name=>presentation[name]??(name.endsWith('.css')?{}:name==='./app-work-guard'?{useAppWorkStatus(value){const id=React.useId();statuses.set(id,value);update();React.useEffect(()=>()=>{statuses.delete(id);update()},[id]);return React.useCallback(next=>{statuses.set(id,next);update()},[id])}}:name.startsWith('.')?(name.endsWith('.json')?JSON.parse(fs.readFileSync(path.resolve(path.dirname(file),name),'utf8')):load(['.tsx','.ts'].map(ext=>path.resolve(path.dirname(file),name)+ext).find(fs.existsSync))):req(name))})
 if(file.endsWith('/transaction-feedback.ts'))exports.settledTransactionRow=async()=>{}
 return exports
}
const {TransactionsScreen}=load(path.resolve('web/expense-report/src/transactions-screen.tsx'))
const fixture=(active=true)=>React.createElement(TransactionsScreen,{active,ownerName:'Brian',initialMonth:'2026-10',onUpdated})
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve()}
const run=async fn=>act(async()=>{fn();await flush()})
const tick=async()=>run(()=>{for(const [id,timer] of [...timers])if(timer.ms<1000){timers.delete(id);timer.fn()}})
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.children?n.children.map(text).join(''):''
const visible=node=>{for(let n=node;n;n=n.parent)if(n.props.hidden||n.props.inert||n.props['aria-hidden'])return false;return true}
const button=label=>tree.root.findAllByType('button').filter(visible).find(n=>text(n)===label||n.props['aria-label']===label)
const click=async label=>run(()=>{const n=button(label);assert.ok(n,`Missing ${label}`);assert.ok(!n.props.disabled,`Disabled ${label}`);n.props.onClick()})
const latest=()=>requests.at(-1)
const respond=async(data,status=200,target=latest())=>run(()=>{now+=60_000;target.resolve({ok:status<400,status,json:async()=>data})})
const reject=async(target=latest())=>run(()=>target.reject(Error('Lost connection')))
const body=()=>JSON.parse(latest().options.body)
const row={id:'2026-10:source-1',actionId:'source-1',month:'2026-10',version:'version-1',date:'2026-10-20',title:'Fixture cable',location:'Fixture shop',person:'Brian (BofA)',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:1234,split:'',fields:{date:'2026-10-20',item:'Fixture cable',amount:'12.34',location:'Fixture shop',person:'Brian (BofA)'},editableFields:['item','amount','location','person'],capabilities:{update:true,move:true,delete:true,split:true,cancel_split:false,undo:true},reasons:{}}
row.splitOptions={custom:true,payerName:'Brian',partnerName:'Hannah',payerBasisPoints:5000}
const listing=(items=[row],extra={})=>({items,total:items.length,nextOffset:null,days:items.length?[{date:row.date,month:row.month,count:items.length,totalCents:items.reduce((sum,r)=>sum+r.amountCents,0),needsCents:0,wantsCents:items.reduce((sum,r)=>sum+r.amountCents,0)}]:[],totalAmountCents:items.reduce((sum,r)=>sum+r.amountCents,0),categories:['shopping'],persons:['Brian (BofA)'],month:'2026-10',...extra})
const review=(change,item=row)=>({review:{item,after:{...item.fields,amount:change.updates?.amount?String(change.updates.amount/100):item.fields.amount},operation:change.operation,destination:change.destination,reviewVersion:'review-'+change.operation,share:change.operation==='split'?{method:'income',payerCents:800,partnerCents:434}:undefined}})
const expand=async()=>run(()=>{})
const submit=async()=>run(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
const input=label=>tree.root.findAllByType('input').filter(visible).find(node=>node.props['aria-label']===label)
const change=async(label,value)=>run(()=>input(label).props.onChange({target:{value}}))
const cancel=async()=>{if(button('Back'))await click('Back');await click('Cancel')}
;(async()=>{
 await run(()=>{tree=Renderer.create(fixture(false))});await tick();assert.equal(requests.length,0)
 assert.equal(updates.at(-1),null,'No transaction update time before a successful listing')
 await run(()=>tree.update(fixture(true)));await tick();await respond(listing())
 assert.equal(updates.at(-1),now,'Transactions reports its own successful listing time')
 const loadedAt=updates.at(-1);await click('Refresh transactions');await respond({error:'Offline fixture'},503)
 assert.equal(updates.at(-1),loadedAt,'A failed refresh retains the last successful update time')
 await click('Refresh transactions');await respond(listing());assert.equal(updates.at(-1),now)
 assert.equal(tree.root.findByProps({'data-graph-open':false}).props['data-graph-open'],false)
 const beforeGraph=requests.length;await click('Show spending graph');assert.equal(button('Hide spending graph').props['aria-expanded'],true);assert.equal(tree.root.findByProps({'data-graph-open':true}).props['data-graph-open'],true);await click('Hide spending graph');assert.equal(requests.length,beforeGraph,'Graph disclosure is presentation-only and cannot request or mutate financial data')
 await change('Search transactions','cable');await tick();await respond(listing())
 await click('Update');assert.equal(button('Clear search').props.disabled,true,'The search clear control cannot detach an active inline editor');assert.equal(work.dirty,true);assert.equal(button('Review change').props.disabled,true,'Unchanged edits cannot request a review')
 await change('Amount','15.99');assert.equal(requests.filter(r=>r.options.body).length,0)
 await submit();assert.equal(body().updates.amount,1599);await respond(review(body()));assert.ok(button('Confirm update'));await cancel();assert.equal(work.dirty,false);await click('Clear search');await tick();await respond(listing())
 for(const [label,op]of[['Update','move'],['Delete','delete'],['Split','split']]){
  await click(label)
  if(op==='move'){await run(()=>tree.root.findByProps({'aria-label':'Update category'}).props.onChange({target:{value:'food'}}));await change('Amount','19.99')}
  await submit();const command=body();assert.equal(command.operation,op)
  if(op==='move'){assert.equal(command.destination,'food');assert.equal(command.updates.amount,1999)}
  await respond(review(command));if(op==='split')assert.match(text(tree.toJSON()),/No repayment will be marked received/)
  await cancel()
 }
 await click('Update');await change('Amount','22.00');await submit();const changed=body();await respond(review(changed));await click('Confirm update');const frozen=body()
 assert.equal(frozen.reviewVersion,'review-update');assert.equal(work.pending,true);assert.equal(work.uncertain,true);assert.equal(button('Back').props.disabled,true)
 const count=requests.length;assert.equal(button('Check saved status'),undefined,'Ordinary saves stay in their row without inserting a recovery panel');assert.equal(requests.length,count,'Locked controls never issue another request')
 await reject();assert.equal(work.uncertain,true);await click('Retry same confirmation');assert.deepEqual(body(),frozen)
 const summary={operation:'update',title:row.title,date:row.date,category:row.categoryLabel,location:row.location,person:row.person,amountCents:1234,before:row.fields,after:{...row.fields,amount:'22.00'}}
 await respond({state:'done',success:true,detail:'Raw Discord text must stay hidden',summary,undo:{month:row.month,id:row.month+':update-1'}})
 assert.match(latest().url,/fresh=1/,'Only a confirmed result advances to feedback and a fresh read')
 await respond(listing([{...row,id:row.month+':update-1',amountCents:2200,fields:summary.after}]))
 assert.equal(work.uncertain,false);assert.equal(work.pending,false);assert.ok(button('Undo'));assert.ok(!button('Undo last change'));assert.ok(!text(tree.toJSON()).includes('Raw Discord'))
 assert.ok(events.includes('bookiebot:transactions-changed'));assert.ok(events.includes('bookiebot:reimbursements-changed'))
 await click('Undo');assert.equal(body().operation,'undo');assert.equal(body().id,row.month+':update-1')
 const undoReview=review(body(),{...row,id:row.month+':update-1'});undoReview.review.restoration={operation:'update',current:summary.after,currentCategory:'Shopping',restoredCategory:'Shopping'}
 await respond(undoReview);assert.equal(latest().url,'/app/transactions');assert.equal(body().operation,'undo','Explicit timed Undo still obtains a fresh server review before confirmation')
 const beforeUndoPlans=plans.length
 await respond({state:'done',success:true,summary:{...summary,operation:'undo',after:row.fields}});assert.equal(work.pending,true,'Undo remains guarded while its saved presentation is read')
 await respond(listing());assert.ok(!button('Undo'))
 assert.equal(updates.at(-1),now,'Canonical Undo readback advances the transaction update time')
 assert.ok(plans.length>beforeUndoPlans,'Timed Undo must enter the shared animation pipeline')
 assert.equal(plans.at(-1).from['row:'+row.month+':update-1:amount'],'$22.00')
 assert.equal(plans.at(-1).to['row:'+row.month+':update-1:amount'],'$12.34','Undo animates canonical readback across action IDs')
 await change('Search transactions','cable');await tick();const old=latest();await change('Search transactions','payroll');await tick();const current=latest()
 await respond(listing([{...row,title:'Payroll fixture',fields:{...row.fields,item:'Payroll fixture'},id:'payroll'}]),200,current);const currentUpdatedAt=updates.at(-1);assert.equal(currentUpdatedAt,now);await respond(listing(),200,old)
 assert.equal(updates.at(-1),currentUpdatedAt,'A superseded response cannot advance the update time')
 const listText=text(tree.root.findByProps({className:'bb-transaction-list bb-daily-transactions'}));assert.match(listText,/Payroll fixture/);assert.ok(!listText.includes('Fixture cable'))
 await run(()=>tree.root.findByProps({'aria-label':'Filter transactions'}).props.onChange({target:{value:'income'}}));await tick();assert.match(latest().url,/kind=income/);await respond(listing([]));assert.match(text(tree.toJSON()),/No transactions match/)
 await click('Clear search and filters');await tick();await respond(listing())
 await click('Refresh transactions');await respond(listing([row],{snapshotVersion:'one',nextOffset:40,total:2}));await click('Load more transactions');await respond(listing([{...row,id:'shifted'}],{snapshotVersion:'two'}));assert.match(text(tree.toJSON()),/Recorded activity changed/)
 await click('Refresh transactions');await respond(listing());await click('Delete');await submit();await respond(review(body()));await click('Confirm delete');const deleted=body();await reject();await run(()=>tree.unmount());assert.ok(storage.size)
 const posts=requests.filter(r=>r.options.body).length;await run(()=>{tree=Renderer.create(fixture(false))});assert.equal(requests.filter(r=>r.options.body).length,posts)
 await click('Check saved status');assert.match(latest().url,new RegExp('/commands/'+deleted.requestId+'$'));await respond({state:'done',success:true});await respond(listing());assert.equal(storage.size,0);assert.equal(work.uncertain,false);await run(()=>tree.unmount())
 for(const editing of[false,true]){
  const customRow={...row,capabilities:{...row.capabilities,cancel_split:editing},split:editing?'custom':'',splitOptions:{...row.splitOptions,incomePayerCents:799,...(editing?{payerCents:411,payerBasisPoints:3333}:{})}}
  await run(()=>{tree=Renderer.create(fixture(true))});await tick();await respond(listing([customRow]));await click(editing?'Edit split':'Split')
  assert.equal(input("Brian's share amount").props.value,editing?'4.11':'7.99')
  assert.ok(tree.root.findAll(node=>node.type==='svg'&&node.props.className?.includes('lucide-chart-pie')).length)
  if(editing)assert.equal(button('Review split').props.disabled,true,'An unchanged existing split cannot be saved again')
  const beforeInvalid=requests.length
  for(const value of['','-1','12.35','1.001','1e2']){await change("Brian's share amount",value);assert.equal(button('Review split').props.disabled,true);await submit();assert.equal(requests.length,beforeInvalid)}
  await change("Hannah's share amount",'3.08');assert.equal(input("Brian's share amount").props.value,'9.26')
  await submit();assert.equal(body().method,'custom');assert.equal(body().payerShareCents,926)
  const checked=review(body(),customRow);checked.review.share={method:'custom',payerCents:926,partnerCents:308,payerName:'Brian',partnerName:'Hannah'};await respond(checked);assert.match(text(tree.toJSON()),/No repayment will be marked received/)
  await click('Back');assert.equal(input("Brian's share amount").props.value,'9.26');await click('Split by income');assert.equal(input("Brian's share amount").props.value,'7.99');assert.equal(button('Split by income').props.disabled,true)
  await cancel()
  if(editing){await click('Edit split');await click('Remove split');await submit();assert.equal(body().operation,'cancel_split');await respond(review(body(),customRow));assert.match(text(tree.toJSON()),/Not split/);assert.match(text(tree.toJSON()),/No repayment will be marked received/);await cancel()}
  await run(()=>tree.unmount())
 }
 await run(()=>{tree=Renderer.create(fixture(true))});await tick();await respond(listing());await click('Update');await change('Amount','22.00');await submit();await respond(review(body()));await click('Confirm update');await respond({state:'done',success:true,summary});await reject()
 assert.ok(button('Update').props.disabled,'Confirmed presentation identities remain inert after a failed refresh')
 await click('Refresh transactions');await respond(listing());assert.equal(button('Update').props.disabled,false,'A successful fresh read restores authoritative actionable identities');await run(()=>tree.unmount())
 // The real editor/controller is shared by both placements, with independent graph preferences.
 duoWide=true
 await run(()=>{tree=Renderer.create(fixture(true))});await tick();await respond(listing())
 const graph=()=>tree.root.findAll(node=>node.props['data-graph-open']!==undefined)[0].props['data-graph-open']
 const inPane=node=>{for(let n=node;n;n=n.parent)if(n.props.className==='bb-duo-action-pane')return true;return false}
 const forms=()=>tree.root.findAllByType('form').filter(visible)
 assert.equal(graph(),true,'Unfolded browsing starts with Daily Spending')
 const beforeDuo=requests.length
 await click('Manage '+row.id);assert.equal(graph(),false);assert.equal(forms().length,0)
 assert.ok(button('Edit'));assert.ok(button('Delete'));assert.ok(inPane(button('Edit')))
 await click('Edit');await change('Amount','23.45')
 assert.equal(forms().length,1);assert.ok(inPane(forms()[0]),'No inline editor may open in the left list')
 await click('Show Daily Spending');assert.equal(graph(),true);assert.equal(forms().length,0)
 await click('Return to transaction editor');assert.equal(input('Amount').props.value,'23.45')
 assert.equal(requests.length,beforeDuo,'Selection, graph peek and local edits cannot write or review')
 await run(()=>{duoWide=false;tree.update(fixture(true))})
 assert.equal(graph(),false,'Unfolding did not alter the closed graph preference')
 assert.equal(input('Amount').props.value,'23.45');assert.ok(!inPane(forms()[0]))
 await submit();const duoCommand=body();await respond(review(duoCommand))
 await run(()=>{duoWide=true;tree.update(fixture(true))})
 assert.ok(inPane(button('Confirm update')),'An existing review follows the fold into the right pane')
 assert.equal(graph(),false);await click('Back');assert.equal(input('Amount').props.value,'23.45')
 await click('Back to transaction actions');assert.equal(forms().length,0);assert.equal(work.dirty,false)
 await click('Split');assert.ok(inPane(forms()[0]));await change("Brian's share amount",'1.001')
 await run(()=>{duoWide=false;tree.update(fixture(true))});assert.equal(input("Brian's share amount").props.value,'1.001','An invalid custom input must remain visible when folding')
 assert.equal(button('Review split').props.disabled,true)
 await run(()=>{duoWide=true;tree.update(fixture(true))});assert.equal(input("Brian's share amount").props.value,'1.001')
 await change("Brian's share amount",'6.00')
 await run(()=>{duoWide=false;tree.update(fixture(true))});assert.equal(input("Brian's share amount").props.value,'6.00')
 await run(()=>{duoWide=true;tree.update(fixture(true))});assert.equal(input("Brian's share amount").props.value,'6.00')
 await submit();assert.equal(body().payerShareCents,600);await respond(review(body()))
 assert.ok(inPane(button('Confirm split')));await cancel();assert.equal(graph(),true)
 await click('Manage '+row.id);await click('Delete');await submit();await respond(review(body()))
 await click('Confirm delete');const frozenDuo=body();assert.equal(button('Close transaction options').props.disabled,true)
 await reject();assert.ok(inPane(button('Check saved status')),'Recovery must be accessible in the right pane')
 await click('Retry same confirmation');assert.deepEqual(body(),frozenDuo);await respond({state:'done',success:true,summary:{...summary,operation:'delete'},undo:{month:row.month,id:row.month+':delete-duo'}})
 await respond(listing([]));await run(()=>{for(const [id,timer]of[...timers])if(timer.ms===700){timers.delete(id);timer.fn()}})
 assert.ok(button('Undo'));await click('Undo');assert.equal(body().operation,'undo');await respond(review(body()))
 assert.ok(inPane(button('Confirm undo')),'Undo is right-side even when its source row is no longer listed')
 assert.equal(body().operation,'undo');await respond({state:'done',success:true,summary:{...summary,operation:'undo',after:row.fields}});await respond(listing())
 assert.equal(plans.at(-1).from['row:'+row.id+':amount'],'$0.00','Restored deleted rows animate their entrance')
 assert.equal(plans.at(-1).to['row:'+row.id+':amount'],'$12.34');await run(()=>tree.unmount());duoWide=false
 await run(()=>{tree=Renderer.create(fixture(true))});await tick();await respond(listing())
 await run(()=>tree.update(React.createElement(TransactionsScreen,{active:true,ownerName:'Brian',initialMonth:'2026-09'})));await tick()
 assert.match(latest().url,/month=2026-09/,'The shared report month must update the already-mounted Transactions controller')
 await respond(listing([],{month:'2026-09'}));await run(()=>tree.unmount())
 await run(()=>{tree=Renderer.create(fixture(true))});await tick();await respond(listing())
 const beforeInactive=updates.at(-1);await click('Refresh transactions');const inactiveRequest=latest()
 await run(()=>tree.update(fixture(false)));await respond(listing(),200,inactiveRequest)
 assert.equal(updates.at(-1),beforeInactive,'A cancelled inactive read cannot advance freshness')
 await run(()=>tree.update(fixture(true)));await tick();await respond({error:'Reconnect fixture'},401)
 assert.equal(updates.at(-1),null,'Cleared access removes the previous transaction update time');await run(()=>tree.unmount())
 const {undoPresentationTarget}=load(path.resolve('web/expense-report/src/transaction-feedback.ts'))
 const prior={...row,id:'latest-action'},restored={...row,id:'restored-parent'}
 assert.equal(undoPresentationTarget([prior],[restored],prior.id,{...summary,operation:'undo',after:row.fields}),restored.id)
 assert.equal(undoPresentationTarget([prior],[restored,{...restored,id:'identical-twin'}],prior.id,{...summary,operation:'undo',after:row.fields}),undefined)
 for(const {options}of requests){assert.equal(options.referrerPolicy,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-BookieBot-App'],'1')}
 console.log('Inline transaction review/cancel, combined Move, split cents/pie shortcut, explicit confirmation, immutable recovery, fresh reads, timed Undo handoff search races and Duo right-pane/fold/graph/draft recovery passed')
})().catch(error=>{console.error(error);process.exitCode=1})
