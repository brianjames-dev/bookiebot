# BookieBot on your iPhone

After deployment and the bot restart, repeat separately for Brian and Hannah:

1. In Discord, use your own account to run **`/expense_app`**.
2. Open **Set up BookieBot** in **Safari** within 15 minutes. If Discord opens its browser, choose **Open in Safari** before connecting.
3. Verify your name and tap **Connect as Brian** or **Connect as Hannah**.
4. When your report opens, tap Safari **Share** (or **More → Share**) → **Add to Home Screen**.
5. Name it **BookieBot**, keep **Open as Web App** enabled if shown, and tap **Add**.
6. Launch the icon. Confirm your name and current month. It refreshes on opening and returning from the background; the **↻ refresh icon** updates it manually. **Updated** shows the last successful fetch. The **•••** menu contains dark mode and sign out.

Use current iOS when possible. Safari copies sign-in cookies into a newly installed Home Screen app on iOS 17.2 and later. If the app asks to connect, follow the reconnect steps below. Internet is required for fresh sheet values; failed refreshes explicitly identify the previous update.

The Home Screen icon is the existing BookieBot holding a piggy bank (`assets/avatars/avatar1.PNG`). The avatar inside the app follows the daily rotation. iOS controls the installed icon; automatic Home Screen icon rotation is not promised.

## Reconnect an existing icon

Access lasts up to 180 days unless signed out or reset. Safari and an installed app have separate sign-in state after installation.

1. Run **`/expense_app`** from your Discord account again.
2. Copy the private setup URL in the response.
3. Open your existing BookieBot icon and paste the URL into **Private setup link**.
4. Tap **Continue**, verify your name, then **Connect as [your name]**.

Hannah must request her own private link. **••• → Sign out** disconnects this browser/app. **`/expense_app_reset`** revokes all your phone sessions and unused setup links, useful after losing a phone. It does not affect the other person or change expenses.

Both phones use the same deployed frontend. After a design update, fully close the app from the app switcher and reopen it to load the new version; reinstalling normally is unnecessary. Refresh updates expense data within the currently loaded version.

## Deployment

The existing server hosts `/app/expenses`. Deploy updated main and restart BookieBot to sync the slash commands. A git push alone does not prove deployment.

- Public HTTPS: `BOOKIEBOT_PUBLIC_BASE_URL`, existing `PUBLIC_BASE_URL`, or Railway public domain.
- Durable database precedence: `BOOKIEBOT_APP_DATABASE_URL`, then `BANK_DATABASE_URL`, then `DATABASE_URL`. Existing Postgres can be reused; only `app_phone_pairings` and `app_phone_sessions` are added. Plaid is not required.
- Railway without Postgres: mount a volume. The default file is `app-access.sqlite3` inside `RAILWAY_VOLUME_MOUNT_PATH`; an optional `BOOKIEBOT_APP_SQLITE_PATH` must be inside that mount. Setup refuses ephemeral Railway storage.
- Local development defaults to `data/app-access.sqlite3` or `BOOKIEBOT_APP_SQLITE_PATH`.

If the command is missing, verify deployment and restart. If setup is unavailable, check HTTPS and durable storage. For expired/used links, request a new one.

## Acceptance checks

Verify Brian/Hannah identity and default scope, cold/foreground/manual refresh, preserved same-month filters, current-month rollover, offline/stale status, signout/reset and installed-app reconnection. Sessions must survive deployment. Unauthenticated `/app/expenses/data` returns 401 and private/no-store; invalid/replayed pairing links fail. Regular signed report links retain their behavior.

Identity and Pacific month are server-derived. Tokens are stored only as hashes; sessions use revocable secure HttpOnly cookies. No financial reports are stored for offline use.

References: [Apple Home Screen setup](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [WebKit cookie transfer](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).
