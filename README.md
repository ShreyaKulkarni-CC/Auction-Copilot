# Auction Copilot — Phase 1 prototype

A narrow, deliberately small first build: one source (cars sourced via
OVE.com, read through vAuto's own pages — never ove.com directly), one
manual trigger, real Gemini reasoning. This runs in **shadow mode** —
nothing here places a bid or touches vAuto's controls. It only reads and
shows a verdict.

## What's in here

```
extension/   — the Chrome extension (Manifest V3)
server/      — the local backend that calls Gemini
```

## Before you start

This was built from screenshots, not the live vAuto page — I don't have
access to test it against the real DOM. The one piece most likely to need
adjustment is `extension/content.js`'s `findPanelText()` function, which
locates the Condition Report / Glance / CARFAX panels by their heading
text and climbs to a nearby container. Open a real vehicle page, right-click
a panel → Inspect, and confirm that function is actually grabbing the panel
content and not, say, the whole sidebar. This is the first thing to debug
together once you've got it loaded.

## 1. Run the backend

```bash
cd server
npm install
cp .env.example .env
```

Edit `.env` and add your Gemini API key (get one at
https://aistudio.google.com/apikey). Also double-check `GEMINI_MODEL` is
still a current model name — verify at
https://ai.google.dev/gemini-api/docs/models before relying on the default.

```bash
npm start
```

You should see `Auction Copilot backend listening on http://localhost:8787`.
Visit `http://localhost:8787/health` in a browser — it should report
`hasApiKey: true`.

## 2. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Open vAuto and navigate to a vehicle with Condition Report and Glance
   panels open. A small "🔦 Analyze this car" button should appear in the
   bottom-right corner. If it doesn't, the page-detection heuristic in
   `pageLooksLikeVehicleView()` needs adjusting — likely worth logging
   `document.body.innerText` to see what the page's actual text looks like.

## 3. Try it

Click the button. It should show an "analyzing…" badge, then either a
verdict card or an error message explaining what went wrong (no panels
found, backend not running, no API key, etc.) — every failure path is
meant to say what broke rather than fail silently.

## 2026-09-16 update — five new features, all now live-confirmed

Built after a full pass of live testing across ProfitTime GPS Global Search,
Manheim, ADESA, and EDGE Pipeline. Sanity-tested with a scripted
`buildPrompt()` call and a live `/analyze` request against the running
server; the quick-check icon reads specifically were confirmed via
DevTools against a real listing (see item 2).

1. **AutoCheck as a fourth reconciliation source.** `content.js` now
   extracts the AutoCheck box (Score/Owners/Accidents/Titles-Probs/ODO)
   from the Manheim iframe and tags it `[AutoCheck — separate report, not
   a Condition Report line]`. The prompt reconciles it against CARFAX/
   Condition Report and never lets it leak into `allConditionItems`.
2. **Quick-check icons — CONFIRMED LIVE 2026-09-16** on a real listing
   (Hyundai Ioniq, KMHC85LC3HU030909, Manheim Charlotte).
   `extractQuickCheckSignals()` reads the small pass/fail icons near the
   Condition Details table by color, the same way row severity is already
   read. The first pass (written without live access) guessed wrong in
   three ways, all now fixed: the real label text is "No Structural
   Damage" (not "Structural Issue"/"No Structural"); Key/Fob are numeric
   counts, not pass/fail icons, and were dropped rather than risk a false
   "flagged" tag from an unrelated element found several DOM levels away;
   Tires shows a graduated per-corner tread reading, not one pass/fail
   state, and was dropped for the same reason. What's left — Start, Int
   Odor, Drivable, No Structural Damage — was confirmed to reliably find
   its own small colored SVG marker 1-2 DOM levels up, without colliding
   with a neighboring icon's marker (`findSmallColoredMarkerNear` climbs
   incrementally and stops at the first level that finds something). See
   the comment above `QUICK_CHECK_LABELS` in content.js for the full
   before/after. "Prior Paint" was seen on a different vehicle's page
   earlier but its exact text wasn't confirmed on this one — left out
   rather than guessed.
3. **Ready Logistics transport cost folded into the bid ceiling.**
   `extractMarketBenchmarks()` pulls the dollar figure off the Glance
   panel; the prompt now subtracts it as its own explicit step before the
   margin, and `transportCost` is a new field in the verdict / shown on
   the card.
4. **Market comparison, kept separate from reconciliation.** The same
   extracted benchmark tiles (MMR Adjusted, rBook, etc.) now show up as a
   labeled `marketComparison` section on the card — how the bid ceiling
   compares to the market — structurally kept apart from the per-VIN
   fact-check so the earlier benchmark-tile-confusion bug can't reappear.
5. **Explicit out-of-scope hint.** On a `vauto.app.coxautoinc.com` page
   that looks like a single vehicle (one VIN, pricing/appraisal/inventory
   context) but has no Condition Report/Glance panels — e.g. the owned-
   inventory pricing tool — a small dismissible note now explains why
   there's nothing to analyze, instead of just showing no button.

## 2026-09-16 update #2 — two fixes from live end-to-end testing

Ran the extension against a real listing end to end (Analyze, verdict
card, "Suggest a correction") and found two real gaps, both now fixed
server-side rather than by asking the model to try harder:

1. **Bid ceiling arithmetic can silently not match its own stated math.**
   CONFIRMED LIVE on the Ioniq listing: the reasoning bullets said
   "Subtracted $1,450, $1,040, and $850 from $5,175" (= $1,835, rounds to
   $1,800) but the verdict returned bidCeiling `$2,200` — a $365 gap
   nothing caught. `promptBuilder.js` now also asks for those same four
   numbers as a plain `bidCeilingInputs` object (`benchmarkValue`,
   `reconCostMidpoint`, `transportCost`, `targetMargin`), and
   `server.js`'s new `reconcileBidCeiling()` independently recomputes the
   formula from them and overrides `bidCeiling` if it's off by more than
   $50 — the original model figure is kept in `bidCeilingModelStated`,
   never silently dropped. A green "🛠" note on the card says when this
   happened and why.
2. **`transportCost` / `marketComparison` weren't reliably reaching the
   card.** CONFIRMED LIVE on the same listing via direct DOM query: both
   fields came back empty even though the model clearly used the $1,040
   transport figure in its headline and reasoning — it uses the data, it
   just doesn't reliably echo it into these specific fields.
   `server.js`'s new `reconcileMarketData()` fills both directly from the
   same `marketBenchmarks` data already sent to Gemini in that request,
   whenever the model's own response left them empty — it never
   overrides a value the model did provide.

## 2026-09-16 update #3 — headline could state a different bid ceiling than the badge

Re-tested the same Ioniq listing twice more and found a THIRD number
disagreement, distinct from update #2's fix: the one-line `headline`
sentence shown right under the decision badge stated its own dollar
figure that didn't match the (now server-verified) `bidCeiling` badge
above it — CONFIRMED LIVE across two separate runs: badge `$2,200` vs.
headline "$3,235" in one run, badge `$1,200` vs. headline "$2,200" in
another. `reconcileBidCeiling()` from update #2 only guarantees the
structured `bidCeiling` field is arithmetically correct — it says
nothing about a competing number the model writes into free-text prose
elsewhere in the same response.

Two-part fix, same philosophy as before (verify, don't just instruct):

1. `promptBuilder.js` step 8 and the `headline` schema description now
   explicitly forbid the model from stating a dollar bid-ceiling figure
   in `headline` at all — the badge already shows it; headline's job is
   the reason, not a restated number.
2. Because prose instructions aren't reliably followed (that's the
   entire reason `bidCeilingInputs` exists for the structured field),
   `server.js`'s new `checkHeadlineConsistency()` scans `headline` for
   any dollar figure that doesn't match the verified `bidCeiling` or any
   other known input (transport cost, benchmark value, recon midpoint,
   margin) and flags it via the same green server-note mechanism, rather
   than silently rewriting the model's sentence (regex surgery on prose
   risks broken grammar, so this warns instead of edits).

