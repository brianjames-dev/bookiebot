import React,{createContext,useContext,useLayoutEffect,useRef,useState} from 'react'

export type ChangeTiming={rollDuration:number;strikeDelay:number;strikeDuration:number;strikeHold:number;fadeDuration:number}
export type ChangePlan={token:number;from:Record<string,string>;to:Record<string,string>;fromColors:Record<string,string>;toColors:Record<string,string>;timing:ChangeTiming;promises:Set<Promise<unknown>>}
export const ChangeMotionContext=createContext<ChangePlan|null>(null)
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
function values(value:string,key:string,plan:ChangePlan|null){return{before:plan?.from[key]??value,after:plan?.to[key]??value}}

function targetTextSize(el:HTMLElement,key:string,plan:ChangePlan){
 const row=el.closest<HTMLElement>('.bb-daily-transaction,.sp-summary')!,clone=row.cloneNode(true) as HTMLElement
 // Measure the final text in the actual row/flex/grid context. A metadata
 // item's current width is its old intrinsic width, not its available width.
 clone.style.cssText=`position:absolute;left:0;top:0;width:${row.getBoundingClientRect().width}px;visibility:hidden;pointer-events:none;transform:none;transition:none;border-top:${getComputedStyle(row).borderTop}`
 clone.style.opacity='0';clone.inert=true;clone.setAttribute('aria-hidden','true')
 clone.querySelectorAll<HTMLElement>('.bi-text-change').forEach(copy=>{copy.querySelector('.bi-text-layout')!.textContent=plan.to[copy.dataset.changeKey!]||'\u200b'})
 clone.querySelectorAll<HTMLElement>('.bi-money-change').forEach(copy=>copy.replaceWith(document.createTextNode(plan.to[copy.dataset.changeKey!]??copy.dataset.value??'')))
 row.parentElement!.append(clone)
 const rect=clone.querySelector<HTMLElement>(`[data-change-key="${CSS.escape(key)}"]`)!.getBoundingClientRect()
 clone.remove();return{width:rect.width,height:rect.height}
}

