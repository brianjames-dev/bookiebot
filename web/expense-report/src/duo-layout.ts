import {useEffect,useLayoutEffect,useState} from "react"
import {recordDisplayFrame} from './display-diagnostics'

export function duoPreferenceKey(owner:string) {
  return `bookiebot:duo-layout:${encodeURIComponent(owner.trim().toLowerCase())}`
}
function readPreference(key:string) {
  try { return window.localStorage.getItem(key)==="true" } catch { return false }
}

export function duoLandscapeGeometry(width:number,height:number,safeRight=0) {
  const landscape=width>=800 && width<=1024 && height>=480 && height<=780 && width>height
  const rail=Math.max(84,safeRight)
  // Some installed viewports already end before the native 84px status strip.
  // Only reserve the part still inside the drawable viewport.
  const excluded=Math.min(rail,Math.max(0,951-width))
  return {landscape,rail,overlay:landscape?rail-excluded:0}
}

export function duoRingGeometry(size:{width:number;height:number}) {
  const width=size.width||219,height=size.height||219
  // Fill the measured chart row, leaving room for the sector outline.
  const radius=Math.max(1,Math.min(width,height)/2-2)
  return {cx:width/2,cy:height/2,outerRadius:radius,innerRadius:radius*(1-52/219)}
}

// Rebuild the fixed positioning box, not the React tree. A retained iOS view
// can keep its old native origin while reporting zero document/visual offsets.
function reattachDuoCanvas() {
  const page=document.querySelector<HTMLElement>('.bb-page[data-duo-enabled="true"]')
  if(!page)return false
  const scrolls=[page,...page.querySelectorAll<HTMLElement>('*')]
    .filter(node=>node.scrollTop||node.scrollLeft)
    .map(node=>({node,top:node.scrollTop,left:node.scrollLeft}))
  const value=page.style.getPropertyValue('position'),priority=page.style.getPropertyPriority('position')
  page.style.setProperty('position','absolute','important')
  void page.offsetHeight
  if(value)page.style.setProperty('position',value,priority)
  else page.style.removeProperty('position')
  void page.offsetHeight
  for(const {node,top,left}of scrolls){node.scrollTop=top;node.scrollLeft=left}
  return true
}

/** Reconnect a retained canvas; an app switch need not fire pageshow/resize. */
export function watchDuoViewport(update:()=>void) {
  let frame=0,panFrame=0,seenVisible=document.visibilityState!=='hidden',suspended=false,reattach=false,lastPan=''
  const viewport=window.visualViewport
  const timers:number[]=[]
  const measure=()=>{
    if(document.visibilityState==='hidden')return
    recordDisplayFrame('measure')
    update()
    const visual=window.visualViewport
    const keyboard=document.activeElement?.matches('input,textarea,[contenteditable=true]')&&visual&&window.innerHeight-visual.height>140
    // Keep keyboard, pinch and modal scroll ownership authoritative.
    if(keyboard||Math.abs((visual?.scale??1)-1)>=.01||document.documentElement.dataset.bbModalScrollLock==='true')return
    const panned=window.scrollX||window.scrollY||visual?.offsetTop||visual?.offsetLeft
    const pan=panned?[window.scrollX,window.scrollY,visual?.offsetTop,visual?.offsetLeft].join(':'):''
    // Even scrollTo(0,0) can emit a visual scroll event without correcting an
    // OS-owned offset. Do not create a feedback loop for an unchanged report.
    const repair=reattach||Boolean(pan&&pan!==lastPan)
    if(repair){lastPan=pan;window.scrollTo({left:0,top:0,behavior:'instant'})}
    if(!panned)lastPan=''
    if(repair&&reattachDuoCanvas()){reattach=false;recordDisplayFrame('repaired')}
  }
  const cancel=()=>{window.cancelAnimationFrame(frame);window.cancelAnimationFrame(panFrame);frame=panFrame=0;timers.splice(0).forEach(id=>window.clearTimeout(id))}
  const pause=(event?:Event)=>{if(event)recordDisplayFrame(event.type,'background');if(seenVisible)suspended=true;cancel()}
  const settle=(event?:Event)=>{
    recordDisplayFrame(event?.type??'mount',document.visibilityState==='hidden'?'background':suspended?'resume':undefined)
    cancel()
    if(document.visibilityState==='hidden'){pause();return}
    seenVisible=true
    if(suspended){suspended=false;reattach=true}
    lastPan=''
    measure()
    frame=window.requestAnimationFrame(()=>{measure();frame=window.requestAnimationFrame(()=>{frame=0;measure()})})
    // Orientation/resume values can settle after the first restored frame.
    for(const delay of [100,300])timers.push(window.setTimeout(measure,delay))
    timers.push(window.setTimeout(()=>recordDisplayFrame('settled'),1000))
  }
  const pan=()=>{if(!panFrame)panFrame=window.requestAnimationFrame(()=>{panFrame=0;measure()})}
  const events=['resize','orientationchange','pageshow','focus']
  events.forEach(name=>window.addEventListener(name,settle))
  window.addEventListener('pagehide',pause)
  document.addEventListener('visibilitychange',settle)
  document.addEventListener('focusout',settle)
  viewport?.addEventListener('resize',settle)
  viewport?.addEventListener('scroll',pan)
  settle()
  return()=>{cancel();events.forEach(name=>window.removeEventListener(name,settle));window.removeEventListener('pagehide',pause);document.removeEventListener('visibilitychange',settle);document.removeEventListener('focusout',settle);viewport?.removeEventListener('resize',settle);viewport?.removeEventListener('scroll',pan)}
}

export function useDuoLayout(owner:string) {
  const key=duoPreferenceKey(owner)
  const [choice,setChoice]=useState(()=>({key,enabled:readPreference(key)}))
  const enabled=choice.key===key?choice.enabled:readPreference(key)
  const [geometry,setGeometry]=useState(()=>duoLandscapeGeometry(0,0))
  useLayoutEffect(()=>{
    if(!enabled)return
    const safe=document.createElement("span")
    safe.setAttribute("aria-hidden","true")
    safe.setAttribute('data-bb-safe-area','')
    safe.style.cssText="position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)"
    document.body.append(safe)
    const update=()=>{
      const width=document.documentElement.clientWidth,height=window.innerHeight
      const next=duoLandscapeGeometry(width,height,parseFloat(getComputedStyle(safe).paddingRight)||0)
      setGeometry(previous=>previous.landscape===next.landscape&&previous.overlay===next.overlay&&previous.rail===next.rail?previous:next)
    }
    const stop=watchDuoViewport(update)
    return()=>{stop();safe.remove()}
  },[enabled])
  useEffect(()=>{
    const sync=(event:StorageEvent)=>{if(event.key===key||event.key===null)setChoice({key,enabled:readPreference(key)})}
    window.addEventListener("storage",sync)
    return()=>window.removeEventListener("storage",sync)
  },[key])
  return {enabled,landscape:enabled&&geometry.landscape,overlay:geometry.overlay,rail:geometry.rail,toggle(){
    setChoice({key,enabled:!enabled})
    try {window.localStorage.setItem(key,String(!enabled))}catch{/* Keep the session choice when storage is unavailable. */}
  }}
}
