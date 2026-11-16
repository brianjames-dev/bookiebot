import {ReportLoading} from "./report-loading"
import {api,useReview,ReviewPanel,type Flow,type Command} from './onboarding-review'
import {useCallback,useEffect,useRef,useState,type CSSProperties} from 'react'
import {KonstaProvider} from 'konsta/react'
import {ArrowUpRight,ArrowDownLeft,ChevronLeft,Plus,RefreshCw,Settings,Trash2} from 'lucide-react'
import {AccountIdentity,AuthFeedback,GoogleSignInButton} from './account-settings'
import {AppWorkGuardProvider,useAppWorkGuard,useAppWorkStatus} from './app-work-guard'
import {AppNavigationContext,screenTitles,type AppScreen,type MainScreen} from './app-navigation'
import {AppNavigationBar} from './app-navigation-bar'
import {NavigationViewport} from './navigation-viewport'
import {BookieBotPortrait,ReportBrand,ReportHeader} from './report-header'
import {ExpenseReportApp,useExpenseReportTheme} from './report-app'
import {FreshExpenseApp} from './fresh-expense-app'
import {ExpenseAppReconnect} from './expense-app-reconnect'
import {useReportViewPreferences} from './report-view-preferences'
import {useDuoLayout} from './duo-layout'
import {MonthPicker} from './components/ui/month-picker'
import {TransactionIcon} from './daily-transactions'
import {EditorScenes} from './transaction-editor-workspace'
import {PageRefreshProvider,usePageRefresh} from './page-refresh'
import {PullToRefresh} from './pull-to-refresh'
import {AskBookieBotPanel} from './ask-bookiebot-panel'
import type {ExpenseAppConfig} from './expense-app-session'
import type {ExpenseReportData} from './types'
import './transaction-inline-editor.css'
import './managed-budget.css'

type Bootstrap={phase:'signed-out'|'onboarding'|'ready';provider?:'managed'|'sheets';account?:{id:string;name:string}}
type Budget={name:string;incomeCents:number;allocation:number[];startMonth:string}
type Entry={id:string;owner:string;version:number;kind:'expense'|'income'|'transfer';category:string;name:string;date:string;amountCents:number;personalAmountCents:number;split:boolean;goalId:string;payerName:string}
type Shared=Entry&{outstandingCents:number;pendingCents:number;repayments:{id:string;sender:string;senderName:string;amount_cents:number;status:string}[]}
type State={account:{id:string;name:string};household:{name:string;role:string;members:{id:string;name:string}[]};budget:Budget;month:string;version:string;entries:Entry[];shared:Shared[];goals:{id:string;name:string;target_cents:number;saved_cents:number}[];report:ExpenseReportData}
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const currentMonth=()=>today().slice(0,7)
const monthLabel=(month:string)=>new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US',{month:'long',year:'numeric'})
function cents(value:string){return /^\d+(\.\d{1,2})?$/.test(value)?Math.round(Number(value)*100):-1}
function readInvite(){try{
  const token=new URLSearchParams(window.location.hash.slice(1)).get('invite')
  if(token&&/^[A-Za-z0-9_-]{43}$/.test(token)){sessionStorage.setItem('bookiebot:household-invite',token);history.replaceState(history.state,'',location.pathname+location.search)}
  return sessionStorage.getItem('bookiebot:household-invite')||''
}catch{return ''}}
function inviteToken(value:string){try{return new URLSearchParams(new URL(value).hash.slice(1)).get('invite')||value.trim()}catch{return value.trim()}}

