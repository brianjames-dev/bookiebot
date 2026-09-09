import { useEffect, useRef, useState } from "react"
import { ArrowLeft } from "lucide-react"
import { CollapsibleContent } from "./components/ui/motion"
import "./widget-setup-guide.css"

export function WidgetSetupGuide({ onBack, onPair }: { onBack: () => void; onPair: () => void }) {
  const [source, setSource] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [showCode, setShowCode] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let active = true
    const timer = window.setTimeout(() => {
      active = false; controller.abort(); setLoading(false)
      setError("The script couldn’t load. Try again when connected.")
    }, 15_000)
    setLoading(true); setError("")
    // Public configured source only. Pairing credentials are never part of this request.
    void fetch("/app/widgets/script", { credentials: "omit", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Script unavailable")
        const text = await response.text()
        if (!text.startsWith("// BookieBot Home Screen widget") || text.length > 100_000 || text.includes("__BOOKIEBOT_ORIGIN__")) throw new Error("Invalid script")
        if (active) setSource(text)
      })
      .catch(() => { if (active) setError("The script couldn’t load. Try again when connected.") })
      .finally(() => { if (active) { window.clearTimeout(timer); setLoading(false) } })
    return () => { mounted.current = false; active = false; controller.abort(); window.clearTimeout(timer) }
  }, [attempt])

  const copyScript = async () => {
    if (!source) return
    try {
      await navigator.clipboard.writeText(source)
      if (mounted.current) setMessage("Script copied. Paste it into your BookieBot script in Scriptable.")
    } catch {
      if (mounted.current) { setShowCode(true); setMessage("Select and copy the script below, then paste it in Scriptable.") }
    }
  }

  return <div className="bb-widget-guide">
    <div className="bb-settings-heading"><button type="button" className="bb-settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Settings</button><h1>Widget setup</h1></div>
    <section className="bb-widget-guide-recovery" aria-label="Widget needs pairing">
      <h2>Seeing “Pair this phone”?</h2>
      <p>The script is installed, but it hasn’t found its saved connection. Run it <strong>inside Scriptable</strong> and paste a fresh setup code. Opening the link in a browser doesn’t pair it.</p>
      <div className="bb-widget-actions"><button className="bb-toolbar-button" type="button" onClick={onPair}>Get a setup code</button><a className="bb-settings-action" href="scriptable:///">Open Scriptable</a></div>
      <p className="bb-settings-note">Already paired? In Edit Widget, select the exact script you paired. Renamed or duplicate scripts use a different connection.</p>
    </section>
    <ol className="bb-widget-guide-steps">
      <li><h2>Add the script</h2><p>Install <a href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" rel="noreferrer">Scriptable</a>. Copy the script below, tap <strong>+</strong> in Scriptable, paste it and name it <strong>BookieBot</strong>.</p>
        <div className="bb-widget-actions"><button type="button" className="bb-toolbar-button" disabled={loading || !source} onClick={() => void copyScript()}>{loading ? "Loading script…" : "Copy script"}</button></div>
        <p className="bb-settings-note">Updating an existing widget? Replace the code in the same script; keep its name to retain pairing.</p>
        {error && <p className="bb-widget-error" role="alert">{error} <button type="button" className="bb-settings-action" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
        {message && <p className="bb-settings-note" role="status">{message}</p>}
        <CollapsibleContent open={showCode}><label className="bb-widget-script-label">Select all and copy<textarea aria-label="BookieBot script" readOnly spellCheck={false} value={source} onFocus={event => event.target.select()} /></label></CollapsibleContent>
      </li>
      <li><h2>Connect your account</h2><p><button type="button" className="bb-widget-guide-inline" onClick={onPair}>Return to Widgets</button>, tap <strong>Pair a widget</strong>, choose Current or Projected, then create and copy the setup code.</p><p>Run BookieBot in Scriptable, paste the code and tap <strong>Pair this phone</strong>. Confirm your name and figures in the preview before continuing.</p><p className="bb-settings-note">Codes work once and expire in 10 minutes. Keep yours private; each person pairs from their own account.</p></li>
      <li><h2>Add it to your Home Screen</h2><p>Hold an empty area → <strong>Edit → Add Widget → Scriptable</strong>. Choose Small or Medium. Hold the widget → <strong>Edit Widget → Script → BookieBot</strong>. Leave Parameter empty.</p><p className="bb-settings-note">A widget with figures opens BookieBot in your browser when tapped. Your browser may need its own sign-in. iOS decides refresh timing; check the timestamp.</p></li>
    </ol>
    <button type="button" className="bb-settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Settings</button>
  </div>
}
