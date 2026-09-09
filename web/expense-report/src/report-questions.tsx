import { useEffect, useRef, useState } from "react"
import { AnimatedDisclosure } from "./components/ui/motion"
import { useAppWorkStatus } from "./app-work-guard"
import { initialQuestionState, questionScope, ReportQuestionClient, reportQuestionSourceLabels, type QuestionMode } from "./report-question-client"
import "./report-questions.css"

const prompts = ["What is driving my spending?", "Explain my money left.", "Which reimbursements are outstanding?"]
export function ReportQuestions({ month, mode, onShowSource, embedded = false }: {
  month: string; mode: QuestionMode; onShowSource?: (section: string) => void; embedded?: boolean
}) {
  const scope = questionScope(month, mode)
  const [draft, setDraft] = useState({ scope, text: "" })
  const [snapshot, setSnapshot] = useState(() => initialQuestionState(month, mode))
  const client = useRef<ReportQuestionClient | null>(null)
  useEffect(() => {
    const next = new ReportQuestionClient(month, mode, setSnapshot)
    client.current = next; setSnapshot(initialQuestionState(month, mode)); setDraft({ scope: questionScope(month, mode), text: "" })
    return () => { next.dispose(); if (client.current === next) client.current = null }
  }, [month, mode])
  // Old results cannot flash under a newly selected month/mode before effects run.
  const state = snapshot.scope === scope ? snapshot : initialQuestionState(month, mode)
  const question = draft.scope === scope ? draft.text : ""
  const busy = state.phase === "loading"
  const discard = () => { client.current?.clear(); setDraft({ scope, text: "" }) }
  const work = { label: "Ask BookieBot", pending: busy, dirty: Boolean(question.trim() || state.answer), onDiscard: discard }
  const updateWork = useAppWorkStatus(work)
  const ask = () => {
    if (!client.current || busy || !question.trim()) return
    updateWork({ ...work, pending: true })
    void client.current.ask(question)
  }
  const monthLabel = /^\d{4}-\d{2}$/.test(month)
    ? new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : month
  const body = (
      <div className="bb-question-body">
        <p className="bb-question-note">Ask about this month and view using your latest report data. BookieBot can explain it; it can’t change expenses or move money.</p>
        <div className="bb-question-prompts" aria-label="Suggested questions">{prompts.map((prompt) => <button type="button" key={prompt} disabled={busy}
          onClick={() => setDraft({ scope, text: prompt })}>{prompt}</button>)}</div>
        <form onSubmit={(event) => { event.preventDefault(); ask() }}>
          <label>Your question<textarea rows={3} maxLength={2000} value={question} disabled={busy}
            onChange={(event) => setDraft({ scope, text: event.target.value })} placeholder="What should I pay attention to this month?" /></label>
          <div className="bb-question-actions"><button type="submit" disabled={busy || !question.trim()}>{busy ? "Reading your report…" : "Ask BookieBot"}</button>
            <span>{question.length.toLocaleString()} / 2,000</span>
            {(state.answer || state.phase === "error" || busy) && <button type="button" onClick={() => client.current?.clear()}>{busy ? "Cancel" : "Clear answer"}</button>}
          </div>
        </form>
        {busy && <p role="status" className="bb-question-note">Checking the selected report. This can take a moment.</p>}
        {state.phase === "error" && <div className="bb-question-error" role="alert"><p>{state.error}</p><button type="button" disabled={!question.trim()} onClick={ask}>Try again</button></div>}
        {state.answer && <div className="bb-question-answer" aria-live="polite"><p className="bb-question-answer-text">{state.answer.answer}</p>
          {!!state.answer.sources.length && <div className="bb-question-sources"><span>Based on</span>{state.answer.sources.map((source) => onShowSource
            ? <button type="button" key={source} onClick={() => onShowSource(source)}>{reportQuestionSourceLabels[source]}</button>
            : <span key={source}>{reportQuestionSourceLabels[source]}</span>)}</div>}
          {state.answer.generatedAt && <p className="bb-question-note">Report updated {state.answer.generatedAt}.</p>}
        </div>}
        <p className="bb-question-privacy">Uses BookieBot’s existing AI service. This app doesn’t save a conversation; changing the report view clears the answer.</p>
      </div>
  )
  return <section className={`bb-report-questions ${embedded ? "bb-report-questions-embedded" : "bb-report-section"}`} aria-label="Ask about this report">
    {embedded ? body : <AnimatedDisclosure summary={<>
      <span className="bb-reimbursement-item"><strong>Ask BookieBot</strong><span>{monthLabel} · {mode === "current" ? "Current" : "Projected"}</span></span>
      <span className="bb-question-invitation">About this report</span><span className="bb-disclosure-mark" aria-hidden="true" />
    </>}>{body}</AnimatedDisclosure>}
  </section>
}
