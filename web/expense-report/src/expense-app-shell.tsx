import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { Tabbar, TabbarLink, ToolbarPane } from "konsta/react"
import { ArrowLeft, House, MessageCircle, PiggyBank, ReceiptText, Settings, Users } from "lucide-react"
import { AppNavigationContext, nextScrollNavigation, screenForReportSource, screenTitles, type AppScreen, type MainScreen, type ScrollNavigationState } from "./app-navigation"
import { ExpenseReportApp, useExpenseReportTheme } from "./report-app"
import { useReportViewPreferences } from "./report-view-preferences"
import { expenseReportIdentity } from "./expense-app-session"
import { ReimbursementLedger } from "./reimbursement-ledger"
import { SharedReimbursementsCard } from "./shared-reimbursements"
import { SavingsGoals } from "./savings-goals"
import { PhoneNotifications } from "./phone-notifications"
import { WidgetSettings } from "./widget-settings"
import { AskBookieBotPanel } from "./ask-bookiebot-panel"
import { AppUpdatePrompt } from "./app-update-prompt"
import { useAppWorkGuard } from "./app-work-guard"
import type { ExpenseReportData } from "./types"

const mainScreens = [
  { id: "overview", Icon: House }, { id: "spending", Icon: ReceiptText },
  { id: "shared", Icon: Users }, { id: "savings", Icon: PiggyBank },
] as const

// Konsta's Link sets role="link" even for a button component. Preserve native
// button semantics for in-page navigation, including Space/Enter activation.
function NavigationButton(props: ComponentProps<"button">) {
  return <button {...props} role={undefined} />
}