export function ChangedText({value,motionKey}:{value:string;motionKey:string}){
 const plan=useContext(ChangeMotionContext),{before,after}=values(value,motionKey,plan),ref=useRef<HTMLSpanElement>(null),[done,setDone]=useState(0)
 const paint=useRef<{token:number;before:string;after:string;fromColor?:string;toColor?:string}|null>(null)
 const moving=!!plan&&before!==after&&done!==plan.token
 const animated=useRef(false)
 if(moving)animated.current=true
 if(!paint.current||(moving&&paint.current.token!==plan!.token)||paint.current.after!==after)paint.current={token:moving?plan!.token:0,before:moving?before:after,after,fromColor:plan?.fromColors[motionKey],toColor:plan?.toColors[motionKey]}
 const scene=paint.current
 useLayoutEffect(()=>{
  const el=ref.current;if(!el||!animated.current)return
  const layout=el.querySelector<HTMLElement>('.bi-text-layout')!,old=el.querySelector<HTMLElement>('.bi-change-old')!,next=el.querySelector<HTMLElement>('.bi-change-new')!
  old.style.opacity='0';next.style.opacity='1'
  // This invisible native layout string is owned by the effect. Visible
  // paint is never replaced, while settled layout remains naturally sized.
  layout.textContent=(plan&&before!==after?before:after)||'\u200b'
  if(!plan||before===after)return
  // A new change starts from the old paint. Settled inline opacity values
  // must not leak from the previous token when the same field is edited again.
  old.style.opacity='1';next.style.opacity='0'
  let live=true;const animations:Animation[]=[],reduced=matchMedia('(prefers-reduced-motion: reduce)').matches
  const work=(async()=>{
   if(!reduced){
    const line=old.querySelector<HTMLElement>('.bi-change-strike')!,timing=plan.timing,fadeAt=timing.strikeDelay+timing.strikeDuration+timing.strikeHold,total=fadeAt+timing.fadeDuration*2
    animations.push(line.animate([{transform:'scaleX(0)'},{transform:'scaleX(1)'}],{duration:timing.strikeDuration,delay:timing.strikeDelay,easing:'cubic-bezier(.2,.7,.3,1)',fill:'both'}))
    animations.push(old.animate([{opacity:1},{opacity:0}],{duration:timing.fadeDuration,delay:fadeAt,easing:'ease-in-out',fill:'both'}))
    animations.push(next.animate([{opacity:0},{opacity:1}],{duration:timing.fadeDuration,delay:fadeAt+timing.fadeDuration,easing:'ease-in-out',fill:'both'}))
    const rect=el.getBoundingClientRect(),from={width:rect.width,height:rect.height},to=targetTextSize(el,motionKey,plan)
    // Each paint layer keeps its own natural line breaks during the fade;
    // only the layout space interpolates, never the glyphs or their scale.
    old.style.width=from.width+'px';old.style.height=from.height+'px'
    next.style.width=to.width+'px';next.style.height=to.height+'px'
    animations.push(el.animate([{width:from.width+'px',height:from.height+'px'},{width:to.width+'px',height:to.height+'px'}],{duration:timing.fadeDuration*2,delay:fadeAt,easing:'ease-in-out',fill:'both'}))
    el.dataset.totalDuration=String(total);await Promise.allSettled(animations.map(a=>a.finished))
   }
   if(live){
    // Commit the paint endpoint BEFORE canceling the fill effects. React's
    // state update can land a frame later; falling back to active CSS here
    // briefly showed old text again, especially without a placement flight.
    old.style.opacity='0';next.style.opacity='1'
    layout.textContent=after||'\u200b';old.style.width=old.style.height=next.style.width=next.style.height=''
    animations.forEach(a=>a.cancel());setDone(plan.token);await frame()
   }
  })();plan.promises.add(work)
  return()=>{live=false;animations.forEach(a=>a.cancel())}
 },[plan?.token,before,after])
 // Retain the actual final paint node after the effect and data commit. The
 // old grid-to-inline renderer swap changed line boxes and glyph placement.
 if(!animated.current)return <span ref={ref} className="bi-text-value">{after}</span>
 return <span ref={ref} className="bi-text-change" data-change-key={motionKey} data-change-state={moving?'text':'settled'}>
  <span className="bi-sr-only">{after}</span>
  <span className="bi-text-layout" aria-hidden="true"/>
  <span className="bi-change-old" aria-hidden="true" style={{color:scene.fromColor}}>{scene.before}<span className="bi-change-strike"/></span>
  <span className="bi-change-new" aria-hidden="true" style={{color:scene.toColor}}>{scene.after}</span>
 </span>
}

