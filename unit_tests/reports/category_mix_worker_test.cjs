const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript'),React=req('react'),Renderer=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
const workers=[], timers=new Map();let serial=0
const window={matchMedia:()=>({matches:false}),setTimeout(fn){const id=++serial;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}}
const flush=()=>{const pending=[...timers.values()];timers.clear();act(()=>pending.forEach(fn=>fn()))}
class Worker {
 constructor(url,options){this.url=url;this.options=options;this.stopped=0;workers.push(this)}
 postMessage(scene){this.scene=scene}
 terminate(){this.stopped++}
 reply(scene){this.onmessage({data:{scene}})}
}
const prepared=(data,width,height)=>({cx:width/2,cy:height/2,radius:110,inner:84,width,height,style:{inset:10},items:data,routes:null})
const runtime={exports:{},Worker,window,require:name=>{
 if(name==='react'||name==='react/jsx-runtime')return req(name)
 if(name.includes('?worker&url'))return {default:'/category-mix-layout-test.js'}
 if(name==='./category-mix-layout')return {CONTOUR_STYLE:{labelSize:12,sidePadding:6,thickness:26},contourLabel:(_key,label)=>label,prepareContourScene:prepared}
 throw new Error(name)
}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/category-mix-contour.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
const useContour=runtime.exports.useCategoryContour
function Host({data,size,shown=false}){return React.createElement('output',{layout:useContour(data,size,shown)})}
const data=[{key:'food',label:'Food',amount:12.99,percentage:100,color:'orange'}],size={width:390,height:396},act=Renderer.act
let tree
try {
 act(()=>{tree=Renderer.create(React.createElement(Host,{data,size}))})
 assert.equal(tree.root.findByType('output').props.layout.outerRadius,187,'Default ring fills the chart');
 assert.equal(tree.root.findByType('output').props.layout.innerRadius,161,'Large ring preserves the current 26px band');
 act(()=>tree.update(React.createElement(Host,{data,size,shown:true})))
 assert.equal(tree.root.findByType('output').props.layout.outerRadius,110,'Showing callouts uses the compact Refined flow ring');
 assert.match(workers[0].scene.items[0].amountLabel,/\$13 \/ 100%/,'Callouts include the ring percentage beside whole-dollar amounts');
 assert.equal(workers.length,1,'Toggling uses the same background worker, without restarting geometry');
 assert.equal(workers.length,1);assert.equal(workers[0].url,'/app/assets/category-mix-layout-test.js');assert.equal(workers[0].options.type,'module')
 act(()=>tree.update(React.createElement(Host,{data:[{...data[0]}],size:{...size}})))
 assert.equal(workers.length,1,'Equivalent report refreshes reuse the existing request')
 const first=workers[0],ready={...first.scene,routes:[],curvedRoutes:[]}
 act(()=>first.reply(ready))
 assert.equal(tree.root.findByType('output').props.layout.contour,ready)
 assert.ok(first.stopped,'A completed worker is disposed')
 act(()=>tree.update(React.createElement(Host,{data:[{...data[0],amount:25}],size})))
 assert.equal(tree.root.findByType('output').props.layout.calloutsReady,false,'Callouts wait for the existing sector morph')
 const second=workers[1]
 act(()=>tree.update(React.createElement(Host,{data:[{...data[0],key:'rent',label:'Rent',amount:800}],size})))
 const third=workers[2]
 assert.ok(second.stopped,'Rapid changes cancel obsolete calculations')
 act(()=>second.reply({...second.scene,routes:[],curvedRoutes:[]}))
 assert.equal(tree.root.findByType('output').props.layout.contour.items[0].id,'rent','Late results cannot replace the newest filter or report')
 act(()=>third.reply({...third.scene,routes:[],curvedRoutes:[]}))
 assert.equal(tree.root.findByType('output').props.layout.calloutsReady,false,'A fast worker cannot expose final stems over interpolating slices')
 flush()
 assert.equal(tree.root.findByType('output').props.layout.calloutsReady,true)
 act(()=>tree.update(React.createElement(Host,{data,size})))
 assert.equal(workers.length,3,'Returning to the same layout uses its bounded in-memory cache')
 assert.equal(tree.root.findByType('output').props.layout.contour,ready)
 act(()=>tree.update(React.createElement(Host,{data:[{...data[0],amount:26}],size})))
 const last=workers[3]
 act(()=>tree.unmount());tree=null
 assert.ok(last.stopped,'Leaving the page cleans up the geometry worker');assert.equal(timers.size,0,'Unmount cancels pending callout settlement')
 assert.doesNotThrow(()=>last.reply({...last.scene,routes:[],curvedRoutes:[]}))
 act(()=>{tree=Renderer.create(React.createElement(Host,{data,size}))})
 assert.equal(workers.length,5,'A new chart/session must not retain the previous report cache')
}finally{if(tree)act(()=>tree.unmount())}
console.log('Refined flow reuses equivalent inputs, cancels stale workers, ignores late results, caches completed layouts and disposes on unmount')

const appSource=fs.readFileSync('web/expense-report/src/report-app.tsx','utf8')
const file=ts.createSourceFile('report-app.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const equal=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='expensePieLayoutsEqual')
const equality={exports:{}}
vm.runInNewContext(ts.transpileModule(equal.getText(file)+'\nexports.equal=expensePieLayoutsEqual',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,equality)
const geometry={cx:195,cy:178,innerRadius:84,outerRadius:110}
assert.equal(equality.exports.equal({...geometry,contour:{routes:null}},{...geometry,contour:{routes:[{}]}}),true,'Worker completion must not restart the unchanged sector morph')
assert.equal(equality.exports.equal(geometry,{...geometry,outerRadius:105}),false,'A real host resize still updates sector geometry')

const {CategoryContourCallouts}=runtime.exports
const calls=[]
const scene={width:390,height:396,style:{labelSize:12,calloutRadius:18},routes:[],curvedRoutes:[],items:[{id:'food',name:'Eating out',amountLabel:'$13 / 100%',x:20,y:25,width:110,height:34,padding:4,lineHeight:13,valueSize:12}]}
try{
 act(()=>{tree=Renderer.create(React.createElement(CategoryContourCallouts,{scene,data,ready:true,visible:true,onInspect:item=>calls.push(item)}))})
 let card=tree.root.findByProps({role:'button'})
 assert.equal(card.props.tabIndex,0);assert.match(card.props['aria-label'],/Food.*100% of ring/)
 card.props.onClick();assert.equal(calls.pop(),data[0],'A callout opens the exact same current category as its slice')
 for(const key of ['Enter',' ']){let prevented=false;card.props.onKeyDown({key,preventDefault(){prevented=true}});assert.ok(prevented);assert.equal(calls.pop(),data[0])}
 act(()=>tree.update(React.createElement(CategoryContourCallouts,{scene,data,ready:true,visible:false,onInspect:item=>calls.push(item)})))
 assert.equal(tree.root.findByType('svg').props['aria-hidden'],true)
 assert.equal(tree.root.findByProps({role:'button'}).props.tabIndex,-1,'Hidden callouts leave the keyboard and accessibility order')
}finally{if(tree)act(()=>tree.unmount())}
