import {useLayoutEffect,useRef,type ReactNode} from 'react'

export function StepMotion({review,open,mode,duration,edit,confirm}:{review:boolean;open:boolean;mode:string;duration:number;edit:ReactNode;confirm:ReactNode}){
 const frame=useRef<HTMLDivElement>(null),editRef=useRef<HTMLDivElement>(null),reviewRef=useRef<HTMLDivElement>(null)
 const state=useRef({initialized:false,open,target:review?1:0,running:false,generation:0,width:0,height:0,animations:[] as Animation[],settle:()=>{},resize:()=>{}})
 useLayoutEffect(()=>{
  const box=frame.current!,panes=[editRef.current!,reviewRef.current!],s=state.current,target=review?1:0
  const snapshots=panes.map(pane=>{const css=getComputedStyle(pane);return{transform:css.transform,opacity:css.opacity,visible:css.visibility!=='hidden'}})
  const oldHeight=box.getBoundingClientRect().height,changed=s.initialized&&target!==s.target&&open&&s.open
  const generation=++s.generation
  s.animations.forEach(animation=>animation.cancel());s.animations=[]
  s.target=target;s.open=open;s.width=box.getBoundingClientRect().width
  const settle=()=>{s.running=false;box.dataset.moving='false';s.height=panes[s.target].offsetHeight;box.style.height=s.height+'px';panes.forEach((pane,index)=>{pane.style.visibility=index===s.target?'visible':'hidden';pane.style.transform='none';pane.style.opacity='1';pane.style.zIndex=index===s.target?'2':'1'})}
  s.settle=()=>{++s.generation;s.animations.forEach(animation=>animation.cancel());s.animations=[];settle()}
  if(!changed||matchMedia('(prefers-reduced-motion: reduce)').matches||!s.width){s.initialized=true;settle();return}
  s.initialized=true;s.running=true;box.dataset.moving='true'
  const forward=target===1,direction=forward?1:-1,incoming=panes[target],outgoing=panes[1-target],height=incoming.offsetHeight,easing='cubic-bezier(.22,.8,.25,1)'
  panes.forEach((pane,index)=>{pane.style.visibility='visible';pane.style.zIndex=index===target?'2':'1';pane.style.transform=snapshots[index].transform;pane.style.opacity=snapshots[index].opacity})
  const from=snapshots[target].visible?snapshots[target]:{transform:`translate3d(${direction*s.width}px,0,0)`,opacity:'1'}
  const to=`translate3d(${-direction*s.width}px,0,0)`
  const options:KeyframeAnimationOptions={duration,easing,fill:'both'}
  const animate=(element:HTMLElement,frames:Keyframe[],extra:KeyframeAnimationOptions={})=>{const animation=element.animate(frames,{...options,...extra});s.animations.push(animation);return animation}
  s.height=height
  const finishAt=performance.now()+duration
  let heightAnimation=animate(box,[{height:oldHeight+'px'},{height:height+'px'}])
  // Nested editors can finish measuring after their parent starts sliding.
  // Retarget only the height, from its current presentation value, so the
  // incoming surface never snaps to its measured height at the slide's end.
  s.resize=()=>{const next=panes[s.target].offsetHeight;if(Math.abs(next-s.height)<=.5)return;const current=box.getBoundingClientRect().height;s.height=next;heightAnimation.cancel();heightAnimation=animate(box,[{height:current+'px'},{height:next+'px'}],{duration:Math.max(0,finishAt-performance.now())})}
  animate(outgoing,[{transform:snapshots[1-target].transform,opacity:snapshots[1-target].opacity},{transform:to,opacity:1}])
  animate(incoming,[{transform:from.transform,opacity:from.opacity},{transform:'none',opacity:1}])
  // Commit only the most recent transition. Rapid reversals start from the
  // current presentation values, rather than restarting at a scene endpoint.
  Promise.allSettled(s.animations.map(animation=>animation.finished)).then(()=>{if(s.generation!==generation)return;s.animations.forEach(animation=>animation.cancel());s.animations=[];settle()})
 },[review,open,mode,duration])
 useLayoutEffect(()=>{
  const s=state.current,box=frame.current!,panes=[editRef.current!,reviewRef.current!]
  let pending=0
  const observer=new ResizeObserver(entries=>{
   const width=box.getBoundingClientRect().width,widthChanged=width>0&&Math.abs(width-s.width)>.5
   const heightChanged=Math.abs(panes[s.target].offsetHeight-s.height)>.5
   if((s.running&&!widthChanged&&!heightChanged)||(!widthChanged&&!entries.some(entry=>entry.target!==box)))return
   cancelAnimationFrame(pending)
   // Defer writes out of ResizeObserver delivery. Height animation frames
   // alone do not schedule this path or feed the observer back into itself.
   pending=requestAnimationFrame(()=>{const width=box.getBoundingClientRect().width;if(s.running){if(width>0&&Math.abs(width-s.width)>.5)s.settle();else s.resize();return}if(width>0){s.width=width;s.height=panes[s.target].offsetHeight;if(Math.abs(box.getBoundingClientRect().height-s.height)>.5)box.style.height=s.height+'px'}})
  })
  panes.forEach(pane=>observer.observe(pane));observer.observe(box)
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),onReduced=()=>{if(reduced.matches)s.settle()};reduced.addEventListener('change',onReduced)
  return()=>{observer.disconnect();cancelAnimationFrame(pending);reduced.removeEventListener('change',onReduced);++s.generation;s.animations.forEach(animation=>animation.cancel())}
 },[])
 return <div className="bi-step-viewport" data-mode={mode} ref={frame}><div ref={editRef} className="bi-step-pane bi-step-edit" data-scene="edit" aria-hidden={review} inert={review}>{edit}</div><div ref={reviewRef} className="bi-step-pane bi-step-review" data-scene="review" aria-hidden={!review} inert={!review}>{confirm}</div></div>
}
