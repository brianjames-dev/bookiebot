# BookieBot on your iPhone

After deployment and the bot restart, repeat separately for Brian and Hannah:

1. In Discord, use your own account to run **`/expense_app`**.
2. Open **Set up BookieBot** in **Safari** within 15 minutes. If Discord opens its browser, choose **Open in Safari** before connecting.
3. Verify your name and tap **Connect as Brian** or **Connect as Hannah**.
4. When your report opens, tap Safari **Share** (or **More → Share**) → **Add to Home Screen**.
5. Name it **BookieBot**, keep **Open as Web App** enabled if shown, and tap **Add**.
6. Launch the icon. Confirm your name and current month. The selected report refreshes on opening and returning from the background; the **↻ refresh icon** updates it manually. **Updated** shows the last successful fetch. The **•••** menu contains dark mode and sign out.

Use current iOS when possible. Safari copies sign-in cookies into a newly installed Home Screen app on iOS 17.2 and later. If the app asks to connect, follow the reconnect steps below. Internet is required for fresh sheet values; failed refreshes keep the last report and its update time. If Google Sheets takes too long, the app identifies that timeout. Try Refresh again shortly; after a successful refresh, unavailable month history is checked once automatically. You can also use the history warning’s Retry button. A timeout does not require reinstalling or signing in again.

The Home Screen icon is the existing BookieBot holding a piggy bank (`assets/avatars/avatar1.PNG`). The avatar inside the app follows the daily rotation. iOS controls the installed icon; automatic Home Screen icon rotation is not promised.

## Using the dashboard

- **History:** tap the month heading and choose an available month. Choose the current month from that same list to return to the live view. The selection stays while that app view is open; a fresh launch starts at the current month.
- **Comparisons:** open **Compare spending**. It starts with the previous month; both month selectors list month names and years only. Use **Compare with** to choose another available month. Both sides cover the same calendar days, shortened when necessary for a shorter month. Comparison waits for an active report refresh before starting new work. If a connection fails, restore it and tap **Try again** or refresh; reopening the app is unnecessary. Changing comparison months reuses a batched history read for up to one minute; Refresh always fetches fresh data and clears that history. If Google Sheets is temporarily busy, the app says so: wait about a minute and retry. This compares dated recorded spending, not the whole Spent headline; **Details** keeps the calculation explanation and excluded amounts in labeled month columns. Missing-month and connection errors remain visible in the main comparison.
- **Details:** tap a Category Mix slice, a Daily Spending bar, or a day number for its entries. Tap the **Income / Spent / Left / Saved** label to explain the active view's total. Recorded and scheduled amounts are labeled separately; a schedule is not confirmation that a bank payment posted.
- **Reimbursements:** one segmented bar divides the outstanding balance into original expense months; matching color labels show each month’s amount. **View expenses** opens compact month groups with the amount due or **Received** on each row, including older expenses after repayment. Expand an expense to see a slim bar with the original total in ivory: blue is **Yours**, solid brown is what the named partner **paid**, and hatched brown matches the amount still **due** in the row header. The due marker appears only while expanded. Date, split method and optional location remain above the bar; fronted expenses and different budget owners are explicit. Older inconsistent records retain labeled amounts. Opening another expense in that month closes the previous one; other months remain independent. The **Totals** button beside the selected month reveals Gross paid, Your share and Received totals. Those receipts apply to the selected expenses, rather than payments received during that calendar month. **Earlier expenses** combines older graph months, and incomplete records stay flagged. Receipts do not become income or change monthly spending.
- **View preferences:** Current/Projected and your selected chart are remembered on this phone for your account. Saved view preferences contain presentation choices, not expense data. They do not change the other person's phone.
- **Ask BookieBot:** expand the section, type a question or choose a suggested question, then tap **Ask BookieBot**. Suggestions only fill the input. Answers use your latest selected month/view through the existing AI service and provide source sections you can revisit. **Clear answer** removes the answer; changing month/view also clears it. The app saves no chat history, and asking cannot change expenses or move money.

## Optional phone notifications

If Enable previously showed “Change notifications from BookieBot,” load **Update now** first, then tap **Enable on this phone** again. Existing iPhone permission can be reused; the section must say **On** and confirm the save. Change one preference and refresh to confirm it persists. Reinstalling the Home Screen icon is unnecessary.

