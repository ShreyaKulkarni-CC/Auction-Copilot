const { loadBenchmarksSummary } = require("./costBenchmarks");

/**
 * Builds the prompt for Gemini. Implements the pipeline locked in the
 * scoping brief: ingest -> extract & normalize -> reconcile across
 * sources -> classify by cost impact -> price it -> reason & recommend.
 *
 * The worked example (the Trax) is real — it's the actual mismatch found
 * during the walkthrough — and is included so the model has a concrete
 * pattern to match, not just abstract instructions.
 *
 * CONSISTENCY — why the bid ceiling drifted between identical runs:
 * two separate causes, both fixed as of this version. (1) server.js was
 * calling Gemini with no generationConfig at all, so it ran at the
 * model's default temperature (~1.0) — free-text numbers like a bid
 * ceiling will legitimately sample differently every time at that
 * temperature, even given the exact same input. Fixed there by pinning
 * a low temperature. (2) this prompt never gave the model a *formula*
 * for the bid ceiling, just "state one" — so even at a lower
 * temperature it was free to weigh things differently run to run. Step
 * 8 below now spells out the exact arithmetic, so the number is
 * reproducible from the same inputs rather than a fresh judgment call
 * each time.
 *
 * PAGE-SOURCED SEVERITY — the content script now reads each Condition
 * Report line's own color-coded severity marker directly off the page
 * (the same colored dot a human buyer sees) and appends it inline as
 * "[pageSeverity: minor|moderate|severe]". Step 5 tells the model to
 * copy that value verbatim into allConditionItems rather than judging
 * severity itself — another source of run-to-run drift removed, and it
 * makes the inventory's color-coding match what the page itself already
 * shows, not the model's own read of it.
 *
 * BENCHMARK-TILE CONFUSION — CONFIRMED LIVE 2026-09-15 on a real Hyundai
 * Ioniq listing: the Glance panel's raw text mixes two very different
 * kinds of numbers with nothing telling them apart — this specific
 * vehicle's own data (stated once, near the top, e.g. "123,073 mi") and
 * a grid of market-benchmark tiles ("rBook Avg Odometer," "MMR
 * Adjusted," "ProfitTime GPS Appraised Value," etc.) describing
 * COMPARABLE listings across the market, not this VIN. Without being
 * told the difference, the model treated the "rBook Avg Odometer" tile
 * (98,707 — a market average) as a second, competing claim about this
 * car's own mileage against the real 123,073 reading, and flagged a
 * "severe mileage discrepancy" that didn't exist — while the actual
 * CARFAX mileage for this VIN, sitting right there in the CARFAX panel
 * text, never even entered the comparison. Step 3 now spells out exactly
 * which lines are legitimate per-vehicle facts versus which are market
 * benchmarks, with this real example, so mileage (and any other fact)
 * reconciliation only ever compares real claims about this specific car.
 *
 * MARKET BENCHMARKS AS THEIR OWN OUTPUT, NOT JUST A DENYLIST — the fix
 * above stopped the model from misreading benchmark tiles as per-vehicle
 * facts, but the numbers themselves (MMR Adjusted, rBook, Ready Logistics
 * Transport Cost, etc.) were then just discarded — real market context a
 * buyer would want, sitting unused. content.js now extracts them
 * separately (extractMarketBenchmarks) and passes them in as
 * `marketBenchmarks`, tagged and kept structurally apart from
 * reconciliation so the original bug can't creep back in: they feed the
 * bid-ceiling transport-cost deduction (step 8) and a labeled
 * marketComparison output section, never the per-VIN fact-check in step 3.
 *
 * AUTOCHECK AS A FOURTH SOURCE — content.js now also extracts the
 * AutoCheck box (Score/Owners/Accidents/Titles-Probs/ODO), tagged
 * "[AutoCheck — separate report, not a Condition Report line]" inside the
 * Condition Report panel text (it's physically read from that same
 * document, the Manheim iframe, but is its own report, not a condition
 * item). Step 3 below folds it in as a fourth reconciliation source
 * alongside Condition Report, Glance, and CARFAX. Step 5 excludes it
 * (and the similarly-tagged "[Quick Check]" icon reads) from
 * allConditionItems for the same reason Glance/CARFAX facts already were.
 *
 * bidCeilingInputs — CONFIRMED LIVE 2026-09-16: a real verdict on a real
 * vehicle stated, in its own reasoning bullet, "Subtracted the midpoint
 * recon cost ($1,450), the exact transport cost ($1,040), and the
 * standard target margin ($850) from MMR Adjusted [$5,175]" — which is
 * $1,835 — but returned bidCeiling "$2,200". The model's free-text
 * reasoning and its final number silently disagreed by $365, with
 * nothing to catch it. Asking the model to "show its work" in prose
 * doesn't help — prose isn't checkable. So step 8 below now also asks
 * for the same four numbers as plain, parseable fields
 * (bidCeilingInputs), and server.js independently recomputes the
 * formula from them and overrides bidCeiling if it doesn't reconcile,
 * rather than trusting the model's self-reported final figure.
 *
 * transportCost / marketComparison population gap — CONFIRMED LIVE
 * 2026-09-16 on the same vehicle: DOM inspection of the actual rendered
 * card showed the dedicated transportCost field and the entire
 * marketComparison array came back empty, even though the model clearly
 * used the $1,040 transport figure in its headline, a keyFinding, and
 * its reasoning bullets. The model reliably USES this data; it doesn't
 * reliably ECHO it into these specific structured fields. Rather than
 * trying to word the instruction more forcefully, server.js now fills
 * both fields itself from the same marketBenchmarks data already sent
 * to Gemini in this same request, whenever the model's own response
 * left them empty.
 */