export function GoogleFirstApp({config}:{config:ExpenseAppConfig}){
  const [state,setState]=useState<Bootstrap|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
  useState(readInvite)
  useEffect(()=>{const expired=()=>setState({phase:'signed-out'});window.addEventListener('bookiebot:managed-expired',expired);return()=>window.removeEventListener('bookiebot:managed-expired',expired)},[])
  useEffect(()=>{const abort=new AbortController();void fetch(config.onboardingUrl!,{credentials:'same-origin',cache:'no-store',signal:abort.signal}).then(async response=>{
    if(response.status===401)return {phase:'signed-out'} as Bootstrap
    if(!response.ok)throw new Error('Could not open your account. Try again.')
    return await response.json() as Bootstrap
  }).then(value=>{if(!abort.signal.aborted){if(value.provider==='sheets'&&readInvite())history.replaceState(history.state,'',location.pathname+location.search+'#settings');setState(value);setError('')}}).catch(()=>{if(!abort.signal.aborted)setError('Could not open your account. Try again.')});return()=>abort.abort()},[config.onboardingUrl,attempt])
  if(state?.provider==='sheets')return <FreshExpenseApp config={config}/>
  return <KonstaProvider theme="ios" dark><AppWorkGuardProvider><AuthFeedback/>{state?.account
    ? <PageRefreshProvider><ManagedSession key={state.account.id} initial={state} onReady={()=>setAttempt(x=>x+1)} onSignedOut={()=>{setState({phase:'signed-out'});setAttempt(x=>x+1)}} version={config.version||''}/></PageRefreshProvider>
    : <div className="bb-page bb-managed-welcome"><ReportBrand owner="BookieBot" avatarUrl="/app/avatar.png" status="Your budget, together."/>
      <main><h1>{state?'Welcome to BookieBot':'Opening BookieBot…'}</h1>{state&&<><p>Create a private budget, or join your household.</p><GoogleSignInButton/>
        <details><summary>Already have a connected budget?</summary><p>Link Google from Settings in your connected app first. Signing in here with an unlinked Google account creates a separate budget.</p><ExpenseAppReconnect/></details></>}
        {error&&<><p role="alert">{error}</p><button onClick={()=>setAttempt(x=>x+1)}>Try again</button></>}</main></div>}
  </AppWorkGuardProvider></KonstaProvider>
}


function BudgetFields({budget,onSubmit,busy,cancel,setup=false}:{budget:Budget;onSubmit:(value:Budget)=>void;busy:boolean;cancel?:()=>void;setup?:boolean}){
  const [name,setName]=useState(budget.name),[income,setIncome]=useState(String(budget.incomeCents/100)),[allocation,setAllocation]=useState(budget.allocation.map(x=>String(x/100))),[start,setStart]=useState(budget.startMonth)
  return <form className="bi-fields" onSubmit={event=>{event.preventDefault();onSubmit({name,incomeCents:cents(income),allocation:allocation.map(x=>Math.round(Number(x)*100)),startMonth:start})}}>
    <label>Your name<input aria-label="Your name" maxLength={60} required value={name} onChange={event=>setName(event.target.value)}/></label>
    <div className="bi-secondary-fields"><label>Monthly take-home ($)<input aria-label="Monthly take-home" inputMode="decimal" required value={income} onChange={event=>setIncome(event.target.value)}/></label>
    <label>Budget starts<input aria-label="Budget starts" type="month" required max={currentMonth()} readOnly={!setup} value={start} onChange={event=>setStart(event.target.value)}/></label></div>
    <div className="bb-managed-allocation">{['Needs','Wants','Savings'].map((label,i)=><label key={label}>{label} (%)<input aria-label={`${label} percent`} type="number" min={0} max={100} step="0.01" required value={allocation[i]} onChange={event=>setAllocation(previous=>previous.map((x,j)=>j===i?event.target.value:x))}/></label>)}</div>
    <p className="bi-footnote">USD · Pacific time. Expected income plans your budget; record deposits as they arrive.</p>
    <footer className="bi-editor-footer">{cancel&&<button className="bi-cancel" type="button" disabled={busy} onClick={cancel}>Cancel</button>}<button className="bi-primary" disabled={busy} type="submit">{busy?'Preparing…':'Review'}</button></footer>
  </form>
}

