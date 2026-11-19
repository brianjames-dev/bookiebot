import {useState,type FormEvent,type ReactNode} from 'react'
import {useAppWorkStatus} from './app-work-guard'
import {goalAmountCents,type SavingsGoal} from './savings-goals'
import type {Account,Goal} from './savings-allocation'
export type Run=(body:Record<string,any>,done:()=>void)=>void
const localDate=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'})
export function GoalEditor({goal,disabled,run,close,iconControl,iconKey,accounts,accountId,onAccount}:{goal?:SavingsGoal;disabled:boolean;run:Run;close:()=>void;iconControl:ReactNode;iconKey:string;accounts:Account[];accountId:string;onAccount:(id:string)=>void}){
 const[name,setName]=useState(goal?.name??''),[target,setTarget]=useState(goal?(goal.targetCents/100).toFixed(2):''),[starting,setStarting]=useState(goal?(goal.startingCents/100).toFixed(2):'0'),[date,setDate]=useState(goal?.targetDate??''),[error,setError]=useState('')
 const[initial]=useState({name,target,starting,date,accountId,iconKey})
 useAppWorkStatus({label:goal?'Edit savings goal':'New savings goal',dirty:name!==initial.name||target!==initial.target||starting!==initial.starting||date!==initial.date||accountId!==initial.accountId||iconKey!==initial.iconKey,onDiscard:close})
 function submit(event:FormEvent){event.preventDefault();const targetCents=goalAmountCents(target),startingCents=goalAmountCents(starting);if(!name.trim()||targetCents===null||targetCents<=0||startingCents===null){setError('Enter a name, positive target, and valid starting allocation.');return}setError('');run({operation:goal?'edit':'create',...(goal?{goalId:goal.id,version:goal.version}:{}),name:name.trim(),targetCents,startingCents,targetDate:date,accountId},close)}
 return <form className="bi-fields sg-goal-form" onSubmit={submit}><fieldset disabled={disabled}>{iconControl}<label>Goal name<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Emergency fund"/></label><div className="bi-secondary-fields"><label>Target<span className="bi-money-input"><span aria-hidden="true">$</span><input required aria-label="Target" inputMode="decimal" value={target} onChange={e=>setTarget(e.target.value)}/></span></label><label>Starting allocation<span className="bi-money-input"><span aria-hidden="true">$</span><input required aria-label="Starting allocation" inputMode="decimal" value={starting} onChange={e=>setStarting(e.target.value)}/></span></label></div><div className="bi-secondary-fields"><label>Target date (optional)<span className="sc-date-field"><input type="date" min="1900-01-01" max="2200-12-31" value={date} onChange={e=>setDate(e.target.value)}/></span></label><label>Account<select value={accountId} disabled={Boolean(goal)} onChange={e=>onAccount(e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>{error&&<p role="alert">{error}</p>}<footer className="bi-editor-footer"><button className="bi-cancel" type="button" onClick={close}>Cancel</button><button className="bi-primary" type="submit">Review</button></footer></fieldset></form>
}
export function ContributionEditor({goal,disabled,run,close}:{goal:SavingsGoal;disabled:boolean;run:Run;close:()=>void}){
 const[amount,setAmount]=useState(''),[date,setDate]=useState(localDate),[note,setNote]=useState(''),[error,setError]=useState('')
 useAppWorkStatus({label:'Savings allocation',dirty:Boolean(amount||note||date!==localDate()),onDiscard:close})
 return <form className="bi-fields sg-goal-form" onSubmit={e=>{e.preventDefault();const cents=goalAmountCents(amount);if(cents===null||cents<=0){setError('Enter a positive amount with at most two decimal places.');return}setError('');run({operation:'contribute',goalId:goal.id,version:goal.version,amountCents:cents,date,note},close)}}><fieldset disabled={disabled}><div className="bi-secondary-fields"><label>Amount<span className="bi-money-input"><span aria-hidden="true">$</span><input required aria-label="Amount" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></span></label><label>Date<span className="sc-date-field"><input type="date" required max={localDate()} value={date} onChange={e=>setDate(e.target.value)}/></span></label></div><label>Note (optional)<input maxLength={200} value={note} onChange={e=>setNote(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<footer className="bi-editor-footer"><button className="bi-cancel" type="button" onClick={close}>Cancel</button><button className="bi-primary" type="submit">Review</button></footer></fieldset></form>
}

export function EndGoalEditor({goal, accounts, disabled, run, close, money}: {
  goal: Goal
  accounts: Account[]
  disabled: boolean
  run: Run
  close: () => void
  money: (cents: number) => string
}) {
  const [subtract, setSubtract] = useState(false)
  const [accountId, setAccountId] = useState(goal.accountId)
  const [amount, setAmount] = useState(() => (goal.balanceCents / 100).toFixed(2))
  const [error, setError] = useState('')
  const account = accounts.find(candidate => candidate.id === accountId)
  const released = goal.allocationsByAccount?.[accountId] ?? (accountId === goal.accountId ? goal.manualBalanceCents : 0)
  const limit = Math.max(0, (account?.availableCents ?? 0) + released)
  useAppWorkStatus({label: 'End savings goal', dirty: subtract, onDiscard: close})

  function submit(event: FormEvent) {
    event.preventDefault()
    const body = {operation: 'archive', goalId: goal.id, version: goal.version}
    if (!subtract) {
      run(body, close)
      return
    }
    const cents = goalAmountCents(amount)
    if (!account || cents === null || cents <= 0 || cents > limit) {
      setError('Enter a withdrawal within the cash available in this account.')
      return
    }
    setError('')
    run({...body, withdrawalAccountId: accountId, withdrawalCents: cents}, close)
  }

  return <form className="bi-fields sg-goal-form sw-end-form" onSubmit={submit}>
    <fieldset disabled={disabled}>
      <label className="sw-withdraw-option">
        <span>Subtract cash</span>
        <input type="checkbox" checked={subtract} onChange={event => {
          setSubtract(event.target.checked)
          setError('')
        }}/>
      </label>
      {subtract ? <>
        <div className="bi-secondary-fields">
          <label>From account<select value={accountId} onChange={event => {
            setAccountId(event.target.value)
            setError('')
          }}>
            {accounts.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select></label>
          <label>Withdrawal<span className="bi-money-input"><span aria-hidden="true">$</span>
            <input required aria-label="Withdrawal" inputMode="decimal" value={amount} onChange={event => {
              setAmount(event.target.value)
              setError('')
            }}/>
          </span></label>
        </div>
        <p className="bi-footnote">{money(limit)} available in this account after ending the goal.</p>
      </> : <p className="bi-footnote">{money(goal.balanceCents)} goes back to Available.</p>}
      {error && <p className="bi-footnote" role="alert">{error}</p>}
      <footer className="bi-editor-footer">
        <button className="bi-cancel" type="button" onClick={close}>Cancel</button>
        <button className="bi-primary" type="submit">Review</button>
      </footer>
    </fieldset>
  </form>
}
