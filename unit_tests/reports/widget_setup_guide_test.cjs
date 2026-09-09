const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const React = req('react'), {create, act} = req('react-test-renderer'), ts = req('typescript')
global.IS_REACT_ACT_ENVIRONMENT = true
const requests=[], timers=new Map(), copied=[]
let serial=0, tree, back=0, pair=0, failCopy=false
const source=ts.transpileModule(fs.readFileSync('web/expense-report/src/widget-setup-guide.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX},
}).outputText
const runtime={exports:{},AbortController,
  window:{setTimeout(fn){timers.set(++serial,fn);return serial},clearTimeout(id){timers.delete(id)}},
  navigator:{clipboard:{writeText:async value=>{if(failCopy)throw Error('Denied');copied.push(value)}}},
  fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),
  require:name=>name.endsWith('.css')?{}:name==='./components/ui/motion'?{
    CollapsibleContent:({open,children})=>React.createElement('div',{hidden:!open},children),
  }:req(name),
}
vm.runInNewContext(source,runtime)
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):node?.children?.map(text).join('')||''
const button=label=>tree.root.findAllByType('button').find(node=>text(node)===label)
const click=async label=>act(async()=>{const node=button(label);assert.ok(node,label);assert.ok(!node.props.disabled);await node.props.onClick()})
const createGuide=()=>act(async()=>{tree=create(React.createElement(runtime.exports.WidgetSetupGuide,{onBack:()=>back++,onPair:()=>pair++}))})
const code='// BookieBot Home Screen widget · v1.1\nconst BOOKIEBOT_ORIGIN = "https://bookiebot.example";'
const respond=(request,value=code,status=200)=>act(async()=>request.resolve({ok:status===200,text:async()=>value}))
;(async()=>{
  await createGuide()
  assert.equal(requests.length,1)
  assert.equal(requests[0].url,'/app/widgets/script')
  assert.equal(requests[0].options.credentials,'omit','Public source fetch needs no account credentials')
  assert.equal(requests[0].options.redirect,'error')
  assert.ok(button('Loading script…').props.disabled)
  assert.equal(tree.root.findAllByType('button').filter(node=>text(node)==='Back to Settings').length,2)
  assert.ok(!tree.root.findAllByType('a').some(node=>node.props.href==='/app/widgets/script'),'Setup never navigates to a raw script with no Back control')
  for(const link of tree.root.findAllByType('a').filter(node=>node.props.href!=='scriptable:///')){
    assert.equal(link.props.target,'_blank','External import/install links preserve the guide')
    assert.equal(link.props.rel,'noreferrer')
  }
  await respond(requests[0])
  assert.equal(timers.size,0)
  await click('Copy script')
  assert.deepEqual(copied,[code])
  assert.match(text(tree.toJSON()),/Script copied/)
  failCopy=true
  await click('Copy script')
  const textarea=tree.root.findByProps({'aria-label':'BookieBot script'})
  assert.equal(textarea.props.value,code)
  assert.equal(textarea.props.readOnly,true)
  assert.equal(textarea.parent.parent.props.hidden,false,'Denied clipboard exposes a selectable fallback')
  await click('Get a setup code');await click('Return to Widgets');await click('Back to Settings')
  assert.equal(pair,2);assert.equal(back,1)
  assert.equal(requests.length,1,'Help navigation does not create or redeem credentials')
  await act(async()=>tree.unmount())
  await createGuide()
  const stalled=requests.at(-1)
  await act(async()=>[...timers.values()][0]())
  assert.equal(stalled.options.signal.aborted,true)
  assert.match(text(tree.toJSON()),/couldn’t load/)
  await respond(stalled)
  assert.ok(button('Copy script').props.disabled,'Late source cannot overwrite timeout feedback')
  await click('Try again')
  await respond(requests.at(-1),'<html>Sign in</html>')
  assert.match(text(tree.toJSON()),/couldn’t load/)
  await click('Try again')
  const unmounted=requests.at(-1)
  await act(async()=>tree.unmount())
  assert.equal(unmounted.options.signal.aborted,true)
  await respond(unmounted)
  assert.equal(timers.size,0)
  console.log('Widget guide navigation, public copy/download, clipboard fallback, timeout and unmount contracts passed')
})().catch(error=>{console.error(error);process.exitCode=1})
