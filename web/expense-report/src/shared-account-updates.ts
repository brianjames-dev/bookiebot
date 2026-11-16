import {useEffect,useRef} from 'react'
import type {AppScreen} from './app-navigation'
import {usePageRefreshRegistry} from './page-refresh'

/** Invalidate visible read models without replacing an open financial draft.
 * Each screen keeps its own cursor so visiting a previously mounted tab still
 * catches up after another person changes a shared bill or repayment. */
export function useSharedAccountUpdates({owner,screen,scope,enabled,blocked}:{owner:string;screen:AppScreen;scope:string;enabled:boolean;blocked:boolean}){
 const registry=usePageRefreshRegistry(),current=useRef({screen,scope,blocked})
 const checker=useRef(()=>{})
 current.current={screen,scope,blocked}
 useEffect(()=>{
  if(!enabled||!registry)return
  const seen=new Map<string,string>(),controller=new AbortController()
  let running=false
  const check=async()=>{
   if(running||current.current.blocked||document.visibilityState!=='visible'||navigator.onLine===false)return
   running=true
   try{
    const response=await fetch('/app/account/changes',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
    if(!response.ok)return
    const {revision,ledgerVersion=''}=await response.json() as {revision:number;ledgerVersion?:string}
    if(!Number.isSafeInteger(revision)||revision<0||controller.signal.aborted||current.current.blocked)return
    const {screen:active,scope:key}=current.current
    const version=String(revision)+':'+ledgerVersion
    if(seen.get(key)===version)return
    // A first revision of zero is already represented by this screen's initial
    // load. Nonzero cursors may have advanced during that load, so refresh once.
    if(!seen.has(key)&&revision===0&&!ledgerVersion){seen.set(key,version);return}
    if(!registry.available('overview'))return
    if(await registry.refresh('overview')===false)return
    if(active!=='overview'&&registry.available(active)&&await registry.refresh(active)===false)return
    if(!controller.signal.aborted&&!current.current.blocked&&current.current.scope===key)seen.set(key,version)
   }catch{/* Focus and pull-to-refresh remain available when offline. */}
   finally{running=false}
  }
  const interval=window.setInterval(()=>void check(),20000)
  const focus=()=>void check()
  checker.current=focus
  window.addEventListener('focus',focus);window.addEventListener('online',focus);document.addEventListener('visibilitychange',focus)
  void check()
  return()=>{controller.abort();checker.current=()=>{};window.clearInterval(interval);window.removeEventListener('focus',focus);window.removeEventListener('online',focus);document.removeEventListener('visibilitychange',focus)}
 },[owner,enabled,registry])
 useEffect(()=>{if(enabled&&!blocked)checker.current()},[scope,enabled,blocked])
}
