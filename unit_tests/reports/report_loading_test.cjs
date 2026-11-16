const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),req=createRequire(path.resolve('web/expense-report/package.json'));
const React=req('react'),{renderToStaticMarkup}=req('react-dom/server'),ts=req('typescript');
const runtime={exports:{},require:req};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/report-loading.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX},
}).outputText,runtime);
const {ReportLoading}=runtime.exports;
for(const compact of [false,true]){
 const html=renderToStaticMarkup(React.createElement(ReportLoading,{compact,label:'Loading transactions & bills…'}));
 assert.match(html,/role="status"/,'The pending state remains available to assistive technology');
 assert.match(html,/<span class="sr-only">Loading transactions &amp; bills…<\/span>/,'The descriptive label is hidden visually instead of discarded');
 assert.match(html,/<span[^>]*aria-hidden="true"><svg/,'The animated glyph is decorative');
 assert.match(html,/<circle[^>]*pathLength="100"[^>]*stroke-dasharray="100"[^>]*stroke-dashoffset="25"/,'Both sizes retain the actual Overview ring');
 assert.equal(html.startsWith(compact?'<span':'<div'),true);
}
const button=renderToStaticMarkup(React.createElement('button',{disabled:true},React.createElement(ReportLoading,{compact:true,label:'Loading more transactions…'})));
assert(!button.includes('<div'),'A compact pending indicator is valid inline button content');
assert.match(button,/Loading more transactions…/,'The temporarily disabled action still has a meaningful accessible name');
console.log('Shared page/compact loading semantics and valid inline action markup passed');
