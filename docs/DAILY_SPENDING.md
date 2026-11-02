# Daily Spending presentation

Daily Spending keeps the approved Quiet indent rows and Date column preview.
The chart, axes, Current/Projected, All/Needs/Wants scopes and financial totals
retain their existing definitions. The Needs/Wants legend shares the bar colors.

Transactions sits beside Total Spent and morphs into the existing All types
selector and X. Both control surfaces remain mounted; CSS interpolates width,
crossfade and the narrow-screen slide/space. Inactive controls are inert and
hidden from accessibility. Keyboard focus follows the replacement control.
Type changes only entries/day totals, never the chart total. Close/reopen retains
Type and expanded days; month/scope changes reset Type, and month resets days.

Days start closed, newest first with undated entries last. The numeric date and
abbreviated weekday form a left column; the actual current Pacific date uses a
soft mint circle and Today beneath it, plus `aria-current="date"`. Historical
months never acquire the marker merely by sharing today's day number. A preview
shows six 28px expense circles, then exact +N overflow. Sparse days show only
actual entries. Header previews wrap when needed without clipping long amounts.
Expanded parents replace the preview with a muted singular/plural entry count,
fading in after circles depart and fading out before their return.

Each expense has one persistent painted circle. Opening uncoils the circles
along staggered curved paths into their exact itemized-row positions; closing
collects them along the reverse path. Earlier expenses stack above later ones,
keeping category dots visible. Real SVG alpha cutouts subtract preceding circles
and their badges, leaving hard transparent gaps. Category dots shrink on departure
and return on collection; logos remain opaque without crossfading duplicate skins
or swapping image elements at landing. Unknown/failed logos use category fallbacks.

`web/expense-report/src/daily-transactions-motion.ts` keeps travel at 500ms with
36ms staggering, a 34px curve and a subtle spring. The cascade is capped at 216ms
on very long days. Offscreen overflow entries settle directly while all entries
remain available. Browser keyframes interpolate transforms, cutout geometry,
text opacity and panel height; there is no per-frame React or JS animation loop.
Reversals sample the current presentation. Width changes settle on the next
animation frame, outside ResizeObserver delivery; reduced motion snaps directly.
Initial layout writes final geometry without constructing/cancelling animations.
Explicit CSS isolation prevents the global reduced-motion duration from starting
secondary transitions when final styles are assigned. Observers/animations are
disposed on unmount; no new dependency or saved preference is introduced.

Rows mount on first opening and retain their DOM and decoded images afterward.
Category sorting preserves original source order within each display category;
amounts and duplicate transactions are unchanged. Quiet-indent rows show merchant,
amount, Category Mix-colored category and logged item, with Scheduled only for
canonical scheduled entries. Category and Scheduled share the secondary line.
The row's 28px anchor is the landing position for its single persistent logo.
Bars retain the existing exact-day inspection dialog.

Merchant identity reuses approved service/provider aliases, then the 158 reviewed
merchant marks. Matching uses explicit normalized names and optional trailing
store/location numbers; locations take precedence over product names. Amazon and
Amazon Prime stay distinct. Runtime images are local content-addressed assets;
Calendar artwork/catalogs/import workflows are unchanged. No recategorization,
sheet/bank writes, remote requests or extra settings are introduced.

Verification includes focused React/identity tests, pinned asset/hash checks,
`daily_date_column_browser_test.cjs` for six/+N, Today, positions, opacity and
reversal continuity, image identity, keyboard/resize/reduced-motion/cleanup, and
`daily_transactions_motion_browser_test.cjs` for a 120-entry day. The shipped-bundle
`daily_spending_controls_browser_test.cjs` covers scopes, controls, transparent-gap
pixels, category order, status alignment, themes, cents and responsive layout.
`section_spacing_browser_test.cjs` checks overall bottom spacing. Browser checks
use synthetic data and blocked external requests. Native acceptance is checklist
234 in `.agent/STATUS.md`; physical-device smoothness still needs phone review.
