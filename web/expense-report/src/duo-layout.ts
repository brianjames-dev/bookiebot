import { useEffect, useLayoutEffect, useState } from "react"

type DuoLayout = "portrait" | "landscape"

// iOS can exclude the 84px system strip from the Home Screen viewport.
// The landscape workspace still fits in the remaining 867px.
const coverQuery = "(orientation: portrait) and (min-width: 440px) and (max-width: 500px) and (min-height: 610px) and (max-height: 750px)"
const innerQuery = "(orientation: landscape) and (min-width: 850px) and (max-width: 1024px) and (min-height: 555px) and (max-height: 750px)"
const innerRailQuery = "(min-width: 880px)"

function readPreference(key: string) {
  try { return window.localStorage.getItem(key) === "true" } catch { return false }
}

export function useDuoLayout(owner: string) {
  const key = `bookiebot:duo-layout:${encodeURIComponent(owner.trim().toLowerCase())}`
  const [preference, setPreference] = useState(() => ({ key, enabled: readPreference(key) }))
  const enabled = preference.key === key ? preference.enabled : readPreference(key)
  const [environment, setEnvironment] = useState<{ installed: boolean; landscape: boolean; rail?: DuoLayout }>({ installed: false, landscape: false })

  useLayoutEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)")
    const cover = window.matchMedia(coverQuery)
    const inner = window.matchMedia(innerQuery)
    const innerRail = window.matchMedia(innerRailQuery)
    const update = () => {
      const installed = display.matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      const landscape = inner.matches
      const rail = cover.matches ? "portrait" : landscape && innerRail.matches ? "landscape" : undefined
      setEnvironment({ installed, landscape, rail })
    }
    update()
    const queries = [display, cover, inner, innerRail]
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

  const active = environment.installed && enabled
  return {
    installed: environment.installed,
    enabled: active,
    landscape: active && environment.landscape,
    rail: active ? environment.rail : undefined,
    toggle() {
      setPreference({ key, enabled: !enabled })
      try { window.localStorage.setItem(key, String(!enabled)) } catch { /* keep the session choice */ }
    },
  }
}
