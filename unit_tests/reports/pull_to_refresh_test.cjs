const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const {createRequire} = require('node:module')
const root = path.resolve(__dirname, '../..'), frontend = path.join(root, 'web/expense-report')
const req = createRequire(path.join(frontend, 'package.json'))
const React = req('react'), Renderer = req('react-test-renderer'), ts = req('typescript'), {act} = Renderer
global.IS_REACT_ACT_ENVIRONMENT = true
const h = React.createElement, listeners = new Map(), timers = new Map(), classes = new Set()
let serial = 0, modal = false
class Element {
  constructor({interactive = false, scrollable = false} = {}) { this.interactive = interactive; this.scrollable = scrollable; this.scrollHeight = scrollable ? 200 : 0; this.clientHeight = 100; this.parentElement = null }
  closest() { return this.interactive ? this : null }
}
const eventHost = name => ({
  addEventListener(type, callback, options) { listeners.set(`${name}:${type}`, {callback,options}) },
  removeEventListener(type) { listeners.delete(`${name}:${type}`) },
})
const win = {...eventHost('window'), scrollY: 0, getComputedStyle: element => ({overflowY:element.scrollable ? 'auto' : 'visible'}),
  setTimeout(callback) { const id = ++serial; timers.set(id,callback); return id }, clearTimeout(id) { timers.delete(id) },
}
const doc = {...eventHost('document'), body: new Element(), querySelector: () => modal ? {} : null,
  documentElement: {dataset:{}, classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}},
}
const cache = new Map()
function load(file) {
  if(cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file,exports)
  const compiled = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
  const requireModule = name => name.endsWith('.css') ? {} : name.startsWith('.')
    ? load(path.resolve(path.dirname(file),name)+(name.endsWith('.ts')||name.endsWith('.tsx') ? '' : fs.existsSync(path.resolve(path.dirname(file),name)+'.tsx') ? '.tsx' : '.ts')) : req(name)
  vm.runInNewContext(compiled,{exports,require:requireModule,window:win,document:doc,Element})
  return exports
}
const {PageRefreshProvider,usePageRefresh,PageRefreshRegistry} = load(path.join(frontend,'src/page-refresh.tsx'))
const {PullToRefresh} = load(path.join(frontend,'src/pull-to-refresh.tsx'))
let calls = [], finish, pending = false, failure = false
function Handlers({disabled}) {
  for (const screen of ['overview','transactions','shared','savings','reconcile','settings']) usePageRefresh(screen,{disabled,refresh:async()=>{
    calls.push(screen)
    if(pending) await new Promise(resolve=>{finish=resolve})
    return !failure
  }})
  usePageRefresh('savings',{refresh:async()=>{calls.push('investments'); return true}})
  return null
}
const fixture = ({screen = 'overview', disabled = false, blocked = false} = {}) => h(PageRefreshProvider,null,h(Handlers,{disabled}),h(PullToRefresh,{screen,blocked}))
let renderer
const phase = () => renderer.root.findByProps({className:'bb-pull-refresh'}).props['data-phase']
const progress = () => renderer.root.findByProps({role:'progressbar'}).props['aria-valuenow']
const touch = (y,x=30,identifier=1) => ({clientX:x,clientY:y,identifier})
function fire(type,{y=20,x=30,target=new Element(),touches,changedTouches,cancelable=true} = {}) {
  const point = touch(y,x)
  const event = {target,cancelable,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},
    touches:touches??(type==='touchend'||type==='touchcancel'?[]:[point]),changedTouches:changedTouches??[point]}
  listeners.get(`document:${type}`)?.callback(event)
  return event
}
const start = options => act(()=>fire('touchstart',options))
const move = options => {let event;act(()=>{event=fire('touchmove',options)});return event}
const release = async options => {await act(async()=>{fire('touchend',options);await Promise.resolve()})}
const settle = async () => {await act(async()=>{await Promise.resolve();await Promise.resolve()})}

