# Daily Spending presentation

Daily Spending uses the approved **Quiet indent** design. Its chart, axes,
Current/Projected selection, All/Needs/Wants scopes and financial totals retain
their existing definitions. Needs/Wants legend dots share the actual bar colors.

The closed Transactions pill sits beside Total Spent. Opening it replaces the
pill with the shared native **All types** selector and an X inside one capsule.
At narrow widths the capsule fills the next row. Keyboard focus follows the
replacement control. Type affects only entries and day totals, never the graph
or Total Spent. Closing/reopening retains Type; changing month/scope resets it.

Days start closed and expand independently with the shared disclosure motion.
They appear newest first, with undated entries last. Headers show the numeric
date, weekday, inline entry count and exact day total. Expanded rows sit inside
a thin left rail, sorted alphabetically by display category while preserving
source order within each category. Duplicate transactions are retained.

Rows show the merchant, amount, category in its Category Mix color and logged
item name without repeating identical text. Person names and Recorded badges
are omitted. Scheduled appears only when the canonical source says scheduled;
a future due date does not turn a recorded bill into an estimate. The category
and Scheduled status occupy the same secondary grid row. Long items can wrap.
Bars continue to open the existing exact-day inspection dialog.

Merchant artwork and fallback circles are both 28px. `transaction-identity.ts`
uses the existing approved service circles/provider aliases, then the reviewed
158-mark merchant catalog. Names match exactly after case/punctuation/spacing
normalization, with optional trailing `#123`, `store 123` or `location #123`.
Location takes precedence over item: an Apple product at an unknown shop does
not select Apple's logo. Amazon purchases and Amazon Prime remain separate.
Unknown names or failed images retain the corresponding category fallback.

`docs/merchant-logos/catalog.json` records approved artwork sources, upstream
packages, adaptations and SHA-256 hashes; the runtime JSON contains only the
fields needed to match and display it. Assets use the existing immutable local
logo route. Existing Calendar circles/catalog/importer remain unchanged. Company
marks remain their respective owners' trademarks. No runtime scraping, outside
image URLs, recategorization, sheet/bank writes or new preferences are added.

Verification: focused React/identity/calendar tests, pinned asset/hash and inert
image checks, and the shipped-bundle `daily_spending_controls_browser_test.cjs`
cover day ordering, all entries, filter isolation, status alignment, equal icon
sizes, colors, keyboard focus, themes, cents settings and responsive layout.
`section_spacing_browser_test.cjs` checks the complete page's bottom spacing.
Native acceptance steps are in `.agent/STATUS.md`, checklist 232.
