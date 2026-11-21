import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,ChevronDown,ChevronRight,Plus,Trash2,RefreshCw,Clock3,Check,RotateCcw,UsersRound} from 'lucide-react'
import {TransactionIcon} from './daily-transactions'
import {useAppNavigation} from './app-navigation'
import {useAppWorkGuard,useAppWorkStatus} from './app-work-guard'
import {NotchedSplitControl,type SplitInputDraft} from './transaction-split-control'
import type {SplitMethod} from './transaction-split-model'
import {transactionMotion} from './transaction-inline-editor'
import {EditorScenes} from './transaction-editor-workspace'
import {StepMotion} from './transaction-step-motion'
import {BillCurrentCharge,type CurrentBillIntent} from './bill-current-charge'
import {BillEndReview,type BillEndReviewData} from './bill-end-review'
import {BillCurrentOffer} from './bill-current-offer'
import {billFlow,billFlowKey,runBillFlow,type BillSaveFlow,type BillCurrentChange} from './bill-save-flow'
import {billReviewLines,currentReviewLines} from './bill-review'
import {BillEditorWorkspace} from './bill-editor-workspace'
import {BillSharingEditor,BillSharingRecovery,readSharingJournal,type BillMembership} from './bill-sharing'
import {billListAmount,recurringStartMonth} from './bill-settings-model'
import {usePageRefresh,usePageRefreshRegistry} from './page-refresh'
import {BillPredictionInfo} from './bill-prediction-info'
import type {BillPrediction} from './types'
import {CategoryFilterControl} from './category-filter-control'
import {ReportLoading,SavingButton} from './report-loading'
import {readPageScroll,scrollPageTo} from './page-scroll'
import type {BillAmountRequest} from './bill-checkin'
import './bill-checkin.css'
import './bill-settings.css'

type Charge={available:boolean;month:string;amountCents?:number;billAmountCents?:number;status?:'unconfirmed'|'confirmed'|'paid';canConfirmAmount?:boolean;splitPending?:boolean;recorded?:boolean;canEditPaymentDate?:boolean;virtual?:boolean;date?:string|null;version?:string}
export type Bill={readOnly?:boolean;sharing?:BillMembership|null;id:string;type:'subscription'|'variable'|'fixed';name:string;amountCents:number|null;cadence:'monthly'|'quarterly'|'yearly';pullDay:number|null;pullMonths:number[];category:string;account:string;active:boolean;effectiveFrom:string;effectiveUntil:string;splitMethod:'none'|SplitMethod;payerBasisPoints:number;version:string;nextDate:string|null;needsSetup:boolean;earliestEffectiveMonth:string;cancellationRequestId?:string|null;charge:Charge;nextChange?:Bill|null;prediction?:BillPrediction|null;checkInLeadDays?:number|null}
type Snapshot={month:string;today:string;settingsVersion:string;ownerName:string;partnerName:string;incomeBasisPoints:number;splitsEnabled:boolean;bills:Bill[];pendingCommand?:Command;earliestStopMonth?:string;pendingFlow?:BillSaveFlow}
type Form={name:string;type:Bill['type'];amount:string;cadence:Bill['cadence'];pullDay:string;paymentDate:string;firstMonth:number;category:string;account:string;effectiveFrom:string;stopFrom:string;splitMethod:Bill['splitMethod'];payerBasisPoints:number}
type Command=Record<string,unknown>&{operation:string;requestId?:string;reviewVersion?:string}
type Review={operation:string;reviewVersion:string;name?:string;amountCents?:number;month?:string;date?:string;previousDate?:string|null;effectiveFrom?:string;before?:Bill|null;after?:Bill;share?:{method:string;payerName?:string;partnerName?:string;payerCents:number;partnerCents:number};replacesScheduledChanges?:boolean;currentChange?:BillCurrentChange|null;applyCurrentCharge?:boolean;currentPaymentDate?:{month:string;previousDate:string|null;date:string};applyCurrentPaymentDate?:boolean;cancellation?:BillEndReviewData}
type Result={state:string;success?:boolean;detail?:string;splitPending?:boolean;transaction?:{id:string;month:string};historyCommands?:Command[];recoveryReview?:Review}
type Mode='settings'|'date'|'amount'|'monthly'|'stop'|'adopt'|'split'|'offer'|'charge'|'sharing'|'shared'
type Draft={form:Form;mode:Mode;amount:string;review:Review|null;reviewBody:Command|null;splitInput:SplitInputDraft;valid:boolean;draftId:string;splitBefore:{method:Form['splitMethod'];basis:number}|null}
const money=(cents:number|null|undefined)=>cents===null||cents===undefined?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
const monthLabel=(value:string)=>new Date(value+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})
const kindLabel={subscription:'Subscription',variable:'Variable bill',fixed:'Fixed bill'}
const categoryLabels:Record<string,string>={rent:'Rent',bills_utilities:'Bills & utilities',static_bills_subscriptions_needs:'Needs',subscriptions_wants:'Wants'}
class BillRequestError extends Error {constructor(message:string,public status:number){super(message)}}
async function request(path:string,body?:unknown,signal?:AbortSignal){
 const controller=new AbortController();let timedOut=false
 const cancel=()=>controller.abort();if(signal?.aborted)cancel();signal?.addEventListener('abort',cancel,{once:true})
 const deadline=window.setTimeout(()=>{timedOut=true;controller.abort()},30_000)
 try{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',mode:'same-origin',referrerPolicy:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-BookieBot-App':'1'},body:body?JSON.stringify(body):undefined,signal:controller.signal})
  const value=await response.json();if(!response.ok)throw new BillRequestError(value.error||'Could not load Bills.',response.status);return value
 }catch(error){if(timedOut)throw new BillRequestError('Bills took too long to respond. Check saved status before repeating a change.',0);throw error}
 finally{window.clearTimeout(deadline);signal?.removeEventListener('abort',cancel)}
}
function newForm(snapshot:Snapshot,source?:Bill):Form{const bill=source?.nextChange??source;return {name:bill?.name??'',type:bill?.type??'subscription',amount:bill?.amountCents==null?'':(bill.amountCents/100).toFixed(2),cadence:bill?.cadence??'monthly',pullDay:String(bill?.pullDay??1),paymentDate:source?.charge.date??'',firstMonth:bill?.pullMonths[0]??Number(snapshot.month.slice(5)),category:bill?.type==='subscription'&&!['static_bills_subscriptions_needs','subscriptions_wants'].includes(bill.category)?'static_bills_subscriptions_needs':bill?.category??'static_bills_subscriptions_needs',account:bill?.account??'',effectiveFrom:source?.nextChange?.effectiveFrom??snapshot.month,stopFrom:source?.nextChange?.active===false?source.nextChange.effectiveFrom:source&&!source.active?source.effectiveFrom:recurringStartMonth(snapshot.month,source?.earliestEffectiveMonth),splitMethod:bill?.splitMethod??'none',payerBasisPoints:bill?.payerBasisPoints??snapshot.incomeBasisPoints}}

