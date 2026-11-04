# Daily Spending presentation

## Authenticated Transactions workspace (2026-11-03)

The approved inline Row Context editors, headerless Slide + resize reviews, Rising fill/pie shortcut, shared-track icon actions, confirmed value/category motion and timed Undo are described in [Transactions](TRANSACTIONS.md). Current-date captions show the actual weekday; the soft date marker remains.

The app now reuses the native chart and row/motion components on **Transactions**;
Overview ends after its four-chart carousel. One All chooser beside Total Spent
filters the recorded chart and list together (Needs/Wants/Shared/categories,
plus Income/Savings); search follows below. Single-entry days are flat and keep
the same total alignment, 28px logo and category badge. Multi-entry days retain
the Date column, quiet indent, Today and persistent-circle snake motion.
Joined right-side Update/Split/Delete actions slide out on a left swipe, with
8px corners, a 12px gap and matching 420ms entry/exit easing. A fixed viewport
clips the painted circle at the row edge without opacity changes. Controls have
no visible focus borders, outlines or focus shadows while retaining keyboard use.
Totals/counts cover the complete recorded snapshot, not just a 40-row page.
Category changes are part of one reviewed Update, delegated to the existing Move
writer. Full canonical purchase amounts can differ from projected/net budget
metrics; scheduled entries remain outside this recorded workspace. See
[Transactions](TRANSACTIONS.md) for scope, safety, pagination and manual checks.

## Standalone signed report

The remaining description of the Transactions morph, type-only filtering and
Current/Projected totals applies to the **standalone report**, not the app tab.
Both surfaces continue using the same native graph, icons and day motion below.

Daily Spending keeps the approved Quiet indent rows and Date column preview.
The chart, axes, Current/Projected, All/Needs/Wants scopes and financial totals
retain their existing definitions. The Needs/Wants legend shares the bar colors.

Transactions sits beside Total Spent and morphs into the existing All types
selector and X. The first tap reveals these controls and the list; only a separate
tap on the selector opens its native picker. Focus lands on the labeled group,
not the select, so iPhone does not open the picker as a side effect. Tab enters
the selector; closing restores the Transactions trigger. Both surfaces remain
mounted and inactive controls are inert and hidden from accessibility.
CSS interpolates width and crossfade in the same amount row at every width.
The right edge stays anchored. The selected text determines the left filter's
width; the X stays 44px. The whole capsule is capped at 190px or 55% of the row,
leaving room for the amount without a second row. A visible label supplies real
ellipsis while the native select remains over it for touch, keyboard and full
option values. Label changes, font readiness and window resize update the width
target; CSS interpolates it without observing the animated capsule or running
per-frame JavaScript. Both collapsed and expanded surfaces use the same primary
8% tint as the category dropdowns, including the collapsed hover state.
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
keeping category dots visible. Nested clips subtract preceding circles and
their badges, leaving hard transparent gaps. Large circle gaps keep a rigid
16px radius (14px icon + 2px gap): a clip window translates with the upper circle,
while an inverse child translation keeps the lower icon's paint in place. The
large shape never morphs on a separate animation clock. Wholly outside holes
park tangent to the icon bounds, keeping the fixed clipping plane small.
Only gaps whose swept bounds can touch an icon get moving layers; distant
neighbors remain unclipped, including between keyframe samples on fast paths.
Small badge holes still shrink directly with their badge. Separate clip layers
intersect so overlapping circle/badge holes cannot refill each other. Category dots shrink on departure
and return on collection; logos remain opaque without crossfading duplicate skins
or swapping image elements at landing. Unknown/failed logos use category fallbacks.
Every fallback glyph uses its Category Mix color with a 12% tint of that color
behind it, in both themes. Utilities use blue; static bills and Needs
subscriptions use purple. Income uses the success color, while cash Savings and
ESPP retain their separate chart colors. The same 28px circle keeps this styling
while loading, after an image failure, and throughout opening/closing; loaded
merchant artwork keeps its original colors.
Constant icon opacity is written directly rather than animated; only actual
overflow fades get opacity keyframes. Motion does not toggle `will-change` on
the clipped icon surfaces, avoiding redundant compositing changes at startup.

`web/expense-report/src/daily-transactions-motion.ts` keeps travel at 500ms with
36ms staggering, a 34px curve and a subtle spring. The cascade is capped at 216ms
on very long days. Offscreen overflow entries settle directly while all entries
remain available. Browser keyframes interpolate transforms, small badge geometry,
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
store/location numbers. Normalize Unicode, case, punctuation and spacing; no
fuzzy, substring or typo matching is used. Locations take precedence, with item
names checked only when the location is blank. `Starbucks Coffee Company` is an
explicit alias for Starbucks; `Starbucks Coffee Company store #123` also matches.
An unrelated shop selling a Starbucks product cannot borrow its logo. Amazon and
Amazon Prime stay distinct. The latest eleven reviewed circle refinements are
published with their exact candidate hashes, including full-bleed Whole Foods
and the smile-only Amazon. Runtime images are local content-addressed assets;
Calendar artwork/catalogs/import workflows are unchanged. No recategorization,
sheet/bank writes, remote requests or extra settings are introduced.

Verification includes focused React/identity tests, pinned asset/hash checks,
`daily_date_column_browser_test.cjs` for six/+N, Today, positions, opacity and
reversal continuity, image identity, keyboard/resize/reduced-motion/cleanup, and
`daily_transactions_motion_browser_test.cjs` for a 120-entry day.
`daily_icon_edges_browser_test.cjs` samples moving fallback/logo edge pixels on
high-density mobile surfaces from 0ms onward, verifies initial/repeat opening
without redundant opacity effects or layer-hint changes, compares the last
collapse frame with rest, and emulates lagging cutout painting (frozen legacy SVG
and a 32ms delay on large CSS shape animations). The previous implementations
fail those emulated cases. Gap-center alignment with the upper circle and
unchanged lower-icon paint positions are checked throughout motion; native iOS
behavior still requires phone acceptance. The shipped-bundle
`daily_spending_controls_browser_test.cjs` covers scopes, controls, transparent-gap
pixels, category order, status alignment, themes, cents and responsive layout.
`section_spacing_browser_test.cjs` checks overall bottom spacing.
`transaction_fallback_colors_browser_test.cjs` compares computed glyph/disc
colors directly with the production Category Mix palette, including aliases,
both themes, live theme switching, failed images and moving persistent circles.
`transaction_logo_publication_browser_test.cjs` checks all eleven published marks
in actual Daily Spending/Calendar components, the Starbucks alias/display name,
zero extra padding and persistent image identity during expansion/collapse.
All browser checks use synthetic data and blocked external requests. Native acceptance is checklist
241 in `.agent/STATUS.md`; physical-device appearance still needs phone review.
