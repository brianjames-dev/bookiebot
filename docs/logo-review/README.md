# Small-circle logo quality review

This is an offline authoring and review process for all 89 calendar logos. The
user approved the complete revised set on 2026-10-31; the app now uses these exact
circle exports. Authoring/export alone never changes the production catalog.
`recipes.json` preserves each original, selected source, SHA-256, circle background,
optical fill and restoration method. `audit.json` records the generated candidates,
their hashes, crop bounds and source resolution. Original art and prior candidates
remain available for comparison and rollback.

## Process

1. Audit the complete catalog, including actual 26px circles on both calendar
   backgrounds and enlarged comparisons. Prefer an original SVG or larger official
   icon over recreating a brand. Resolution alone cannot establish visual quality.
2. Fix framing separately from artwork: remove the universal pale backplate, use a
   suitable brand background and optical padding, and extract a native symbol from
   a wordmark when the company already supplies one. Do not draw replacement paths.
3. For genuinely weak sources, use the built-in image-generation tool with the
   original attached and a preservation-focused prompt. Save a versioned candidate
   and its input/output hashes and full prompt in `ai-restorations.json`. This pass
   restores Aidvantage, Santa Rosa, American Water, Spectrum and Farmers. These are AI
   interpretations, not official replacement artwork or guaranteed exact tracing.
   The second pass also adapts the official YouTube Premium reference into a
   compact play-mark/Premium arrangement; its full prompt and lineage are recorded.
4. Export circle candidates at 256px and inspect them at 26px and enlarged. The
   exporter checks complete catalog coverage, source hashes, decoding and empty
   alpha bounds. It flags raster sources below 52px (2× the displayed size); a
   78px/3× source is preferable. All current candidate sources meet the 2× target;
   upscaling by itself does not count as a restored source.
5. Review with the interactive gallery. Record requested changes by catalog ID,
   retain prior versions, and revise individual recipes. Do not use the source
   importer to overwrite a curated reconstruction. Once the complete audit is
   approved, promote content-addressed assets and framing together into the app.

The exact BaJ icon is copied from the user's portfolio's
`public/favicon_io/favicon-baj-dark.png`, rather than its outdated angular SVG.
Native round badges fill their circle; square badges extend their own background
to every edge. GitHub and LinkedIn have exported-pixel border regressions. Following
the user's second-pass correction, Railway's white mark fills the complete circle;
the dark reference color remains only in its native negative-space stripes.
ChatGPT uses the clean native knot on a dark circle. No account/transaction names
are sent to a third-party logo or AI service during app use.

## Rebuild / verify

From the repository root, with Playwright available (the same module override used
by the existing browser tests):

```bash
python scripts/prepare_company_logo_marks.py
BOOKIEBOT_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/build_company_logo_review.cjs /tmp/company-logo-review-bundle.json
python -m pytest unit_tests/reports/test_logo_quality_review.py
```

Rebuilding resets the audit to `review-candidates`, requiring a fresh visual
approval before publication. After approval, mark the audit and item reviews
`approved`, then run `python scripts/update_company_logos.py --promote-reviewed`.
Promotion validates all 89 hashes/dimensions before writing any catalog change.
The app's `preparedCircle` flag displays the already-framed PNG edge to edge,
without applying the old padding or pale backplate a second time. Routine imports
preserve these pinned images while allowing explicit alias edits; a damaged pinned
file stops the import instead of silently replacing it with an upstream favicon.

The browser performs deterministic image decoding, alpha-bound measurement and
format/size export, not AI generation. A source change deliberately fails its hash
check until the reviewed recipe is updated. The generated gallery bundle contains
images suitable for embedding without runtime network requests. Revised candidates
use lossless 156px PNG previews for the 52px inspection size at 3× phone density;
original comparisons remain 96px. The renderer measures alpha bounds separately,
then paints revised source vectors directly with a full-viewport transform. Avoid
the nine-argument SVG source crop, whose intrinsic-coordinate behavior displaced
marks in Chromium. Export checks reject empty/displaced marks and wrong circle
edge colors, including NordVPN/Paramount's partial-circle center geometry.
The original full AI outputs remain in the task's `work/logo-quality-review` area;
the review sources retain normalized 256px exports and original-output hashes.

For manual acceptance, inspect every brand at calendar size; compare especially
Railway, ChatGPT, Aidvantage, Santa Rosa, BaJ, the utility symbols, Canva and Farmers.
Check complete silhouettes, optical balance, contrast, unintended white squares,
tiny wordmarks and clipping. Flag any questionable AI likeness for another pass.
For the 13 revised marks, also follow [the second-pass checklist](REVISIONS.md).

Brand marks remain their owners' property. Source URLs are recorded per recipe.
Native vector sources include pinned Dashboard Icons (the production catalog's
existing notice), Simple Icons 13/16 and gilbarbara/logos, plus official company
sites. Symbol extraction and paint adaptations are explicitly identified by the
recipes and preparation script; the imported production originals remain intact.
