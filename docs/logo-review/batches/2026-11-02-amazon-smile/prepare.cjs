// Preserve the supplied smile-only artwork and its framing; no runtime writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {createRequire}=require('node:module'),folder=__dirname,repo=path.resolve(folder,'../../../..')
const req=createRequire(path.join(repo,'web/expense-report/package.json'))
const {chromium}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const metadata=JSON.parse(fs.readFileSync(path.join(folder,'source.json')))
const source=fs.readFileSync(path.join(folder,metadata.source)),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
if(sha(source)!==metadata.sha256)throw Error('Reference changed')
;(async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort())
  const png=await page.evaluate(async url=>{
   const image=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=url})
   const canvas=document.createElement('canvas');canvas.width=canvas.height=256
   const ctx=canvas.getContext('2d');ctx.beginPath();ctx.arc(128,128,128,0,Math.PI*2);ctx.clip()
   ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0,256,256)
   return canvas.toDataURL('image/png')
  },'data:image/jpeg;base64,'+source.toString('base64'))
  const data=Buffer.from(png.split(',')[1],'base64'),out=path.resolve(process.argv[2]||'/tmp/bookiebot-amazon-smile.png')
  fs.writeFileSync(out,data)
  fs.writeFileSync(path.join(folder,'rendering.json'),JSON.stringify({version:1,method:'native supplied artwork / deterministic circle framing',sourceSha256:metadata.sha256,sha256:sha(data),size:[256,256],framing:'Complete supplied image clipped to circle; preserve white smile and orange background'},null,2)+'\n')
  console.log(JSON.stringify({output:out,sha256:sha(data)}))
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
