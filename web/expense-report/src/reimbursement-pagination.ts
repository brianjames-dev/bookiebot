import { useEffect, useRef, useState } from "react"

// A refresh may insert a newer expense or month ahead of the current page.
// Retain every already displayed record so its disclosure and draft stay mounted.
export function useReimbursementPage<T>(items: T[], key: (item: T) => string, revealedPage = true) {
  const [showAll, setShowAll] = useState(false)
  const revealed = useRef<Set<string>>(new Set())
  const visibleCount = showAll ? items.length : items.reduce((count, item, index) => revealed.current.has(key(item)) ? Math.max(count, index + 1) : count, 5)
  const visible = items.slice(0, visibleCount)
  useEffect(() => { if (revealedPage) revealed.current = new Set(visible.map(key)) })
  return { visible, hasMore: items.length > visibleCount, loadAll: () => setShowAll(true) }
}