;(async()=>{
  act(()=>{renderer=Renderer.create(fixture())})
  assert.equal(listeners.get('document:touchmove').options.passive,false,'Captured pulls must suppress native page reload')
  start(); move({y:90}); assert.equal(progress(),49)
  await release({y:90}); assert.equal(calls.length,0,'Short pull cancels')
  start(); move({y:180}); assert.equal(phase(),'armed'); assert.equal(progress(),100)
  move({y:100}); await release({y:100}); assert.equal(calls.length,0,'Retreat below threshold cancels')
  start(); const captured=move({y:164}); assert.equal(captured.defaultPrevented,true)
  assert.equal(calls.length,0,'Threshold never triggers before release')
  await release({y:164}); assert.deepEqual(calls,['overview']); assert.equal(phase(),'done')
  for(const options of [{y:180,x:220},{y:0},{y:180,cancelable:false}]) {
    start(); move(options); await release(options)
  }
  assert.equal(calls.length,1,'Horizontal/upward/noncancelable gestures never refresh')
  for(const target of [new Element({interactive:true}),new Element({scrollable:true})]) {
    start({target});move({y:200});await release({y:200})
  }
  win.scrollY=100;start();win.scrollY=0;move({y:200});await release({y:200})
  modal=true;start();move({y:200});await release({y:200});modal=false
  doc.documentElement.dataset.bbModalScrollLock='true';start();move({y:200});await release({y:200});delete doc.documentElement.dataset.bbModalScrollLock
  start();move({y:200,touches:[touch(200),touch(210,40,2)]});await release({y:200})
  start();move({y:200});act(()=>fire('touchcancel'));await release({y:200})
  assert.equal(calls.length,1,'Nested/interactive/scrolled/modal/multitouch/cancel paths remain untouched')
  start();move({y:200});act(()=>renderer.update(fixture({screen:'shared'})));await release({y:200})
  assert.equal(calls.length,1,'Tab changes cancel the captured gesture')
  for(const screen of ['transactions','shared','savings','reconcile','settings']) {
    act(()=>renderer.update(fixture({screen})))
    start();move({y:170});await release({y:170})
    assert.ok(calls.includes(screen),`${screen} uses its own registered implementation`)
  }
  assert.equal(calls.filter(call=>call==='investments').length,1,'Savings refresh waits for both goals and investments')
  act(()=>renderer.update(fixture({disabled:true})))
  start();move({y:200});await release({y:200});assert.equal(calls.filter(call=>call==='overview').length,1)
  act(()=>renderer.update(fixture({blocked:true})))
  start();move({y:200});await release({y:200});assert.equal(calls.filter(call=>call==='overview').length,1)
  act(()=>renderer.update(fixture()));pending=true
  start();move({y:200});await release({y:200});assert.equal(phase(),'refreshing')
  start();move({y:200});await release({y:200})
  assert.equal(calls.filter(call=>call==='overview').length,2,'In-flight refresh cannot be duplicated')
  pending=false;await act(async()=>finish());await settle();assert.equal(phase(),'done')
  failure=true;await act(async()=>renderer.root.findByType('button').props.onClick());await settle();assert.equal(phase(),'error')
  assert.ok(renderer.root.findByProps({role:'status'}).children.join('').includes('Couldn’t refresh Overview'))
  failure=false;await act(async()=>renderer.root.findByType('button').props.onClick());await settle();assert.equal(phase(),'done','Common keyboard/button path recovers from failure')
  act(()=>renderer.unmount());assert.equal(listeners.size,0);assert.equal(timers.size,0);assert.equal(classes.size,0)

  const registry=new PageRefreshRegistry();let completed=false
  registry.set('first','savings',()=>({refresh:async()=>false}))
  registry.set('second','savings',()=>({refresh:async()=>{await Promise.resolve();completed=true}}))
  assert.equal(await registry.refresh('savings'),false);assert.equal(completed,true,'A failed section still waits for all page data')
  registry.set('first','savings',()=>({disabled:true,refresh:async()=>assert.fail('Disabled handler ran')}))
  assert.equal(registry.available('savings'),false);assert.equal(await registry.refresh('savings'),false)
  registry.remove('first');assert.equal(await registry.refresh('savings'),true)
  console.log('Pull refresh: threshold/release/cancel, active-tab dispatch, combined data, locks, errors, deduplication and cleanup passed')
})().catch(error=>{console.error(error);process.exitCode=1})
