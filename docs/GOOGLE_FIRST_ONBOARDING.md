# Google-first onboarding and household budgets

New people sign in with Google, create a household or accept a private invitation,
review income/allocation settings, and open a budget without Discord or a Drive
permission. Sign-in still requests only `openid email profile`. No Google token
is stored. Financial setup is a separate reviewed action after authentication.

## Brian and Hannah keep their connected budgets

Preserve each person's existing owner, actor, workbook, financial history,
canonical shared bill/repayment identities and installed phone session. Each
person links Google from their **already connected Settings → Account**. Never
merge by email or name: an unlinked Google subject creates a distinct empty
account, even if it resembles an existing person. Welcome explains this and
retains the existing pairing fallback.

Existing accounts get **Settings → Household → Create household / Join
household**. One person creates it and shares an invitation link privately; the
other reviews and accepts from their own connected account. Neither sees new
budget setup. Membership/invitations use SQL, while financial records stay in
their original Sheets. Joining does not copy expenses, adopt bills, alter splits
or settle reimbursements. Existing Bills/Shared workflows remain authoritative.

Both storage providers can belong to a household. Membership exposes names and
explicitly shared records, not private income, personal transactions or goals.
A new **database expense split against a workbook member** is rejected until a
canonical financial bridge exists; never silently create a second hidden debt
ledger. Brian/Hannah's existing shared bill/repayment integration is unchanged.

## New managed budgets

Verified Google subjects own stable app user IDs. New identities receive
`managed:<id>` / `app:<id>` keys that cannot authenticate to legacy financial
APIs. Bootstrap resolves the provider before fetching any financial report.
An unavailable bootstrap fails closed rather than choosing a default workbook.

Setup reviews household create/join, display name, expected monthly take-home,
Needs/Wants/Savings percentages totaling 100%, initial month and USD/Pacific time.
One SQL transaction creates membership and budget. Expected income plans a
budget; Current income comes from actual deposits. Budget changes preserve
earlier months' configurations. Monetary storage uses integer cents, including
exact rounding remainder allocation.

Managed screens reuse native Overview, glass navigation, merchant logos, month
picker, editor materials/slides and read-only portrait chat. They support
reviewed expense/deposit/savings-transfer entry and edit/delete, personal savings
goals and equal household expense splits (six members maximum). Transfers count
once in Saved/their linked goal, never Needs/Wants spend. Future payments cannot
be entered as actual transactions. Shared money counts only after the payer
confirms a repayment report. Sender cancellation/payer rejection of an
unconfirmed report preserves the owed share. Confirmed repayments protect source
edits; effects remain attached to the original expense month.

This initial managed provider does not port the Sheets recurring-bill,
scheduled-transfer, bank reconciliation or widget adapters. Those remain intact
for existing users and must not be exposed to generic managed actors. Discord
is not required for any managed-user flow.

## Boundaries and recovery

- Private `/app/bootstrap` resolves account/provider/setup state. Household
  metadata uses `/app/household`; managed finances use `/app/budget`.
- Both domains have review/confirm/recovery endpoints. Confirm accepts an owned
  server review ID rather than a replacement payload. Expiring reviews, request
  fingerprints, optimistic versions, live session proof and durable receipts
  commit with their changes. Retry cannot duplicate a successful command.
- Creator-only invitation links are one-use, seven-day, fragment-only and hashed
  in storage. Creating another revokes the unused previous link.
- The existing durable app database is PostgreSQL in production, with SQLite
  compatibility for isolated tests. Schema setup and mutations serialize across
  processes. No financial workbook is generated or migrated.
- An owner/endpoint-scoped browser journal stores only an interrupted review ID.
  Reload checks its result read-only; an unresolved result retains the exact
  confirmation and blocks new edits until checked/retried.
- Managed refreshes run at most once per twenty seconds while visible/idle and
  defer during drafts/reviews. Legacy refresh acknowledgement/backoff and phone
  preference separation remain unchanged.

Tests use isolated accounts/databases and stub only Google token verification
in native browser coverage. No live financial or identity records were changed.
Real Google/PWA acceptance is STATUS checklist 304; release evidence is in the PR.
