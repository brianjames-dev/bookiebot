// Ephemeral geometry only. Never read DOM text, inputs, URLs, account data or
// storage. Nothing is sent anywhere; the user explicitly copies the report.
const now=()=>typeof performance==='undefined'?Date.now():performance.now()
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.round(value*100)/100:null
const rect=(node:Element|null)=>{
  if(!node)return null
  const box=node.getBoundingClientRect()
  return [box.x,box.y,box.width,box.height].map(number)
}
function snapshot(reason:string) {
  const page=document.querySelector<HTMLElement>('.bb-page[data-duo-enabled="true"]')
  if(typeof page?.getBoundingClientRect!=='function')return null
  const root=document.documentElement,body=document.body,visual=window.visualViewport
  const style=getComputedStyle(page),safe=document.querySelector('[data-bb-safe-area]')
  const insets=safe?getComputedStyle(safe):null
  const scroll=(node:Element|null)=>node?[node.scrollLeft,node.scrollTop].map(number):null
  const ancestors=[]
  for(let node=page.parentElement;node&&ancestors.length<6;node=node.parentElement){
    const css=getComputedStyle(node)
    ancestors.push({tag:node.tagName,box:rect(node),position:css.position,transform:css.transform,translate:css.translate,scale:css.scale,zoom:css.zoom,contain:css.contain,filter:css.filter,willChange:css.willChange})
  }
  const knownScreen=['overview','transactions','shared','savings','reconcile','settings'].includes(page.dataset.screen??'')?page.dataset.screen:null
  return {
    at:number(now()),reason,visibility:document.visibilityState,screen:knownScreen,open:page.dataset.duoLandscape==='true',
    window:[window.innerWidth,window.innerHeight,window.outerWidth,window.outerHeight,window.scrollX,window.scrollY,window.screenX,window.screenY].map(number),
    root:[root.clientWidth,root.clientHeight,root.scrollWidth,root.scrollHeight,...(scroll(root)??[])].map(number),
    visual:visual?[visual.width,visual.height,visual.offsetLeft,visual.offsetTop,visual.pageLeft,visual.pageTop,visual.scale].map(number):null,
    safe:insets?[insets.paddingTop,insets.paddingRight,insets.paddingBottom,insets.paddingLeft].map(value=>number(parseFloat(value))):null,
    boxes:{root:rect(root),body:rect(body),app:rect(document.querySelector('#bookiebot-expense-report-root')),page:rect(page),masthead:rect(page.querySelector('.bb-shell-masthead')),title:rect(page.querySelector('.bb-report-header')),tools:rect(page.querySelector('.bb-shell-header-actions')),dock:rect(document.querySelector('.bb-navigation-viewport')),nav:rect(document.querySelector('.bb-navigation-pane'))},
    ancestors,
    pageStyle:{position:style.position,height:style.height,padding:[style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft],transform:style.transform,rows:style.gridTemplateRows},
    scrolls:{page:scroll(page),list:scroll(page.querySelector(page.dataset.screen==='shared'?'.sr-list':'.bb-recorded-results'))},
    pull:{box:rect(page.querySelector('.bb-pull-refresh-space')),phase:page.querySelector<HTMLElement>('.bb-pull-refresh-space')?.dataset.phase??null},
    focusedField:Boolean(document.activeElement?.matches('input,textarea,[contenteditable=true]')),
    modal:root.dataset.bbModalScrollLock==='true',
  }
}
type Frame=NonNullable<ReturnType<typeof snapshot>>
let baseline:Frame|null=null,beforeBackground:Frame|null=null,resume:Frame[]=[],captureUntil=0

export function recordDisplayFrame(reason:string,phase?:'background'|'resume') {
  // Reporting must never interrupt normal foreground/scroll recovery.
  try{
    if(baseline&&!phase&&now()>captureUntil)return
    const frame=snapshot(reason);if(!frame)return
    baseline??=frame
    if(phase==='background')beforeBackground=frame
    if(phase==='resume'){resume=[frame];captureUntil=now()+1500}
    else if(resume.length&&now()<=captureUntil){resume.push(frame);if(resume.length>10)resume.splice(1,1)}
  }catch{/* Best-effort geometry collection only. */}
}

export function displayReport(version:string) {
  const current=snapshot('copy')
  const screen=window.screen
  let previous=beforeBackground??baseline
  const resumeChanges=resume.map(frame=>{
    const delta=Object.fromEntries(Object.entries(frame).filter(([key,value])=>key==='at'||key==='reason'||JSON.stringify(value)!==JSON.stringify(previous?.[key as keyof Frame])))
    previous=frame;return delta
  })
  return JSON.stringify({format:'BookieBot display report 1',build:version.slice(0,32),
    device:{agent:navigator.userAgent.slice(0,200),pixelRatio:number(window.devicePixelRatio),screen:[screen?.width,screen?.height,screen?.availWidth,screen?.availHeight].map(number),orientation:screen?.orientation?[screen.orientation.type,number(screen.orientation.angle)]:null,standalone:(navigator as Navigator&{standalone?:boolean}).standalone??window.matchMedia('(display-mode: standalone)').matches},
    baseline,beforeBackground,resumeChanges,current})
}