Sanity-tested against the exact two live headline strings above in a
standalone harness (23 assertions total across all three fixes, all
passing) before shipping — not yet confirmed against a live Gemini call
with the updated prompt.

Both fixes were sanity-tested against the actual Ioniq numbers (including
the exact $2,200-vs-$1,800 case) in a standalone script before shipping,
plus a scripted `buildPrompt()` call confirming the new schema fields
appear in the generated prompt. Neither has a live Gemini re-run yet —
that's the next thing to confirm once this is loaded locally.

## Known limitations, on purpose (this is Phase 1, not the final build)

- **One source, one trigger.** No auto-badge yet, no other six auction
  sources — those are Phase 2.
- **Screenshot is viewport-only.** The vision pass captures what's visible
  on screen when the button is clicked, not the whole scrollable page. If
  a damage photo is scrolled out of view, it won't be seen. Worth testing
  whether that matters in practice before building anything more elaborate
  (stitching multiple screenshots, for instance).
- **No real cost-history data yet.** `server/cost-benchmarks.json` is
  empty — the model is instructed to say so and mark any estimate as
  illustrative until `recon_cost_log.xlsx` has real rows and this file is
  updated to match.
- **Shadow mode only.** This is meant to run alongside a buyer's normal
  decision, not in place of it, per the roadmap.
- **Host permissions are a guess.** `manifest.json` matches `*.vauto.com` —
  confirm that's actually the domain the Global Search / Condition Report
  pages live on, and narrow it if there's a more specific subdomain.