function Onboarding({account,flow,onSignOut}:{account:{id:string;name:string};flow:Flow;onSignOut:()=>void}){
  const [invite,setInvite]=useState(readInvite),[join,setJoin]=useState(Boolean(invite)),[household,setHousehold]=useState('My household')
  return <div className="bb-page bb-managed-setup"><div className="bb-masthead"><ReportBrand owner={account.name} avatarUrl="/app/avatar.png" status="Set up your budget"/><button className="bb-settings-action" onClick={onSignOut}>Sign out</button></div>
    <div className="bb-managed-setup-panes"><section><h1>A fresh start.</h1><p>Your personal income and budget stay private. Only expenses you choose to share are visible to household members.</p><p>Existing connected budgets stay where they are. Setup creates a new database budget.</p></section>
    <ReviewPanel flow={flow}><h2>Your household</h2><div className="bb-managed-choice" role="group" aria-label="Household setup">
      <button aria-pressed={!join} disabled={flow.busy} onClick={()=>setJoin(false)}>Create household</button><button aria-pressed={join} disabled={flow.busy} onClick={()=>setJoin(true)}>Join household</button></div>
      <label className="bb-managed-setup-label">{join?'Invitation link or code':'Household name'}<input aria-label={join?'Invitation link or code':'Household name'} value={join?invite:household} onChange={event=>join?setInvite(event.target.value):setHousehold(event.target.value)} maxLength={join?512:60}/></label>
      <BudgetFields setup budget={{name:account.name,incomeCents:0,allocation:[5000,3000,2000],startMonth:currentMonth()}} busy={flow.busy||flow.uncertain} onSubmit={value=>void flow.prepare({operation:'setup',...value,householdName:household,invite:join?inviteToken(invite):''})}/>
    </ReviewPanel></div></div>
}

