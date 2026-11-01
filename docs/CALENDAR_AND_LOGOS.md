# Calendar and company logos

The Calendar graph uses the approved **Under calendar** design. Its sliding title and fixed graph indicators remain part of the existing carousel.

- Default: the current Pacific week (Sunday–Saturday) and next week. For a historical report, start with the week containing that month's first day.
- The round calendar control switches to the selected full month. Both views occupy the same grid height. No All/Subs filter, event count, or separate Details button.
- The date range sits immediately above outgoing. Daily outgoing and incoming use separate coral/mint whole-dollar capsules; they are never netted. Exact cents and Scheduled/Recorded provenance remain in the shared day dialog.
- Two-week cells show original color company logos, type icons for unknown/failed logos, and a `+N` control for overflow. Full month retains combined-color dots. Tapping a date, total, dot, logo, or overflow opens its applicable events.
- The legend sits below the grid. Keep generous bottom breathing room, consistent with Category Mix and Burn Rate, while future shared-graph work reduces unnecessary height.

## Layout and motion

Code settings live in `web/expense-report/src/calendar-model.ts`: 26px logos, 22% stack overlap, 1.5px separation, 72px target month cells, 4px cell gaps and 104px bottom space. Two-week row heights derive from the corresponding 4/5/6-row month. On shorter screens the existing shared chart stage constrains both views equally; logo capacity adjusts to the available cell height. Other graphs' heights do not change.

A logo and its small type dot share one masked layer. The next card cuts both, with hard, genuinely transparent gaps rather than a painted border or gradient. The logo's own dot uses another hard transparent cutout. View switches animate shared dates from their previous positions for 380ms; rapid toggles cancel the previous animation and Reduce Motion switches immediately. Native chart swipes still own finger tracking.

## Data boundaries

`calendarEvents` and canonical Current/Projected calculations remain unchanged. `calendarContext` contains only the adjacent months needed by the two-week view. It reuses already-read budget-history rows; it performs no extra sheet read, provisioning, mutation, bank import or notification.

If a future month's actual rows are unavailable, use recurring subscription dates (including yearly/quarterly rules), explicit bill expectations and the existing configured income projection. Never copy this month's actual utility/loan payment into next month. A scheduled bill with an unknown amount displays **Not entered**, contributes no invented zero-dollar payment, and is excluded from sums. Incomplete coverage is labeled **known outgoing**. Missing historical rows remain unavailable, rather than implying an empty month.

As before, schedules remain visible in both report modes. The header sums visible dated outflows using the selected Current/Projected inclusion rule. Adjacent context does not feed Spent, Category Mix, Burn Rate, comparison totals, activity, widgets or persistence. A scheduled date is never proof of bank posting.

## Local logo catalog

The initial catalog contains **89 images**, including Brian's ten named subscriptions, PG&E, Recology, Aidvantage, and the City of Santa Rosa, plus common streaming, software, internet, phone, insurance, electric, gas, water and waste providers. Names and aliases are reviewed explicitly; there is no fuzzy merchant matching. `Water` and `Student Loan` aliases are scoped to Brian's display profile, following his provider confirmation. They do not change sheet labels or financial categories.

`company-logo-sources.json` records reviewed source URLs. `src/company-logos.json` records the downloaded content hash, local filename and source/notice. Images use content-addressed filenames served by the narrow `/app/assets/company-logo-…` allowlist, with an immutable cache policy and same-origin CSP. The frontend fingerprint changes with catalog imports. Only visible logos load; unknown, ambiguous or failed images retain generic type icons. No transaction name is sent to a logo service at runtime.

To extend the catalog:

1. Add exact aliases and a reviewed HTTPS asset URL to `web/expense-report/company-logo-sources.json`. Prefer a pinned original-color SVG or an official square site icon. A public favicon snapshot is a secondary source when direct downloads fail.
2. Run `python scripts/update_company_logos.py` from the repository root. The importer bounds downloads, rejects active/external SVG content and HTML responses, records SHA-256, and preserves an already-reviewed local image if its source fails.
3. Review the images visually, run the catalog/model and HTTP asset tests, then typecheck/build and commit the generated assets and catalog together. Remove obsolete content-addressed files only when no catalog references them.

Brand marks remain their owners' property. The Dashboard Icons portion is pinned to commit `83f32e08257b66fbd971ac8d7645f5b38d52e85d`; its Apache-2.0 notice is in `docs/licenses/dashboard-icons.txt`. Per-image sources are retained in the catalog. Other entries are public company/city site icons or public favicon snapshots; no mark was redrawn or recolored.

Coverage research used [Nielsen's streaming coverage](https://www.nielsen.com/news-center/2026/tv-viewing-cools-off-in-nielsens-august-gauge-reports-as-sports-take-a-breather-and-school-resumes/), [J.D. Power's ISP study](https://www.jdpower.com/business/press-releases/2025-us-residential-internet-service-provider-satisfaction-study), [EIA utility data](https://www.eia.gov/electricity/data/eia861/), and [NAIC market-share reports](https://content.naic.org/research_actuarial_dept.htm). These are coverage guides, not an exhaustive company directory or a ranking of the logos bundled here.

## Manual acceptance

On a phone, open Calendar and check the current-week date range, colored logos, separate incoming/outgoing pills, and the legend/bottom spacing. Open a busy day using `+N`, inspect exact amounts, close it, then swipe to Burn Rate. Toggle full month repeatedly; the section height and scroll position should stay stable, mixed dots should remain, and no tap should fire after a swipe. Check Current/Projected, a historical month, a month/year boundary, both themes, Reduce Motion, and an unknown company. Confirm Water/Aidvantage provider icons for Brian without assigning those providers to another user's generic bills.
