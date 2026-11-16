import {ReportLoading} from "./report-loading"
import {useCallback,useEffect,useState} from 'react'
import {ChevronRight} from 'lucide-react'
import {api,useReview,ReviewPanel} from './onboarding-review'
import {useAppWorkStatus} from './app-work-guard'

type HouseholdProfile={account:{id:string;name:string};provider:string;household:null|{name:string;role:string;members:{id:string;name:string;provider:string}[]}}
function savedInvite(){try{return sessionStorage.getItem('bookiebot:household-invite')||''}catch{return ''}}
function token(value:string){try{return new URLSearchParams(new URL(value).hash.slice(1)).get('invite')||value.trim()}catch{return value.trim()}}

export function HouseholdSettings({active}:{active:boolean}){
  const [profile,setProfile]=useState<HouseholdProfile|null>(null),[error,setError]=useState('')
  const load=useCallback(async()=>{try{const value=await api<HouseholdProfile>('/app/household');setProfile(value);setError('')}catch(e){setError((e as Error).message)}},[])
  useEffect(()=>{if(!active)return;const controller=new AbortController();void api<HouseholdProfile>('/app/household',undefined,controller.signal).then(value=>{if(!controller.signal.aborted){setProfile(value);setError('')}}).catch(e=>{if(!controller.signal.aborted)setError(e.message)});return()=>controller.abort()},[active])
  return <section className="bb-settings-section" aria-label="Household settings"><h2>Household</h2>
    {profile?<HouseholdContent key={profile.account.id} profile={profile} reload={load}/>:error?<p className="bb-settings-note" role="alert">{error}</p>:<ReportLoading label="Loading household…"/>}
    {error&&profile&&<p className="bb-settings-note" role="alert">{error}</p>}
  </section>
}

function HouseholdContent({profile,reload}:{profile:HouseholdProfile;reload:()=>Promise<void>}){
  const [mode,setMode]=useState<'create'|'join'|null>(()=>savedInvite()?'join':null),[name,setName]=useState('Our household'),[invite,setInvite]=useState(savedInvite),[link,setLink]=useState(''),[error,setError]=useState(''),[issuing,setIssuing]=useState(false)
  const flow=useReview(profile.account.id,async()=>{setMode(null);try{sessionStorage.removeItem('bookiebot:household-invite')}catch{/* Membership is already saved. */}await reload()},'/app/household')
  useAppWorkStatus({label:'Household invitation',pending:issuing,dirty:Boolean(mode),onDiscard:()=>setMode(null)})
  const locked=flow.busy||flow.uncertain||issuing
  if(profile.household)return <>
    <div className="bb-setting-row"><strong>{profile.household.name}</strong><span>{profile.household.members.length} members</span></div>
    {profile.household.members.map(member=><div className="bb-setting-row" key={member.id}><span>{member.name}{member.id===profile.account.id?' · You':''}</span><span>{member.provider==='sheets'?'Connected workbook':'BookieBot budget'}</span></div>)}
    {profile.household.role==='owner'&&<button className="bb-settings-action bb-account-action" disabled={locked} onClick={()=>{setIssuing(true);setError('');void api<{token:string}>('/app/household/invite',{accountId:profile.account.id}).then(value=>setLink(`${location.origin}/app/expenses#invite=${value.token}`)).catch(e=>setError(e.message)).finally(()=>setIssuing(false))}}><span>{issuing?'Creating invitation…':'Invite a household member'}</span><ChevronRight aria-hidden="true"/></button>}
    {link&&<label className="bb-managed-invite">Invitation · valid for 7 days<input aria-label="Household invitation" readOnly value={link} onFocus={e=>e.target.select()}/><p className="bb-settings-note">Share privately. Creating another invitation replaces this one.</p></label>}
    <p className="bb-settings-note">Your connected budget and financial history stay in place. Joining a household doesn’t share private transactions or change existing splits.</p>
    {error&&<p role="alert" className="bb-settings-note">{error}</p>}
    {flow.error&&<p role="alert" className="bb-settings-note">{flow.error}</p>}{flow.uncertain&&!flow.review&&<button className="bb-settings-action" disabled={flow.busy} onClick={flow.check}>Check last confirmation</button>}
  </>
  return <>
    {!mode&&!flow.review?<><p className="bb-settings-note">Create or join a household while keeping your connected budget.</p>
      <button className="bb-settings-action bb-account-action" onClick={()=>setMode('create')}><span>Create household</span><ChevronRight aria-hidden="true"/></button>
      <button className="bb-settings-action bb-account-action" onClick={()=>setMode('join')}><span>Join household</span><ChevronRight aria-hidden="true"/></button></>
      :<ReviewPanel flow={flow}><form className="bi-fields" onSubmit={e=>{e.preventDefault();void flow.prepare(mode==='join'?{operation:'join',invite:token(invite)}:{operation:'create',name})}}>
        <h2>{mode==='join'?'Join household':'Create household'}</h2><label>{mode==='join'?'Invitation link or code':'Household name'}<input aria-label={mode==='join'?'Invitation link or code':'Household name'} maxLength={mode==='join'?512:60} required value={mode==='join'?invite:name} onChange={e=>mode==='join'?setInvite(e.target.value):setName(e.target.value)}/></label>
        <p className="bi-footnote">Keep your existing budget, bills, transactions and reimbursement history.</p><footer className="bi-editor-footer"><button className="bi-cancel" type="button" disabled={locked} onClick={()=>setMode(null)}>Cancel</button><button className="bi-primary" disabled={locked}>Review</button></footer>
      </form></ReviewPanel>}
  </>
}
