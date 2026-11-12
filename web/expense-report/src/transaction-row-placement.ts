import {transactionCategory} from './transaction-identity'
import {recordedDays} from './recorded-transaction-view'
import type {RecordedTransaction} from './transactions-screen'

export type PlacementTiming={reorderLift:number;reorderGap:number;reorderTravel:number;reorderLand:number;reorderHeight:number;reorderSpace:number}
type Bounds={x:number;y:number;width:number;height:number}
export type Placement={group:HTMLElement;id:string;before:Map<string,Bounds>;timing:PlacementTiming}
const collator=new Intl.Collator('en-US',{sensitivity:'base'})
const bounds=(node:HTMLElement,origin:DOMRect):Bounds=>{const rect=node.getBoundingClientRect();return{x:rect.left-origin.left,y:rect.top-origin.top,width:rect.width,height:rect.height}}
const rows=(group:HTMLElement)=>[...group.querySelectorAll<HTMLElement>('.bi-selected-row[data-entry-id]')]

// Read the old presentation only after every value effect has settled. A
// closed day, unchanged sort position, or deletion needs no placement flight.
export function preparePlacement(product:HTMLElement|null,id:string,after:RecordedTransaction[],timing:PlacementTiming,previousId=id):Placement|null{
 if(!product||matchMedia('(prefers-reduced-motion: reduce)').matches)return null
 const row=product.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(previousId)}"]`),group=row?.closest<HTMLElement>('.bb-daily-day-group')
 if(!group||group.querySelector('.bb-daily-day-header')?.getAttribute('aria-expanded')!=='true'||group.dataset.moving==='true')return null
 const current=rows(group),next=recordedDays(after,[],after[0]?.month??'all').find(day=>day.entries.some(entry=>entry.id===id))
 if(!next||next.entries.length!==current.length||!next.entries.some(entry=>entry.id===id))return null
 const order=next.entries.map((entry,index)=>({entry,index,label:transactionCategory(entry).label})).sort((a,b)=>collator.compare(a.label,b.label)||a.index-b.index).map(({entry})=>entry.id)
 const presentationId=(node:HTMLElement)=>node.dataset.entryId===previousId?id:node.dataset.entryId!
 // A fresh Undo read may also replace neighboring manual-sheet identities.
 // Animate placement only when every destination has a captured origin.
 const known=new Set(current.map(presentationId))
 if(order.some(entry=>!known.has(entry!)))return null
 if(order.every((entry,index)=>entry===presentationId(current[index])))return null
 const origin=group.getBoundingClientRect(),before=new Map(current.map(node=>[presentationId(node),bounds(node,origin)]))
 // The native day scene still owns each bead's resting pose. Only the outer
 // row and its existing icon viewport receive temporary layout offsets.
 group.dataset.rowReordering='true'
 return{group,id,before,timing:{...timing}}
}