export function BillSettings({active,ownerName,aliases,amountRequest,onAmountConsumed}:{active:boolean;ownerName:string;aliases?:Record<string,string>;amountRequest?:BillAmountRequest|null;onAmountConsumed?:()=>void}){
 const showRefresh=useAppNavigation()?.duoLandscape===true
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[filter,setFilter]=useState('all'),[selected,setSelected]=useState<Bill|null>(null),[form,setForm]=useState<Form|null>(null)
 const [mode,setMode]=useState<Mode>('settings'),[amount,setAmount]=useState(''),[review,setReview]=useState<Review|null>(null),[reviewBody,setReviewBody]=useState<Command|null>(null)
 const [busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null),[pending,setPending]=useState<Command|null>(null),[valid,setValid]=useState(true)
 const [splitInput,setSplitInput]=useState<SplitInputDraft>(null)
 const [confirmReady,setConfirmReady]=useState(false)
 const [sharingBlocked,setSharingBlocked]=useState(false),[sharingRecovery,setSharingRecovery]=useState(()=>readSharingJournal(ownerName))
 const root=useRef<HTMLDivElement>(null),rowPositions=useRef(new Map<string,DOMRect>()),rowMotion=useRef<Animation[]>([])
 const captureRows=()=>{rowPositions.current=new Map([...root.current?.querySelectorAll<HTMLElement>('.bb-bills-row-shell')??[]].map(node=>[node.querySelector<HTMLElement>('[data-bill-id]')!.dataset.billId!,node.getBoundingClientRect()]))}
 const flowKey=billFlowKey(ownerName),flowRef=useRef<BillSaveFlow|null>(null),order=useRef<string[]|null>(null)
 const [flow,setFlow]=useState<BillSaveFlow|null>(null),[anchors,setAnchors]=useState<string[]>([])
 const [currentIntent,setCurrentIntent]=useState<CurrentBillIntent|null>(null),[newRequested,setNewRequested]=useState(false)
 const refreshRegistry=usePageRefreshRegistry()
 const work=useAppWorkGuard(),currentLocked=work.pending||work.uncertain
 const wasActive=useRef(false)
 const splitBefore=useRef<{method:Form['splitMethod'];basis:number}|null>(null)
 const followKey=`bookiebot:bill-current:${ownerName.toLowerCase()}`
 const drafts=useRef(new Map<string,Draft>())
 const flight=useRef(false),alive=useRef(true),generation=useRef(0),draftId=useRef(''),abort=useRef<AbortController|null>(null)
 const placement=useRef<{order:number;isNew:boolean;billId?:string}>({order:1,isNew:true})
 const storageKey=`bookiebot:bills-request:${ownerName.toLowerCase()}`
 const reset=useCallback(()=>{drafts.current.clear();setForm(null);setSelected(null);setReview(null);setReviewBody(null);setMode('settings');setAmount('');setError('');setValid(true);setSplitInput(null);setConfirmReady(false);setCurrentIntent(null);splitBefore.current=null;try{sessionStorage.removeItem(followKey)}catch{}},[followKey])
 const updateWork=useAppWorkStatus({label:'Bill changes',pending:busy&&Boolean(form||pending||flow),uncertain:Boolean(pending||flow?.pending),dirty:Boolean(form),onDiscard:reset})
 const load=useCallback(async(fresh=true)=>{
  const token=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('')
  try{const next=await request(fresh?'/app/bills?fresh=1':'/app/bills',undefined,controller.signal) as Snapshot;if(!alive.current||token!==generation.current)return false
   if(next.ownerName?.toLowerCase()!==ownerName.toLowerCase())throw new Error('Your budget profile changed. Reopen BookieBot.');
   if(!Array.isArray(next.bills)||!next.settingsVersion)throw new Error('Bills could not be read completely.')
   if(next.pendingFlow&&!flowRef.current){sessionStorage.setItem(flowKey,JSON.stringify(next.pendingFlow));flowRef.current=next.pendingFlow;setFlow(next.pendingFlow)};if(!order.current)captureRows();setSnapshot(next);try{const follow=JSON.parse(sessionStorage.getItem(followKey)||'null') as CurrentBillIntent|null;if(follow&&(follow.stage==='charge'||follow.stage==='adopt'||follow.stage==='offer')){setCurrentIntent(follow);setSelected(next.bills.find(b=>b.id===follow.id)??null);setForm(newForm(next,next.bills.find(b=>b.id===follow.id)));setMode(follow.stage)}}catch{};if(flowRef.current){const retained=flowRef.current;order.current=retained.rowOrder??order.current??next.bills.map(b=>b.id);const id=retained.current?.id??retained.configuration?.id;const bill=next.bills.find(b=>b.id===id);setSelected(bill??null);setForm(newForm(next,bill));if(retained.presentation)setReview(retained.presentation as Review)};if(next.pendingCommand&&!flowRef.current){setPending(next.pendingCommand);try{sessionStorage.setItem(storageKey,JSON.stringify(next.pendingCommand))}catch{}};return true
  }catch(e){if(alive.current&&token===generation.current&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:'Could not load Bills.');return false}
  finally{if(alive.current&&token===generation.current)setBusy(false)}
 },[storageKey,followKey])
 usePageRefresh(active?'settings':null,{refresh:async()=>{setRefreshing(true);try{return await load()}finally{setRefreshing(false)}},disabled:busy||Boolean(pending)||currentLocked})
 useEffect(()=>{alive.current=true;try{const retained=JSON.parse(sessionStorage.getItem(flowKey)||'null');if(retained?.version===1){if(retained.stage==='done')sessionStorage.removeItem(flowKey);else{flowRef.current=retained;setFlow(retained)}}else{const saved=sessionStorage.getItem(storageKey);if(saved)setPending(JSON.parse(saved))}}catch{}return()=>{alive.current=false;++generation.current;abort.current?.abort()}},[storageKey])
 useEffect(()=>{if(active&&!snapshot&&!flight.current)void load(false)},[active,snapshot,load])
 useEffect(()=>{if(wasActive.current&&!active&&!busy&&!pending&&!currentLocked&&!sharingBlocked&&!sharingRecovery){setNewRequested(false);reset()}wasActive.current=active},[active,busy,pending,currentLocked,sharingBlocked,sharingRecovery,reset])
 const choose=(bill?:Bill)=>{
  if(busy||pending||flow||currentLocked||sharingBlocked||sharingRecovery||!snapshot)return
  for(const animation of rowMotion.current)animation.finish();rowMotion.current=[]
  if(form&&bill?.id===selected?.id){if(bill)reset();return}
  const followup=mode==='charge'||mode==='offer'||mode==='adopt'
  if(followup){setCurrentIntent(null);try{sessionStorage.removeItem(followKey)}catch{}}
  if(form&&!followup)drafts.current.set(selected?.id??'new',{form,mode,amount,review,reviewBody,splitInput,valid,draftId:draftId.current,splitBefore:splitBefore.current})
  if(!order.current)order.current=snapshot.bills.map(b=>b.id)
  const draft=drafts.current.get(bill?.id??'new')
  setSelected(bill??null);setForm(draft?.form??newForm(snapshot,bill));setMode(bill?.readOnly?'shared':draft?.mode??'settings');setAmount(draft?.amount??'')
  setReview(draft?.review??null);setReviewBody(draft?.reviewBody??null);setSplitInput(draft?.splitInput??null);setValid(draft?.valid??true)
  draftId.current=draft?.draftId??crypto.randomUUID();setConfirmReady(false);setError('');setResult(null);splitBefore.current=draft?.splitBefore??null
 }
 const addBill=()=>{if(busy||pending||flow||currentLocked||sharingBlocked||sharingRecovery||!snapshot){setNewRequested(true);return}choose()}
 const openMonthly=(bill:Bill)=>{
  if(locked||!snapshot)return
  if(!form||selected?.id!==bill.id)choose(bill)
  setMode(bill.charge.recorded||bill.charge.amountCents?'monthly':'amount');setReview(null);setReviewBody(null);setAmount('')
 }
 useEffect(()=>{
  if(!active||!amountRequest||!snapshot||busy||pending||currentLocked)return
  const bill=snapshot.bills.find(b=>b.id===amountRequest.id)
  if(bill&&snapshot.month===amountRequest.month&&bill.charge.canConfirmAmount!==false)openMonthly(bill)
  else setError('This bill changed. Refresh Bills to check its amount.')
  onAmountConsumed?.()
 },[active,amountRequest,snapshot,busy,pending,currentLocked])
 const setCheckin=async(value:string)=>{
  if(!selected||locked)return
  setBusy(true);setError('')
  try{const next=await request('/app/bills/check-in/preferences',{id:selected.id,leadDays:value==='off'?null:Number(value)});setSelected(previous=>previous?{...previous,checkInLeadDays:next.leadDays}:null);setSnapshot(previous=>previous?{...previous,bills:previous.bills.map(b=>b.id===selected.id?{...b,checkInLeadDays:next.leadDays}:b)}:null)}
  catch(e){setError(e instanceof Error?e.message:'Could not save check-in.')}
  finally{setBusy(false)}
 }
 const editMonthly=()=>{
  if(!selected||!snapshot||locked)return
  setCurrentIntent({id:selected.id,month:snapshot.month,name:selected.name,amountCents:null,method:selected.splitMethod,basis:selected.payerBasisPoints,stage:'charge',editAmount:!selected.charge.splitPending});setMode('charge')
 }
 useEffect(()=>{if(newRequested&&active&&!busy&&!pending&&!flow&&!currentLocked&&snapshot){setNewRequested(false);choose()}},[newRequested,active,busy,pending,currentLocked,snapshot])
 // Confirmation is a separate action after the review's native slide settles.
 useEffect(()=>{setConfirmReady(false);if(!review)return;const timer=window.setTimeout(()=>setConfirmReady(true),transactionMotion.duration);return()=>window.clearTimeout(timer)},[review,selected?.id])
 // A compact creation review is shorter than its form. Keep its heading out
 // from under the fixed Settings capsule after the native slide settles.
 useEffect(()=>{
  if(review?.operation!=='create'||!root.current)return
  const timer=window.setTimeout(()=>{
   const heading=root.current?.querySelector<HTMLElement>('.bb-bills-editor[data-open=true] .bi-step-review[aria-hidden=false] h2')
   const capsule=document.querySelector<HTMLElement>('.bb-settings-masthead-title')
   if(!heading||!capsule)return
   const pane = showRefresh ? root.current?.closest('.bb-settings-detail') : null
   const top = pane?.getBoundingClientRect().top ?? capsule.getBoundingClientRect().bottom
   const delta=heading.getBoundingClientRect().top-top-12
   const behavior=matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'
   if(delta<0){
    if(pane)pane.scrollBy({top:delta,behavior})
    else scrollPageTo({top:readPageScroll().y+delta,behavior})
   }
  },transactionMotion.duration)
  return()=>window.clearTimeout(timer)
 },[review,showRefresh])
 const change=(patch:Partial<Form>)=>{setForm(previous=>previous?{...previous,...patch}:null);setReview(null);setReviewBody(null);setError('')}
 const prepare=async(operation=selected?'update':'create',{applyCurrentCharge=false,applyCurrentPaymentDate=false,removeMonths}:{applyCurrentCharge?:boolean;applyCurrentPaymentDate?:boolean;removeMonths?:string[]}={})=>{
  if(flight.current||pending||!form||!snapshot)return
  flight.current=true;setBusy(true);setConfirmReady(false);setError('');setResult(null)
  const base:Command={operation,...(['create','update'].includes(operation)?{applyCurrentCharge}:{}),...(applyCurrentPaymentDate?{applyCurrentPaymentDate}:{}),settingsVersion:snapshot.settingsVersion,...(selected?{id:selected.id,version:selected.version}:{draftId:draftId.current})}
  let body:Command
  if(operation==='payment-date')body={operation,id:selected?.id,month:snapshot.month,chargeVersion:selected?.charge.version,paymentDate:form.paymentDate}
  else if(operation==='amount'||operation==='adopt')body={operation,id:selected?.id,month:snapshot.month,settingsVersion:snapshot.settingsVersion,chargeVersion:selected?.charge.version,...(operation==='amount'?{amount}: {})}
  else if(operation==='delete'||operation==='end')body={...base,effectiveFrom:form.stopFrom,...(removeMonths?{removeMonths}: {})}
  else if(operation==='restore-end')body={...base,undoOf:selected?.cancellationRequestId}
  else{const {firstMonth,stopFrom,paymentDate,...fields}=form;body={...base,bill:{...fields,pullDay:Number(fields.pullDay),effectiveFrom:fields.effectiveFrom,pullMonths:form.cadence==='monthly'?[]:form.cadence==='yearly'?[firstMonth]:[0,3,6,9].map(n=>(firstMonth-1+n)%12+1).sort((a,b)=>a-b)}}}
  try{const next=await request('/app/bills/review',body);if(alive.current){setReview(next.review);setReviewBody(next.review.cancellation&&operation==='end'?{...body,removeMonths:next.review.cancellation.removeMonths}:body)}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not review bill.')}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 // Resume confirmations already made by the previous multi-screen release.
 // New recurring confirmations use executeFlow and never enter offer/adopt UI.
 const accept=async(next:Result,command:Command)=>{
  setResult(next)
  if(next.state==='done'&&next.success&&['end','restore-end'].includes(command.operation)&&next.historyCommands?.length){
   const retained:BillSaveFlow={version:1,stage:'history',configuration:command,historyCommands:next.historyCommands,historyIndex:0,presentation:next.recoveryReview,rowOrder:order.current??undefined}
   sessionStorage.setItem(flowKey,JSON.stringify(retained));flowRef.current=retained;setFlow(retained);setPending(null);sessionStorage.removeItem(storageKey);await load();return
  }
  if(next.state==='done'){
   let follow:CurrentBillIntent|null=null;try{follow=JSON.parse(sessionStorage.getItem(followKey)||'null')}catch{}
   const ownsFollow=follow&&(follow.stage==='configuration'&&command.operation==='update'&&follow.requestId===command.requestId&&command.id===follow.id||follow.stage==='adopt'&&command.operation==='adopt'&&command.id===follow.id)
   if(next.success&&follow&&ownsFollow){
    const stage={...follow,stage:follow.stage==='configuration'&&follow.offerCurrent?'offer' as const:follow.stage==='configuration'&&follow.needsAdoption?'adopt' as const:'charge' as const};sessionStorage.setItem(followKey,JSON.stringify(stage));setCurrentIntent(stage)
    // Adoption is separately reviewed before opening a virtual occurrence.
    setMode(stage.stage);setReview(null);setReviewBody(null)
   }else reset()
   setPending(null);try{sessionStorage.removeItem(storageKey)}catch{}
   if(next.success){window.dispatchEvent(new Event('bookiebot:transactions-changed'));window.dispatchEvent(new Event('bookiebot:reimbursements-changed'))}
   await load()
  }
 }
 const executeFlow=async(next:BillSaveFlow,recover=false,retry=false)=>{
  if(flight.current)return
  flight.current=true;setBusy(true);setError('')
  const persist=(value:BillSaveFlow)=>{sessionStorage.setItem(flowKey,JSON.stringify(value));flowRef.current=value;if(alive.current)setFlow(value)}
  try{
   await runBillFlow(next,request,persist,{recover,retry})
   sessionStorage.removeItem(flowKey);flowRef.current=null;setFlow(null);reset();setResult({state:'done',success:true,detail:'Bill changes saved.'})
   window.dispatchEvent(new Event('bookiebot:transactions-changed'));window.dispatchEvent(new Event('bookiebot:reimbursements-changed'));await load()
  }catch(e){if(alive.current)setError((next.configuration&&next.stage!=='configuration'?'Recurring settings are saved. ':'')+(e instanceof Error?e.message:'Check saved status before continuing.'))}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const save=async()=>{
  if(flight.current||pending||flow||!review||!reviewBody||!confirmReady)return
  const command={...reviewBody,requestId:crypto.randomUUID(),reviewVersion:review.reviewVersion}
  if(['create','update','delete','end','restore-end'].includes(command.operation)){
   const next=billFlow(command,review.applyCurrentCharge&&review.currentChange?review.currentChange:undefined)
   if(review.cancellation)next.historyCommands=review.cancellation.historyCommands
   next.presentation=review;next.rowOrder=order.current??snapshot?.bills.map(b=>b.id)
   await executeFlow(next);return
  }
  try{sessionStorage.setItem(storageKey,JSON.stringify(command))}catch{setError('Saved-status storage is unavailable. Reopen BookieBot before confirming this change.');return}
  flight.current=true;setBusy(true);setPending(command);updateWork({label:'Bill changes',pending:true,uncertain:true})
  try{await accept(await request('/app/bills',command),command)}catch(e){if(alive.current){if(e instanceof BillRequestError&&[400,403,409].includes(e.status))await accept({state:'done',success:false,detail:e.message},command);else setResult({state:'uncertain',detail:e instanceof Error?e.message:'Check saved status.'})}}
  finally{flight.current=false;if(alive.current)setBusy(false)}
 }
 const checkSaved=async(retry=false)=>{if(flight.current||!pending?.requestId)return;flight.current=true;setBusy(true);setError('');try{await accept(await request(retry?'/app/bills':`/app/bills/commands/${encodeURIComponent(pending.requestId)}`,retry?pending:undefined),pending)}catch(e){setError(e instanceof Error?e.message:'Could not check saved status.')}finally{flight.current=false;setBusy(false)}}
 const reviewCurrent=()=>{if(!currentIntent||busy||pending||currentLocked)return;const next={...currentIntent,stage:currentIntent.needsAdoption?'adopt' as const:'charge' as const};try{sessionStorage.setItem(followKey,JSON.stringify(next))}catch{setError('Keep this screen open and retry the current-charge review.');return}setCurrentIntent(next);setMode(next.stage);setReview(null);setReviewBody(null)}
 const selectedIncome=form?.splitMethod==='income'?snapshot?.incomeBasisPoints??5000:form?.splitMethod==='equal'?5000:form?.splitMethod==='fronted'?0:form?.payerBasisPoints??10000
 const releaseRows=()=>{if(flowRef.current)return;captureRows();order.current=null;setAnchors([]);setSnapshot(value=>value?{...value}:value)}
 useLayoutEffect(()=>{
  if(!rowPositions.current.size)return
  const before=rowPositions.current;rowPositions.current=new Map()
  for(const animation of rowMotion.current)animation.finish();rowMotion.current=[]
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return
  for(const node of root.current?.querySelectorAll<HTMLElement>('.bb-bills-row-shell')??[]){const old=before.get(node.querySelector<HTMLElement>('[data-bill-id]')!.dataset.billId!),now=node.getBoundingClientRect();if(old&&Math.abs(old.y-now.y)>.5)rowMotion.current.push(node.animate([{transform:`translateY(${old.y-now.y}px)`},{transform:'none'}],{duration:440,easing:'cubic-bezier(.2,.8,.25,1)'}))}
 },[snapshot,anchors])
 const ordered=order.current&&snapshot?[...snapshot.bills].sort((a,b)=>{const rank=(id:string)=>{const i=order.current!.indexOf(id);return i<0?order.current!.length:i};return rank(a.id)-rank(b.id)}):snapshot?.bills
 const visible=ordered?.filter(b=>(filter==='ended'?!b.active:b.active&&(filter==='all'||(b.nextChange??b).type===filter))||Boolean(form)&&b.id===selected?.id||anchors.includes(b.id)||Boolean(order.current)&&b.id===placement.current.billId)??[]
 // Keep the editor's row anchor through its closing expansion. Folding changes
 // only the grid placement, never the mounted scenes or controlled draft.
 if(form)placement.current={order:selected?visible.findIndex(bill=>bill.id===selected.id)*2+3:1,isNew:!selected,billId:selected?.id}
 const locked=busy||Boolean(pending)||Boolean(flow)||currentLocked||sharingBlocked||Boolean(sharingRecovery),lastReview=useRef<Review|null>(null)
 if(review)lastReview.current=review
 const shownReview=review??lastReview.current
 const splitLabel=(bill:Pick<Bill,'splitMethod'|'payerBasisPoints'>)=>bill.splitMethod==='none'?'No split':bill.splitMethod==='income'?'By income':bill.splitMethod==='equal'?'50 / 50':bill.splitMethod==='fronted'?`100% ${snapshot?.partnerName}`:`${(bill.payerBasisPoints/100).toFixed(2)}% ${snapshot?.ownerName}`
 const dateLabel=(value:string|null|undefined)=>value?new Date(value+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'Not set'
 const reviewLines=shownReview?.operation==='payment-date'?[{label:'Payment date',before:dateLabel(shownReview.previousDate),after:dateLabel(shownReview.date)}]:shownReview?.after?billReviewLines(shownReview.before,shownReview.after,shownReview.operation):shownReview?.currentChange?currentReviewLines(shownReview.currentChange):shownReview?.share&&shownReview.share.method!=='none'?[
  {label:snapshot?.ownerName??'',before:null,after:money(shownReview.share.payerCents)},
  {label:snapshot?.partnerName??'',before:null,after:money(shownReview.share.partnerCents)},
 ]:[]
 const allReviewLines=shownReview?.after&&shownReview.applyCurrentCharge&&shownReview.currentChange?[...reviewLines,...currentReviewLines(shownReview.currentChange).map(line=>({...line,label:new Date(shownReview.currentChange!.month+'-01T12:00:00').toLocaleDateString('en-US',{month:'short'})+' · '+line.label}))]:[...reviewLines]
 const currentDate=shownReview?.currentPaymentDate
 if(currentDate&&shownReview?.applyCurrentPaymentDate)allReviewLines.push({label:monthLabel(currentDate.month).split(' ')[0]+' · Payment date',before:dateLabel(currentDate.previousDate),after:dateLabel(currentDate.date)})
 const heading=mode==='date'?'Edit payment date':mode==='split'?'Recurring split':mode==='amount'?'Monthly amount':mode==='monthly'?'This month’s bill':mode==='adopt'?'Recorded charge':mode==='stop'?'Stop bill':selected?((selected.nextChange??selected).active?'Edit bill':'Restart bill'):'New bill'
 const dueLabel=selected?.charge.date?new Date(selected.charge.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'Set a payment day'
 const reminder=selected&&selected.charge.canConfirmAmount!==false&&<label className="bb-bills-reminder">Amount check-in<span className="bi-select"><select aria-label="Amount check-in" disabled={locked} value={selected.checkInLeadDays===null?'off':selected.checkInLeadDays??7} onChange={e=>void setCheckin(e.target.value)}>{[1,3,7,14,30].map(n=><option key={n} value={n}>{n} {n===1?'day':'days'} before</option>)}<option value="off">Off</option></select><ChevronDown aria-hidden="true"/></span></label>
 const editView=form&&snapshot&&(selected&&(mode==='sharing'||mode==='shared')?<BillSharingEditor bill={selected} ownerName={ownerName} partnerName={snapshot.partnerName} onClose={()=>selected.readOnly?reset():setMode('settings')} onSaved={()=>{reset();void load()}} onBlock={setSharingBlocked}/>:mode==='offer'&&currentIntent?<BillCurrentOffer intent={currentIntent} locked={locked} onKeep={()=>{reset();void load()}} onReview={reviewCurrent}/>:<>
  <header className="sp-flow-heading bb-bill-heading bb-bill-edit-heading"><h2>{heading}</h2>{mode==='split'&&<button type="button" className="bi-cancel bb-bills-remove-split" disabled={locked} onClick={()=>{change({splitMethod:'none'});setSplitInput(null);setValid(true);setMode('settings')}}>Remove split</button>}{selected?.cancellationRequestId&&mode==='settings'&&<button type="button" className="bb-bills-undo-end" aria-label="Undo cancellation" title="Undo cancellation" disabled={locked} onClick={()=>void prepare('restore-end')}><RotateCcw aria-hidden="true"/></button>}{selected&&mode==='settings'&&<button type="button" className="bb-bills-share" aria-label="Share bill" disabled={locked} onClick={()=>setMode('sharing')}><UsersRound aria-hidden="true"/></button>}{selected&&mode==='settings'&&<button type="button" className="bb-bills-stop" aria-label="Stop bill" disabled={locked} onClick={()=>setMode('stop')}><Trash2 aria-hidden="true"/></button>}</header>
  <form className="bi-fields bb-bills-form" data-editor-mode={mode} onSubmit={e=>{e.preventDefault();if(mode==='split'){if(valid&&!locked)setMode('settings');return}if(mode==='monthly'||mode==='date'&&(!form.paymentDate||form.paymentDate===selected?.charge.date))return;void prepare(mode==='date'?'payment-date':mode==='stop'?'end':mode==='amount'?'amount':mode==='adopt'?'adopt':selected?'update':'create')}}>
   {mode==='split'?<>
    <div className="sp-management"><NotchedSplitControl unit="percent" inputDraft={splitInput} onInputDraft={setSplitInput} total={10000} payerCents={selectedIncome} method={form.splitMethod==='none'?'income':form.splitMethod} incomeBasis={snapshot.incomeBasisPoints} capture={6} payerName={snapshot.ownerName} partnerName={snapshot.partnerName} disabled={locked} onChange={(payerBasisPoints,splitMethod)=>change({payerBasisPoints,splitMethod})} onValidityChange={setValid}/></div>
   </>:mode==='date'?<><label>Payment date<input type="date" aria-label="Payment date" required min={snapshot.month+'-01'}
     max={snapshot.month+'-'+new Date(Number(snapshot.month.slice(0,4)),Number(snapshot.month.slice(5)),0).getDate()}
     value={form.paymentDate} disabled={locked} onChange={e=>change({paymentDate:e.target.value})}/></label><p className="bi-footnote">This month’s charge only.</p>
   </>:mode==='amount'||mode==='monthly'||mode==='adopt'?<>
    {mode==='amount'?<><label>Bill amount<span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label="Bill amount" inputMode="decimal" required value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></span></label><p className="bb-bills-month-status"><Clock3 aria-hidden="true"/>Autopay · {dueLabel}</p>{reminder}</>:mode==='monthly'?<><p className="bb-bills-month-amount">{money(selected?.charge.billAmountCents??selected?.charge.amountCents)}</p><p className="bb-bills-month-status">{selected?.charge.status==='paid'?<Check aria-hidden="true"/>:<Clock3 aria-hidden="true"/>}{selected?.charge.status==='paid'?'Paid':'Autopay'} · {dueLabel}</p><p className="bi-footnote">{selected?.charge.status==='paid'?'Included in Transactions.':'Amount confirmed. Appears in Transactions on the autopay date.'}</p>{selected?.charge.canEditPaymentDate&&<button type="button" className="bb-settings-action" disabled={locked} onClick={()=>{change({paymentDate:selected.charge.date??''});setMode('date')}}>Edit payment date</button>}{selected?.type==='variable'&&reminder}</>:<p className="bi-footnote">Review this {money(selected?.amountCents)} recorded charge here. Its purchase total is preserved.</p>}
   </>:<>
    {selected&&mode==='settings'&&selected.active&&selected.charge.available&&(selected.type==='variable'||selected.charge.canEditPaymentDate)&&selected.charge.canConfirmAmount!==false&&<div className="bb-bills-charge-actions">
     <button type="button" className="bb-settings-action" aria-label={selected.charge.recorded||selected.charge.amountCents?'This month’s bill':'Enter monthly amount'} disabled={locked} onClick={()=>openMonthly(selected)}><span>{selected.charge.recorded||selected.charge.amountCents?'This month’s bill':'Enter monthly amount'}</span><ChevronRight aria-hidden="true"/></button>
    </div>}
    {mode==='stop'?<p className="bi-footnote">Choose when billing ended. Review individual charges before removing them.</p>:<>
     <label data-bill-field="name">Name<input className="bb-bills-input" required maxLength={100} value={form.name} onChange={e=>change({name:e.target.value})}/></label>
     <div className="bi-secondary-fields">
      <label data-bill-field="type">Type<span className="bi-select"><select aria-label="Type" value={form.type} onChange={e=>change({type:e.target.value as Form['type'],category:e.target.value==='subscription'&&!['static_bills_subscriptions_needs','subscriptions_wants'].includes(form.category)?'static_bills_subscriptions_needs':form.category,cadence:form.cadence})}><option value="subscription">Subscription</option><option value="variable">Variable bill</option><option value="fixed">Fixed bill</option></select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="amount"><span>{form.type==='variable'?'Estimate (optional)':'Recurring amount'}</span><span className="bi-money-input"><span aria-hidden="true">$</span><input className="bb-bills-input" aria-label={form.type==='variable'?'Estimate (optional)':'Recurring amount'} required={form.type!=='variable'} inputMode="decimal" placeholder="0.00" value={form.amount} onChange={e=>change({amount:e.target.value})}/></span></label>
     </div>
     <div className="bi-secondary-fields">
      <label data-bill-field="cadence">Repeats<span className="bi-select"><select aria-label="Repeats" value={form.cadence} onChange={e=>change({cadence:e.target.value as Form['cadence']})}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="day">Payment day<input className="bb-bills-input" type="text" inputMode="numeric" pattern="(?:[1-9]|[12][0-9]|3[01])" required value={form.pullDay} onChange={e=>{if(/^\d{0,2}$/.test(e.target.value))change({pullDay:e.target.value})}}/></label>
     </div>
     {form.cadence!=='monthly'&&<label data-bill-field="billing-month"><span>{form.cadence==='yearly'?'Billing month':'First billing month'}</span><span className="bi-select"><select aria-label={form.cadence==='yearly'?'Billing month':'First billing month'} value={form.firstMonth} onChange={e=>change({firstMonth:Number(e.target.value)})}>{Array.from({length:12},(_,i)=><option value={i+1} key={i}>{new Date(2026,i,1).toLocaleDateString('en-US',{month:'long'})}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>}
     <div className="bi-secondary-fields">
      <label data-bill-field="category"><span>Budget category</span><span className="bi-select"><select aria-label="Budget category" value={form.category} onChange={e=>change({category:e.target.value})}>{Object.entries(categoryLabels).filter(([key])=>form.type!=='subscription'||['static_bills_subscriptions_needs','subscriptions_wants'].includes(key)).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>
      <label data-bill-field="account">Account<input className="bb-bills-input" maxLength={80} value={form.account} placeholder="Optional" onChange={e=>change({account:e.target.value})}/></label>
     </div>
    </>}
    {mode==='settings'&&<label data-bill-field="starting-month">Applies from<input className="bb-bills-input" type="month" required min={snapshot.month} value={form.effectiveFrom} onChange={e=>change({effectiveFrom:e.target.value})}/></label>}
    {mode==='stop'&&<label data-bill-field="starting-month">Stop from<input className="bb-bills-input" type="month" required min={snapshot.earliestStopMonth??snapshot.month} value={form.stopFrom} onChange={e=>change({stopFrom:e.target.value})}/></label>}
    {mode!=='stop'&&<button type="button" className="bb-settings-action bb-bills-split-action" data-bill-field="split" disabled={locked||!snapshot.splitsEnabled&&form.splitMethod==='none'} onClick={()=>{splitBefore.current={method:form.splitMethod,basis:form.payerBasisPoints};if(form.splitMethod==='none')change({splitMethod:'income',payerBasisPoints:snapshot.incomeBasisPoints});setMode('split')}}><span>Recurring split<small>{form.splitMethod==='none'?'No split':splitLabel(form)}</small></span><ChevronRight aria-hidden="true"/></button>}
   </>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={mode==='settings'?reset:()=>{if(mode==='split'&&splitBefore.current){change({splitMethod:splitBefore.current.method,payerBasisPoints:splitBefore.current.basis});setSplitInput(null);setValid(true)}setMode(mode==='date'?'monthly':'settings')}}>{mode==='monthly'||mode==='date'?'Back':'Cancel'}</button>{mode==='monthly'?selected?.charge.canConfirmAmount!==false&&<button className="bi-primary" type="button" disabled={locked} onClick={editMonthly}>{selected?.charge.splitPending?'Review split':'Edit amount'}</button>:mode==='split'?<button className="bi-primary" type="button" disabled={locked||!valid} onClick={()=>setMode('settings')}>Use split</button>:<button className="bi-primary" type="submit" disabled={locked||!valid||mode==='date'&&(!form.paymentDate||form.paymentDate===selected?.charge.date)}>{busy?'Preparing…':'Review'}</button>}</footer>
  </form>
 </>)
 const reviewView=shownReview&&<>
  <header className="sp-flow-heading bb-bill-heading bb-bills-review-heading" data-current-choice={Boolean(shownReview.currentChange&&shownReview.after)}><h2>{shownReview.operation==='delete'||shownReview.operation==='end'?'Stop bill':shownReview.operation==='restore-end'?'Restore bill':shownReview.operation==='adopt'?'Edit recorded charge':shownReview.operation==='amount'?'Confirm amount':shownReview.operation==='current'?'Review charge':shownReview.operation==='payment-date'?'Review payment date':'Review bill'}</h2>{shownReview.currentChange&&shownReview.after&&<label className="bb-bills-current-choice"><input type="checkbox" checked={Boolean(shownReview.applyCurrentCharge)} disabled={locked||Boolean(shownReview.currentChange.blockedReason)} onChange={e=>void prepare(shownReview.operation,{applyCurrentCharge:e.target.checked,applyCurrentPaymentDate:shownReview.applyCurrentPaymentDate})}/><span>Also update {monthLabel(shownReview.currentChange.month).split(' ')[0]}’s charge</span></label>}<p className="sp-flow-context bb-bills-review-context"><span title={shownReview.after?.name??shownReview.name??selected?.name}>{shownReview.after?.name??shownReview.name??selected?.name}</span>{shownReview.after&&<span> · {kindLabel[shownReview.after.type]}</span>}</p></header>
  {!shownReview.after&&typeof shownReview.amountCents==='number'&&<p className="bb-bills-review-amount">{money(shownReview.amountCents)}</p>}
  <dl className="bi-review-changes" aria-label="Bill changes to review" data-dense={allReviewLines.length>5} data-new-bill={!selected&&shownReview.operation==='create'}>{allReviewLines.map(line=><div className="bi-review-change" data-review-field={line.label} key={line.label}><dt>{line.label}</dt><dd>{line.before!==null&&line.before!==line.after&&<><del title={line.before}>{line.before}</del><span className="bi-review-new"><ArrowRight aria-hidden="true"/><span title={line.after}>{line.after}</span></span></>}{(line.before===null||line.before===line.after)&&<span className="bi-review-new" title={line.after}>{line.after}</span>}</dd></div>)}</dl>

  {currentDate&&<label className="bb-bills-current-choice"><input type="checkbox" checked={Boolean(shownReview.applyCurrentPaymentDate)} disabled={locked} onChange={e=>void prepare(shownReview.operation,{applyCurrentCharge:shownReview.applyCurrentCharge,applyCurrentPaymentDate:e.target.checked})}/><span>Also move {monthLabel(currentDate.month).split(' ')[0]}’s charge to {dateLabel(currentDate.date)}</span></label>}
  {shownReview.cancellation&&<BillEndReview value={shownReview.cancellation} locked={locked} onSelection={months=>void prepare('end',{removeMonths:months})}/>}
  {shownReview.currentChange?.blockedReason&&<p className="bi-footnote">{shownReview.currentChange.blockedReason}</p>}
  {shownReview.replacesScheduledChanges&&<p className="bi-footnote">Replaces later scheduled changes for this bill.</p>}
  {shownReview.operation==='amount'&&<p className="bi-footnote">Appears in Transactions on the saved autopay date. Early repayments stay in Shared.</p>}
  {shownReview.operation==='payment-date'&&<p className="bi-footnote">Moves this month’s charge. Amount, split and repayments stay the same.</p>}
  {shownReview.operation==='adopt'&&<p className="bi-footnote">Prepares this recorded charge for editing here. The purchase total stays unchanged.</p>}
  <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={()=>{setReview(null);setReviewBody(null)}}><ArrowLeft aria-hidden="true"/>Back</button><SavingButton type="button" className="bi-primary" disabled={locked||!review||!confirmReady} saving={busy&&Boolean(pending)} onClick={()=>void save()}>{shownReview.operation==='delete'||shownReview.operation==='end'?'Stop bill':shownReview.operation==='restore-end'?'Restore bill':shownReview.operation==='amount'?'Confirm amount':'Confirm'}</SavingButton></footer>
 </>
 return <div ref={root} className="bb-bills bi-product" data-tone="sage" aria-busy={busy}>

  <div className="bb-bills-notices">
  {sharingRecovery&&<BillSharingRecovery journal={sharingRecovery} ownerName={ownerName} onSaved={()=>{setSharingRecovery(null);void load()}} onBlock={setSharingBlocked}/>}
  {newRequested&&<p className="bb-bills-status" role="status">New bill will open after the current change is verified.</p>}
  {error&&(!form||Boolean(flow))&&<p className="bb-bills-error" role="alert">{error}</p>}
  {result?.detail&&<p role="status" className="bb-bills-status">{result.detail}</p>}
  {flow&&!busy&&<div className="bb-bills-recovery">{flow.pending?<><button type="button" onClick={()=>void executeFlow(flow,true)}>Check saved status</button><button type="button" onClick={()=>void executeFlow(flow,true,true)}>Retry same confirmation</button></>:<>{!flow.failed&&<button type="button" onClick={()=>void executeFlow(flow)}>Resume saved change</button>}<button type="button" onClick={()=>{sessionStorage.removeItem(flowKey);flowRef.current=null;setFlow(null);reset();void load()}}>Close</button></>}</div>}
  {pending&&<div className="bb-bills-recovery"><p role="status">Check the saved status before making another change.</p><button className="bb-bills-primary" type="button" disabled={busy} onClick={()=>void checkSaved()}>Check saved status</button><button type="button" className="bb-settings-action" disabled={busy} onClick={()=>void checkSaved(true)}>Retry same confirmation</button></div>}
  {!snapshot&&busy&&<ReportLoading label="Loading bills…"/>}
  {!snapshot&&!busy&&<button type="button" className="bb-settings-action" onClick={()=>void load()}>Reload Bills</button>}
  </div>
  {snapshot&&<div className="bb-bills-panes">
   <section className="bb-bills-list" aria-label="Your bills">
    <div className="bb-bills-toolbar"><CategoryFilterControl filter={filter} onFilterChange={setFilter} filters={[{value:'all',label:'Active bills'},{value:'subscription',label:'Subscriptions'},{value:'variable',label:'Variable bills'},{value:'fixed',label:'Fixed bills'},{value:'ended',label:'Ended bills'}]} label="Bill type" dismissTrigger="bill-filter"/><button type="button" className="bb-bills-add" aria-busy={newRequested} onClick={addBill}><Plus aria-hidden="true"/>Add bill</button>{showRefresh&&<button type="button" className="bb-bills-refresh" aria-label="Refresh bills" disabled={locked} onClick={()=>{setResult(null);void refreshRegistry?.refresh('settings')}}><RefreshCw aria-hidden="true" className={refreshing?'bb-bills-refresh-spinning':undefined}/></button>}</div>
    <div className="bb-bills-rows"><div className="bb-bills-row-stack">{visible.map((bill,index)=>{
     const configured=bill.nextChange??bill,{cents:value,prediction,known}=billListAmount(bill)
     return <div className="bb-bills-row-shell" style={{order:index*2+2}} key={bill.id}>
      <button type="button" className="bb-bills-row" data-predicted={Boolean(prediction)} aria-pressed={bill.id===selected?.id} data-bill-id={bill.id} data-editor-anchor={bill.id===placement.current.billId} disabled={locked} onClick={()=>choose(bill)}>
       <TransactionIcon entry={{date:bill.nextDate??'',category:bill.category==='bills_utilities'?'Bills & Utilities':bill.category==='rent'?'Rent':bill.category==='subscriptions_wants'?'Subs (Wants)':'Static Bills & Subscriptions',amount:(value??0)/100,person:ownerName,item:configured.name,location:configured.name}} aliases={aliases}/>
       <span className="bb-bills-row-text"><strong>{configured.name}</strong><small>{bill.readOnly?`${bill.sharing?.status==='pending'?'Invitation':'Shared'} · Paid by ${bill.sharing?.payerName}`:!bill.active?'Ended':bill.nextChange?.active===false?`Ends ${monthLabel(bill.nextChange.effectiveFrom)}`:configured.needsSetup?'Finish setup':`${kindLabel[configured.type]} · ${configured.cadence}`}{bill.effectiveFrom>snapshot.month?` · From ${monthLabel(bill.effectiveFrom)}`:bill.nextChange?.active?` · ${bill.nextChange.active?'Changes':'Stops'} ${monthLabel(bill.nextChange.effectiveFrom)}`:''}</small></span>
       <span className="bb-bills-row-amount">{value==null?bill.active?'Amount needed':'—':money(value)}</span><ChevronRight aria-hidden="true"/>
      </button>
      {prediction&&<BillPredictionInfo items={[{label:configured.name,prediction}]}/>}
      {known&&bill.type==='variable'&&bill.charge.status==='confirmed'&&<button type="button" className="bb-bills-scheduled-icon" aria-label={`Scheduled ${bill.name}`} title={`Amount confirmed · autopay ${bill.charge.date??'date needed'}`} disabled={locked} onClick={()=>openMonthly(bill)}><Clock3 aria-hidden="true"/></button>}
     </div>
    })}
    {!visible.length&&<p className="bb-bills-empty">No bills here yet.</p>}</div></div>
   </section>
   <BillEditorWorkspace billId={selected?.id??'new'} order={placement.current.order} isNew={placement.current.isNew} open={Boolean(form)} locked={busy||Boolean(pending)||Boolean(flow)} onAnchorsChange={ids=>setAnchors(previous=>previous.length===ids.length&&previous.every((id,index)=>id===ids[index])?previous:ids)} onClosed={releaseRows}>
    <EditorScenes scene={`${selected?.id??draftId.current}:${mode}`} open={Boolean(form)}>
     <>{mode==='charge'&&currentIntent?<BillCurrentCharge intent={currentIntent} ownerName={ownerName} rowOrder={order.current??undefined} onDone={()=>{reset();void load()}}/>:<div className="bi-editor" data-design="levels" data-operation={mode==='stop'?'delete':'update'}>
      <StepMotion review={Boolean(review)} open={Boolean(form)} mode="slide" duration={transactionMotion.duration} edit={editView} confirm={reviewView}/>
      {error&&<p className="bs-error" role="alert">{error}</p>}
     </div>}</>
    </EditorScenes>
   </BillEditorWorkspace>
  </div>}
 </div>
}
