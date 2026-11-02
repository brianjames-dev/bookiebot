import catalog from './merchant-logos.json'
import { companyIdentity, companyLogo } from './company-logo'
import type { ExpenseEntry } from './types'

export type DailyTransaction = ExpenseEntry & { status?: 'recorded' | 'scheduled'; kind?: 'bill' | 'subscription' | 'income' }
const byAlias = new Map(catalog.flatMap(merchant => merchant.aliases.map(alias => [companyIdentity(alias), merchant] as const)))

export function transactionMerchant(entry: DailyTransaction, aliases: Record<string, string> = {}) {
  // Location is authoritative: a product called Apple at an unknown shop must
  // never borrow Apple's mark. Match exact names and explicit store suffixes.
  const value = (entry.location.trim() || entry.item.trim()).replace(/\s+(?:(?:store|location)\s*#?\s*|#\s*)\d{1,6}$/i, '')
  const company = companyLogo(value, aliases)
  if (company) return { ...company, background: 'transparent', inset: 0 }
  const merchant = byAlias.get(companyIdentity(value))
  return merchant ? { id: merchant.id, name: merchant.name, src: `/app/assets/${merchant.asset}`, background: merchant.background, inset: merchant.inset } : null
}

const families = [
  { categories: ['Rent', 'Mortgage'], label: 'Rent', icon: 'house', token: 'rent' },
  { categories: ['Groceries', 'Grocery'], label: 'Groceries', icon: 'basket', token: 'grocery' },
  { categories: ['Gas', 'Fuel'], label: 'Gas', icon: 'fuel', token: 'gas' },
  { categories: ['Food', 'Eating out', 'Dining'], label: 'Food', icon: 'utensils', token: 'food' },
  { categories: ['Shopping'], label: 'Shopping', icon: 'bag', token: 'shopping' },
  { categories: ['Need Expenses', 'Need', 'Needs', 'Other needs', 'Need transactions', 'Needs transactions'], label: 'Other needs', icon: 'package', token: 'need' },
  { categories: ['Subs (Needs)', 'Needs subscriptions', 'Need sub'], label: 'Subs (Needs)', icon: 'repeat', token: 'subs-needs' },
  { categories: ['Subs (Wants)', 'Wants subs', 'Wants subscriptions', 'Want sub'], label: 'Subs (Wants)', icon: 'repeat', token: 'subs-wants' },
  { categories: ['Static Bills & Subscriptions'], label: 'Bills & subs', icon: 'receipt', token: 'bills' },
  { categories: ['Bills & Utilities', 'Bills and Utilities', 'Bills', 'Utilities'], label: 'Bills & utilities', icon: 'receipt', token: 'bills' },
  { categories: ['Income'], label: 'Income', icon: 'dollar', token: 'income' },
  { categories: ['Savings', 'Saved', 'ESPP', 'SpaceX ESPP'], label: 'Savings', icon: 'piggy', token: 'savings' },
]

export function transactionCategory(entry: DailyTransaction) {
  const key = companyIdentity(entry.category)
  let base = families.find(row => row.categories.some(category => companyIdentity(category) === key)) ?? { label: entry.category || 'Transaction', icon: 'receipt', token: 'need' }
  if (key === 'mortgage') base = { ...base, label: 'Mortgage' }
  if (key === 'static bills and subscriptions' && (entry.kind === 'subscription' || (!entry.kind && ['Need sub', 'Want sub'].includes(entry.person)))) return { ...base, icon: 'repeat' }
  if (base.token === 'bills') {
    const bill = companyIdentity(entry.item)
    if (/\brent\b|\bmortgage\b/.test(bill)) return { ...base, icon: 'house' }
    if (/\bwater\b/.test(bill)) return { ...base, icon: 'droplets' }
    if (/\binternet\b|\bphone\b|\bbroadband\b/.test(bill)) return { ...base, icon: 'wifi' }
    if (/\belectric\b|\bpower\b|\bpge\b|\bpg and e\b/.test(bill)) return { ...base, icon: 'zap' }
    if (/\bgas\b/.test(bill)) return { ...base, icon: 'flame' }
    if (/\binsurance\b/.test(bill)) return { ...base, icon: 'shield' }
    if (/\bstudent loans?\b|\baidvantage\b/.test(bill)) return { ...base, icon: 'graduation' }
  }
  return base
}

export function transactionText(entry: DailyTransaction, merchant: ReturnType<typeof transactionMerchant>) {
  const primary = merchant?.name || entry.location.trim() || entry.item.trim() || entry.category || 'Transaction'
  const item = entry.item.trim()
  const category = transactionCategory(entry).label
  return { primary, category, item: item && companyIdentity(item) !== companyIdentity(primary) && companyIdentity(item) !== companyIdentity(category) ? item : null }
}
