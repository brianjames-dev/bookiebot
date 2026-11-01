import catalog from './company-logos.json'

export function companyIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}
const byId = new Map(catalog.map(item => [item.id, item]))
const byAlias = new Map(catalog.flatMap(item => item.aliases.map(alias => [companyIdentity(alias), item] as const)))

// Confirmed provider assignments arrive with the authenticated report. Only
// catalog IDs are accepted; an alias cannot introduce an outside image URL.
export function companyLogo(label: string, aliases: Record<string, string> = {}) {
  const key = companyIdentity(label)
  const scoped = aliases[key]
  const item = scoped ? byId.get(scoped) : byAlias.get(key)
  return item ? { id: item.id, name: item.name, preparedCircle: item.preparedCircle, src: `/app/assets/${item.asset}` } : null
}
