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
  return {landscape,rail,overlay:landscape?Math.max(safeRight,rail-excluded):0}
}

export function duoRingGeometry(size:{width:number;height:number}) {
  const width=size.width||219,height=size.height||219
  const radius=Math.max(1,Math.min(219,width,height))/2
  return {cx:width/2,cy:height/2,outerRadius:radius,innerRadius:radius*(1-52/219)}
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
    update()
    window.addEventListener("resize",update)
    window.addEventListener("orientationchange",update)
    return()=>{safe.remove();window.removeEventListener("resize",update);window.removeEventListener("orientationchange",update)}
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
