export type TransactionOperation = "update" | "move" | "delete" | "split" | "cancel_split" | "undo"
export interface TransactionChangeSummary {
  operation: TransactionOperation
  kind?: string
  title: string
  date: string
  category: string
  location: string
  person: string
  amountCents: number
  before: Record<string, string>
  after: Record<string, string>
  destination?: string
  transferEffect?: {savedBeforeCents:number;savedAfterCents:number;goalBeforeName:string;goalAfterName:string}
  share?: {method: string; payerCents: number; partnerCents: number; payerBasisPoints?: number; payerName?: string; partnerName?: string}
  restoration?: {operation: "update" | "move"; current: Record<string, string>; currentCategory: string; restoredCategory: string}
}
