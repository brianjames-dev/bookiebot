import {useLayoutEffect,useRef} from 'react'

const lists:Record<string,{container:string;rows:string}>={
 transactions:{container:'.bb-recorded-results',rows:'.bb-daily-day-group'},
 shared:{container:'.sr-list',rows:'.sr-row-group'},
 savings:{container:'.sw-root .sg-left',rows:'.sg-goal-item,.ss-parent-item'},
 reconcile:{container:'.bb-reconcile-left',rows:'.bb-reconcile-row'},
}
type View={anchor:HTMLElement|null;offset:number;y:number;wide:boolean}

/** Move scroll ownership, never the editor DOM or the body-level dock. */
export function createDuoListScroll(page:HTMLElement) {
 const views=new Map<string,View>()
 const viewport=window.visualViewport
 let wide=false,screen='',readFrame=0,resumeFrame=0,settleFrame=0,settleTimer=0,settling=false,disposed=false
 const list=()=>lists[screen]?page.querySelector<HTMLElement>(lists[screen].container):null
 const allowed=()=>{
  const visual=window.visualViewport
  const keyboard=document.activeElement?.matches('input,textarea,[contenteditable=true]')&&visual&&window.innerHeight-visual.height>140
  return !disposed&&!keyboard&&Math.abs((visual?.scale??1)-1)<.01&&document.documentElement.dataset.bbModalScrollLock!=='true'
 }
 const capture=(hidden=false)=>{
  if(!allowed()||settling||!hidden&&document.visibilityState==='hidden'||page.dataset.screen!==screen||Boolean(page.dataset.duoLandscape)!==wide)return
  const target=list();if(!target)return
  const owner=wide?target:page,rect=owner.getBoundingClientRect();if(!rect.height)return
  const anchor=[...target.querySelectorAll<HTMLElement>(lists[screen].rows)].find(row=>row.getBoundingClientRect().bottom>rect.top+1)??null
  views.set(screen,{anchor,offset:anchor?anchor.getBoundingClientRect().top-rect.top:0,y:Math.max(0,owner.scrollTop),wide})
 }
 const stopMotion=(owner:HTMLElement,y:number)=>{
  const previous=owner.style.overflow
  // Destroy the old scrolling box to cancel WebKit's retained momentum/bounce.
  // Restore it in the same layout turn, preserving focus and mounted editors.
  owner.style.overflow='clip'
  void owner.offsetHeight
  owner.style.overflow=previous
  owner.scrollTop=Math.max(0,Math.min(y,owner.scrollHeight-owner.clientHeight))
 }
 const apply=(saved:View|undefined,motion:boolean)=>{
  if(!allowed()||document.visibilityState==='hidden')return
  const target=list();if(!target)return
  if(wide){if(motion)stopMotion(page,0);else page.scrollTop=0}
  else target.scrollTop=0
  const owner=wide?target:page
  let y=saved?.wide===wide?saved.y:owner.scrollTop
  if(saved?.y===0)y=0
  else if(saved?.anchor?.isConnected&&target.contains(saved.anchor))y=owner.scrollTop+saved.anchor.getBoundingClientRect().top-owner.getBoundingClientRect().top-saved.offset
  if(motion)stopMotion(owner,y)
  else owner.scrollTop=Math.max(0,y)
 }
 const cancelSettle=()=>{window.cancelAnimationFrame(settleFrame);window.clearTimeout(settleTimer);settleFrame=settleTimer=0;settling=false}
 const restore=()=>{
  cancelSettle()
  const saved=views.get(screen)
  settling=true;apply(saved,true)
  // Responsive text and row measurements settle after the mode commit. Keep
  // the original anchor through those frames instead of caching a partial pose.
  settleFrame=window.requestAnimationFrame(()=>{apply(saved,false);settleFrame=window.requestAnimationFrame(()=>{settleFrame=0;apply(saved,false)})})
  settleTimer=window.setTimeout(()=>{settleTimer=0;apply(saved,false);settling=false;capture()},300)
 }
 const scroll=(event:Event)=>{const target=list();if(!settling&&target&&event.target===(wide?target:page)){window.cancelAnimationFrame(readFrame);readFrame=window.requestAnimationFrame(()=>{readFrame=0;capture()})}}
 const pause=()=>{window.cancelAnimationFrame(readFrame);window.cancelAnimationFrame(resumeFrame);readFrame=resumeFrame=0;if(!settling)capture(true);cancelSettle()}
 const resume=()=>{window.cancelAnimationFrame(resumeFrame);resumeFrame=window.requestAnimationFrame(()=>{resumeFrame=0;restore()})}
 const interact=()=>{if(settling){cancelSettle();capture()}}
 const visibility=()=>document.visibilityState==='hidden'?pause():resume()
 page.addEventListener('scroll',scroll,{passive:true,capture:true})
 const interactions=['pointerdown','touchstart','wheel','keydown']
 interactions.forEach(name=>page.addEventListener(name,interact,{passive:true,capture:true}))
 window.addEventListener('pagehide',pause)
 window.addEventListener('pageshow',resume)
 window.addEventListener('focus',resume)
 document.addEventListener('visibilitychange',visibility)
 viewport?.addEventListener('resize',resume)
 return {
  layout(nextWide:boolean,nextScreen:string){
   // Tab navigation already restores its own position in the shell. Only a
   // fold/resume hands this saved viewport between the two scroll owners.
   if(nextScreen!==screen)views.delete(nextScreen)
   wide=nextWide;screen=nextScreen;restore()
  },
  dispose(){disposed=true;cancelSettle();window.cancelAnimationFrame(readFrame);window.cancelAnimationFrame(resumeFrame);interactions.forEach(name=>page.removeEventListener(name,interact,true));page.removeEventListener('scroll',scroll,true);window.removeEventListener('pagehide',pause);window.removeEventListener('pageshow',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',visibility);viewport?.removeEventListener('resize',resume)},
 }
}

export function useDuoListScroll(enabled:boolean,wide:boolean,screen:string) {
 const controller=useRef<ReturnType<typeof createDuoListScroll>|null>(null)
 useLayoutEffect(()=>{
  if(!enabled)return
  const page=document.querySelector<HTMLElement>('.bb-page[data-duo-enabled="true"]');if(!page)return
  const current=createDuoListScroll(page);controller.current=current
  return()=>{current.dispose();controller.current=null}
 },[enabled])
 useLayoutEffect(()=>{controller.current?.layout(wide,screen)},[enabled,wide,screen])
}
