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
  let running=false,failures=0,retryAt=0
  const failed=()=>{
   failures=Math.min(failures+1,4)
   retryAt=Date.now()+Math.min(60000*2**(failures-1),300000)
  }
  const check=async()=>{
   if(running||current.current.blocked||document.visibilityState!=='visible'||navigator.onLine===false||Date.now()<retryAt)return
   running=true
   try{
    const response=await fetch('/app/account/changes',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
    if(!response.ok){failed();return}
    const {revision,ledgerVersion=''}=await response.json() as {revision:number;ledgerVersion?:string}
    if(controller.signal.aborted||current.current.blocked)return
    if(!Number.isSafeInteger(revision)||revision<0){failed();return}
    const {screen:active,scope:key}=current.current
    const version=String(revision)+':'+ledgerVersion
    if(seen.get(key)===version){failures=0;retryAt=0;return}
    // A first revision of zero is already represented by this screen's initial
    // load. Nonzero cursors may have advanced during that load, so refresh once.
    if(!seen.has(key)&&revision===0&&!ledgerVersion){seen.set(key,version);seen.set('overview',version);failures=0;retryAt=0;return}
    if(seen.get('overview')!==version){
     if(!registry.available('overview'))return
     if(await registry.refresh('overview')===false){failed();return}
     if(controller.signal.aborted)return
     seen.set('overview',version)
    }
    // A draft/navigation change during the report read defers its page refresh.
    if(current.current.blocked||current.current.scope!==key)return
    // Financial changes invalidate Bills/Transfers, not per-phone notification
    // and widget preferences. Those keep their explicit page refresh.
    if(active!=='overview'&&(active!=='settings'||key==='bills'||key==='transfers')){
     if(!registry.available(active))return
     if(await registry.refresh(active)===false){failed();return}
    }
    // Settings' own refresh raises the work guard until React commits its
    // settled state. Acknowledge the successful read independently of that
    // transient flag, or clearing it immediately restarts this same refresh.
    if(!controller.signal.aborted&&current.current.scope===key){seen.set(key,version);failures=0;retryAt=0}
   }catch{if(!controller.signal.aborted)failed()}
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
