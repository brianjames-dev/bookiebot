import { useEffect, useLayoutEffect, useState } from "react"

type DuoLayout = "portrait" | "landscape"

// The standalone cover viewport is wider than the Safari window with its
// own side controls. Reserve a rail only when there is room for both.
const coverQuery = "(orientation: portrait) and (min-width: 440px) and (max-width: 500px) and (min-height: 610px) and (max-height: 750px)"
const innerQuery = "(orientation: landscape) and (min-width: 880px) and (max-width: 1024px) and (min-height: 555px) and (max-height: 750px)"

function readPreference(key: string) {
  try { return window.localStorage.getItem(key) === "true" } catch { return false }
}

export function useDuoLayout(owner: string) {
  const key = `bookiebot:duo-layout:${encodeURIComponent(owner.trim().toLowerCase())}`
  const [preference, setPreference] = useState(() => ({ key, enabled: readPreference(key) }))
  const enabled = preference.key === key ? preference.enabled : readPreference(key)
  const [environment, setEnvironment] = useState<{ installed: boolean; layout?: DuoLayout }>({ installed: false })

  useLayoutEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)")
    const cover = window.matchMedia(coverQuery)
    const inner = window.matchMedia(innerQuery)
    const update = () => {
      const installed = display.matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      const layout = cover.matches ? "portrait" : inner.matches ? "landscape" : undefined
      setEnvironment({ installed, layout })
    }
    update()
    const queries = [display, cover, inner]
    queries.forEach(query => query.addEventListener("change", update))
    return () => queries.forEach(query => query.removeEventListener("change", update))
  }, [])

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setPreference({ key, enabled: readPreference(key) })
    }
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [key])

  return {
    installed: environment.installed,
    enabled: environment.installed && enabled,
    layout: environment.installed && enabled ? environment.layout : undefined,
    toggle() {
      setPreference({ key, enabled: !enabled })
      try { window.localStorage.setItem(key, String(!enabled)) } catch { /* keep the session choice */ }
    },
  }
}
