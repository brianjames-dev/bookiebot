const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const React = req('react'), {create, act} = req('react-test-renderer'), ts = req('typescript')
global.IS_REACT_ACT_ENVIRONMENT = true
const requests=[], timers=new Map(), copied=[]
let serial=0, tree, back=0, pair=0, failCopy=false
const motionRuntime={exports:{},require:req}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/components/ui/motion.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX},
}).outputText,motionRuntime)
const source=ts.transpileModule(fs.readFileSync('web/expense-report/src/widget-setup-guide.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX},
}).outputText
const runtime={exports:{},AbortController,
  window:{setTimeout(fn){timers.set(++serial,fn);return serial},clearTimeout(id){timers.delete(id)}},
  navigator:{clipboard:{writeText:async value=>{if(failCopy)throw Error('Denied');copied.push(value)}}},
  fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),
  require:name=>name.endsWith('.css')?{}:name==='./components/ui/motion'?motionRuntime.exports:req(name),
}
vm.runInNewContext(source,runtime)
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):node?.children?.map(text).join('')||''
const button=label=>tree.root.findAllByType('button').find(node=>text(node)===label)
const click=async label=>act(async()=>{const node=button(label);assert.ok(node,label);assert.ok(!node.props.disabled);await node.props.onClick()})
const createGuide=()=>act(async()=>{tree=create(React.createElement(runtime.exports.WidgetSetupGuide,{onBack:()=>back++,onPair:()=>pair++}))})
const code='// BookieBot Home Screen widget · v1.3\nconst BOOKIEBOT_ORIGIN = "https://bookiebot.example";'
const respond=(request,value=code,status=200)=>act(async()=>request.resolve({ok:status===200,text:async()=>value}))
;(async()=>{
  await createGuide()
  assert.equal(requests.length,1)
  assert.equal(requests[0].url,'/app/widgets/script')
  assert.equal(requests[0].options.credentials,'omit','Public source fetch needs no account credentials')
  assert.equal(requests[0].options.redirect,'error')
  assert.ok(button('Loading script…').props.disabled)
  assert.equal(tree.root.findAllByType('button').filter(node=>text(node)==='Back to Settings').length,2)
  assert.equal(tree.root.findAllByType('ol').length,1)
  assert.equal(tree.root.findByType('ol').findAllByType('li').length,3,'Setup remains three short steps')
  assert.equal(tree.root.findAllByType('details').length,0,'Disclosures use shared animated motion')
  assert.equal(tree.root.findAllByProps({'aria-label':'Widget needs pairing'}).length,0,'Recovery no longer occupies the initial view')
  const themesButton=button('Themes'), helpButton=button('Help')
  const themeGuide=tree.root.findAllByType('div').find(node=>node.props.id===themesButton.props['aria-controls'])
  const helpGuide=tree.root.findAllByType('div').find(node=>node.props.id===helpButton.props['aria-controls'])
  assert.notEqual(themesButton.props['aria-controls'],helpButton.props['aria-controls'])
  for(const [toggle,content] of [[themesButton,themeGuide],[helpButton,helpGuide]]) {
    assert.equal(toggle.props['aria-expanded'],false)
    assert.equal(content.props['aria-hidden'],true)
    assert.equal(content.props.inert,true,'Closed help cannot receive keyboard focus')
    assert.equal(content.props['data-state'],'closed')
  }
  assert.match(text(themeGuide),/Theme & preview.*Editorial or Two-tone/)
  assert.deepEqual(themeGuide.findAllByType('code').map(text),['editorial','two-tone'])
  assert.match(text(themeGuide),/Leave Parameter empty for your saved theme/)
  assert.match(text(themeGuide),/Never put a setup code here/)
  assert.match(text(helpGuide),/Replace its code and keep the same name/)
  assert.match(text(helpGuide),/pairing stays connected; no need to pair again/)
  assert.match(text(helpGuide),/iOS controls refresh timing/)
  assert.match(text(helpGuide),/browser.*separate sign-in/)
  await click('Themes')
  assert.equal(themesButton.props['aria-expanded'],true)
  assert.equal(themeGuide.props['data-state'],'open')
  assert.equal(themeGuide.props.inert,false)
  assert.equal(helpButton.props['aria-expanded'],false,'Theme disclosure does not open troubleshooting')
  await click('Help')
  assert.equal(helpGuide.props['data-state'],'open')
  await click('Themes')
  assert.equal(themeGuide.props['data-state'],'closed')
  assert.equal(helpGuide.props['data-state'],'open','Independent disclosures preserve their current state')
  await click('Help')
  assert.equal(helpGuide.props['data-state'],'closed')
  assert.equal(requests.length,1,'Reading themes and help does not start requests or change credentials')
  assert.ok(!tree.root.findAllByType('a').some(node=>node.props.href==='/app/widgets/script'),'Setup never navigates to a raw script with no Back control')
  for(const link of tree.root.findAllByType('a').filter(node=>node.props.href!=='scriptable:///')){
    assert.equal(link.props.target,'_blank','External import/install links preserve the guide')
    assert.equal(link.props.rel,'noreferrer')
  }
  await respond(requests[0])
  assert.equal(timers.size,0)
  await click('Copy script')
  assert.deepEqual(copied,[code])
  assert.match(text(tree.toJSON()),/Copied. Paste into Scriptable/)
  failCopy=true
  await click('Copy script')
  const textarea=tree.root.findByProps({'aria-label':'BookieBot script'})
  assert.equal(textarea.props.value,code)
  assert.equal(textarea.props.readOnly,true)
  assert.equal(textarea.parent.parent.parent.props['data-state'],'open','Denied clipboard exposes a selectable fallback')
  let selected=false
  textarea.props.onFocus({target:{select(){selected=true}}})
  assert.equal(selected,true,'Fallback selects the entire public source')
  await click('Get a setup code');await click('Back to Settings')
  const bottomBack=tree.root.findAllByType('button').filter(node=>text(node)==='Back to Settings').at(-1)
  await act(async()=>bottomBack.props.onClick())
  assert.equal(pair,1);assert.equal(back,2)
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
  console.log('Compact widget guide disclosures, navigation, public copy, clipboard fallback, timeout and unmount contracts passed')
})().catch(error=>{console.error(error);process.exitCode=1})
