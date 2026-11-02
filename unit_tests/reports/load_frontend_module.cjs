// Load a production TS/TSX module with its real local dependencies and React.
const {createRequire}=require('node:module'),path=require('node:path'),vm=require('node:vm')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
module.exports=(entry)=>{
 const result=req('esbuild').buildSync({entryPoints:[path.join(root,'web/expense-report/src',entry)],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react/*','lucide-react'],logLevel:'silent'})
 const context={module:{exports:{}},require:req,window:{matchMedia:()=>({matches:false}),setTimeout,clearTimeout}}
 vm.runInNewContext(result.outputFiles[0].text,context)
 return context.module.exports
}
