const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(require('node:path').resolve('web/expense-report/package.json'))
const ts=req('typescript'),React=req('react'),Renderer=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
const source=fs.readFileSync('web/expense-report/src/report-app.tsx','utf8')
const ast=ts.createSourceFile('report-app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const names=new Set(['CategoryMixFilterControl','CATEGORY_MIX_FILTERS','useExpensePieLayout','fitExpensePieLayout','expensePieEnvelope','PIE_METRIC_LABEL_GAP','PIE_METRIC_MINIMUM_RADIUS','PIE_METRIC_START_ANGLE','PIE_METRIC_END_ANGLE'])
const declarations=ast.statements.filter(node=>ts.isFunctionDeclaration(node)?names.has(node.name?.text):ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>names.has(item.name.getText(ast))))
assert.equal(declarations.length,names.size)
const runtime={exports:{},require:req,useState:React.useState,useMediaQuery:()=>true,pieMetricLabelDeltas:()=>({}),ChevronDown:props=>React.createElement('svg',props)}
vm.runInNewContext(ts.transpileModule(declarations.map(node=>node.getText(ast)).join('\n')+'\nexports.Filter=CategoryMixFilterControl;exports.layout=useExpensePieLayout;exports.angles=[PIE_METRIC_START_ANGLE,PIE_METRIC_END_ANGLE]',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
assert.deepEqual(Array.from(runtime.exports.angles),[90,-270],'The ring starts at noon and sweeps clockwise')
for(const [width,height] of [[288,360],[358,360],[480,200],[250,340]]){
 const layout=runtime.exports.layout([],{width,height})
 assert.ok(Math.abs(layout.outerRadius-(Math.min(width,height)/2-8))<.001,'Use all available phone chart space, subject to its height')
 assert.equal(layout.innerRadius/layout.outerRadius,.72)
 assert.ok(Math.abs(layout.cx-width/2)<.001&&Math.abs(layout.cy-height/2)<.001,'Percentage and ring share the host center')
 assert.equal(layout.showLabels,false,'Phone category itemization stays in the Categories modal')
}
let tree;const selected=[]
try{
 Renderer.act(()=>{tree=Renderer.create(React.createElement(runtime.exports.Filter,{filter:'all',onFilterChange:value=>selected.push(value)}))})
 let select=tree.root.findByType('select')
 assert.equal(select.props['aria-label'],'Category mix filter')
 assert.equal(select.props.value,'all')
 assert.deepEqual(tree.root.findAllByType('option').map(option=>[option.props.value,option.children.join('')]),[['all','All'],['needs','Needs'],['wants','Wants'],['savings','Savings']])
 Renderer.act(()=>select.props.onPointerDown())
 assert.equal(tree.root.findByProps({className:'bb-category-mix-filter'}).props['data-pointer-focus'],'true')
 Renderer.act(()=>select.props.onChange({target:{value:'needs'}}))
 assert.equal(tree.root.findByProps({className:'bb-category-mix-filter'}).props['data-pointer-focus'],'true','Choosing a scope must not restore the touch focus ring')
 selected.length=0
 Renderer.act(()=>select.props.onKeyDown())
 assert.equal(tree.root.findByProps({className:'bb-category-mix-filter'}).props['data-pointer-focus'],undefined,'Keyboard input restores the visible focus indicator')
 Renderer.act(()=>select.props.onPointerDown())
 Renderer.act(()=>select.props.onBlur())
 assert.equal(tree.root.findByProps({className:'bb-category-mix-filter'}).props['data-pointer-focus'],undefined,'Leaving the chooser clears its local pointer modality')
 for(const value of ['needs','wants','savings','all'])Renderer.act(()=>select.props.onChange({target:{value}}))
 assert.deepEqual(selected,['needs','wants','savings','all'])
 Renderer.act(()=>tree.update(React.createElement(runtime.exports.Filter,{filter:'savings',onFilterChange:value=>selected.push(value)})))
 assert.equal(tree.root.findByType('select').props.value,'savings','Refreshing/rerendering preserves the selected scope')
 assert.equal(tree.root.findByType('svg').props['aria-hidden'],'true')
}finally{if(tree)Renderer.act(()=>tree.unmount())}
console.log('Category Mix uses a controlled native scope selector and fills the available phone ring area clockwise from noon.')
