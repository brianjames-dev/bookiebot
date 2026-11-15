import {useCallback,useEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,ArrowRightLeft,ChevronDown,ChevronRight,Plus,RefreshCw,Trash2} from 'lucide-react'
import {useAppNavigation} from './app-navigation'
import {useAppWorkGuard,useAppWorkStatus} from './app-work-guard'
import {BillEditorWorkspace} from './bill-editor-workspace'
import {EditorScenes} from './transaction-editor-workspace'
import {StepMotion} from './transaction-step-motion'
import {transactionMotion} from './transaction-inline-editor'
import {CategoryFilterControl} from './category-filter-control'
import {usePageRefresh,usePageRefreshRegistry} from './page-refresh'
import './bill-settings.css'
import './savings-transfers.css'

type Frequency='once'|'monthly'|'quarterly'|'yearly'
type Transfer={id:string;revision:number;name:string;amountCents:number;frequency:Frequency;startsOn:string;effectiveFrom:string;goalId:string;goalName?:string;fromAccount:string;toAccount:string;active:boolean;nextDate:string|null}
type Command=Record<string,unknown>&{operation:string;requestId?:string;reviewVersion?:string}
type Snapshot={ownerName:string;today:string;year:number;settingsVersion:string;transfers:Transfer[];goals:{id:string;name:string;archived:boolean}[];pendingCommand?:Command;blockedReason?:string}
type Form={name:string;amount:string;frequency:Frequency;startsOn:string;goalId:string;fromAccount:string;toAccount:string}
type Review={operation:string;effectiveFrom:string;reviewVersion:string;before:Transfer|null;after:Transfer}
type Draft={form:Form;review:Review|null;body:Command|null;draftId:string}
const frequencyLabel={once:'One time',monthly:'Monthly',quarterly:'Quarterly',yearly:'Yearly'}
const money=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100)
const dateLabel=(value:string)=>new Date(value+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
const tomorrow=(value:string)=>{const day=new Date(value+'T12:00:00');day.setDate(day.getDate()+1);return `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`}
class TransferError extends Error {constructor(message:string,public status:number){super(message)}}
async function request(path:string,body?:unknown,signal?:AbortSignal){
 const controller=new AbortController(),cancel=()=>controller.abort();let timedOut=false
 if(signal?.aborted)cancel();signal?.addEventListener('abort',cancel,{once:true})
 const timer=window.setTimeout(()=>{timedOut=true;controller.abort()},30_000)
 try{const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',headers:{'X-BookieBot-App':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:controller.signal});const data=await response.json();if(!response.ok)throw new TransferError(data.error||'Could not verify transfers.',response.status);return data}
 catch(error){if(timedOut)throw new TransferError('Transfers took too long. Check saved status before repeating a change.',0);throw error}
 finally{window.clearTimeout(timer);signal?.removeEventListener('abort',cancel)}
}

export function SavingsTransfers({active,ownerName}:{active:boolean;ownerName:string}){
 const wide=useAppNavigation()?.duoLandscape===true,guard=useAppWorkGuard(),registry=usePageRefreshRegistry()
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[filter,setFilter]=useState('active'),[selected,setSelected]=useState<Transfer|null>(null)
 const [form,setForm]=useState<Form|null>(null),[review,setReview]=useState<Review|null>(null),[body,setBody]=useState<Command|null>(null)
 const [pending,setPending]=useState<Command|null>(null),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(''),[confirmReady,setConfirmReady]=useState(false),[anchors,setAnchors]=useState<string[]>([])
 const [queued,setQueued]=useState(false)
 const alive=useRef(true),flight=useRef(false),abort=useRef<AbortController|null>(null),generation=useRef(0),draftId=useRef(''),order=useRef<string[]|null>(null),drafts=useRef(new Map<string,Draft>())
 const key=`bookiebot:transfer-request:${ownerName.toLowerCase()}`
 const close=()=>{setForm(null);setReview(null);setBody(null);setSelected(null);drafts.current.clear();setError('')}
 const updateWork=useAppWorkStatus({label:'Savings transfers',pending:busy,uncertain:Boolean(pending),dirty:Boolean(form),onDiscard:close})
 const locked=busy||Boolean(pending)||guard.pending||guard.uncertain||Boolean(snapshot?.blockedReason)
 const load=useCallback(async()=>{
  const token=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('')
  try{const data=await request('/app/transfers',undefined,controller.signal) as Snapshot;if(!alive.current||generation.current!==token)return false
   if(data.ownerName.toLowerCase()!==ownerName.toLowerCase()||!data.settingsVersion||!Array.isArray(data.transfers))throw new Error('Your personal budget changed. Reopen BookieBot.')
   setSnapshot(data);if(data.pendingCommand){sessionStorage.setItem(key,JSON.stringify(data.pendingCommand));setPending(data.pendingCommand)}return true
  }catch(e){if(alive.current&&generation.current===token&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Could not load transfers.');return false}
  finally{if(alive.current&&generation.current===token)setBusy(false)}
 },[key,ownerName])
 useEffect(()=>{alive.current=true;try{const saved=sessionStorage.getItem(key);if(saved)setPending(JSON.parse(saved))}catch{setError('Could not restore the saved transfer request. Reopen BookieBot.')};return()=>{alive.current=false;++generation.current;abort.current?.abort()}},[key])
 useEffect(()=>{if(active&&!snapshot&&!flight.current)void load()},[active,snapshot,load])
 usePageRefresh(active?'settings':null,{refresh:async()=>{setRefreshing(true);try{return await load()}finally{setRefreshing(false)}},disabled:busy||Boolean(pending)||guard.pending||guard.uncertain})
 useEffect(()=>{setConfirmReady(false);if(!review)return;const timer=window.setTimeout(()=>setConfirmReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review])
 const choose=(transfer?:Transfer)=>{
  if(locked||!snapshot)return
  if(form&&selected?.id===transfer?.id){if(transfer)close();return}
  if(form)drafts.current.set(selected?.id??'new',{form,review,body,draftId:draftId.current})
  if(!order.current)order.current=snapshot.transfers.map(t=>t.id)
  const saved=drafts.current.get(transfer?.id??'new')
  draftId.current=saved?.draftId??crypto.randomUUID();setSelected(transfer??null);setReview(saved?.review??null);setBody(saved?.body??null);setError('')
  setForm(saved?.form??{name:transfer?.name??'',amount:transfer?(transfer.amountCents/100).toFixed(2):'',frequency:transfer?.frequency??'monthly',startsOn:transfer?.nextDate&&transfer.nextDate>snapshot.today?transfer.nextDate:transfer?tomorrow(snapshot.today):snapshot.today,goalId:transfer?.goalId??'',fromAccount:transfer?.fromAccount??'',toAccount:transfer?.toAccount??''})
 }
 const add=()=>{if(locked||!snapshot){setQueued(true);return}choose()}
 useEffect(()=>{if(queued&&active&&snapshot&&!locked){setQueued(false);choose()}},[queued,active,snapshot,locked])
 const prepare=async(stop=false)=>{
  if(flight.current||!form||!snapshot||pending)return
  flight.current=true;setBusy(true);setError('')
  const command:Command={operation:stop?'transfer-stop':selected?'transfer-update':'transfer-create',year:snapshot.year,settingsVersion:snapshot.settingsVersion,...(selected?{id:selected.id,revision:selected.revision}:{draftId:draftId.current}),...(!stop?{transfer:form}:{})}
  try{const data=await request('/app/transfers/review',command);if(alive.current){setBody(command);setReview(data.review)}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not review transfer.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const finish=async(result:{state:string;success?:boolean;detail?:string})=>{
  if(result.state==='done'){
   sessionStorage.removeItem(key);setPending(null)
   if(result.success){close();window.dispatchEvent(new Event('bookiebot:transfers-changed'));window.dispatchEvent(new Event('bookiebot:transactions-changed'))}
   else{setReview(null);setBody(null)}
   await load()
   if(!result.success)setError(result.detail||'Transfer was not changed. Review it again.')
  }
  else setError(result.detail||'Check saved status before repeating this change.')
 }
 const submit=async(command:Command)=>{
  if(flight.current)return
  flight.current=true;setBusy(true);setError('');updateWork({label:'Savings transfers',pending:true,uncertain:true,dirty:true})
  try{sessionStorage.setItem(key,JSON.stringify(command));setPending(command);const data=await request('/app/transfers',command);if(alive.current)await finish(data)}
  catch(e){if(alive.current){
   if(e instanceof TransferError&&[400,403,409].includes(e.status))await finish({state:'done',success:false,detail:e.message})
   else setError(e instanceof Error?e.message:'Check saved status before repeating this change.')
  }}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const check=async(retry=false)=>{
  if(!pending||flight.current)return
  const command=pending;flight.current=true;setBusy(true);setError('')
  try{let result;try{result=await request(`/app/transfers/commands/${encodeURIComponent(command.requestId!)}`)}catch(e){if(!(retry&&e instanceof TransferError&&e.status===404))throw e}
   if(retry&&(!result||result.state==='uncertain')){flight.current=false;await submit(command);return}if(alive.current)await finish(result)
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not check the saved transfer.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const change=(patch:Partial<Form>)=>{setForm(previous=>previous?{...previous,...patch}:null);setReview(null);setBody(null);setError('')}
 const visible=(snapshot?.transfers??[]).filter(t=>(filter==='active'?t.active&&Boolean(t.nextDate):!t.active||!t.nextDate)||anchors.includes(t.id)||selected?.id===t.id).sort((a,b)=>order.current?order.current.indexOf(a.id)-order.current.indexOf(b.id):a.name.localeCompare(b.name))
 const slot=selected?Math.max(0,visible.findIndex(t=>t.id===selected.id))*2+3:1
 const edit=form&&snapshot&&<>
  <header className="bb-bill-edit-heading"><h2>{selected?'Edit transfer':'Add transfer'}</h2>{selected?.active&&selected.nextDate&&<button type="button" className="bb-bills-stop" aria-label="Stop transfer" disabled={locked} onClick={()=>void prepare(true)}><Trash2 aria-hidden="true"/></button>}</header>
  <form className="bb-bills-form bb-transfer-form" data-editor-mode="settings" onSubmit={e=>{e.preventDefault();void prepare()}}>
   <label data-bill-field="name">Name<input className="bb-bills-input" required maxLength={80} value={form.name} onChange={e=>change({name:e.target.value})}/></label>
   <div className="bi-secondary-fields"><label data-bill-field="amount">Amount<span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label="Amount" required inputMode="decimal" value={form.amount} onChange={e=>change({amount:e.target.value})}/></span></label>
    <label data-bill-field="cadence">Repeats<span className="bi-select"><select aria-label="Repeats" value={form.frequency} onChange={e=>change({frequency:e.target.value as Frequency})}>{Object.entries(frequencyLabel).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select><ChevronDown aria-hidden="true"/></span></label></div>
   <label data-bill-field="starting-month">{selected?'Next transfer':'First transfer'}<input className="bb-bills-input" aria-label={selected?'Next transfer':'First transfer'} type="date" required min={selected?tomorrow(snapshot.today):snapshot.today} value={form.startsOn} onChange={e=>change({startsOn:e.target.value})}/></label>
   <div className="bi-secondary-fields"><label data-bill-field="account" data-transfer-field="from">From<input className="bb-bills-input" placeholder="Checking (optional)" maxLength={80} value={form.fromAccount} onChange={e=>change({fromAccount:e.target.value})}/></label><label data-bill-field="account" data-transfer-field="to">To<input className="bb-bills-input" placeholder="Savings (optional)" maxLength={80} value={form.toAccount} onChange={e=>change({toAccount:e.target.value})}/></label></div>
   <label data-bill-field="goal">Savings goal<span className="bi-select"><select aria-label="Savings goal" value={form.goalId} onChange={e=>change({goalId:e.target.value})}><option value="">No goal</option>{snapshot.goals.filter(g=>!g.archived||g.id===form.goalId).map(g=><option key={g.id} value={g.id} disabled={g.archived}>{g.name}{g.archived?' (archived)':''}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>
   <p className="bi-footnote bb-transfer-note">Adds to Saved{form.goalId?' and this goal':''} on its date. Your bank moves the money.</p>
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={close}>Cancel</button><button type="submit" className="bi-primary" disabled={locked}>{busy?'Preparing…':'Review'}</button></footer>
  </form>
 </>
 const lines=review?[{label:'Name',value:review.after.name},{label:'Amount',value:money(review.after.amountCents)},{label:'Repeats',value:frequencyLabel[review.after.frequency]},{label:review.operation==='transfer-stop'?'Stops from':'Next transfer',value:dateLabel(review.operation==='transfer-stop'?review.effectiveFrom:review.after.nextDate??form?.startsOn??review.after.startsOn)},{label:'Savings goal',value:review.after.goalName||'No goal'},...((review.after.fromAccount||review.after.toAccount)?[{label:'Accounts',value:`${review.after.fromAccount||'Checking'} → ${review.after.toAccount||'Savings'}`}]:[])]:[]
 const previousValues:Record<string,string>=review?.before?{'Name':review.before.name,'Amount':money(review.before.amountCents),'Repeats':frequencyLabel[review.before.frequency],'Savings goal':review.before.goalName||'No goal','Next transfer':review.before.nextDate?dateLabel(review.before.nextDate):'Completed','Accounts':`${review.before.fromAccount||'Checking'} → ${review.before.toAccount||'Savings'}`} : {}
 const confirm=review&&<><header className="sp-flow-heading bb-bill-heading"><h2>{review.operation==='transfer-stop'?'Stop transfer':'Review transfer'}</h2></header><dl className="bi-review-changes" aria-label="Transfer changes to review" data-dense={lines.length>5}>{lines.map(line=><div className="bi-review-change" key={line.label}><dt>{line.label}</dt><dd>{review.operation!=="transfer-stop"&&previousValues[line.label]&&previousValues[line.label]!==line.value&&<del title={previousValues[line.label]}>{previousValues[line.label]}</del>}<span className="bi-review-new">{review.operation!=="transfer-stop"&&previousValues[line.label]&&previousValues[line.label]!==line.value&&<ArrowRight aria-hidden="true"/>}<span title={line.value}>{line.value}</span></span></dd></div>)}</dl><p className="bi-footnote">{review.operation==='transfer-stop'?'Future transfers stop. Previously saved amounts and goal contributions stay unchanged.':selected?'Changes apply to future transfers. Previously saved amounts stay unchanged.':'Saved and the linked goal increase on each scheduled date.'}</p><footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={()=>{setReview(null);setBody(null)}}><ArrowLeft aria-hidden="true"/>Back</button><button type="button" className="bi-primary" disabled={locked||!confirmReady} onClick={()=>{if(body)void submit({...body,requestId:crypto.randomUUID(),reviewVersion:review.reviewVersion})}}>{busy?'Saving…':review.operation==='transfer-stop'?'Stop transfer':'Confirm'}</button></footer></>
 return <div className="bb-bills bb-transfers bi-product" data-tone="sage" data-wide={wide} aria-busy={busy}>
  <div className="bb-bills-notices">{(error||snapshot?.blockedReason)&&<p className="bb-bills-error" role="alert">{error||snapshot?.blockedReason}</p>}{queued&&<p role="status">New transfer opens after the current change is verified.</p>}{pending&&<div className="bb-bills-recovery"><button type="button" disabled={busy} onClick={()=>void check()}>Check saved status</button><button type="button" disabled={busy} onClick={()=>void check(true)}>Retry same confirmation</button></div>}{!snapshot&&!busy&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Load transfers</button>}</div>
  {snapshot&&<div className="bb-bills-panes"><section className="bb-bills-list" aria-label="Your savings transfers"><div className="bb-bills-toolbar"><CategoryFilterControl filter={filter} onFilterChange={setFilter} filters={[{value:'active',label:'Active transfers'},{value:'ended',label:'Past transfers'}]} label="Transfer status" dismissTrigger="transfer-filter"/><button type="button" className="bb-bills-add" onClick={add}><Plus aria-hidden="true"/>Add transfer</button>{wide&&<button type="button" className="bb-bills-refresh" aria-label="Refresh transfers" disabled={busy||Boolean(pending)||guard.pending||guard.uncertain} onClick={()=>void registry?.refresh('settings')}><RefreshCw aria-hidden="true" className={refreshing?'bb-bills-refresh-spinning':undefined}/></button>}</div><div className="bb-bills-rows"><div className="bb-bills-row-stack">{visible.map((t,index)=><div className="bb-bills-row-shell" key={t.id} style={{order:index*2+2}}><button type="button" className="bb-bills-row" data-bill-id={t.id} aria-pressed={t.id===selected?.id} disabled={locked} onClick={()=>choose(t)}><span className="bb-transfer-icon"><ArrowRightLeft aria-hidden="true"/></span><span className="bb-bills-row-text"><strong>{t.name}</strong><small>{!t.active?'Ended':!t.nextDate?'Completed':`${frequencyLabel[t.frequency]} · ${dateLabel(t.nextDate)}`}{t.goalName?` · ${t.goalName}`:''}</small></span><span className="bb-bills-row-amount">{money(t.amountCents)}</span><ChevronRight aria-hidden="true"/></button></div>)}{!visible.length&&<p className="bb-bills-empty">{filter==='active'?'Schedule money for savings, with an optional goal.':'No past transfers.'}</p>}</div></div></section>
   <BillEditorWorkspace billId={selected?.id??'new-transfer'} open={Boolean(form)} order={slot} isNew={!selected} wide={wide} locked={busy||Boolean(pending)} editorLabel="Transfer editor" emptyText="Choose a transfer to manage it." onAnchorsChange={ids=>setAnchors(previous=>previous.join()===ids.join()?previous:ids)} onClosed={()=>{order.current=null;drafts.current.clear()}}><EditorScenes scene={`${selected?.id??draftId.current}:transfer`} open={Boolean(form)}><div className="bi-editor" data-design="levels" data-operation="update"><StepMotion review={Boolean(review)} open={Boolean(form)} mode="slide" duration={transactionMotion.duration} edit={edit} confirm={confirm}/></div></EditorScenes></BillEditorWorkspace>
  </div>}
 </div>
}
