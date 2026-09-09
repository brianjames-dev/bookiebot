import { useEffect, useRef, useState } from "react"
import { Toast } from "konsta/react"
import { AppVersionWatcher, watchAppVersionLifecycle } from "./app-update"
import { useAppWorkGuard } from "./app-work-guard"
import "./app-update-prompt.css"

export function AppUpdatePrompt({ initialVersion, onAvailabilityChange }: { initialVersion: string; onAvailabilityChange?: (version: string | null) => void }) {
  const [version, setVersion] = useState<string | null>(null)
  const watcher = useRef<AppVersionWatcher | null>(null)
  const availabilityCallback = useRef(onAvailabilityChange)
  availabilityCallback.current = onAvailabilityChange
  const guard = useAppWorkGuard()
  const requestUpdate = useRef(() => {})
  requestUpdate.current = () => {
    if (watcher.current?.availableVersion) guard.requestAction({ kind: "update", onProceed: () => window.location.reload() })
  }
  useEffect(() => {
    const current = new AppVersionWatcher(initialVersion)
    watcher.current = current
    const unsubscribe = current.subscribe(setVersion)
    const stopAvailability = current.subscribeAvailability(value => availabilityCallback.current?.(value))
    const stop = watchAppVersionLifecycle(current)
    const update = () => requestUpdate.current()
    window.addEventListener("bookiebot:request-app-update", update)
    return () => { stop(); unsubscribe(); stopAvailability(); current.dispose(); watcher.current = null
      window.removeEventListener("bookiebot:request-app-update", update) }
  }, [initialVersion])
  return <Toast className="bb-app-update" position="center" opened={Boolean(version)} aria-hidden={!version} inert={!version}
    button={<div className="bb-app-update-actions">
      <button type="button" className="bb-app-update-now" disabled={guard.pending || guard.uncertain} onClick={() => requestUpdate.current()}>Update</button>
      <button type="button" className="bb-app-update-later" aria-label="Dismiss update notice for now" onClick={() => watcher.current?.dismiss()}>×</button>
    </div>}>
    <div className="bb-app-update-message"><p role={version ? "status" : undefined}>A BookieBot update is ready.</p>
      {(guard.pending || guard.uncertain) && <small>{guard.uncertain ? "Resolve your latest change before updating." : "Finish the current request before updating."}</small>}
    </div>
  </Toast>
}