function ManagedSession({initial,onReady,onSignedOut,version}:{initial:Bootstrap;onReady:()=>void;onSignedOut:()=>void;version:string}){
  const account=initial.account!,[state,setState]=useState<State|null>(null),[month,setMonth]=useState(currentMonth),[error,setError]=useState(''),[editor,setEditor]=useState<{kind:'add'|'edit'|'budget'|'goal'|'shared';entry?:Entry;shared?:Shared}|null>(null)
  const [screen,setScreen]=useState<AppScreen>('overview'),[main,setMain]=useState<MainScreen>('overview'),[invite,setInvite]=useState(''),[chat,setChat]=useState(false),[refreshing,setRefreshing]=useState(false)
  const duo=useDuoLayout(account.id),preferences=useReportViewPreferences(account.id,false),guard=useAppWorkGuard(),theme=useExpenseReportTheme()
  const loaded=useRef(0),reading=useRef(false),scope=useRef(month);scope.current=month
  const refresh=useCallback(async()=>{if(reading.current)return false;reading.current=true;setRefreshing(true);const target=scope.current
    try{const value=await api<State>(`/app/budget?month=${encodeURIComponent(target)}`);if(value.account.id!==account.id){setState(null);onSignedOut();return false}if(scope.current!==target)return false;setState(value);setError('');loaded.current=Date.now();return true}catch(e){setError((e as Error).message);return false}finally{reading.current=false;setRefreshing(false)}},[])
  const complete=async()=>{setEditor(null);try{sessionStorage.removeItem('bookiebot:household-invite')}catch{/* Setup is already committed. */}if(initial.phase==='onboarding')onReady();else await refresh()}
  const flow=useReview(account.id,complete)
  // Recovery must be reachable before navigation is unlocked. A completed
  // receipt keeps Overview; unresolved/failed reads open the recovery workspace.
  useEffect(()=>{if(initial.phase==='ready'&&flow.uncertain&&!flow.busy&&!editor){setScreen('transactions');setMain('transactions')}},[initial.phase,flow.uncertain,flow.busy,editor])
  useAppWorkStatus({label:'Budget editor',dirty:Boolean(editor),onDiscard:()=>setEditor(null)})
  const signOut=()=>guard.requestAction({kind:'signout',onProceed:async()=>{await fetch('/app/logout',{method:'POST',credentials:'same-origin',referrerPolicy:'same-origin',headers:{'X-BookieBot-App':'1'}}).then(response=>{if(!response.ok)throw new Error('Could not sign out.');onSignedOut()}).catch(()=>setError('Could not sign out. Try again.'))}})
  useEffect(()=>{if(initial.phase==='ready'){setState(null);void refresh()}},[month,initial.phase,refresh])
  useEffect(()=>{if(initial.phase!=='ready')return;const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&!editor&&!flow.review&&!flow.busy&&Date.now()-loaded.current>=20000)void refresh()},20000);return()=>clearInterval(timer)},[editor,flow.review,flow.busy,initial.phase,refresh])
  useEffect(()=>{let stopped=false,checking=false;const check=()=>{if(checking||document.visibilityState!=='visible')return;checking=true;void api<Bootstrap>('/app/bootstrap').then(value=>{if(!stopped&&(value.account?.id!==account.id||value.provider!=='managed')){setState(null);onSignedOut()}}).catch(()=>{}).finally(()=>checking=false)};window.addEventListener('focus',check);window.addEventListener('pageshow',check);document.addEventListener('visibilitychange',check);return()=>{stopped=true;window.removeEventListener('focus',check);window.removeEventListener('pageshow',check);document.removeEventListener('visibilitychange',check)}},[account.id])
  if(initial.phase==='onboarding')return <Onboarding account={account} flow={flow} onSignOut={signOut}/>
  if(!state)return <div className="bb-page bb-managed-welcome"><h1>BookieBot</h1>{!error&&!flow.uncertain&&<ReportLoading label="Opening your budget…"/>}{flow.uncertain&&<ReviewPanel flow={flow}><h2>Check your last change</h2><p className="bi-footnote">Resolve the previous confirmation before making another change.</p></ReviewPanel>}{error&&<><p role="alert">{error}</p><button onClick={()=>void refresh()}>Try again</button><button onClick={signOut}>Sign out</button></>}</div>
  const selectScreen=(next:AppScreen)=>{if(flow.busy||flow.uncertain)return;setScreen(next);if(next!=='settings')setMain(next)}
  const locked=flow.busy||flow.uncertain,overview=screen==='overview',selected=editor?.entry
  const nav={screen,duoLandscape:duo.landscape,monthHeader:true,preferences,sourceRequest:null,selectScreen}
  const options=[];for(let cursor=currentMonth();cursor>=state.budget.startMonth;){options.push({value:cursor,label:monthLabel(cursor)});const d=new Date(cursor+'-01T12:00:00');d.setMonth(d.getMonth()-1);cursor=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
  const title=overview?monthLabel(month).replace(/\s+\d{4}$/,''):screenTitles[screen]
  const chooseEditor=(value:typeof editor)=>{if(!flow.busy&&!flow.uncertain){flow.back();setEditor(value)}}
  const editorPane=(editor||flow.review||flow.uncertain)&&<ReviewPanel flow={flow}>{flow.uncertain&&!editor&&!flow.review?<><h2>Check your last change</h2><p className="bi-footnote">Confirm the previous result before making another change.</p></>:editor?.kind==='budget'?<><h2>Edit budget</h2><BudgetFields budget={state.budget} busy={locked} cancel={()=>chooseEditor(null)} onSubmit={value=>void flow.prepare({operation:'budget',...value})}/></>
    :editor?.kind==='goal'?<GoalForm busy={locked} onCancel={()=>chooseEditor(null)} onReview={flow.prepare}/>
    :editor?.kind==='shared'&&editor.shared?<SharedEditor entry={editor.shared} state={state} busy={locked} onCancel={()=>chooseEditor(null)} onReview={flow.prepare}/>
    :<EntryForm key={selected?.id||'new'} entry={selected} state={state} busy={locked} onCancel={()=>chooseEditor(null)} onReview={flow.prepare}/>}</ReviewPanel>
  return <AppNavigationContext.Provider value={nav}><div className="bb-page bb-app-shell bb-managed" data-duo-enabled={duo.enabled||undefined} data-duo-landscape={duo.landscape||undefined} data-duo-overview={duo.landscape&&overview||undefined} data-screen={screen}
    style={{'--bb-duo-overlay':`${duo.overlay}px`,'--bb-duo-right-rail':`${duo.rail}px`} as CSSProperties}>
    <div className="bb-masthead bb-shell-masthead">{screen==='settings'?<button className="bb-glass-control bb-managed-back" onClick={()=>selectScreen(main)}><ChevronLeft aria-hidden="true"/>Settings</button>:<ReportBrand owner={state.account.name} avatarUrl="/app/avatar.png" status={`Updated ${new Date(state.report.generatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`} onChat={()=>setChat(true)} />}
      <div className="bb-managed-header-actions">{duo.landscape&&<button className="bb-managed-refresh" aria-label="Refresh budget" disabled={Boolean(editor)||locked||refreshing} data-refreshing={refreshing} onClick={()=>void refresh()}><RefreshCw aria-hidden="true"/></button>}{screen==='settings'&&<BookieBotPortrait avatarUrl="/app/avatar.png" onChat={()=>setChat(true)}/>}<button className="bb-glass-control bb-managed-gear" aria-label="Settings" disabled={locked} onClick={()=>selectScreen('settings')}><Settings aria-hidden="true"/></button></div>
    </div>
    <ReportHeader month={overview||screen==='transactions'?<MonthPicker label="Budget month" value={month} options={options} onSelect={setMonth} disabled={Boolean(editor)||locked} variant="title" triggerLabel={title}/>:title}
      projected={preferences.mode==='projected'} onToggle={()=>preferences.setMode(preferences.mode==='projected'?'current':'projected')} showViewControl={overview} hidden={screen==='settings'}/>
    {error&&<p className="bb-managed-error" role="alert">{error}</p>}
    {overview?<div className="bb-shell-report"><ExpenseReportApp report={state.report} externalHeader/></div>:<div className="bb-managed-workspace">
      <section className="bb-managed-pane bb-managed-list" aria-label={screenTitles[screen]}>
        {screen==='transactions'?<><div className="bb-managed-toolbar"><p>{monthLabel(month)}</p><button className="bb-bills-add" disabled={locked} onClick={()=>chooseEditor({kind:'add'})}><Plus aria-hidden="true"/>Add transaction</button></div>
          {!state.entries.length&&<p className="bb-managed-empty">No transactions yet. Add an expense, deposit or savings transfer.</p>}
          {state.entries.map((entry,index)=><div key={entry.id} className="bb-managed-row-stack"><button className="bb-bills-row" style={{'--bb-managed-row-order':index*2+2} as CSSProperties} aria-pressed={selected?.id===entry.id} disabled={locked} onClick={()=>chooseEditor(selected?.id===entry.id?null:{kind:'edit',entry})}>
            <TransactionIcon entry={{date:entry.date,item:entry.name,location:'',category:entry.category,person:entry.payerName,amount:entry.personalAmountCents/100,kind:entry.kind}}/>
            <span className="bb-bills-row-text"><strong>{entry.name}</strong><small>{entry.date} · {entry.kind==='transfer'?'Savings transfer':entry.category}{entry.split?' · Shared':''}</small></span><span className="bb-bills-row-amount">{money(entry.personalAmountCents)}</span></button>
            </div>)}
        </>:screen==='shared'?<><h2>{state.household.name}</h2><p className="bi-footnote">Only shared expenses appear here. A reported repayment counts after the payer confirms receiving it.</p>
          {!state.shared.length&&<p className="bb-managed-empty">No shared expenses yet.</p>}{state.shared.map((entry,index)=><div className="bb-managed-row-stack" key={entry.id}><button className="bb-bills-row" style={{'--bb-managed-row-order':index*2+2} as CSSProperties} disabled={locked} onClick={()=>chooseEditor(editor?.shared?.id===entry.id?null:{kind:'shared',shared:entry})}>
            <span className="bb-bills-row-text"><strong>{entry.name}</strong><small>Paid by {entry.payerName} · {money(entry.amountCents)}</small></span><span className="bb-bills-row-amount">{money(entry.outstandingCents)} {entry.owner===state.account.id?'owed to you':'you owe'}</span></button>
            </div>)}
        </>:screen==='savings'?<><div className="bb-managed-toolbar"><p>Personal goals</p><button className="bb-bills-add" disabled={locked} onClick={()=>chooseEditor({kind:'goal'})}><Plus aria-hidden="true"/>Add goal</button></div>
          {!state.goals.length&&<p className="bb-managed-empty">Create a goal, then link savings transfers to it in Transactions.</p>}{state.goals.map(goal=><div className="bb-managed-goal" key={goal.id}><strong>{goal.name}</strong><span>{money(goal.saved_cents)} / {money(goal.target_cents)}</span><progress value={goal.saved_cents} max={goal.target_cents}/></div>)}
        </>:<><section className="bb-managed-settings"><h2>Budget</h2><button className="bb-settings-action" onClick={()=>chooseEditor({kind:'budget'})}>Edit income & allocation</button><button className="bb-settings-action" onClick={theme.toggleTheme}>Appearance · {theme.theme}</button><button className="bb-settings-action" onClick={duo.toggle}>iPhone DUO layout · {duo.enabled?'On':'Off'}</button></section>
          <section className="bb-managed-settings"><h2>Household</h2><p>{state.household.name}</p>{state.household.members.map(member=><div className="bb-setting-row" key={member.id}><span>{member.name}</span><small>{member.id===state.account.id?'You':'Member'}</small></div>)}
          {state.household.role==='owner'&&<button className="bb-settings-action" disabled={locked} onClick={()=>{void api<{token:string}>('/app/budget/invite',{accountId:state.account.id}).then(value=>setInvite(`${location.origin}/app/expenses#invite=${value.token}`)).catch(e=>setError(e.message))}}>Create invitation link</button>}
          {invite&&<label className="bb-managed-invite">Invitation · expires in 7 days<input aria-label="Household invitation" readOnly value={invite} onFocus={event=>event.target.select()}/><p className="bi-footnote">Share privately. Creating another link replaces this one.</p></label>}</section>
          <section className="bb-managed-settings"><h2>Account</h2><AccountIdentity active ownerName={state.account.name}/><button className="bb-settings-action bb-account-signout" onClick={signOut}>Sign out</button><p className="bi-footnote">BookieBot · Version {version.slice(0,8)}</p></section>
        </>}
      </section>
      <aside className="bb-managed-pane bb-managed-detail" aria-label="Details" data-has-editor={Boolean(editorPane)} style={{order:editor?.entry?state.entries.findIndex(e=>e.id===editor.entry?.id)*2+3:editor?.shared?state.shared.findIndex(e=>e.id===editor.shared?.id)*2+3:1}}>
        {editorPane?<EditorScenes scene={editor?.entry?.id||editor?.shared?.id||editor?.kind||'recovery'}>{editorPane}</EditorScenes>:<section className="bb-managed-empty"><h2>{screen==='settings'?'Your budget':screen==='shared'?'Shared, clearly.':screen==='savings'?'Save with a purpose.':'Your transactions'}</h2><p>{screen==='settings'?'Choose an option to edit.':'Select a row to see details, or add something new.'}</p></section>}</aside>
    </div>}
    <AskBookieBotPanel open={chat} onClose={()=>setChat(false)} month={month} mode={preferences.mode}/>
    <NavigationViewport enabled landscape={duo.landscape} overlay={duo.overlay} rail={duo.rail}><AppNavigationBar active={main} current={screen==='settings'?null:main} compact={false} reconciliationVisible={false} disabled={locked} onSelect={selectScreen}/></NavigationViewport>
    <ManagedRefresh screen={screen} refresh={refresh} disabled={Boolean(editor)||locked}/>
    {!duo.landscape&&<PullToRefresh screen={screen} blocked={Boolean(editor)||locked}/>}
  </div></AppNavigationContext.Provider>
}

