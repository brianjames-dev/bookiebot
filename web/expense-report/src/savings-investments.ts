import {useCallback,useEffect,useRef,useState} from 'react'
import {usePageRefresh} from './page-refresh'
import type {ExpenseReportData} from './types'
const monthOf=(report:ExpenseReportData)=>`${report.year}-${String(report.month).padStart(2,'0')}`
/** Savings is lifetime/current; a historical Overview month cannot date its investments. */
export function useSavingsInvestments(report:ExpenseReportData,ready:boolean,active:boolean){
 const month=new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'}).slice(0,7)
 const[saved,setSaved]=useState<{month:string;owner:string;report:ExpenseReportData}|null>(null)
 const inFlight=useRef<Promise<boolean>|null>(null),fresh=useRef(0),epoch=useRef(0)
 const direct=ready&&monthOf(report)===month
 const load=useCallback(()=>{if(direct)return Promise.resolve(true);if(inFlight.current)return inFlight.current;const generation=epoch.current,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000)
 const work=fetch('/app/expenses/data',{credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',redirect:'error',signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('Unavailable');const value=await response.json() as ExpenseReportData;if(generation===epoch.current&&value.ownerName===report.ownerName&&monthOf(value)===month){setSaved({owner:report.ownerName,month,report:value});fresh.current=Date.now();return true}return false}).catch(()=>false).finally(()=>{clearTimeout(timer);if(inFlight.current===work)inFlight.current=null});inFlight.current=work;return work
 },[direct,month,report.ownerName])
 usePageRefresh('savings',{refresh:load})
 useEffect(()=>{epoch.current++;inFlight.current=null;fresh.current=0;return()=>{epoch.current++}},[report.ownerName,month])
 useEffect(()=>{if(direct){setSaved({owner:report.ownerName,month,report});fresh.current=Date.now()}},[direct,month,report])
 useEffect(()=>{if(active&&!direct&&(!saved||Date.now()-fresh.current>30000))void load();const refresh=()=>{if(active&&!direct&&document.visibilityState==='visible'&&Date.now()-fresh.current>30000)void load()};window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}},[active,direct,load,saved])
 return direct?report:saved?.owner===report.ownerName&&saved.month===month?saved.report:null
}
