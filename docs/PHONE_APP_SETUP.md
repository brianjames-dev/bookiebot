# BookieBot on your iPhone

After deployment and the bot restart, repeat separately for Brian and Hannah:

1. In Discord, use your own account to run **`/expense_app`**.
2. Open **Set up BookieBot** in **Safari** within 15 minutes. If Discord opens its browser, choose **Open in Safari** before connecting.
3. Verify your name and tap **Connect as Brian** or **Connect as Hannah**.
4. When your report opens, tap Safari **Share** (or **More → Share**) → **Add to Home Screen**.
5. Name it **BookieBot**, keep **Open as Web App** enabled if shown, and tap **Add**.
6. Launch the icon. Confirm your name and current month on **Overview**. The selected report refreshes on opening and returning from the background; the **↻ refresh icon** updates it manually. **Updated** shows the last successful fetch. The header **gear** opens Settings for dark mode, notifications, account/signout and app updates.

Use current iOS when possible. Safari copies sign-in cookies into a newly installed Home Screen app on iOS 17.2 and later. If the app asks to connect, follow the reconnect steps below. Internet is required for fresh sheet values; failed refreshes keep the last report and its update time. If Google Sheets takes too long, the app identifies that timeout. Try Refresh again shortly; after a successful refresh, unavailable month history is checked once automatically. You can also use the history warning’s Retry button. A timeout does not require reinstalling or signing in again.

The Home Screen icon is the existing BookieBot holding a piggy bank (`assets/avatars/avatar1.PNG`). The avatar inside the app follows the daily rotation. iOS controls the installed icon; automatic Home Screen icon rotation is not promised.

## Using the dashboard

Use the bottom navigation to switch screens:

| Screen | Contents | Scope |
| --- | --- | --- |
| **Overview** | Income, Spent, Left and Saved; Compare spending; Category Mix, Burn Rate, Calendar and Bills & Utilities | Selected month and Current/Projected view |
| **Spending** | Daily spending and largest/frequent expenses | Same selected month and view |
| **Shared** | Owed to you, You owe, payment history and offsets | Canonical reimbursement balances across months |
| **Savings** | Total recorded savings, goals and contribution history | Personal goals across months |

The Konsta navigation bar becomes compact while you scroll down and expands when you scroll up. Switching screens keeps their scroll positions, open controls and forms during the current app session. The header gear opens **Settings**; **Back** returns to the last main screen. The chat icon opens Ask BookieBot from any screen. Signed report links retain their existing report layout; this navigation belongs to the authenticated phone app.

- **History:** tap the month heading on Overview or Spending. A month-grid popover highlights the selected month; use its year arrows to browse available years. Months without available history are disabled. Choose the current month from the same grid to restore the live current-month view. The selection stays while that app view is open; a fresh launch starts on Overview at the current month. Tap outside or press Escape to close the picker without changing the selection.
- **Comparisons:** on Overview, open **Compare spending**. It starts with the previous month; **Compare with** opens the same month-grid picker, with month/year labels and no “Last month” prefix. Both sides cover the same calendar days, shortened when necessary for a shorter month. Comparison waits for an active report refresh before starting new work. If a connection fails, restore it and tap **Try again** or refresh; reopening the app is unnecessary. Changing comparison months reuses a batched history read for up to one minute; Refresh always fetches fresh data and clears that history. If Google Sheets is temporarily busy, the app says so: wait about a minute and retry. This compares dated recorded spending, not the whole Spent headline; **Details** keeps the calculation explanation and excluded amounts in labeled month columns. Missing-month and connection errors remain visible in the main comparison.
- **Details:** tap a Category Mix slice, a Daily Spending bar, or a day number for its entries. Tap the **Income / Spent / Left / Saved** label to explain the active view's total. Recorded and scheduled amounts are labeled separately; a schedule is not confirmation that a bank payment posted.
- **Reimbursements:** open **Shared** and choose **Owed to you** or **You owe**. Month segments show which original purchases make up the selected outstanding balance. Expand an expense for its split, confirmed payments, remaining amount and available payment actions. Confirmed repayment changes spending: it reduces the payer's original expense and records a linked repayment expense for the debtor, dated when paid. It never becomes income or transfers money. See [Shared reimbursement payments](#shared-reimbursement-payments) below and the [full accounting and recovery guide](REIMBURSEMENTS.md). If the canonical ledger is not enabled, Shared retains the historical report-based reimbursement view; it does not offer the canonical payment workflow.
- **View preferences:** Current/Projected and your selected chart are remembered on this phone for your account. Saved view preferences contain presentation choices, not expense data. They do not change the other person's phone.
- **Ask BookieBot:** tap the header chat icon to open a floating panel that slides in from the right. Its heading shows the selected report month and Current/Projected view, including when opened from Shared, Savings or Settings. Type a question or choose a suggestion, then tap **Ask BookieBot**; suggestions only fill the input. Close with **×**, outside the panel, or Escape. Closing and reopening keeps the question, answer and any ongoing request. **Cancel** stops a request; **Clear answer** removes the answer. Changing the report month or Current/Projected view clears the old question and answer and cancels its request. A source button closes the panel and opens the relevant screen and section. Answers use the existing read-only AI service; the app saves no conversation history and cannot change expenses or move money.

