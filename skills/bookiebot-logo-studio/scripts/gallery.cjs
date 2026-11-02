// Render actual local icon treatments into one lossless, offline review atlas.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module')
const {execFileSync}=require('node:child_process')
const job=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
const req=createRequire(path.join(job.repo,'web/expense-report/package.json'))
const {chromium}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const data=asset=>{
 const file=path.resolve(job.repo,asset),bytes=fs.readFileSync(file)
 if(bytes.length>8000000)throw Error('Oversized image')
 const mime=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.jpg')||file.endsWith('.jpeg')?'image/jpeg':file.endsWith('.webp')?'image/webp':file.endsWith('.ico')?'image/x-icon':'image/png'
 return 'data:'+mime+';base64,'+bytes.toString('base64')
}
;(async()=>{
 const images=[]
 for(const row of job.snapshot.items){
  if(row.asset){row.currentIndex=images.length;images.push({url:data(row.asset),background:row.background,inset:row.inset||0})}
  if(row.candidate){row.candidateIndex=images.length;images.push({url:data(row.candidate.asset),background:'transparent',inset:0})}
 }
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort())
  const atlas=await page.evaluate(async images=>{
   const size=84,columns=12,canvas=document.createElement('canvas')
   canvas.width=columns*size;canvas.height=Math.max(1,Math.ceil(images.length/columns))*size
   const ctx=canvas.getContext('2d')
   for(let index=0;index<images.length;index++){
    const item=images[index],image=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('Image decode failed'));i.src=item.url})
    const x=index%columns*size,y=Math.floor(index/columns)*size,pad=item.inset*size/28
    ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.arc(size/2,size/2,size/2,0,Math.PI*2);ctx.clip()
    if(item.background!=='transparent'){ctx.fillStyle=item.background;ctx.fillRect(0,0,size,size)}
    const scale=Math.min((size-pad*2)/image.naturalWidth,(size-pad*2)/image.naturalHeight)
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high'
    ctx.drawImage(image,(size-image.naturalWidth*scale)/2,(size-image.naturalHeight*scale)/2,image.naturalWidth*scale,image.naturalHeight*scale)
    ctx.restore()
   }
   return{url:canvas.toDataURL('image/png'),size,columns,width:canvas.width,height:canvas.height}
  },images)
  // Lossless compression preserves every visible edge pixel; no lossy thumbnails.
  const compressed=execFileSync(process.env.BOOKIEBOT_STUDIO_PYTHON||'python',['-c',
   'import io,sys; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.save(sys.stdout.buffer,format="WEBP",lossless=True,exact=True,method=6)'],
   {input:Buffer.from(atlas.url.split(',')[1],'base64'),maxBuffer:8000000})
  atlas.url='data:image/webp;base64,'+compressed.toString('base64')
  const payload={version:1,snapshotId:job.snapshot.snapshotId,items:job.snapshot.items.map(({key,kind,id,name,group,currentIndex,candidateIndex,candidate,notes,referenceUrls,status})=>({key,kind,id,name,group,currentIndex,candidateIndex,candidateSha256:candidate?.sha256,notes,referenceUrls,status})),atlas}
  const json=JSON.stringify(payload).replace(/</g,'\\u003c')
  const fragment=fs.readFileSync(job.template,'utf8').replace('__STUDIO_DATA__',json)
  if(Buffer.byteLength(fragment)>1000000)throw Error('Review exceeds the inline size budget; review a selected batch instead')
  fs.writeFileSync(job.out,fragment)
  console.log(JSON.stringify({icons:payload.items.length,bytes:Buffer.byteLength(fragment),output:job.out}))
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