function reel(before:string,after:string){
 if(before===after)return[after]
 if(/^[0-9]$/.test(after)){
  const start=/^[0-9]$/.test(before)?Number(before):0,steps=10+(Number(after)-start+10)%10
  return Array.from({length:steps+1},(_,i)=>i===0?before||' ':String((start+i)%10))
 }
 return[before||' ',after||' ']
}
function moneyFrame(before:string,after:string,token:number){
 const prefix=after.match(/^[^\d]+/)?.[0]??'',oldPrefix=before.match(/^[^\d]+/)?.[0]??'',oldBody=before.slice(oldPrefix.length),body=after.slice(prefix.length),count=Math.max(oldBody.length,body.length)
 const previous=oldBody.padStart(count,' ').split(''),next=body.padStart(count,' ').split('')
 return{token,after,prefix,columns:next.map((char,index)=>{const old=previous[index].trim(),current=char.trim();return{place:count-index-1,old,current,digits:reel(old,current)}})}
}
export function ChangedMoney({value,motionKey}:{value:string;motionKey:string}){
 const plan=useContext(ChangeMotionContext),{before,after}=values(value,motionKey,plan),ref=useRef<HTMLSpanElement>(null),[done,setDone]=useState(0),paint=useRef<ReturnType<typeof moneyFrame>|null>(null)
 const moving=!!plan&&before!==after&&done!==plan.token
 const animated=useRef(false)
 if(moving)animated.current=true
 if(!paint.current||(moving&&paint.current.token!==plan!.token)||paint.current.after!==after)paint.current=moneyFrame(moving?before:after,after,moving?plan!.token:0)
 const scene=paint.current
 useLayoutEffect(()=>{
  const el=ref.current;if(!el||!plan||before===after)return
  let live=true;const animations:Animation[]=[],endpoints:Array<()=>void>=[],reduced=matchMedia('(prefers-reduced-motion: reduce)').matches
  const work=(async()=>{
   el.querySelectorAll<HTMLElement>('.bi-reel-window').forEach((window,index)=>{
    // The in-flow layout glyph owns the native baseline. Clipping is on an
    // absolute child so overflow cannot change the inline-block baseline.
    const track=window.querySelector<HTMLElement>('.bi-reel-track')!,final=window.querySelector<HTMLElement>('.bi-reel-final')!,old=window.querySelector<HTMLElement>('[data-measure="old"]')!,next=window.querySelector<HTMLElement>('[data-measure="new"]')!
    const oldWidth=old.getBoundingClientRect().width,newWidth=next.getBoundingClientRect().width,distance=window.getBoundingClientRect().height*track.children.length,end=`translateY(${-distance}px)`,duration=plan.timing.rollDuration,delay=Math.min(120,(scene.columns.length-index-1)*24)
    track.style.transform='translateY(0)';track.style.visibility=track.children.length?'visible':'hidden';final.style.transform=`translateY(${distance}px)`
    // The actual target glyph ends at its own native origin. It never needs
    // a stacked-line offset or a replacement label after the roll finishes.
    endpoints.push(()=>{window.style.width='';track.style.visibility='hidden';final.style.transform='translateY(0)'})
    if(!reduced){
     animations.push(window.animate([{width:oldWidth+'px'},{width:newWidth+'px'}],{duration,delay,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'}))
     if(track.children.length){
      animations.push(track.animate([{transform:'translateY(0)'},{transform:end}],{duration,delay,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'}))
      animations.push(final.animate([{transform:`translateY(${distance}px)`},{transform:'translateY(0)'}],{duration,delay,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'}))
     }
    }
   })
   await Promise.allSettled(animations.map(a=>a.finished))
   if(live){
    // Preserve the exact target glyphs/track/metrics through commit. Never
    // swap the settled reels for a differently shaped plain-text label.
    endpoints.forEach(apply=>apply());animations.forEach(a=>a.cancel());setDone(plan.token);await frame()
   }
  })();plan.promises.add(work)
  return()=>{live=false;animations.forEach(a=>a.cancel())}
 },[plan?.token,before,after])
 // Ordinary rows need one text node, not a reel for every currency glyph.
 // Once used, retain the exact final reels through settling and future edits.
 if(!animated.current)return <span ref={ref} className="bi-money-value">{after}</span>
 return <span ref={ref} className="bi-money-change" data-change-key={motionKey} data-change-state={moving?'money':'settled'} data-value={after}>
  <span className="bi-sr-only">{after}</span>
  <span className="bi-money-prefix" aria-hidden="true">{scene.prefix}</span>{scene.columns.map(column=><span className="bi-reel-window" key={column.place} aria-hidden="true">
   <span className="bi-reel-layout">{column.current||'\u200b'}</span>
   <span className="bi-reel-measure" data-measure="old">{column.old}</span><span className="bi-reel-measure" data-measure="new">{column.current}</span>
   <span className="bi-reel-clip"><span className="bi-reel-track">{column.digits.slice(0,-1).map((digit,i)=><span className="bi-reel-cell" key={i} style={{top:`${i*100}%`}}>{digit}</span>)}</span><span className="bi-reel-cell bi-reel-final">{column.digits[column.digits.length-1]}</span></span>
  </span>)}
 </span>
}

export function ChangedItem({value,motionKey}:{value?:string|null;motionKey:string}){
 const plan=useContext(ChangeMotionContext),{before,after}=values(value??'',motionKey,plan)
 if(!before&&!after)return null
 return <><span aria-hidden="true">·</span><span className="bb-daily-transaction-item"><ChangedText value={value??''} motionKey={motionKey}/></span></>
}