export function ExpenseAppShell({ report, controls, monthControl, comparison, avatarUrl, initialVersion, signOut, signingOut, monthlyReady = true, questionMonth }: {
  report: ExpenseReportData; controls: ReactNode; monthControl: ReactNode; comparison: ReactNode
  avatarUrl: string; initialVersion: string; signOut: () => void; signingOut: boolean
  monthlyReady?: boolean; questionMonth?: string
}) {
  const { theme, toggleTheme } = useExpenseReportTheme()
  const preferences = useReportViewPreferences(report.ownerName, Boolean(report.burnRate))
  const [screen, setScreen] = useState<AppScreen>("overview")
  const [lastMain, setLastMain] = useState<MainScreen>("overview")
  const [askOpen, setAskOpen] = useState(false)
  const [sourceRequest, setSourceRequest] = useState<{ section: string; id: number; scope: string } | null>(null)
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [compact, setCompact] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const screenRef = useRef(screen)
  const positions = useRef<Partial<Record<AppScreen, number>>>({})
  const sourceId = useRef(0)
  const scrollState = useRef<ScrollNavigationState>({ lastY: 0, travel: 0, compact: false })
  const guard = useAppWorkGuard()
  const selectScreen = (next: AppScreen) => {
    if (next === screenRef.current) return
    setSourceRequest(null)
    positions.current[screenRef.current] = window.scrollY
    if (next !== "settings") setLastMain(next)
    screenRef.current = next
    setScreen(next)
    window.dispatchEvent(new CustomEvent("bookiebot:screen-change"))
  }

  const reportIdentity = expenseReportIdentity(report)
  useEffect(() => { setSourceRequest(null) }, [reportIdentity, monthlyReady])
  const consumeSource = (id: number) => setSourceRequest(current => current?.id === id ? null : current)

  useLayoutEffect(() => {
    const y = positions.current[screen] ?? 0
    window.scrollTo({ top: y, behavior: "instant" })
    scrollState.current = { lastY: window.scrollY, travel: 0, compact: false }
    setCompact(false)
  }, [screen])

  useEffect(() => {
    let frame = 0
    const readScroll = () => {
      frame = 0
      if (document.querySelector("dialog[open]") || document.documentElement.dataset.bbModalScrollLock === "true") return
      const state = nextScrollNavigation(scrollState.current, window.scrollY, document.documentElement.scrollHeight - window.innerHeight)
      scrollState.current = state
      setCompact(state.compact)
    }
    const scroll = () => { if (!frame) frame = requestAnimationFrame(readScroll) }
    const viewport = () => {
      const visual = window.visualViewport
      const editing = document.activeElement?.matches("input,textarea,[contenteditable=true]")
      setKeyboardOpen(Boolean(editing && visual && window.innerHeight - visual.height > 140))
    }
    window.addEventListener("scroll", scroll, { passive: true })
    window.visualViewport?.addEventListener("resize", viewport)
    document.addEventListener("focusin", viewport)
    document.addEventListener("focusout", viewport)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", scroll)
      window.visualViewport?.removeEventListener("resize", viewport)
      document.removeEventListener("focusin", viewport)
      document.removeEventListener("focusout", viewport)
    }
  }, [])

  const showSource = (section: string) => {
    setAskOpen(false)
    selectScreen(screenForReportSource(section))
    setSourceRequest({ section, id: ++sourceId.current, scope: expenseReportIdentity(report) })
  }
  useEffect(() => {
    if (sourceRequest?.section !== "reimbursements" || screen !== "shared") return
    const timer = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(".bb-shell-shared .bb-reimbursement-section")
      consumeSource(sourceRequest.id)
      if (!target) return
      target.tabIndex = -1; target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
    }, 280)
    return () => window.clearTimeout(timer)
  }, [sourceRequest, screen])

  const reportVisible = screen === "overview" || screen === "spending"
  const fallback = <SharedReimbursementsCard items={report.sharedReimbursements ?? []} openItems={report.openSharedReimbursements}
    receivedItems={report.receivedSharedReimbursements} coverage={report.reimbursementCoverage}
    monthLabel={report.monthLabel} year={report.year} month={report.month} />

  const scopedSourceRequest = sourceRequest?.scope === expenseReportIdentity(report) ? sourceRequest : null
  return <AppNavigationContext.Provider value={{ screen, selectScreen, preferences, sourceRequest: scopedSourceRequest, consumeSource }}>
    <div className="bb-page bb-app-shell k-ios" data-screen={screen} data-keyboard-open={keyboardOpen}>
      <header className="bb-masthead bb-shell-masthead">
        <span className="bb-wordmark"><img className="bb-app-avatar" src={avatarUrl} alt="" />BookieBot<span className="bb-report-owner"><span aria-hidden="true">•</span>{" "}{report.ownerName}</span></span>
        <div className="bb-shell-header-actions">
          <button type="button" className="bb-shell-icon" aria-label="Ask BookieBot" aria-expanded={askOpen} disabled={!monthlyReady} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setAskOpen(true) }}><MessageCircle aria-hidden="true" /></button>
          <button type="button" className="bb-shell-icon" aria-label="Settings" aria-current={screen === "settings" ? "page" : undefined} onClick={() => selectScreen(screen === "settings" ? lastMain : "settings")}><Settings aria-hidden="true" /></button>
        </div>
      </header>

      <div className="bb-shell-report" hidden={!reportVisible || !monthlyReady}>
        <ExpenseReportApp key={expenseReportIdentity(report)} report={report} appControls={controls} appMonthControl={monthControl}
          appComparison={comparison} appSession={{ signOut, signingOut }} />
      </div>
      {!monthlyReady && reportVisible && <main className="bb-shell-report-loading bb-main">
        <div className="bb-page-header"><div className="bb-report-context"><h1>{monthControl}</h1></div>{controls}</div>
        <p role="status" className="bb-settings-note">Load the selected month to view its report. Shared and Savings are still available.</p>
      </main>}
      <main className="bb-shell-shared bb-main" aria-label="Shared" hidden={screen !== "shared"}>
        <ReimbursementLedger fallback={fallback} refreshKey={report.generatedAt} />
      </main>
      <main className="bb-shell-savings bb-main" aria-label="Savings" hidden={screen !== "savings"}>
        <SavingsGoals />
      </main>
      <main className="bb-shell-settings bb-main" aria-label="Settings" hidden={screen !== "settings"}>
        <div className="bb-settings-heading"><button type="button" className="bb-settings-back" onClick={() => selectScreen(lastMain)}><ArrowLeft aria-hidden="true" />Back</button><h1>Settings</h1></div>
        <section className="bb-settings-section" aria-labelledby="bb-appearance-title"><h2 id="bb-appearance-title">Appearance</h2>
          <div className="bb-setting-row"><span>Dark mode</span><button type="button" className="bb-setting-switch" role="switch" aria-label="Dark mode" aria-checked={theme === "dark"} onClick={toggleTheme}><span /></button></div>
        </section>
        <div className="bb-settings-section bb-settings-notifications"><PhoneNotifications embedded /></div>
        <WidgetSettings ownerName={report.ownerName} defaultMode={preferences.mode} />
        <section className="bb-settings-section" aria-labelledby="bb-account-title"><h2 id="bb-account-title">Account</h2>
          <div className="bb-setting-row"><span>Signed in as</span><strong>{report.ownerName}</strong></div>
          <button type="button" className="bb-settings-action" disabled={signingOut} onClick={() => guard.requestAction({ kind: "signout", onProceed: signOut })}>{signingOut ? "Signing out…" : "Sign out"}</button>
        </section>
        <section className="bb-settings-section" aria-labelledby="bb-updates-title"><h2 id="bb-updates-title">About &amp; updates</h2>
          <div className="bb-setting-row"><span>BookieBot</span><span className="bb-app-version">{initialVersion ? `Version ${initialVersion.slice(0, 8)}` : "Web app"}</span></div>
          {availableVersion ? <button type="button" className="bb-settings-action" disabled={guard.pending || guard.uncertain} onClick={() => window.dispatchEvent(new CustomEvent("bookiebot:request-app-update"))}>Update available · Update now</button>
            : <p className="bb-settings-note">Updates appear here when available.</p>}
        </section>
      </main>

      <Tabbar component="nav" icons labels className="bb-bottom-navigation" aria-label="Main navigation" data-compact={compact && !askOpen} hidden={keyboardOpen}>
        <ToolbarPane className="bb-navigation-pane">
          {mainScreens.map(({ id, Icon }) => <TabbarLink key={id} component={NavigationButton} linkProps={{ type: "button" }} className="bb-navigation-link"
            active={screen === id || (screen === "settings" && lastMain === id)} aria-label={screenTitles[id]} aria-current={screen === id ? "page" : undefined}
            label={screenTitles[id]} icon={<Icon size={23} strokeWidth={1.7} aria-hidden="true" />} onClick={() => selectScreen(id)} />)}
        </ToolbarPane>
      </Tabbar>
      <AskBookieBotPanel open={askOpen && monthlyReady} onClose={() => setAskOpen(false)} month={questionMonth ?? `${report.year}-${String(report.month).padStart(2, "0")}`} mode={preferences.mode} onShowSource={showSource} />
      <AppUpdatePrompt initialVersion={initialVersion} onAvailabilityChange={setAvailableVersion} />
    </div>
  </AppNavigationContext.Provider>
}