export function playPlacement(scene:Placement){
 const{group,id,before,timing}=scene,origin=group.getBoundingClientRect(),current=rows(group),selectedIndex=current.findIndex(row=>row.dataset.entryId===id)
 const layer=group.querySelector<HTMLElement>('.bb-daily-icon-layer')!,animations=new Set<Animation>(),restores:(()=>void)[]=[]
 let live=true,resolve!:()=>void
 const finished=new Promise<void>(done=>{resolve=done})
 const mark=(name:string)=>{group.dataset.placementStage=name}
 function temporary(node:HTMLElement,property:string,value:string){const old=node.style.getPropertyValue(property);node.style.setProperty(property,value);restores.push(()=>old?node.style.setProperty(property,old):node.style.removeProperty(property))}
 const subjects=current.map((row,index)=>{
  const old=before.get(row.dataset.entryId!)!,final=bounds(row,origin),viewport=layer.querySelector<HTMLElement>(`.bb-daily-bead[data-entry="${index}"]`)?.parentElement
  const shell=row.closest<HTMLElement>('.bb-daily-row-shell')!
  const selected=index===selectedIndex,dx=old.x-final.x,dy=old.y-final.y
  temporary(shell,'z-index',selected?'12':'0')
  temporary(shell,'position','relative')
  // Relative layout offsets keep text on the normal paint path. Even a
  // translation-only accelerated transform can resample a cached text layer.
  temporary(row,'will-change','auto')
  const nativeRow=row.querySelector<HTMLElement>('.bb-daily-transaction')!
  temporary(nativeRow,'transform','none');temporary(nativeRow,'will-change','auto')
  row.dataset.placementRow=selected?'lifted':'neighbor'
  if(viewport){temporary(viewport,'z-index',selected?'13':'3');temporary(viewport,'width','100%');temporary(viewport,'height','100%');temporary(viewport,'right','auto');temporary(viewport,'bottom','auto');temporary(viewport,'will-change','auto')}
  const targets=viewport?[row,viewport]:[row]
  const pose=(x:number,y:number)=>({left:`${x}px`,top:`${y}px`})
  const start=pose(dx,dy),lifted=pose(dx+4,dy-timing.reorderHeight),hover=pose(4,-timing.reorderHeight)
  const spread=index===selectedIndex-1?-timing.reorderSpace:index===selectedIndex+1?timing.reorderSpace:0
  targets.forEach(target=>{temporary(target,'left',start.left);temporary(target,'top',start.top)})
  return{row,targets,selected,start,lifted,hover,spread,pose}
 })
 const selected=subjects.find(subject=>subject.selected)!
 // An opaque, very lightly lifted surface keeps passing rows underneath the
 // whole purchase. Its persistent logo sits one level above that same row.
 // A compact ink contact shadow gives depth in both themes. Foreground ink
 // becomes white in dark mode and made the previous broad shadow a glow.
 const shadow='0 3px 8px -3px light-dark(hsl(150 24% 8% / .18), hsl(150 30% 2% / .42))'
 temporary(selected.row,'border-radius','8px')
 temporary(selected.row,'box-shadow','none')
 function cleanup(){
  if(!live)return;live=false
  animations.forEach(animation=>animation.cancel());animations.clear()
  restores.reverse().forEach(restore=>restore())
  subjects.forEach(({row})=>delete row.dataset.placementRow)
  delete group.dataset.rowReordering;delete group.dataset.placementStage
  observer.disconnect();reduced.removeEventListener('change',onReduced)
  resolve()
 }
 const width=origin.width
 const observer=new ResizeObserver(()=>{if(Math.abs(group.getBoundingClientRect().width-width)>.5)cleanup()})
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),onReduced=()=>{if(reduced.matches)cleanup()}
 observer.observe(group);reduced.addEventListener('change',onReduced)
 async function stage(name:string,duration:number,work:()=>Animation[]){
  if(!live)return
  mark(name)
  const jobs=work();jobs.forEach(animation=>animations.add(animation))
  await Promise.allSettled(jobs.map(animation=>animation.finished))
  if(!live)return
  jobs.forEach(animation=>{
   const effect=animation.effect as KeyframeEffect,target=effect.target as HTMLElement,frames=effect.getKeyframes(),last=frames[frames.length-1]
   for(const key of['left','top','boxShadow'])if(last[key]!==undefined)(target.style as any)[key]=String(last[key])
   animation.cancel();animations.delete(animation)
  })
 }
 const animate=(target:HTMLElement,frames:Keyframe[],duration:number,easing='cubic-bezier(.22,.8,.25,1)')=>target.animate(frames,{duration,easing,fill:'both'})
 const offsets=(subject:typeof selected,from:{left:string;top:string},to:{left:string;top:string},duration:number)=>subject.targets.map(target=>animate(target,[from,to],duration))
 void(async()=>{
  try{
   await stage('lift',timing.reorderLift,()=>[...offsets(selected,selected.start,selected.lifted,timing.reorderLift),animate(selected.row,[{boxShadow:'none'},{boxShadow:shadow}],timing.reorderLift)])
   if(!live)return
   await stage('make-room',timing.reorderGap,()=>subjects.filter(subject=>!subject.selected).flatMap(subject=>offsets(subject,subject.start,subject.pose(0,subject.spread),timing.reorderGap)))
   if(!live)return
   await stage('travel',timing.reorderTravel,()=>offsets(selected,selected.lifted,selected.hover,timing.reorderTravel))
   if(!live)return
   await stage('land',timing.reorderLand,()=>[
    ...selected.targets.map(target=>animate(target,[{...selected.hover,offset:0,easing:'cubic-bezier(.35,0,.7,1)'},{...selected.pose(0,1.1),offset:.58,easing:'ease-out'},{...selected.pose(0,-.3),offset:.82},{...selected.pose(0,0),offset:1}],timing.reorderLand,'linear')),
    animate(selected.row,[{boxShadow:shadow},{boxShadow:'none'}],timing.reorderLand),
    ...subjects.filter(subject=>!subject.selected&&subject.spread).flatMap(subject=>offsets(subject,subject.pose(0,subject.spread),subject.pose(0,0),timing.reorderLand)),
   ])
  }finally{cleanup()}
 })()
 return{finished,finish:cleanup}
}

export function discardPlacement(scene:Placement|null){if(!scene)return;delete scene.group.dataset.rowReordering;delete scene.group.dataset.placementStage}
