// Native artwork and deterministic framing only. No network, AI or runtime writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {createRequire}=require('node:module'),folder=__dirname,repo=path.resolve(folder,'../../../..')
const req=createRequire(path.join(repo,'web/expense-report/package.json'))
const {chromium}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const recipes=JSON.parse(fs.readFileSync(path.join(folder,'framing.json')))
const out=path.resolve(process.argv[2]||path.join(folder,'prepared'))
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
;(async()=>{
 fs.mkdirSync(out,{recursive:true})
 const browser=await chromium.launch(),results=[]
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort())
  for(const recipe of recipes.items){
   const file=path.join(folder,recipe.source),bytes=fs.readFileSync(file)
   if(sha(bytes)!==recipe.sourceSha256)throw Error('Source changed: '+recipe.key)
   const mime=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.jpg')?'image/jpeg':'image/png'
   const result=await page.evaluate(async({recipe,url,size})=>{
    const image=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=url})
    const sample=document.createElement('canvas');sample.width=image.naturalWidth;sample.height=image.naturalHeight
    const sc=sample.getContext('2d');sc.drawImage(image,0,0)
    const w=sample.width,h=sample.height,pixels=sc.getImageData(0,0,w,h).data
    let left=w,top=h,right=-1,bottom=-1
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
     const i=(y*w+x)*4,[r,g,b,a]=pixels.subarray(i,i+4)
     const painted=a>32&&(recipe.trim==='full'||recipe.trim==='alpha'||
      recipe.trim==='red'&&r>170&&g<100&&b<90||recipe.trim==='blue'&&r<80&&g<180&&b>130||
      recipe.trim==='yellow'&&r>200&&g>130&&b<110||recipe.trim==='pge'&&(Math.abs(r-0)>48||Math.abs(g-137)>48||Math.abs(b-196)>48))
     if(painted){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
    }
    if(right<left)throw Error('Empty artwork')
    const crop=[left,top,right-left+1,bottom-top+1],scale=size*recipe.fill/Math.max(crop[2],crop[3])
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size
    const ctx=canvas.getContext('2d');ctx.beginPath();ctx.arc(size/2,size/2,size/2,0,Math.PI*2);ctx.clip()
    ctx.fillStyle=recipe.background;ctx.fillRect(0,0,size,size)
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high'
    // Draw the original viewport through its crop transform; no intermediate raster.
    ctx.drawImage(image,(size-crop[2]*scale)/2-left*scale,(size-crop[3]*scale)/2-top*scale,w*scale,h*scale)
    return{png:canvas.toDataURL('image/png'),crop,sourceSize:[w,h]}
   },{recipe,url:'data:'+mime+';base64,'+bytes.toString('base64'),size:recipes.size})
   const png=Buffer.from(result.png.split(',')[1],'base64'),fileName=recipe.key.replace(':','-')+'.png'
   fs.writeFileSync(path.join(out,fileName),png)
   results.push({...recipe,crop:result.crop,sourceSize:result.sourceSize,sha256:sha(png),prepared:fileName})
  }
 }finally{await browser.close()}
 fs.writeFileSync(path.join(folder,'rendering.json'),JSON.stringify({version:1,method:'native artwork / deterministic canvas framing',items:results},null,2)+'\n')
 console.log(JSON.stringify({count:results.length,output:out}))
})().catch(error=>{console.error(error);process.exitCode=1})