## Optional phone notifications

If Enable previously showed “Change notifications from BookieBot,” load the available app update first, then tap **Enable on this phone** again. Existing iPhone permission can be reused; the section must say **On** and confirm the save. Change one preference and refresh to confirm it persists. Reinstalling the Home Screen icon is unnecessary.

Notifications require an installed Home Screen web app on **iOS 16.4 or later** and an explicit permission request from a button tap. [WebKit explains the requirement](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

1. Open BookieBot from its **Home Screen icon**, then open **Settings → Notifications** using the header gear.
2. Choose the notifications and delivery hour. The initial selection is **Weekly check-in · Mondays**, at **10 AM Pacific**. **Scheduled payments · day before** is optional and additional to Discord reminders.
3. Leave **Show amounts on the Lock Screen** off for private, generic messages. Tap **Enable on this phone**, then allow notifications when iOS asks. Nothing subscribes until you do this.
4. Optionally tap **Send a test**. This explicitly sends one generic test to this phone; setup does not send a test automatically. Check Notification Center and iPhone Focus settings if a test accepted by the push service is not visible.

After enabling, changes save automatically; **Save preferences** can retry a failed save. At least one notification type stays selected while On; use **Turn off** to stop this phone's notifications. Each phone/session has separate settings. Signout, session expiry, or `/expense_app_reset` stops future sends; after reconnecting, enable notifications again if desired. Notifications already delivered may remain in Notification Center. Delivery depends on the running server, push service, and iPhone settings; reminders describe schedules rather than confirmed bank activity.

## Personal savings

The **Savings** total adds the recorded balances of all your goals, including archived goals. Each balance already includes its starting amount and unreversed contributions; these are counted once. Archiving or restoring a goal does not change the total. This is independent of the selected expense month.

Under **Savings → Goals**, tap **＋ Goal** and enter a name, target, optional date, and starting balance. The starting balance is money already allocated before this goal's contribution history. Goals belong to your account and survive months, reconnects, and deployments when the database is retained.

Goals start as compact rows with their name, exact amount set aside, and a thin progress bar. Tap the row or left chevron for its target, remaining amount, optional date, and progress; opening another goal closes the previous one. Completed goals keep their exact balance and show **Target reached** when expanded. The starting balance and contribution records are in **History**.

Open a goal's **⋯** menu for **Record contribution**, **History**, **Edit goal**, or **Archive goal**. **History → Reverse → Confirm reversal** removes an entry from the goal's balance while retaining its record. Archiving keeps the balance/history; **Archived goals → ⋯ → Restore goal** brings it back. All row actions retain their existing confirmation and save recovery behavior.

These are manual planning allocations, not bank balances or transfers. They do not read from or write to the monthly **Saved** amount. Do not count the same money toward multiple goals. If a connection fails while saving, **Retry this change** safely retries that request; **Check latest** reloads the saved state before you continue.

## Reconnect an existing icon

Access lasts up to 180 days from setup unless signed out or reset; opening the app does not extend that deadline. Safari and an installed app have separate sign-in state after installation.

1. Run **`/expense_app`** from your Discord account again.
2. Copy the private setup URL in the response.
3. Open your existing BookieBot icon and paste the URL into **Private setup link**.
4. Tap **Continue**, verify your name, then **Connect as [your name]**.

Hannah must request her own private link. **Settings → Account → Sign out** disconnects this browser/app. **`/expense_app_reset`** revokes all your phone sessions and unused setup links, useful after losing a phone. It does not affect the other person or change expenses.

## App updates and unfinished work

Both phones use the same deployed frontend. When a different deployed version is detected, the **A BookieBot update is ready** toast offers **Update** and **×**. **Update** reloads the app after unfinished-work checks. **×** dismisses that exact version's toast for the current browser/app session, without hiding the update in **Settings → About & updates → Update available · Update now**. A different version can show a new notice. Settings also shows the loaded version.

Update checks run on opening/foreground return and periodically while visible; they never force a reload. Refresh updates expense data within the loaded version. If an older version has no update prompt, fully close it from the app switcher and reopen it once; reinstalling normally is unnecessary.

Updates and signout wait for pending savings, reimbursement, notification or Ask requests. If a financial change has an uncertain result, resolve it with that form's recovery controls before proceeding; a timeout may mean the change already saved. Unsaved drafts, including a retained Ask question or answer, offer **Keep editing** or explicit discard before leaving. If a form cannot safely discard itself, save or cancel it first. These checks also include work on another tab: switching screens keeps it available instead of treating navigation as cancellation. Drafts are not durable storage and should be saved before closing the app.

## Deployment

The existing server hosts `/app/expenses`. Deploy updated main and restart BookieBot to sync the slash commands. A git push alone does not prove deployment.

- Public HTTPS: `BOOKIEBOT_PUBLIC_BASE_URL`, existing `PUBLIC_BASE_URL`, or Railway public domain.
- Durable database precedence: `BOOKIEBOT_APP_DATABASE_URL`, then `BANK_DATABASE_URL`, then `DATABASE_URL`. Existing Postgres can be reused. Phone sessions, personal goals/contribution history, notification subscriptions/preferences, delivery records, and push signing keys use their own `app_*` tables. Plaid is not required.
- Railway without Postgres: mount a volume. The default file is `app-access.sqlite3` inside `RAILWAY_VOLUME_MOUNT_PATH`; an optional `BOOKIEBOT_APP_SQLITE_PATH` must be inside that mount. Setup refuses ephemeral Railway storage.
- Local development defaults to `data/app-access.sqlite3` or `BOOKIEBOT_APP_SQLITE_PATH`.
- Install the repository requirements, including the Web Push dependency. Push signing keys are generated and persisted automatically. Keep the database/volume across deployments; the running server checks opted-in notification schedules.
- Historical month discovery requires configured personal/shared annual spreadsheet IDs and existing month tabs. Missing or inaccessible history is identified in the UI. Reimbursement carry-forward reads configured payer ledgers directly, without copying their rows into the new year.

If the command is missing, verify deployment and restart. If setup is unavailable, check HTTPS and durable storage. For expired/used links, request a new one.

## Acceptance checks

Verify Brian/Hannah identity and default scope, cold/foreground/manual refresh, remembered mode/chart, and all four navigation tabs. Scroll down/up to check the compact navigation; switch tabs and return to confirm scroll positions and open forms remain. Use the gear and Back to check Settings and its appearance, notification, account and update controls.

Check both month popovers: selected-month highlight, year arrows, unavailable months, outside/Escape dismissal, and return to the current month. Verify matching-day comparisons, offline/stale status, chart/day details and all four metric explanations. Open Ask from each screen, close/reopen during a question, follow a source link, and confirm changing month/mode clears its old context. Create/contribute/reverse/archive/restore a test goal and confirm monthly Saved and the other account are unchanged.

Check explicit **Update**/**×** behavior: dismissing one version leaves it in Settings and suppresses repeat notices for that version during the session; a different version can notify again. Confirm update/signout cannot interrupt a pending or uncertain change, and a draft requires keeping or explicitly discarding it. Use isolated test records for reimbursement payment and recovery checks described in [REIMBURSEMENTS.md](REIMBURSEMENTS.md).

On each iPhone, notifications must remain off until explicitly enabled. If desired, enable them and tap **Send a test**, then verify signout/reset stops future sends. Check installed-app reconnection and re-enable only if wanted. Sessions, goals, and enabled notification preferences must survive deployment while the same valid session/database remains. Unauthenticated personal APIs return 401 and private/no-store; invalid/replayed pairing links fail. Regular signed report links retain their behavior.

Identity is server-derived; the default month is Pacific and historical selections are validated against available owner workbooks. Tokens are stored only as hashes; sessions use revocable secure HttpOnly cookies. Ask tools are read-only and confined to the selected report. No financial reports are stored for offline use; the push worker does not cache expense data.

References: [Apple Home Screen setup](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [WebKit cookie transfer](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).

## Shared reimbursement payments

Once the canonical ledger is enabled, **Shared** shows **Owed to you** and **You owe** across months. An empty direction has a simple message, with settled history still available when present. Expand a row to record a full or partial amount: the recipient's **Record received** confirms money already received; the debtor's **Record sent payment** waits for the other person to **Confirm received**. Pending sent reports must be resolved before another direct receipt or offset for that expense.

Only confirmed amounts change expense rows. The payer's original purchase is reduced by the confirmed repayment, and the debtor gets a linked expense dated when they paid, including when that falls in a later month. **Offset balances** previews equal allocations in both directions before confirming. This records settlement without transferring money or creating income. History retains payments and reviewed reversals; imported historical received splits remain read-only. A syncing notice means the payment is saved and expense-sheet updates are pending; use Refresh to retry. See [full workflow, accounting and safeguards](REIMBURSEMENTS.md).
