import type {SavingsGoal} from './savings-goals'
export type Account={id:string;name:string;institutionId:string;kind:'cash'|'investment';balanceCents:number;allocatedCents:number;availableCents:number}
export type Goal=SavingsGoal&{accountId:string;iconKey:string;manualBalanceCents:number}
export type Transfer={id:string;accountId?:string;name:string;date:string;frequency:string;amountCents:number;goalId:string;toAccount:string;fromAccount:string}
export type SavingsState={accounts:Account[];goals:Goal[];totals:{cash:number;goals:number;available:number};version:string;transfers:Transfer[];undoId?:string|null}
export function goalView(s:SavingsState,id:string){return s.goals.find(g=>g.id===id)}
export function accountAvailable(s:SavingsState,id:string){return s.accounts.find(a=>a.id===id)?.availableCents??0}
export function totals(s:SavingsState){const invested=s.accounts.filter(a=>a.kind==='investment').reduce((n,a)=>n+a.balanceCents,0);return {...s.totals,invested,total:s.totals.cash+invested}}
export function transferPlan(s:SavingsState,transfer:Transfer){const goal=goalView(s,transfer.goalId),room=goal&&!goal.archived?Math.max(0,goal.targetCents-goal.balanceCents):0,allocated=Math.min(transfer.amountCents,room);return {amount:transfer.amountCents,allocated,available:transfer.amountCents-allocated,room,goal,account:s.accounts.find(a=>transfer.accountId?a.id===transfer.accountId:a.name===transfer.toAccount)??{id:'upcoming',name:transfer.toAccount||'Savings',kind:'cash' as const,institutionId:'other',balanceCents:0,availableCents:0,allocatedCents:0}}}
