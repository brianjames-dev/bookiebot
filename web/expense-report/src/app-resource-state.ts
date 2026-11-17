import {useCallback,useSyncExternalStore} from 'react'

const resetters=new Set<()=>void>()
export const clearAppResources=()=>resetters.forEach(clear=>clear())

/** Owner-scoped, memory-only display state shared by retained app screens. */
export function createAppResource<T>() {
 const values=new Map<string,T>(),listeners=new Map<string,Set<()=>void>>()
 const key=(owner:string)=>owner.trim().toLowerCase()
 resetters.add(()=>{const scopes=[...values.keys()];values.clear();scopes.forEach(scope=>listeners.get(scope)?.forEach(listener=>listener()))})
 return {
  read:(owner:string)=>values.get(key(owner))??null,
  publish(owner:string,value:T){const scope=key(owner);if(values.get(scope)===value)return;values.set(scope,value);listeners.get(scope)?.forEach(listener=>listener())},
  clear(owner:string){const scope=key(owner);if(values.delete(scope))listeners.get(scope)?.forEach(listener=>listener())},
  subscribe(owner:string,listener:()=>void){const scope=key(owner),set=listeners.get(scope)??new Set<()=>void>();set.add(listener);listeners.set(scope,set);return()=>{set.delete(listener);if(!set.size)listeners.delete(scope)}},
 }
}
export function useAppResource<T>(resource:ReturnType<typeof createAppResource<T>>,owner:string){
 const subscribe=useCallback((listener:()=>void)=>resource.subscribe(owner,listener),[resource,owner])
 const read=useCallback(()=>resource.read(owner),[resource,owner])
 return useSyncExternalStore(subscribe,read,read)
}
