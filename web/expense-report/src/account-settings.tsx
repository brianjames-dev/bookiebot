import { useEffect, useRef, useState } from "react"
import { useAppWorkGuard, useAppWorkStatus } from "./app-work-guard"

interface AccountProfile {id:string;name:string;googleEnabled:boolean;google:{connected:boolean;email:string|null}}

export function GoogleSignInButton({link = false, disabled = false}: {link?:boolean;disabled?:boolean}) {
  const guard = useAppWorkGuard()
  const [busy,setBusy] = useState(false), [error,setError] = useState("")
  const inflight = useRef(false)
  const updateWork = useAppWorkStatus({label:"Google sign-in",pending:busy})
  const start = async () => {
    if (inflight.current) return
    inflight.current = true; setBusy(true); setError("")
    try {
      const response = await fetch('/app/auth/google/start', {method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',mode:'same-origin',redirect:'error',
        headers:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:JSON.stringify({action:link?'link':'login'})})
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not start Google sign-in.')
      const url = new URL(result.url)
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Could not start Google sign-in.')
      // The start request is complete. Release its own work guard before the
      // deliberate navigation; financial drafts were handled by requestAction.
      updateWork({label:'Google sign-in',pending:false});setBusy(false)
      window.location.assign(url.href)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start Google sign-in. Try again.')
      inflight.current = false; setBusy(false)
    }
  }
  return <>
    <button type="button" className="bb-settings-action bb-google-sign-in" disabled={disabled || busy || guard.pending || guard.uncertain}
      onClick={() => guard.requestAction({kind:'signin',onProceed:start})}>{busy?'Connecting…':link?'Link Google account':'Continue with Google'}</button>
    {error && <p className="bb-settings-note" role="alert">{error}</p>}
  </>
}

export function AccountIdentity({active,ownerName}: {active:boolean;ownerName:string}) {
  const [profile,setProfile] = useState<AccountProfile|null>(null), [error,setError] = useState('')
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void fetch('/app/account',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
      if (!response.ok) throw new Error('Couldn’t load your sign-in settings.')
      const data = await response.json() as AccountProfile
      if (data.name?.toLowerCase() !== ownerName.toLowerCase()) throw new Error('Your BookieBot account changed. Reopen the app.')
      if (!controller.signal.aborted) {setProfile(data);setError('')}
    }).catch(()=>{if(!controller.signal.aborted)setError('Couldn’t load your sign-in settings. Reopen Settings to retry.')})
    return ()=>controller.abort()
  },[active,ownerName])
  return <>
    <div className="bb-setting-row"><span>Signed in as</span><strong>{profile?.name ?? ownerName}</strong></div>
    {profile?.google.connected ? <div className="bb-setting-row"><span>Google account</span><span className="bb-account-email">{profile.google.email}</span></div>
      : profile?.googleEnabled ? <GoogleSignInButton link/> : profile && <p className="bb-settings-note">Google sign-in setup pending.</p>}
    {error && <p className="bb-settings-note" role="status">{error}</p>}
  </>
}

export function GoogleLogin() {
  const [enabled,setEnabled] = useState(false)
  useEffect(()=>{
    const controller=new AbortController()
    void fetch('/app/auth/options',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(response=>response.ok?response.json():null).then(value=>{if(!controller.signal.aborted)setEnabled(value?.googleEnabled===true)}).catch(()=>{})
    return ()=>controller.abort()
  },[])
  return enabled ? <div className="bb-google-login"><GoogleSignInButton/><p>Use the Google account linked in BookieBot Settings.</p></div> : null
}

export function AuthFeedback() {
  const [message,setMessage] = useState(()=>{
    const url = new URL(window.location.href), result=url.searchParams.get('auth')
    if (!result) return ''
    return result==='linked'?'Google account linked.':result==='signed-in'?'Signed in with Google.':result==='link-required'
      ?'Use your connected BookieBot app to link this Google account in Settings.':'Google sign-in wasn’t completed. Try again.'
  })
  useEffect(()=>{
    const url = new URL(window.location.href)
    if (!url.searchParams.has('auth')) return
    url.searchParams.delete('auth');window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash)
  },[])
  return message ? <div className="bb-auth-feedback" role="status"><span>{message}</span><button type="button" aria-label="Dismiss sign-in message" onClick={()=>setMessage('')}>×</button></div> : null
}
