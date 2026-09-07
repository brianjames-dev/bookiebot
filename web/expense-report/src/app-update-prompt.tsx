import { useEffect, useRef, useState } from "react"
import { AppVersionWatcher, watchAppVersionLifecycle } from "./app-update"
import "./app-update-prompt.css"

export function AppUpdatePrompt({ initialVersion }: { initialVersion: string }) {
  const [version, setVersion] = useState<string | null>(null)
  const watcher = useRef<AppVersionWatcher | null>(null)
  useEffect(() => {
    const current = new AppVersionWatcher(initialVersion)
    watcher.current = current
    const unsubscribe = current.subscribe(setVersion)
    const stop = watchAppVersionLifecycle(current)
    return () => { stop(); unsubscribe(); current.dispose(); watcher.current = null }
  }, [initialVersion])
  return <div className="bb-app-update" data-open={Boolean(version)} aria-hidden={!version} {...{ inert: version ? undefined : "" }}>
    <div className="bb-app-update-clip"><div className="bb-app-update-content">
      <p role={version ? "status" : undefined}>A BookieBot update is ready.</p>
      <div className="bb-app-update-actions">
        <button type="button" className="bb-toolbar-button" onClick={() => window.location.reload()}>Update now</button>
        <button type="button" className="bb-toolbar-button" onClick={() => watcher.current?.dismiss()}>Later</button>
      </div>
    </div></div>
  </div>
}
