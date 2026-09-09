# BookieBot Home Screen widgets

Keep your existing BookieBot web app. [Scriptable](https://scriptable.app/) runs this optional Home Screen widget; there is no native BookieBot build, weekly signing or Apple developer membership.

The small and medium widgets show your name, BookieBot avatar, Current/Projected view, budget remaining, available today, and the snapshot's update time. **Medium** gives the amounts more room. Each person pairs their own phone from their own BookieBot account.

## Set up each iPhone

1. Install **Scriptable** from the App Store and open it once.
2. In your existing **BookieBot → Settings → Widgets**, download the Scriptable script. Add the downloaded code to Scriptable: use **Share → Scriptable** if offered; otherwise open the `.js` file, copy its text, tap **+** in Scriptable, and paste into a new script. Name it **BookieBot**. The download already contains the correct server address; no code changes are needed.
3. Back in **Settings → Widgets**, choose **Current** or **Projected**, create a pairing code and copy its private setup link. Run **BookieBot** inside Scriptable, paste the link when asked, and tap **Pair this phone**. The link expires after **10 minutes** and works once. Keep it private.
4. Confirm the preview shows **your name** and the expected amounts. The widget reads the current calendar month in BookieBot's Pacific timezone. Its view is the mode chosen for this connection in Settings, independent of the dashboard's selected view.
5. Hold an empty area of the iPhone Home Screen, then **Edit → Add Widget → Scriptable**. Choose **Small** or **Medium**, add it, and tap **Done**. Hold the new widget, tap **Edit Widget**, and select the **BookieBot** script. Leave the parameter empty. These steps follow [Apple's widget setup guide](https://support.apple.com/en-us/118610).
6. Tap the widget once and check the destination described below. Repeat setup on the other person's phone using their own BookieBot Settings, never by sharing a pairing link.

If the setup link expires or pairing fails, create a new one in BookieBot. Reusing a consumed link cannot recover a lost credential. Keep the Scriptable script's name unchanged after pairing; access is scoped to both that name and the BookieBot server.

## What tapping opens

The widget asks iOS to open your BookieBot server's **`/app/expenses` HTTPS page**. The link contains no account identifier, pairing code or read credential. Scriptable documents that a widget's [`url` overrides its configured tap action](https://docs.scriptable.app/listwidget/#url).

**Expect the default browser to open.** This is not a native universal link, and we cannot promise that iOS will launch the installed BookieBot Home Screen app. The browser may have a different login session or account from your installed web app. If it asks to reconnect, use your own fresh `/expense_app` link from Discord in that browser. The widget credential cannot sign the browser in. Use your existing BookieBot icon whenever you want to open the installed app directly.

The generated URL and absence of credentials are checked automatically. Actual app routing, Scriptable import and Home Screen rendering still need the tap/preview checks on your iPhone; a desktop test cannot certify those iOS behaviors.

## Updates, delays and unavailable data

Budget amounts come from the same server calculations as the dashboard; the script never recalculates them. The server can reuse a report for up to **five minutes**, keeping its original source timestamp. The avatar follows the server's daily selection when a refresh runs. Widgets are snapshots, not a continuously running app.

The script requests another refresh after 15 minutes. **iOS decides the actual timing**, and can delay it for battery or usage reasons; Scriptable's [`refreshAfterDate` is an earliest time, not a schedule guarantee](https://docs.scriptable.app/listwidget/#refreshafterdate). Opening the web app does not force iOS to redraw its widget.

- **Updated** shows when BookieBot produced that snapshot, in the phone's local date/time. **Age** uses Scriptable's [native relative date](https://docs.scriptable.app/widgetdate/) so the displayed age can advance even between script runs.
- **Stale** appears when a run cannot fetch fresh data, the snapshot is over 30 minutes old, or it belongs to an earlier Pacific day/month. The previous numbers and their original timestamp remain visible. If iOS has not run the script again, the age and timestamp are the freshness indicators; the Stale label itself cannot change until another run.
- **Budget unavailable** means there is no usable snapshot. **—** means that particular metric is unavailable; it does not mean zero.
- For an immediate check, open Scriptable, run **BookieBot**, and choose **Refresh & preview**. This requests a snapshot for the preview; within the five-minute server reuse window, it may show the same source data and timestamp. iOS still controls when the Home Screen redraws. For a live financial decision, open BookieBot and refresh there.

## Mode, revocation and privacy

Change a connection's mode or revoke it in **BookieBot → Settings → Widgets**. Brian and Hannah have independent connections; changing or revoking one does not give access to or change the other person's widget. A widget connection expires **365 days** after pairing. Signing out of the web app leaves separately paired widgets active. Your Discord **`/expense_app_reset`** revokes all phone sessions and widget connections belonging to your account.

Pairing grants only the widget's small budget summary. It cannot log an expense, record a payment, read itemized transactions, change settings or establish a web-app login. The one-time pairing link is exchanged for a separate read credential stored in [Scriptable Keychain](https://docs.scriptable.app/keychain/). It is never embedded in the script, a widget parameter, a tap URL or the snapshot file. Do not run scripts from sources you do not trust in the same Scriptable installation: Keychain is an app-level facility, not isolation between scripts.

The last summary and avatar are kept in Scriptable's **local cache**, scoped to the connection; the script never writes them to iCloud. Revoked or expired access stops server reads immediately. On the next attempted read, the script removes its stored credential and cached amounts and shows **Reconnect widget**. An already rendered Home Screen snapshot can remain until iOS refreshes it—remote revocation cannot erase a screenshot or an offline widget render.

iOS can purge cached files. Scriptable also does not promise that its [cache directory](https://docs.scriptable.app/filemanager/#-cachedirectory) is shared across execution contexts, so an in-app preview should not be treated as preloading the Home Screen widget's offline data. A widget without its own usable snapshot shows **Budget unavailable** until it can fetch one.

To remove it fully, revoke the connection in BookieBot, run the script and choose **Forget this phone**, then remove the Home Screen widget. Forget clears only this local Scriptable profile; revocation is the server-side step. Removing the widget alone does not revoke its credential. Pairing again replaces this script's local profile/cache; revoke any old connection you no longer use.

## Quick acceptance check

- Compare the two numbers with **Overview → Budget remaining** and **Burn Rate → Available today** for the same person, current month and mode. Check both Current and Projected after changing the widget connection's mode.
- Preview Small and Medium; confirm the name, avatar and full amounts fit. The timestamp and age must remain visible.
- Tap the Home Screen widget: record whether your default browser opens, which account it shows, and whether it needs its own sign-in. The installed BookieBot icon should continue to work independently.
- After one successful in-app preview, enable Airplane Mode and run **Refresh & preview**: the saved numbers should be marked **Stale**, with the original timestamp. To check the Home Screen widget's offline behavior, first let that widget itself fetch successfully online; a preview may use a different cache, and iOS may purge either cache. Restore connectivity and repeat.
- Revoke a test connection in Settings, then run the script: old amounts should disappear and **Reconnect widget** should appear. Pair again only if you want to keep using it.

Automated coverage executes the actual distributed script against a Scriptable API harness, including setup-origin rejection, Keychain/cache isolation, redirected/failed requests, expiration/revocation, stale dates, unavailable/negative amounts, avatar fallback and credential-free tap URLs. It does not simulate iOS refresh scheduling or native widget rendering.
