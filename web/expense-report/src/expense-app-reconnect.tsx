import { useEffect, useId, useRef, useState } from "react"

import { ExpenseAppPairing, initialExpenseAppPairingState } from "./expense-app-session"

export function ExpenseAppReconnect() {
  const [input, setInput] = useState("")
  const [state, setState] = useState(initialExpenseAppPairingState)
  const pairing = useRef<ExpenseAppPairing | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const inputId = useId()
  const busy = state.phase === "checking" || state.phase === "connecting" || state.phase === "connected"
  const confirming = state.phase === "confirm" || state.phase === "connecting" || state.phase === "connected"

  useEffect(() => {
    const current = new ExpenseAppPairing()
    pairing.current = current
    const unsubscribe = current.subscribe(setState)
    return () => {
      unsubscribe()
      current.dispose()
      pairing.current = null
    }
  }, [])

  useEffect(() => {
    if (state.phase === "connected") window.location.reload()
    else if (state.phase === "confirm") confirmRef.current?.focus()
    else if (state.phase === "error") inputRef.current?.focus()
  }, [state.phase])

  return (
    <section className="bb-app-reconnect" aria-label="Reconnect this app">
      <p>Request <code>/expense_app</code> in Discord, copy its setup link, then paste it here.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        const pasted = input
        setInput("")
        void pairing.current?.check(pasted, window.location.origin)
      }}>
        {!confirming ? <>
          <label htmlFor={inputId}>Private setup link</label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="url"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Paste your setup link"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            aria-describedby={`${inputId}-status`}
          />
          <div className="bb-app-buttons">
            <button className="bb-app-button" type="submit" disabled={busy || !input.trim()}>
              {state.phase === "checking" ? "Checking…" : "Continue"}
            </button>
          </div>
        </> : <>
          <p>Connect this app to <strong>{state.ownerName}’s expense report</strong>.</p>
          <div className="bb-app-buttons">
            <button ref={confirmRef} className="bb-app-button" type="button" disabled={busy} onClick={() => { void pairing.current?.connect() }}>
              {busy ? "Connecting…" : `Connect as ${state.ownerName}`}
            </button>
            <button className="bb-app-button bb-app-signout" type="button" disabled={busy} onClick={() => {
              setInput("")
              pairing.current?.reset()
            }}>Use another link</button>
          </div>
        </>}
        <p id={`${inputId}-status`} className="bb-app-reconnect-status" role="status" aria-live="polite" aria-atomic="true">
          {state.message || (state.phase === "checking" ? "Checking your setup link…" : state.phase === "connecting" || state.phase === "connected" ? "Connecting this app…" : "")}
        </p>
      </form>
    </section>
  )
}
