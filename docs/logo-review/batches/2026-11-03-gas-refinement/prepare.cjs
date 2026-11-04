// Reframe the supplied source artwork; preserve its glyphs and brand geometry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE);
const folder=__dirname,sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sources=JSON.parse(fs.readFileSync(path.join(folder,'source-manifest.json'))).items;
const recipes=JSON.parse(fs.readFileSync(path.join(folder,'framing.json')));
(async()=>{
 const browser=await chromium.launch();
 const results=[],out=path.join(folder,'prepared');fs.mkdirSync(out,{recursive:true});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());
  for(const recipe of recipes.items){
   const source=sources.find(item=>item.key===recipe.key),bytes=fs.readFileSync(path.join(folder,source.source));
   if(sha(bytes)!==source.sha256)throw Error('Source hash mismatch: '+recipe.key);
   const mime=source.format==='SVG'?'image/svg+xml':source.format==='JPEG'?'image/jpeg':'image/png';
   const result=await page.evaluate(async({recipe,url,size})=>{
    const image=new Image();image.src=url;await image.decode();
    const sample=document.createElement('canvas');sample.width=image.naturalWidth;sample.height=image.naturalHeight;
    const sc=sample.getContext('2d');sc.drawImage(image,0,0);
    const pixels=sc.getImageData(0,0,sample.width,sample.height).data,w=sample.width,h=sample.height;
    let left=w,top=h,right=-1,bottom=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(pixels[(y*w+x)*4+3]>64){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    const crop=recipe.crop||[left,top,right-left+1,bottom-top+1];
    if(crop[2]<=0||crop[3]<=0)throw Error('Empty artwork');
    let scale=size*recipe.fill/(recipe.fit==='short-side'?Math.min(crop[2],crop[3]):Math.max(crop[2],crop[3]));
    if(recipe.fit==='radial'){
     const cx=crop[0]+crop[2]/2,cy=crop[1]+crop[3]/2;let radius=0;
     for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(pixels[(y*w+x)*4+3]>64)radius=Math.max(radius,Math.hypot(x+.5-cx,y+.5-cy));
     scale=size/2*recipe.fill/radius;
    }
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
    const ctx=canvas.getContext('2d');ctx.beginPath();ctx.arc(size/2,size/2,size/2,0,Math.PI*2);ctx.clip();
    ctx.fillStyle=recipe.background;ctx.fillRect(0,0,size,size);
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    const dx=(size-crop[2]*scale)/2-crop[0]*scale,dy=(size-crop[3]*scale)/2-crop[1]*scale;
    if(recipe.diamond){
     ctx.save();ctx.beginPath();recipe.diamond.forEach(([x,y],i)=>{if(i===0)ctx.moveTo(dx+x*scale,dy+y*scale);else ctx.lineTo(dx+x*scale,dy+y*scale);});ctx.closePath();ctx.clip();
     ctx.drawImage(image,dx,dy,w*scale,h*scale);ctx.restore();
    }else ctx.drawImage(image,dx,dy,w*scale,h*scale);
    return{png:canvas.toDataURL('image/png'),crop,sourceSize:[w,h],scale};
   },{recipe,url:'data:'+mime+';base64,'+bytes.toString('base64'),size:recipes.size});
   const png=Buffer.from(result.png.split(',')[1],'base64'),prepared=recipe.key.replace(':','-')+'.png';
   fs.writeFileSync(path.join(out,prepared),png);
   results.push({...recipe,source:source.source,sourceUrl:source.url,sourceSha256:source.sha256,sourceSize:result.sourceSize,crop:result.crop,scale:result.scale,sha256:sha(png),prepared:'prepared/'+prepared});
  }
 }finally{await browser.close();}
 fs.writeFileSync(path.join(folder,'rendering.json'),JSON.stringify({version:1,method:'original artwork / deterministic canvas framing',items:results},null,2)+'\n');
 console.log(JSON.stringify({count:results.length,output:out}));
})().catch(error=>{console.error(error);process.exitCode=1;});
