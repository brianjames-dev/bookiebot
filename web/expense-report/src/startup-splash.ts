import {useEffect} from 'react'

/** The server-painted ring survives bootstrap and provider changes until ready. */
export function finishStartupSplash(){
 if(typeof document==='undefined')return
 const splash=document.getElementById?.('bookiebot-startup-splash')
 if(!splash||splash.dataset.leaving)return
 splash.dataset.leaving='true'
 splash.setAttribute('aria-hidden','true')
 const root=document.getElementById('bookiebot-expense-report-root')
 root?.removeAttribute('inert');root?.removeAttribute('aria-hidden')
 const remove=()=>{window.clearTimeout(timer);splash.removeEventListener('transitionend',ended);splash.remove()}
 const ended=(event:TransitionEvent)=>{if(event.target===splash&&event.propertyName==='opacity')remove()}
 const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
 const timer=window.setTimeout(remove,reduced?0:360)
 splash.addEventListener('transitionend',ended)
}
export function useStartupSplash(ready:boolean){useEffect(()=>{if(ready)finishStartupSplash()},[ready])}
