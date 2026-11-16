# Accounts and shared bills

BookieBot now owns a stable account ID. Google is a sign-in identity linked to
that account; the existing workbook and Discord actor keys remain financial
adapters. Existing Home Screen sessions and pairing links continue to work.
Accounts are never merged by matching names or email addresses.

## Link Google once

From the **already connected app**, open **Settings → Account → Link Google
account** and select your own approved Google test account. The callback links
Google’s verified subject and rotates the first-party BookieBot session.
Thereafter **Continue with Google** on the disconnected screen can reconnect
that same account. An unlinked Google account cannot choose a workbook or sign
itself up as Brian or Hannah. Each person links from their own connected app.

The start action respects unsaved financial drafts and unresolved saves. A
cancelled, expired, replayed, wrong-browser or revoked-session callback does not
link an identity. Linking a different Google account over an existing link, or
using an identity already linked to somebody else, is rejected.

Tap the **BookieBot portrait** to open **Talk to BookieBot**. The existing chat
panel, read-only questions, focus return and animations are retained. Settings
also has one portrait opener beside its existing gear control. Discord remains
operational during this migration; its optional plugin cutover and additional
in-app mutation/chat capabilities are later work.

## Share a bill

1. The payer saves the bill’s recurring split in **Settings → Bills**.
2. Open that bill and choose its **Share bill** icon. **Review invitation →
   Confirm** sends an in-app invitation to the existing configured partner.
3. The partner opens the invitation in **Bills**, reviews it and explicitly
   accepts. An invitation alone grants no recurring planning contribution.
4. The payer keeps managing the single original plan and entering variable
   invoices. The recipient sees its schedule, their share, the original monthly
   total, confirmed receipts and the remaining balance, with a link to Shared.

The recipient’s editor is read-only for recurring fields. Payments continue
through the existing Shared/reimbursement flows, with their normal confirmation
and recovery. Either person can review stopping sharing. That removes the
shared Bills view/planning link; it does not cancel the payer’s bill, delete a
transaction or forgive/receive an outstanding repayment.

Legacy local bills are coalesced only when existing canonical split lineage
identifies their exact source. A matching merchant name alone is insufficient.
If that verified local bill still has its own positive future recurring rule,
acceptance asks the member to end that separate setup from next month first.
Use the native Stop review and retain its already recorded charges; then accept
the invitation. This prevents two future schedules without silently deleting
history or altering an existing charge. One local source cannot be adopted by
two accepted shared bills.

## Amounts and refresh

- The payer’s hidden plan remains the source for future amount/date/split
  versions. An already recorded occurrence retains its original category,
  autopay date and canonical split, even after a recurring edit.
- Confirmed repayment, a reported payment awaiting confirmation, and autopay
  status are separate. An early reimbursement does not mark the bill paid.
  Cleared balances are not described as money received.
- Accepted recipient planning derives the remaining share from that same
  occurrence. Existing paid or queued recipient amounts fulfill it once, including a renamed
  display label resolved through its verified local plan.
  Cancelled allocations do not reappear as current-month forecasts.
  Adjacent calendar forecasts continue across December/January.
- Variable estimates use available completed **gross shared invoices**, then
  apply the recurring split. They never average the payer’s net-after-repayment
  cell. Current-cycle invoices and ambiguous duplicate samples are excluded.
- Recipient forecasts appear in Projected Overview/Calendar. They are never
  written into actual-only Transactions or the monthly worksheets. Historical
  actuals and confirmed repayments remain their original source records.
- Visible screens check the shared cursor/canonical ledger versions every
  twenty seconds and on focus/reconnection. Drafts and pending/uncertain
  commands defer refresh. Pull-to-refresh remains available. This is foreground
  synchronization, not push delivery while the app is closed.

## Persistence and recovery

Operational tables in the existing app-access database hold stable users,
provider links, short-lived OAuth flows, reviewed bill memberships, immutable
sharing-command receipts and refresh cursors. Financial plans and charges stay
in `_BookieBot Bill Schedule`, `_BookieBot Subscription Schedule` and
`_BookieBot Bill Charges`; existing canonical allocation/repayment events remain
the only repayment ledger. Sharing does not copy financial amounts into SQL or
create a second recurring plan.

Sharing confirms under the existing Bills/projection locks, rechecks source and
membership revisions and verifies the initiating session. The browser journals
the exact command before POST. **Check saved change** is read-only; **Retry same
confirmation** reuses its original ID/body. Folding and reload never resubmit
automatically. Unknown outcomes retain recovery; definitive non-applied
rejections release the journal with an explicit error.

## Deployment configuration

Google Cloud project `bookiebot-463020` has a **BookieBot Web** web OAuth client,
an External/Testing audience and the two user-approved test accounts. Authorized
origin: `https://bookiebot-production.up.railway.app`. Redirect URI:
`https://bookiebot-production.up.railway.app/app/auth/google/callback`.

The existing Railway service has `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`. Values stay in its secret configuration, never in
the repository. Requested scopes are only `openid email profile`; no Gmail,
Drive or Sheets access is requested from the signing-in Google account.
BookieBot continues using its existing server-side Sheets integration.

The audience must leave Testing before general public access. This release
supports the existing configured financial pair. Public household enrollment,
new workbook provisioning, provider management and a complete Discord-independent
financial-adapter migration are separate follow-ups.

## Manual acceptance

1. Update the Home Screen app, link each person’s Google account from their own
   existing session, then verify reconnecting with Google. Test the installed
   iPhone/PWA callback and Safari handoff on the physical phone; isolated browser
   tests validate the protocol but cannot prove that OS-specific handoff.
2. Tap the portrait on Overview and Settings; close chat and verify focus,
   Current/Projected, the gear and fixed nav in closed/open DUO.
3. Share one genuinely intended split bill and accept from the other app. Verify
   the shared row, readonly recipient fields, original charge and repayment
   totals against Shared. Review/cancel first when inspecting existing data.
4. Verify Projected/Calendar includes only the unpaid recipient remainder and
   Current/Transactions remain actual-only. Refresh another device after a
   genuinely intended existing financial change; never create test repayments
   in production.
5. Fold with a sharing review open. Check short landscape fit, closed inline
   scrolling and retained selection. Isolated regressions cover lost responses,
   reload, exact-request retry, revoked sessions and rejected journals.