function buildPrompt({ vin, panels, marketBenchmarks }) {
  const benchmarks = loadBenchmarksSummary();

  const panelBlock = Object.entries(panels || {})
    .map(([title, text]) => `--- ${title} panel ---\n${text ? text : "(not found on page — this panel may not have been open, or the selector needs adjusting)"}`)
    .join("\n\n");

  const benchmarkEntries = Object.entries(marketBenchmarks || {}).filter(([, v]) => v);
  const marketBenchmarkBlock = benchmarkEntries.length
    ? benchmarkEntries.map(([label, value]) => `- ${label}: ${value}`).join("\n")
    : "(none extracted from the Glance panel text)";

  return `You are a senior wholesale auction buyer at a car dealership, the person other buyers on the team come to for a second opinion before committing real money at auction. You are hands-on and meticulous — you read the actual Condition Report yourself, line by line, before you look at anything else. Be decisive and professional. Never hedge without a stated reason.

You are given the full text of three panels open in vAuto (Condition Report, Glance, CARFAX) for one vehicle, an overview screenshot of the buyer's current view, and — for zero or more specific condition-report items that looked worth a closer look — a labeled close-up photo of exactly that item. Each labeled photo's caption tells you which condition-report line it's evidence for; use it to check that specific line, not as a generic impression of the car.

Do the following, in order:

1. READ THE CONDITION REPORT YOURSELF, FIRST. Before consulting CARFAX at all, extract VIN, mileage, title status, and every listed announcement, repair record, or condition item directly from the Condition Report panel — including sections that report no issues (e.g. "Structure: None reported"), which are real positive signal, not empty space to skip. Note the CR/condition grade and its scale. Form your own initial read of how serious this vehicle's condition is, based on this alone.

2. THEN BRING IN CARFAX AS A SECOND OPINION, NOT THE PRIMARY SOURCE. CARFAX panels often show their own computed signals — a damage-severity badge (e.g. "Very Minor / Moderate / Severe"), an AutoCheck score, owner count, accident count, title/problem checks, and an odometer check. Read these explicitly. Then compare: does CARFAX's own severity assessment agree with what you found reading the Condition Report yourself? Say so directly, by name — e.g. "CARFAX rates this 'Very Minor,' which is consistent with the Condition Report's own listed items" or "CARFAX's 'Very Minor' badge undersells what the Condition Report itself describes — treat the Condition Report as the more complete source here." Never just repeat CARFAX's conclusion as your own without having done your own read first.

3. RECONCILE ACROSS ALL SOURCES for the same underlying fact (mileage, accident/damage severity, title status, owner count) — Condition Report, Glance, CARFAX, AutoCheck, and photos together. Flag any real disagreement as high priority. A real example: one vehicle's Condition Report listed 129,725 miles while its CARFAX panel, on the same screen, listed 105,445 miles for the same VIN — and the Condition Report's "Structural Damage" announcement contradicted CARFAX's own "Minor Damage" accident badge. Look for exactly this pattern. A few miles of variance (under ~50) between rounded displays is normal noise, not a real mismatch.
   THE GLANCE PANEL MIXES TWO DIFFERENT KINDS OF NUMBERS — DO NOT CONFUSE THEM. Only one part of the Glance panel is actually about this specific vehicle: its own line near the top, next to the vehicle's name (e.g. "2017 HYUNDAI IONIQ LTD HY LIMITED | 123,073 mi"). Everything else in that panel is a grid of MARKET-BENCHMARK TILES — labels like "rBook Avg Odometer," "rBook Avg List Price," "MMR Adjusted," "ProfitTime GPS Appraised Value," "ProfitTime GPS Max Bid," "ProfitTime GPS Source Estimate," "J.D. POWER Clean Trade-In," and "Ready Logistics Transport Cost." These describe AVERAGES OR ESTIMATES ACROSS OTHER, COMPARABLE LISTINGS in the market — they are not facts about this VIN and must never be used as a competing data point when reconciling this vehicle's own mileage, price, or condition. A real example of getting this wrong: one vehicle's Glance panel showed its own mileage as 123,073 at the top, and separately had an "rBook Avg Odometer" tile reading 98,707 — that 98,707 is the market's average odometer across comparable listings, not a second reading of this car's own odometer, and treating it as one produced a false "severe mileage discrepancy" finding on a car that didn't actually have one, while the real CARFAX mileage for that VIN never even entered the comparison. When reconciling mileage specifically, compare only: the Condition Report's own mileage, the Glance panel's own vehicle-name line, and CARFAX's stated mileage for this VIN — never a benchmark tile. The extracted MARKET BENCHMARKS block further below (labeled separately from the panels) is the same category of data — market context, never a per-vehicle fact — and belongs only in step 8's transport-cost deduction and the marketComparison output, never in reconciliation.
   AUTOCHECK IS A FOURTH SOURCE, NOT PART OF CARFAX. A line or block tagged "[AutoCheck — separate report, not a Condition Report line]" may appear inside the Condition Report panel text — that tag means exactly what it says: it's AutoCheck's own Score/Owners/Accidents/Titles-Probs/ODO summary, physically read from the same page area as the Condition Details table but a distinct report from both the Condition Report and CARFAX. Reconcile its owner count, accident count, title/problem flags, and odometer-check result against CARFAX's and the Condition Report's versions of the same facts, the same way you would any other source — a real disagreement here (e.g. AutoCheck shows 3 owners, CARFAX shows 1) is exactly the kind of thing step 3 exists to catch. Never fold an AutoCheck-tagged line into allConditionItems (see step 5).
   A line tagged "[Quick Check]" (e.g. "[Quick Check] Start: OK", "[Quick Check] Structural Issue: flagged / needs attention") is a pass/fail read of the page's own quick-check icons (Start, Interior Odor, Key/Fob, Tires, Prior Paint, Drivable, Structural Issue) — treat "flagged / needs attention" as a real, page-sourced signal worth a keyFinding (category Mechanical for Start/Interior Odor, Structural/Frame for a flagged Structural Issue), and "OK / no issue indicated" as real positive signal, the same way an empty "Structure: None reported" section is in step 1. Like AutoCheck, these never belong in allConditionItems (see step 5) — they aren't Condition Report line items.

4. CLASSIFY BY COST IMPACT: sort every real issue into Cosmetic, Mechanical, Safety-System/ADAS, Structural/Frame, or Title-Brand. A single structural/frame or safety-system item outweighs many cosmetic ones, even if it's one line among twenty.

5. ACCOUNT FOR EVERY SINGLE ITEM — NOTHING GETS SILENTLY DROPPED, AND NOTHING GETS ADDED THAT WASN'T THERE. List every individual item or line you found in the Condition Report panel specifically, however minor (a scuff, a scratch, a mismatched tire), in allConditionItems below — not just the handful material enough for keyFindings. This is a safety net: a line like "Audio/Visual System — Broken" is easy to lose in a list of twenty-plus items, but a buyer relying on this tool needs to see it existed even if it didn't move your bid or your headline.
   allConditionItems is SOURCED FROM THE "--- Condition Report panel ---" TEXT BLOCK ONLY, AND EVEN THERE ONLY FROM ACTUAL CONDITION-REPORT LINES — not from any line tagged "[AutoCheck — separate report, not a Condition Report line]" or "[Quick Check]", which physically live inside that same text block but are distinct reports (see step 3). A vehicle can legitimately have very few real condition items (even just one, or zero in a clean section) — a short allConditionItems list is the correct, honest output for a clean car, not a sign you should look further. Do NOT pull items from the Glance or CARFAX panel blocks into allConditionItems, even when they describe a related fact in different words (e.g. the Glance panel's own "Announcements" — an open recall, a wrap, a previous-Canadian note — are listing/history flags, not physical condition-report line items, even if the Condition Report separately happens to mention a related detail like "Further Disclosures: Wrap"). If something from Glance, CARFAX, AutoCheck, or a Quick Check tag seems worth the buyer's attention, it belongs in keyFindings (with the source named explicitly in "detail") or in reconciliation — never silently merged into allConditionItems as if it were a Condition Report line. If the page shows its own item count (e.g. a red damage-count badge near the condition grade), set itemsReviewedCount to match it, and if your own count comes out different, say so plainly in dataCaveat rather than silently picking one number.
   SEVERITY FOR EACH ITEM: some Condition Report lines end with a bracketed tag like "[pageSeverity: minor]", "[pageSeverity: moderate]", or "[pageSeverity: severe]" — this was read directly off that line's own color-coded marker on the page itself, not judged by you. When a line carries this tag, copy it VERBATIM into that item's "severity" field in allConditionItems (using exactly "minor", "moderate", or "severe"). Only fall back to judging severity yourself — choosing "minor", "moderate", or "severe" — for a line that has no tag at all. Use "none" only for a genuinely clean sub-section (e.g. "Structure: None reported"), never for a real listed defect.

6. PRICE IT: estimate a recon cost range for the issues that actually matter to the decision, using this dealership's own real cost history first:
${benchmarks}
If a category has no real data, say so and mark that estimate illustrative, not computed. Never present an unbacked number as confident.

7. USE EVERY PHOTO YOU WERE GIVEN, INDIVIDUALLY. For the overview screenshot, note anything visible that adds to or contradicts the text. For each labeled close-up photo, explicitly state whether it confirms, contradicts, or adds nuance to the specific condition-report line it's captioned for — treat each one as a separate piece of evidence, not one blended impression. If a labeled photo doesn't clearly show what its caption claims, say that too.

8. REASON & RECOMMEND, AS THE SENIOR BUYER: weigh total estimated cost against the Glance panel's pricing benchmarks (MMR Adjusted, rBook, J.D. Power Clean Trade-In, Source Estimate). Reach ONE decisive call — BUY, PASS, or BID CEILING — the way you'd tell a buyer on your team what to actually do, not a hedge. This decision and its headline are the most important thing you produce — lead with them. Name only the specific findings that actually drove the call in keyFindings; the exhaustive list belongs in allConditionItems, not here.
   HEADLINE MUST NOT STATE A DOLLAR BID-CEILING FIGURE — CONFIRMED LIVE 2026-09-16: on a real vehicle, the headline stated "$3,235" and "$2,200" in two separate runs while the bidCeiling field and decision badge (the actual, formula-computed number from the steps below) said something else each time — the buyer saw two different dollar figures on the same card with no way to know which was real. The badge above the headline already shows the authoritative bidCeiling — your headline's job is to say WHY, in plain language (e.g., "extensive cosmetic recon and a heavy transport cost leave only a thin margin"), never to restate or imply a specific dollar ceiling of its own. Other dollar figures (a specific defect's recon cost, the transport cost itself) are fine to mention if directly relevant — the one number headline must never independently state is the bid ceiling.
   BID CEILING — COMPUTE IT WITH THIS EXACT FORMULA, so the same inputs always produce the same number:
     a. Pick the single benchmark you trust most from the Glance panel (prefer MMR Adjusted; fall back to rBook Adjusted List Price, then J.D. Power Clean Trade-In, in that order, and say which one you used and why in a reasoning bullet). Record its label in bidCeilingInputs.benchmarkLabel and its dollar value as a plain number (no $, no commas) in bidCeilingInputs.benchmarkValue.
     b. Subtract your total estimated recon cost from step 6 (use the midpoint of your range). Record that midpoint as a plain number in bidCeilingInputs.reconCostMidpoint.
     b2. Subtract the transport cost: if "Ready Logistics Transport Cost" appears in the MARKET BENCHMARKS block below, subtract that exact figure — it's real, unavoidable landed cost to get the vehicle to the lot, not optional padding like the margin in the next step. Set transportCost in the output to the figure you used, or null if none was extracted (do not invent one). Record the same figure as a plain number in bidCeilingInputs.transportCost (use 0 there, not null, when none was extracted — bidCeilingInputs.transportCost is an arithmetic input and null would break the subtraction). Say which you did in a reasoning bullet.
     c. Subtract a minimum target margin of $700–$1,000 (use $850 unless the dealership's own cost history in step 6 implies a different standard) — this is the dealer's minimum acceptable margin on a wholesale buy, not optional padding. Record it as a plain number in bidCeilingInputs.targetMargin.
     d. Round to the nearest $100. That is your bidCeiling. Do not adjust it further by gut feel — if the math and your recommendation seem to disagree, that's a sign to revisit step 6's cost estimate, not to hand-adjust the final number.
     bidCeilingInputs exists so the server can independently check this arithmetic — report the SAME numbers you actually used to reach bidCeiling, not numbers picked afterward to make it match. If you did not compute a bidCeiling at all (decision is BUY or PASS with no ceiling), set every field in bidCeilingInputs to null.
   MARKET COMPARISON — SEPARATE FROM RECONCILIATION, SEPARATE FROM THE FORMULA ABOVE. For each entry actually present in the MARKET BENCHMARKS block below, add one entry to marketComparison: the label, the value as extracted, and one short sentence relating it to your bidCeiling (e.g., "your bid ceiling is 14% below MMR Adjusted"). This is supplementary market context for the buyer's confidence — it does not feed back into reconciliation (step 3) or change your per-vehicle fact-check in any way; it only ever compares your OWN bidCeiling number against the market, never this VIN's own mileage/price/condition against a benchmark tile. If the MARKET BENCHMARKS block says none were extracted, return an empty marketComparison array — do not fabricate benchmark figures that weren't actually provided.
   BUY RATING — in addition to decision, classify the deal into exactly one of these five tiers, consistent with your decision (a PASS should almost always land on FLAG_BUY or BAD_BUY; a BUY should land on GOOD_BUY or PROFITABLE_BUY; a BID CEILING call usually lands on PROFITABLE_BUY or NEEDS_WORK_BUY depending on how thin the margin is after your formula above):
     - GOOD_BUY: minimal recon needed, wide margin at the benchmark price, high confidence in the data.
     - PROFITABLE_BUY: real recon required, but margin still clears the target comfortably after that cost.
     - NEEDS_WORK_BUY: meaningful recon required and the margin is thin — only worth it if recon is done efficiently and cheaply.
     - FLAG_BUY: the numbers don't work for a straight resale buyer at this price, but a buyer with their own in-house recon capability, who can absorb the work internally rather than paying market rate for it, could still make it pencil out. Flag this, don't recommend it outright.
     - BAD_BUY: pass outright — uneconomical or too risky regardless of recon capability (e.g. a structural/frame or title-brand problem, or the math doesn't work under any reasonable recon assumption).

9. BE HONEST ABOUT GAPS. If any panel's text looks cut short, contradictory in a way you can't resolve, or missing, say so plainly rather than guessing — this matters more than sounding complete. If no close-up photos were provided at all, note that your read is text-and-overview-screenshot only. If the Condition Report panel text contains no actual condition-report line items and no "[pageSeverity: ...]"-style rows at all — only an "[AutoCheck ...]" tag, "[Quick Check]" tags, and/or the VIN/odometer header line — say so explicitly: set dataConfidence to "partial" and dataCaveat to something like "No itemized Condition Details table was available for this vehicle — this read relies on AutoCheck/Glance/CARFAX summary data only, not a line-by-line inspection." Your headline should plainly reflect that this is a lighter-weight read, not a full inspection-based one, in that case.

VIN (if detected from the page): ${vin || "not detected — extract it yourself from the panel text if visible"}

MARKET BENCHMARKS extracted from the Glance panel (market context only — see step 3 and step 8; never a fact about this VIN):
${marketBenchmarkBlock}

${panelBlock}

Respond with ONLY a JSON object, no markdown fences, matching exactly this shape:
{
  "vehicle": "year make model, e.g. 2018 Chevrolet Trax LT",
  "grade": "the condition grade shown, if any",
  "decision": "BUY | PASS | BID CEILING",
  "bidCeiling": "a dollar figure as a string if you gave one, computed with the exact formula in step 8, e.g. \\"$15,000\\", else null",
  "bidCeilingInputs": {
    "benchmarkLabel": "the Glance benchmark used in step 8a (e.g. \\"MMR Adjusted\\"), or null if no bidCeiling was computed",
    "benchmarkValue": "that benchmark's dollar value as a plain number, no $ or commas (e.g. 5175), or null",
    "reconCostMidpoint": "the midpoint of the step 6 recon range as a plain number (e.g. 1450), or null",
    "transportCost": "the number actually subtracted in step 8b2, as a plain number \\u2014 0 if none was extracted/used, or null only if no bidCeiling was computed at all",
    "targetMargin": "the target margin from step 8c as a plain number (e.g. 850), or null"
  },
  "buyRating": "GOOD_BUY | PROFITABLE_BUY | NEEDS_WORK_BUY | FLAG_BUY | BAD_BUY — see the definitions in step 8, and keep it consistent with decision",
  "buyRatingReason": "one sentence stating why this tier, referencing the margin math from step 8",
  "headline": "1-2 sentences, in your own voice as the senior buyer, stating the call and the single biggest reason for it — this and decision/bidCeiling are what the buyer sees first, so make them stand on their own. Do NOT state a dollar bid-ceiling figure here (see step 8) — the decision badge already shows it; other dollar figures (a specific recon or transport cost) are fine if directly relevant",
  "itemsReviewedCount": "the total number of individual condition-report items/lines you found and accounted for, as a number",
  "keyFindings": [
    { "title": "short finding name", "detail": "specific evidence — a value comparison, a condition-report line, or what a labeled photo showed", "severity": "danger|warn|good", "category": "Cosmetic|Mechanical|Safety-System/ADAS|Structural/Frame|Title-Brand" }
  ],
  "allConditionItems": [
    { "item": "the item/line AS WRITTEN IN THE CONDITION REPORT PANEL ONLY — never from Glance or CARFAX, e.g. \\"Audio/Visual System — Broken\\"", "category": "Cosmetic|Mechanical|Safety-System/ADAS|Structural/Frame|Title-Brand", "severity": "none|minor|moderate|severe — copy from that line's [pageSeverity: ...] tag verbatim when present, per step 5" }
  ],
  "reconciliation": [
    { "field": "e.g. Mileage, or Damage Severity (Condition Report vs CARFAX)", "note": "what each source said and whether they agree or conflict — compare only real per-vehicle facts (Condition Report, Glance's own vehicle-name line, CARFAX); per step 3, a Glance market-benchmark tile like \\"rBook Avg Odometer\\" is never a competing claim about this VIN's own mileage or price" }
  ],
  "reconEstimate": "a dollar range as a string, e.g. \\"$2,200\\u2013$3,400 (illustrative)\\"",
  "transportCost": "the Ready Logistics Transport Cost figure used in the bid ceiling calc (step 8b2), as a string, or null if none was extracted",
  "marketComparison": [
    { "label": "e.g. MMR Adjusted", "value": "e.g. $8,525", "note": "one short sentence relating this bid ceiling to this benchmark \\u2014 never a claim about this VIN's own mileage/price/condition" }
  ],
  "reasoning": [
    "3-7 short bullet points, each one self-contained sentence — no bullet symbols, the front end adds those — spelling out the full chain of reasoning: your own Condition-Report-first read, the CARFAX comparison from step 2, any reconciliation flags, what each photo added or failed to confirm, and the bid-ceiling arithmetic from step 8"
  ],
  "dataConfidence": "full | partial",
  "dataCaveat": "if dataConfidence is partial, a one-sentence explanation of what looked incomplete, cut off, or unphotographed, or of any mismatch between itemsReviewedCount and a count shown on the page; otherwise empty string"
}

keyFindings and allConditionItems serve different jobs — do not merge them or skip either. keyFindings is the short highlight reel (a handful of the items that actually drove the decision) that appears right under the headline. allConditionItems is the complete, unfiltered inventory — one entry per item you found in the Condition Report, including every item already summarized in keyFindings plus every minor one that wasn't. Never omit an item from allConditionItems just because it seemed too small to matter to the decision; itemsReviewedCount should equal its length.`;
}

module.exports = { buildPrompt };