Notifications require an installed Home Screen web app on **iOS 16.4 or later** and an explicit permission request from a button tap. [WebKit explains the requirement](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

1. Open BookieBot from its **Home Screen icon**, then expand **Phone notifications**.
2. Choose the notifications and delivery hour. The initial selection is **Weekly check-in · Mondays**, at **10 AM Pacific**. **Scheduled payments · day before** is optional and additional to Discord reminders.
3. Leave **Show amounts on the Lock Screen** off for private, generic messages. Tap **Enable on this phone**, then allow notifications when iOS asks. Nothing subscribes until you do this.
4. Optionally tap **Send a test**. This explicitly sends one generic test to this phone; setup does not send a test automatically. Check Notification Center and iPhone Focus settings if a test accepted by the push service is not visible.

After enabling, changes save automatically; **Save preferences** can retry a failed save. At least one notification type stays selected while On; use **Turn off** to stop this phone's notifications. Each phone/session has separate settings. Signout, session expiry, or `/expense_app_reset` stops future sends; after reconnecting, enable notifications again if desired. Notifications already delivered may remain in Notification Center. Delivery depends on the running server, push service, and iPhone settings; reminders describe schedules rather than confirmed bank activity.

## Personal savings goals

In **Savings goals**, tap **＋ Goal** and enter a name, target, optional date, and starting balance. The starting balance is money already allocated before this goal's contribution history. Goals belong to your account and survive months, reconnects, and deployments when the database is retained.

Goals start as compact rows with their name, exact amount set aside, and a thin progress bar. Tap the row or left chevron for its target, remaining amount, optional date, and progress; opening another goal closes the previous one. Completed goals keep their exact balance and show **Target reached** when expanded. The starting balance and contribution records are in **History**.

Open a goal's **⋯** menu for **Record contribution**, **History**, **Edit goal**, or **Archive goal**. **History → Reverse → Confirm reversal** removes an entry from the goal's balance while retaining its record. Archiving keeps the balance/history; **Archived goals → ⋯ → Restore goal** brings it back. All row actions retain their existing confirmation and save recovery behavior.

These are manual planning allocations, not bank balances or transfers. They do not read from or write to the monthly **Saved** amount. Do not count the same money toward multiple goals. If a connection fails while saving, **Retry this change** safely retries that request; **Check latest** reloads the saved state before you continue.

## Reconnect an existing icon

Access lasts up to 180 days from setup unless signed out or reset; opening the app does not extend that deadline. Safari and an installed app have separate sign-in state after installation.

1. Run **`/expense_app`** from your Discord account again.
2. Copy the private setup URL in the response.
3. Open your existing BookieBot icon and paste the URL into **Private setup link**.
4. Tap **Continue**, verify your name, then **Connect as [your name]**.

Hannah must request her own private link. **••• → Sign out** disconnects this browser/app. **`/expense_app_reset`** revokes all your phone sessions and unused setup links, useful after losing a phone. It does not affect the other person or change expenses.

Both phones use the same deployed frontend. When a newer version is detected, **A BookieBot update is ready → Update now** reloads the app; **Later** keeps the current view open. Update checks run on opening/foreground return and periodically while visible, and never force a reload. Finish any form you are editing before choosing Update now. Refresh updates expense data within the loaded version. If an older version has no update prompt, fully close it from the app switcher and reopen it once; reinstalling normally is unnecessary.

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

Verify Brian/Hannah identity and default scope, cold/foreground/manual refresh, remembered mode/chart, history selection and return to the current month, matching-day comparisons, offline/stale status, and explicit update/Later behavior. Check chart/day details and all four metric explanations. Ask about each mode and confirm answers clear when changing it. Create/contribute/reverse/archive/restore a test goal and confirm monthly Saved and the other account are unchanged.

On each iPhone, notifications must remain off until explicitly enabled. If desired, enable them and tap **Send a test**, then verify signout/reset stops future sends. Check installed-app reconnection and re-enable only if wanted. Sessions, goals, and enabled notification preferences must survive deployment while the same valid session/database remains. Unauthenticated personal APIs return 401 and private/no-store; invalid/replayed pairing links fail. Regular signed report links retain their behavior.

Identity is server-derived; the default month is Pacific and historical selections are validated against available owner workbooks. Tokens are stored only as hashes; sessions use revocable secure HttpOnly cookies. Ask tools are read-only and confined to the selected report. No financial reports are stored for offline use; the push worker does not cache expense data.

References: [Apple Home Screen setup](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [WebKit cookie transfer](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).
