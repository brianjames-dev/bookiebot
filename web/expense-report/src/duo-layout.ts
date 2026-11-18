import {useEffect,useLayoutEffect,useState} from "react"

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

/** iOS can restore document pan/old geometry without delivering a resize. */
export function watchDuoViewport(update:()=>void) {
  let frame=0
  const viewport=window.visualViewport
  const timers:number[]=[]
  const measure=()=>{
    if(document.visibilityState==='hidden')return
    update()
    const visual=window.visualViewport
    const keyboard=document.activeElement?.matches('input,textarea,[contenteditable=true]')&&visual&&window.innerHeight-visual.height>140
    // The Duo page owns content scroll. Never turn keyboard/zoom panning into
    // a document reset, and never reset the page surface or its retained editor.
    if(!keyboard&&Math.abs((visual?.scale??1)-1)<.01&&(window.scrollX||window.scrollY))window.scrollTo({left:0,top:0,behavior:'instant'})
  }
  const cancel=()=>{window.cancelAnimationFrame(frame);frame=0;timers.splice(0).forEach(id=>window.clearTimeout(id))}
  const settle=()=>{
    cancel()
    if(document.visibilityState==='hidden')return
    measure()
    frame=window.requestAnimationFrame(()=>{measure();frame=window.requestAnimationFrame(()=>{frame=0;measure()})})
    // Orientation/resume values can settle after the first restored frame.
    for(const delay of [100,300])timers.push(window.setTimeout(measure,delay))
  }
  const events=['resize','orientationchange','pageshow','focus']
  events.forEach(name=>window.addEventListener(name,settle))
  document.addEventListener('visibilitychange',settle)
  viewport?.addEventListener('resize',settle)
  settle()
  return()=>{cancel();events.forEach(name=>window.removeEventListener(name,settle));document.removeEventListener('visibilitychange',settle);viewport?.removeEventListener('resize',settle)}
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
    safe.style.cssText="position:fixed;visibility:hidden;width:0;height:0;padding-right:env(safe-area-inset-right,0px)"
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