function ManagedRefresh({screen,refresh,disabled}:{screen:AppScreen;refresh:()=>Promise<boolean>;disabled:boolean}){usePageRefresh(screen,{refresh,disabled});return null}

function EntryForm({entry,state,busy,onCancel,onReview}:{entry?:Entry;state:State;busy:boolean;onCancel:()=>void;onReview:(command:Command)=>Promise<void>}){
  const [name,setName]=useState(entry?.name||''),[amount,setAmount]=useState(entry?String(entry.amountCents/100):''),[date,setDate]=useState(entry?.date||today()),[kind,setKind]=useState(entry?.kind||'expense'),[category,setCategory]=useState(entry?.category==='wants'?'wants':'needs'),[split,setSplit]=useState(entry?.split||false),[goal,setGoal]=useState(entry?.goalId||'')
  const own=!entry||entry.owner===state.account.id
  if(!own)return <><h2>{entry.name}</h2><p>Purchase total {money(entry.amountCents)}</p><p>Your confirmed payments {money(entry.personalAmountCents)}</p><p className="bi-footnote">The payer manages this transaction. Report repayment in Shared.</p><button className="bi-cancel" onClick={onCancel}>Close</button></>
  return <form className="bi-fields" onSubmit={event=>{event.preventDefault();void onReview({operation:entry?'edit':'add',entryId:entry?.id,version:entry?.version,name,amountCents:cents(amount),date,kind,category,split:kind==='expense'&&split,goalId:kind==='transfer'?goal:''})}}>
    <header className="bb-managed-editor-heading"><h2>{entry?'Edit transaction':'Add transaction'}</h2>{entry&&<button type="button" aria-label="Delete transaction" disabled={busy} onClick={()=>void onReview({operation:'delete',entryId:entry.id,version:entry.version})}><Trash2/></button>}</header>
    <label>Name<input required maxLength={80} aria-label="Transaction name" value={name} onChange={e=>setName(e.target.value)}/></label>
    <div className="bi-secondary-fields"><label>Amount ($)<input required aria-label="Transaction amount" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>Date<input aria-label="Transaction date" type="date" min={state.budget.startMonth+'-01'} max={today()} required value={date} onChange={e=>setDate(e.target.value)}/></label></div>
    <div className="bi-secondary-fields"><label>Type<select aria-label="Transaction type" value={kind} onChange={e=>setKind(e.target.value as Entry['kind'])}><option value="expense">Expense</option><option value="income">Income deposit</option><option value="transfer">Savings transfer</option></select></label>
    {kind==='expense'?<label>Category<select aria-label="Transaction category" value={category} onChange={e=>setCategory(e.target.value)}><option value="needs">Needs</option><option value="wants">Wants</option></select></label>:kind==='transfer'?<label>Savings goal<select aria-label="Savings goal" value={goal} onChange={e=>setGoal(e.target.value)}><option value="">No goal</option>{state.goals.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>:null}</div>
    {kind==='expense'&&state.household.members.length>1&&<label className="bb-managed-checkbox"><input type="checkbox" checked={split} onChange={e=>setSplit(e.target.checked)}/>Share equally with this household</label>}
    <p className="bi-footnote">{kind==='transfer'?'Counts as Saved, never Needs or Wants. Your bank moves the money.':split?'Your recorded payment decreases only when you confirm a repayment.':'Only actual transactions dated today or earlier.'}</p>
    <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="bi-primary" disabled={busy}>Review</button></footer>
  </form>
}
function GoalForm({busy,onCancel,onReview}:{busy:boolean;onCancel:()=>void;onReview:(command:Command)=>Promise<void>}){
  const [name,setName]=useState(''),[target,setTarget]=useState('')
  return <form className="bi-fields" onSubmit={e=>{e.preventDefault();void onReview({operation:'goal',name,targetCents:cents(target)})}}><h2>Add savings goal</h2><label>Name<input aria-label="Goal name" maxLength={80} required value={name} onChange={e=>setName(e.target.value)}/></label><label>Target ($)<input aria-label="Goal target" inputMode="decimal" required value={target} onChange={e=>setTarget(e.target.value)}/></label><footer className="bi-editor-footer"><button className="bi-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="bi-primary" disabled={busy}>Review</button></footer></form>
}
function SharedEditor({entry,state,busy,onCancel,onReview}:{entry:Shared;state:State;busy:boolean;onCancel:()=>void;onReview:(command:Command)=>Promise<void>}){
  const receive=entry.owner===state.account.id,[amount,setAmount]=useState(String((entry.outstandingCents-entry.pendingCents)/100))
  return <><h2>{entry.name}</h2><p className="bb-managed-shared-amount">{receive?<ArrowUpRight/>:<ArrowDownLeft/>}{money(entry.outstandingCents)} <small>{receive?'owed to you':'you owe'}</small></p><p className="bi-footnote">Purchase total {money(entry.amountCents)} · Paid by {entry.payerName}</p>
    {entry.repayments.map(p=><div className="bb-setting-row" key={p.id}><span>{p.senderName} · {money(p.amount_cents)}</span>{receive&&p.status==='pending'?<button className="bi-primary" disabled={busy} onClick={()=>void onReview({operation:'confirm-repayment',entryId:entry.id,repaymentId:p.id})}>Confirm received</button>:<span>{p.status==='pending'?'Awaiting confirmation':p.status==='confirmed'?'Received':'Dismissed'}</span>}{p.status==='pending'&&<button className="bi-cancel" disabled={busy} onClick={()=>void onReview({operation:'remove-repayment',entryId:entry.id,repaymentId:p.id})}>{receive?'Reject':'Cancel report'}</button>}</div>)}
    {!receive&&entry.outstandingCents>entry.pendingCents&&<form className="bi-fields" onSubmit={e=>{e.preventDefault();void onReview({operation:'repay',entryId:entry.id,amountCents:cents(amount)})}}><label>Repayment ($)<input aria-label="Repayment amount" inputMode="decimal" required value={amount} onChange={e=>setAmount(e.target.value)}/></label><button className="bi-primary" disabled={busy}>Report repayment</button></form>}
    <footer className="bi-editor-footer"><button className="bi-cancel" disabled={busy} onClick={onCancel}>Close</button></footer></>
}
