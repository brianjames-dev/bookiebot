import {useEffect,useState} from 'react'
import {Copy} from 'lucide-react'
import {displayReport} from './display-diagnostics'

export function DisplayReport({version}:{version:string}) {
  const [copied,setCopied]=useState(false),[fallback,setFallback]=useState('')
  useEffect(()=>{if(!copied)return;const timer=window.setTimeout(()=>setCopied(false),3000);return()=>window.clearTimeout(timer)},[copied])
  const copy=async()=>{
    const report=displayReport(version)
    try{
      if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable')
      await navigator.clipboard.writeText(report);setFallback('');setCopied(true)
    }catch{setCopied(false);setFallback(report)}
  }
  return <>
    <button type="button" className="bb-settings-action bb-account-action" onClick={()=>void copy()}><span>Copy display report</span><Copy aria-hidden="true"/></button>
    {copied&&<p className="bb-settings-note" role="status">Display report copied.</p>}
    {fallback&&<div className="bb-settings-note"><p>Select and copy the report below.</p><textarea className="bb-display-report-fallback" aria-label="Display report" readOnly rows={4} value={fallback} onFocus={event=>event.currentTarget.select()}/></div>}
  </>
}
