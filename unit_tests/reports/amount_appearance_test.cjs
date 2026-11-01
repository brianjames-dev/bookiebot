const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const frontend=path.resolve(__dirname,'../../web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const React=req('react'),Renderer=req('react-test-renderer'),ts=req('typescript'),{act}=Renderer
global.IS_REACT_ACT_ENVIRONMENT=true
const storage=new Map(),listeners=new Set(),writes=[];let blocked=false
const win={get localStorage(){if(blocked)throw Error('Storage denied');return{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);writes.push({key,value})}}},
  addEventListener:(name,fn)=>{if(name==='storage')listeners.add(fn)},removeEventListener:(name,fn)=>{if(name==='storage')listeners.delete(fn)}}
const cache=new Map(),ink=[]
const canvas={font:'',measureText(text){ink.push({text,font:this.font});return{actualBoundingBoxAscent:parseFloat(this.font.split(' ')[1])*.7}}}
function load(file){
  if(cache.has(file))return cache.get(file)
  const exports={};cache.set(file,exports)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText
  vm.runInNewContext(code,{exports,window:win,document:{createElement:()=>({getContext:()=>canvas})},getComputedStyle:node=>node.computed,
    require:name=>name.startsWith('.')?load([path.resolve(path.dirname(file),name)+'.tsx',path.resolve(path.dirname(file),name)+'.ts'].find(fs.existsSync)):req(name)})
  return exports
}
const model=load(path.join(frontend,'src/amount-typography.ts'))
assert.deepEqual(JSON.parse(JSON.stringify(model.DEFAULT_AMOUNT_APPEARANCE)),{size:50,emphasis:55})
assert.equal(model.loadRaisedCents('Brian'),true)
assert.equal(model.amountAppearanceKey(' Brian '),model.amountAppearanceKey('BRIAN'))
assert.notEqual(model.amountAppearanceKey('Brian'),model.amountAppearanceKey('Hannah'))
for(const raw of ['broken','null','[]','{"version":2,"raisedCents":false}','{"version":1,"raisedCents":"false"}']){
  storage.set(model.amountAppearanceKey('Brian'),raw);assert.equal(model.loadRaisedCents('Brian'),true)
}
model.saveRaisedCents('Brian',false)
assert.deepEqual(JSON.parse(storage.get(model.amountAppearanceKey('Brian'))),{version:1,raisedCents:false})
assert.equal(model.loadRaisedCents('Brian'),false);assert.equal(model.loadRaisedCents('Hannah'),true)
blocked=true;assert.equal(model.loadRaisedCents('Brian'),true);model.saveRaisedCents('Brian',false);blocked=false
for(const[value,integer,fraction]of[['$0.00','$0','.00'],['-$1,234.56','-$1,234','.56'],['+$12.34','+$12','.34'],['$123,456,789,012.34','$123,456,789,012','.34']]){
  const parts=model.decimalAmountParts(value);assert.equal(parts.integer,integer);assert.equal(parts.fraction,fraction);assert.equal(parts.integer+parts.fraction,value)
}
for(const value of['N/A','—','88.1%','$12','$12.345','$5.00/day','-$3.00 left'])assert.equal(model.decimalAmountParts(value),null)
const values=new Map();let alignWrites=0
const integer={textContent:'-$1,234',computed:{fontWeight:'500',fontSize:'32px',fontFamily:'system-ui'}}
const fraction={textContent:'.56',computed:{fontWeight:'500',fontSize:'16px',fontFamily:'system-ui'},style:{getPropertyValue:key=>values.get(key)||'',setProperty:(key,value)=>{alignWrites++;values.set(key,value)}}}
const text={querySelector:selector=>selector.includes('integer')?integer:fraction}
model.alignAmountFraction(text);assert.equal(values.get('--bb-cents-shift'),'11.2px');assert.deepEqual(ink.map(row=>row.text),['1234','56'])
model.alignAmountFraction(text);assert.equal(alignWrites,1,'Identical layout does not repeat alignment writes')
storage.clear();writes.length=0
const{AmountAppearanceBoundary,AmountAppearanceSettings,MetricAmount}=load(path.join(frontend,'src/amount-appearance.tsx'))
const h=React.createElement,view=owner=>h(AmountAppearanceBoundary,{owner},h(AmountAppearanceSettings),h(MetricAmount,{className:'headline'},'-$7,473.86'))
const run=fn=>act(async()=>{fn();await Promise.resolve()})
const toggle=tree=>tree.root.findByProps({role:'switch','aria-label':'Raised cents'})
const headline=tree=>tree.root.findAll(node=>node.type==='span'&&node.props.className==='bb-fitted-amount-text').at(-1)
async function main(){
  let tree;await run(()=>{tree=Renderer.create(view('Brian'))})
  assert.equal(toggle(tree).props['aria-checked'],true);assert.equal(writes.length,0)
  assert.equal(tree.root.findAllByType('select').length,0);assert.equal(tree.root.findAllByType('input').length,0,'Only a toggle is exposed')
  const painted=tree.root.findAll(node=>node.type==='span'&&node.props.className==='bb-amount-fraction')
  assert.equal(painted.length,2);assert.ok(painted.every(node=>node.props.style.fontSize==='50%'&&node.props.style.opacity===.55))
  await run(()=>toggle(tree).props.onClick());assert.equal(toggle(tree).props['aria-checked'],false)
  assert.equal(headline(tree).children.join(''),'-$7,473.86')
  await run(()=>tree.update(view('Hannah')));assert.equal(toggle(tree).props['aria-checked'],true)
  await run(()=>tree.update(view('Brian')));assert.equal(toggle(tree).props['aria-checked'],false)
  await run(()=>tree.unmount());assert.equal(listeners.size,0)
  await run(()=>{tree=Renderer.create(view('Brian'))});assert.equal(toggle(tree).props['aria-checked'],false,'Off survives remount')
  storage.set(model.amountAppearanceKey('Brian'),JSON.stringify({version:1,raisedCents:true}))
  await run(()=>listeners.forEach(fn=>fn({key:model.amountAppearanceKey('Hannah')})));assert.equal(toggle(tree).props['aria-checked'],false)
  await run(()=>listeners.forEach(fn=>fn({key:model.amountAppearanceKey('Brian')})));assert.equal(toggle(tree).props['aria-checked'],true)
  await run(()=>tree.unmount())
  blocked=true;await run(()=>{tree=Renderer.create(view('Brian'))});assert.equal(toggle(tree).props['aria-checked'],true)
  await run(()=>toggle(tree).props.onClick());assert.equal(toggle(tree).props['aria-checked'],false,'Blocked storage still permits the session toggle')
  await run(()=>tree.unmount());blocked=false
  console.log('Raised cents toggle, defaults, persistence, owner isolation and digit alignment passed.')
}
main().catch(error=>{console.error(error);process.exit(1)})
