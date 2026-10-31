const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer'),ts=req('typescript')
global.IS_REACT_ACT_ENVIRONMENT=true
const source=fs.readFileSync('web/expense-report/src/components/ui/chart.tsx','utf8'),file=ts.createSourceFile('chart.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const names=new Set(['ChartTooltip','ChartTooltipMotionFrame','ChartTooltipAutoDismissContent','chartTooltipSignature','ChartInteractionContext','ChartTooltipDismissContext','TOOLTIP_LAST_TRANSFORM_ATTRIBUTE','TOOLTIP_MOTION_READY_ATTRIBUTE','TOOLTIP_FADE_DURATION'])
const declarations=file.statements.filter(n=>ts.isFunctionDeclaration(n)?names.has(n.name?.text):ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.has(d.name.getText(file))))
assert.equal(declarations.length,names.size)
let now=0,serial=0;const timers=new Map()
const window={matchMedia:()=>({matches:false}),setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,at:now+delay});return id},clearTimeout:id=>timers.delete(id)}
window.requestAnimationFrame=fn=>window.setTimeout(fn,16);window.cancelAnimationFrame=id=>window.clearTimeout(id)
function advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);act(()=>next[1].fn())}now=end}
class HTMLDivElement{constructor(){this.style={transform:'none'};this.attrs=new Map()}getAttribute(k){return this.attrs.get(k)}hasAttribute(k){return this.attrs.has(k)}setAttribute(k,v){this.attrs.set(k,v)}removeAttribute(k){this.attrs.delete(k)}}
// Reproduce Recharts' custom-content contract, including the colliding `content`
// prop. The production adapter must render exactly one lifecycle/motion frame.
const nativeTooltip=props=>React.cloneElement(props.content,props)
const runtime={exports:{},require:req,React,window,HTMLDivElement,RechartsPrimitive:{Tooltip:nativeTooltip},cn:(...values)=>values.filter(Boolean).join(' ')}
vm.runInNewContext(ts.transpileModule(declarations.map(n=>n.getText(file)).join('\n')+'\nexports.Chart=ChartTooltip;exports.Interaction=ChartInteractionContext;exports.Dismiss=ChartTooltipDismissContext',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
const {Chart,Interaction,Dismiss}=runtime.exports,h=React.createElement,Leaf=({label})=>h('span',null,label)
for(const fadeDuration of [180,360]){
 const wrapper=new HTMLDivElement();let revision=0,dismiss=0,label='Oct 13',active=true,view
 const render=()=>h(Interaction.Provider,{value:revision},h(Dismiss.Provider,{value:dismiss},h(Chart,{content:h(Leaf),dismissDelay:5000,fadeDuration:fadeDuration===180?undefined:fadeDuration,isAnimationActive:false,active,payload:[{value:13}],label})))
 act(()=>{view=create(render(),{createNodeMock:()=>({parentElement:wrapper})})})
 assert.equal(view.root.findAll(n=>n.type==='div'&&n.props.className?.split(' ').includes('bb-chart-tooltip-frame')).length,1,'Native content injection must never nest lifecycle frames')
 const className=()=>view.toJSON()?.props.className??''
 const update=()=>act(()=>view.update(render()))
 advance(4999);assert.ok(!className().includes('dismissing'));assert.ok(view.toJSON())
 advance(1);assert.ok(className().includes('dismissing'));assert.equal(view.toJSON().props.style['--bb-tooltip-fade-duration'],`${fadeDuration}ms`)
 advance(fadeDuration-1);assert.ok(view.toJSON(),'Retain content until the CSS fade has finished')
 advance(1);assert.equal(view.toJSON(),null);assert.equal(wrapper.style.visibility,'hidden')
 revision++;label='Oct 20';update();advance(5000);assert.ok(className().includes('dismissing'))
 advance(80);revision++;label='Oct 21';update();assert.ok(!className().includes('dismissing'),'Reopening reverses the retained frame instead of remounting it')
 advance(fadeDuration);assert.ok(view.toJSON(),'The previous exit timer cannot hide a newly selected day')
 active=false;update();assert.ok(view.toJSON(),'Native inactive payload retains its last content during the hold')
 dismiss++;update();assert.ok(className().includes('dismissing'));advance(fadeDuration);assert.equal(view.toJSON(),null)
 active=true;update();assert.equal(view.toJSON(),null,'A dismissed native payload cannot reopen without fresh interaction')
 revision++;update();assert.ok(view.toJSON());act(()=>view.unmount());assert.equal(timers.size,0,'Unmount clears hold, fade and entry timers')
}
console.log('PASS: five-second hold, synchronized default/custom exit duration, retained inactive payload, interrupted fade, dismissal and cleanup')
