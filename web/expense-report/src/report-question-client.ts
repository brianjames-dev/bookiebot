export type QuestionMode = "current" | "projected"
export const reportQuestionSourceLabels: Record<string, string> = {
  overview: "Headline totals", categories: "Category mix", cash_flow: "Cash flow",
  commitments: "Bills and subscriptions", burn_rate: "Spending pace",
  activity: "Daily spending", reimbursements: "Shared reimbursements",
}
export interface ReportAnswer {
  answer: string; sources: string[]; month: string; monthLabel: string; mode: QuestionMode; generatedAt: string
  sourceDetails?: { section: string; label: string }[]
}
export interface ReportQuestionState {
  scope: string; phase: "idle" | "loading" | "answered" | "error"; answer: ReportAnswer | null; error: string
}
export function questionScope(month: string, mode: QuestionMode) { return `${month}:${mode}` }
export function initialQuestionState(month: string, mode: QuestionMode): ReportQuestionState {
  return { scope: questionScope(month, mode), phase: "idle", answer: null, error: "" }
}
class QuestionResponseError extends Error {}

/** One ephemeral selected-view interaction. No storage, history or automatic requests. */
export class ReportQuestionClient {
  private controller: AbortController | null = null
  private generation = 0
  private disposed = false
  private busy = false
  constructor(private readonly month: string, private readonly mode: QuestionMode,
    private readonly changed: (state: ReportQuestionState) => void,
    private readonly fetcher: typeof fetch = fetch) {}

  async ask(question: string) {
    if (this.disposed || this.busy) return
    const scope = questionScope(this.month, this.mode)
    const text = question.trim()
    if (!text || text.length > 2000) {
      this.changed({ scope, phase: "error", answer: null, error: "Enter a question of up to 2,000 characters." }); return
    }
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    this.busy = true
    this.changed({ scope, phase: "loading", answer: null, error: "" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
    try {
      const response = await this.fetcher("/app/expenses/ask", {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", "X-BookieBot-App": "1" },
        body: JSON.stringify({ question: text, month: this.month, mode: this.mode }), signal: controller.signal,
      })
      const data = await response.json()
      if (this.disposed || generation !== this.generation) return
      if (!response.ok) throw new QuestionResponseError(typeof data.error === "string" ? data.error : "BookieBot couldn’t answer right now. Try again.")
      if (data.month !== this.month || data.mode !== this.mode || typeof data.answer !== "string" || !data.answer.trim()) {
        throw new QuestionResponseError("This answer doesn’t match the selected report. Please ask again.")
      }
      const sources = Array.isArray(data.sources)
        ? [...new Set(data.sources.filter((source: unknown): source is string => typeof source === "string" && Object.prototype.hasOwnProperty.call(reportQuestionSourceLabels, source)))] as string[] : []
      this.changed({ scope, phase: "answered", error: "", answer: { ...data, answer: data.answer.slice(0, 8000), sources } })
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      const message = error instanceof QuestionResponseError ? error.message
        : timedOut ? "BookieBot took too long to answer. Try again." : "Couldn’t reach BookieBot. Check your connection and try again."
      this.changed({ scope, phase: "error", answer: null, error: message })
    } finally {
      clearTimeout(timer)
      if (generation === this.generation) { this.controller = null; this.busy = false }
    }
  }

  clear() {
    this.generation += 1; this.controller?.abort(); this.controller = null; this.busy = false
    if (!this.disposed) this.changed(initialQuestionState(this.month, this.mode))
  }

  dispose() { this.disposed = true; this.clear() }
}
