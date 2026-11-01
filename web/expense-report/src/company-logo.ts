import catalog from './company-logos.json'

export function companyIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}
const byId = new Map(catalog.map(item => [item.id, item]))
const byAlias = new Map(catalog.flatMap(item => item.aliases.map(alias => [companyIdentity(alias), item] as const)))

// Explicit, display-only owner preferences confirmed by Brian. Generic labels
// never identify a provider globally or affect any financial classification.
const ownerAliases: Record<string, Record<string, string>> = {
  brian: { water: 'santa-rosa-water', 'student loan': 'aidvantage', 'student loan payment': 'aidvantage' },
}
export function companyLogo(label: string, owner: string) {
  const key = companyIdentity(label)
  const scoped = ownerAliases[companyIdentity(owner)]?.[key]
  const item = scoped ? byId.get(scoped) : byAlias.get(key)
  return item ? { id: item.id, name: item.name, src: `/app/assets/${item.asset}` } : null
}
