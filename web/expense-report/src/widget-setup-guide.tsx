import { useEffect, useId, useRef, useState } from "react"
import { ArrowLeft, ChevronDown } from "lucide-react"
import { CollapsibleContent } from "./components/ui/motion"
import "./widget-setup-guide.css"

export function WidgetSetupGuide({ onBack, onPair }: { onBack: () => void; onPair: () => void }) {
  const [source, setSource] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [showCode, setShowCode] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [showThemes, setShowThemes] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const themesId = useId()
  const helpId = useId()
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
      if (mounted.current) setMessage("Copied. Paste into Scriptable.")
    } catch {
      if (mounted.current) { setShowCode(true); setMessage("Select and copy the script below, then paste it in Scriptable.") }
    }
  }

  return <div className="bb-widget-guide">
    <div className="bb-settings-heading"><button type="button" className="bb-settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Settings</button><h1>Widget setup</h1></div>
    <ol className="bb-widget-guide-steps">
      <li><h2>Copy to Scriptable</h2><p>Install <a href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" rel="noreferrer">Scriptable</a>, tap <strong>+</strong>, paste the script and name it <strong>BookieBot</strong>.</p>
        <div className="bb-widget-actions"><button type="button" className="bb-toolbar-button" disabled={loading || !source} onClick={() => void copyScript()}>{loading ? "Loading script…" : "Copy script"}</button></div>
        <p className="bb-settings-note">Already installed? Replace the code in the same script.</p>
        {error && <p className="bb-widget-error" role="alert">{error} <button type="button" className="bb-settings-action" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
        {message && <p className="bb-settings-note" role="status">{message}</p>}
        <CollapsibleContent open={showCode}><label className="bb-widget-script-label">Select all and copy<textarea aria-label="BookieBot script" readOnly spellCheck={false} value={source} onFocus={event => event.target.select()} /></label></CollapsibleContent>
      </li>
      <li><h2>Pair your account</h2><p>Create a setup code, then run BookieBot in Scriptable and paste it when asked.</p><div className="bb-widget-actions"><button className="bb-toolbar-button" type="button" onClick={onPair}>Get a setup code</button></div><p className="bb-settings-note">Use your own account. Keep the code private; it expires in 10 minutes.</p></li>
      <li><h2>Add the widget</h2><p>Hold your Home Screen → <strong>Edit → Add Widget → Scriptable</strong>. Choose Small or Medium, then <strong>Edit Widget → Script → BookieBot</strong>.</p><p className="bb-settings-note">Both sizes can use the same script.</p></li>
    </ol>
    <div className="bb-widget-guide-extras">
      <section aria-label="Theme options">
        <button type="button" className="bb-widget-guide-disclosure" aria-expanded={showThemes} aria-controls={themesId} onClick={() => setShowThemes(value => !value)}>Themes<ChevronDown aria-hidden="true" /></button>
        <CollapsibleContent open={showThemes} id={themesId}>
          <div className="bb-widget-guide-extra-body">
            <p>Run BookieBot in Scriptable → <strong>Theme &amp; preview</strong> → choose Editorial or Two-tone, then a size.</p>
            <p>For a different theme on each widget, set <strong>Edit Widget → Parameter</strong>:</p>
            <dl className="bb-widget-theme-parameters"><div><dt>Editorial</dt><dd><code>editorial</code></dd></div><div><dt>Two-tone</dt><dd><code>two-tone</code></dd></div></dl>
            <p className="bb-settings-note">Leave Parameter empty for your saved theme. Never put a setup code here.</p>
          </div>
        </CollapsibleContent>
      </section>
      <section aria-label="Setup help">
        <button type="button" className="bb-widget-guide-disclosure" aria-expanded={showHelp} aria-controls={helpId} onClick={() => setShowHelp(value => !value)}>Help<ChevronDown aria-hidden="true" /></button>
        <CollapsibleContent open={showHelp} id={helpId}>
          <div className="bb-widget-guide-extra-body bb-widget-guide-help">
            <div><h3>Updating an existing script</h3><p>Replace its code and keep the same name. Your pairing stays connected; no need to pair again.</p></div>
            <div><h3>Still says “Pair this phone”?</h3><p>Run the updated script <a href="scriptable:///">inside Scriptable</a> and enter a fresh setup code if asked. In Edit Widget, select that exact script. Check your name and figures in its preview.</p></div>
            <div><h3>Refreshes &amp; tapping</h3><p>iOS controls refresh timing; check the timestamp. Leave When Interacting at <strong>Open App</strong> and Parameter empty unless choosing a theme.</p><p>Tapping a paired widget opens BookieBot in your browser, which may need a separate sign-in.</p></div>
          </div>
        </CollapsibleContent>
      </section>
    </div>
    <button type="button" className="bb-settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Settings</button>
  </div>
}
