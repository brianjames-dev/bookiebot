import { useEffect, useRef, useState } from "react"

// A refresh may insert a newer expense or month ahead of the current page.
// Retain every already displayed record so its disclosure and draft stay mounted.
export function useReimbursementPage<T>(items: T[], key: (item: T) => string, revealedPage = true) {
  const [requestedCount, setRequestedCount] = useState(5)
  const revealed = useRef<Set<string>>(new Set())
  const visibleCount = items.reduce((count, item, index) => revealed.current.has(key(item)) ? Math.max(count, index + 1) : count, requestedCount)
  const visible = items.slice(0, visibleCount)
  useEffect(() => { if (revealedPage) revealed.current = new Set(visible.map(key)) })
  return { visible, hasMore: items.length > visibleCount, loadMore: () => setRequestedCount(visibleCount + 5) }
}
