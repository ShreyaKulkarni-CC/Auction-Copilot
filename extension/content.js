/**
 * Auction Copilot — content script
 *
 * Runs on vAuto pages AND, separately, inside the Manheim panel that vAuto
 * embeds — see "THE REAL BUG" below, this second injection is the whole
 * reason this file is structured the way it is.
 *
 * Its jobs, in the TOP FRAME (the vAuto/Stockwave page itself):
 *   1. Notice when a vehicle detail view (Condition Report / Glance / CARFAX
 *      panels) is open, and show a small "Analyze this car" button.
 *   2. On click, pull the FULL text out of the Glance/CARFAX panels, ask the
 *      Manheim iframe (via the background script) for the Condition Report
 *      data it has already extracted, find any photos tied to a flagged
 *      line, and ask the background script to resolve everything into a
 *      request to the local backend.
 *   3. Render the verdict as an overlay card.
 *
 * Its job in the MANHEIM IFRAME (see below) is much smaller: watch its own
 * page for the Condition Details table, extract it the moment it's on
 * screen, and relay it to the background script so the top frame can pick
 * it up on click. It never shows a button or an overlay of its own.
 *
 * IMPORTANT — why photo fetching happens in background.js, not here:
 * a content script's network requests are subject to the same CORS rules
 * as the page itself, so fetching an auction photo hosted on a different
 * domain (an image CDN, say) would likely be blocked right here. The
 * extension's background service worker, with host_permissions for
 * <all_urls>, doesn't have that restriction — so this file only *finds*
 * candidate photo URLs, and background.js does the actual fetching.
 *
 * CONDITION REPORT EXTRACTION — the full history, because every step of
 * this mattered:
 *   1-3. Three early attempts tried to find the Condition Report "panel"
 *      by matching its heading text on the vAuto page, and each failed for
 *      a different, confirmed reason — a small dashboard tile sharing the
 *      same heading text, a heading actually spelled "Condition Details"
 *      instead, and finally, confirmed via a live console diagnostic, no
 *      exact text-node match at all.
 *   4. Anchoring on the row markup directly (`[class*="damage-row-item"]`)
 *      instead of a heading fixed the matching problem, but rows still
 *      came back with generic, placeholder-looking text at click time.
 *   5. THE REAL BUG, confirmed by directly opening the live page in a
 *      browser and inspecting it: the "Manheim Browser" panel vAuto embeds
 *      is a cross-origin <iframe> (router.manheim.com, inside a page on
 *      vauto.app.coxautoinc.com). The Condition Report summary tile lives
 *      on the vAuto page itself — that's the thing three heading-matching
 *      attempts kept finding — but the actual itemized Condition Details
 *      table, the one with real per-item text and photos, renders entirely
 *      inside that iframe's own document. document.querySelectorAll from
 *      the top-frame content script can NEVER see into it — browsers
 *      block that outright for cross-origin frames, the same way this
 *      script itself couldn't reach it either. That's also why the table
 *      only had 23 correctly-COUNTED-but-content-free rows: some other
 *      part of the page (the summary tile) mentioned the count "23," and
 *      the model was left to invent 23 generic placeholder lines to
 *      satisfy the "account for every item" instruction, because it was
 *      never actually given the real per-item text.
 *
 *      Fix: the extension's manifest now also injects this exact file
 *      into *.manheim.com frames, with "all_frames": true, so a second,
 *      independent copy of this script runs directly inside the iframe —
 *      same-document access there is completely normal, it's only
 *      cross-frame JS access from a DIFFERENT document that's blocked.
 *      That copy extracts the Condition Details table the moment it's
 *      open on screen and relays it to background.js, which caches it per
 *      tab; the top-frame copy asks background.js for that cached data
 *      instead of ever trying to read it from its own document again.
 */

// Where analysis requests actually go is decided in background.js, not
// here — see BACKEND_URL there. Keeping that single source of truth out
// of this file means a request to redirect analysis to a different
// backend can't just be satisfied by editing content.js.
const PANEL_TITLES = ["Condition Report", "Glance", "CARFAX"];

// Words that mark a condition-report line as worth a close-up photo,
// rather than sending every one of a listing's photos.
const PHOTO_KEYWORDS = [
  "dent", "damage", "repair", "chip", "scuff", "crack", "scratch",
  "tear", "stain", "broken", "bent", "rust", "structural", "hail",
  "collision", "replace", "mismatch", "worn",
];
const MAX_PHOTOS = 5;

// This same file is injected into two different kinds of frame (see the
// top-of-file note) — everything below branches on which one this
// particular instance is running in.
const IS_TOP_FRAME = window.top === window;

let buttonInjected = false;
let overlayEl = null;

// The VIN/vehicle/decision/bidCeiling/buyRating for whatever verdict is
// currently on screen — set each time showVerdict() renders, read only
// when the buyer actually submits a correction. This is what lets
// "Suggest a correction" auto-attach the right context instead of making
// the buyer retype what car or what number they're talking about.
let currentFeedbackContext = null;

// ---------- Detection (top frame only) ----------

function pageLooksLikeVehicleView() {
  const text = document.body ? document.body.innerText : "";
  return text.includes("Condition Report") && text.includes("Glance");
}

function ensureButton() {
  if (!pageLooksLikeVehicleView()) {
    removeButton();
    return;
  }
  removeScopeHint(); // the real thing is here — don't also show the out-of-scope nudge
  if (buttonInjected) return;
  const btn = document.createElement("button");
  btn.id = "ac-trigger-btn";
  btn.textContent = "🔦 Analyze this car";
  btn.addEventListener("click", onAnalyzeClick);
  document.body.appendChild(btn);
  buttonInjected = true;
}

function removeButton() {
  const btn = document.getElementById("ac-trigger-btn");
  if (btn) btn.remove();
  buttonInjected = false;
}

// ---------- Out-of-scope hint (top frame only) ----------
// The extension only injects on *.vauto.com / *.vauto.app.coxautoinc.com
// (see manifest.json) — so every page it can possibly run on is already
// some Cox Automotive/vAuto tool, never an unrelated site. Confirmed live
// this session: that family of hosts includes pages that are genuinely
// out of scope for this tool — an owned-inventory pricing/appraisal view
// (profittime.vauto.app.coxautoinc.com) and search/list pages — and today
// those just silently show no button, which reads as "broken" rather than
// "not applicable here." This shows a small, dismissible, one-time-per-page
// nudge instead, but only when the page looks like a SINGLE vehicle's
// detail view (one VIN-shaped token, some pricing/appraisal/inventory
// context) rather than a list — a search-results page has many VINs
// scattered across rows, and guessing at "why" this particular page has
// no auction panels would be exactly the kind of wrong guess this
// codebase has repeatedly had to walk back. Stays quiet (returns without
// showing anything) for anything it can't confidently characterize.
let scopeHintInjected = false;
let scopeHintDismissed = false;

function pageLooksLikeSingleVehicleButOutOfScope() {
  if (pageLooksLikeVehicleView()) return false;
  const text = document.body ? document.body.innerText : "";
  if (!text) return false;
  const vinMatches = text.match(new RegExp(VIN_PATTERN.source, "g")) || [];
  if (vinMatches.length !== 1) return false; // 0 = no vehicle here; 2+ = probably a list
  return /pricing|appraisal|book values|vehicle info|owned inventory/i.test(text);
}

function ensureScopeHint() {
  if (!pageLooksLikeSingleVehicleButOutOfScope()) {
    removeScopeHint();
    return;
  }
  if (scopeHintDismissed || scopeHintInjected) return;
  const el = document.createElement("div");
  el.id = "ac-scope-hint";
  el.innerHTML = `
    <span>🔦 Auction Copilot: this looks like owned-inventory pricing, not an active auction listing — nothing to analyze here.</span>
    <button id="ac-scope-hint-dismiss" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(el);
  scopeHintInjected = true;
  const dismissBtn = document.getElementById("ac-scope-hint-dismiss");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      scopeHintDismissed = true;
      removeScopeHint();
    });
  }
}

function removeScopeHint() {
  const el = document.getElementById("ac-scope-hint");
  if (el) el.remove();
  scopeHintInjected = false;
}

// ---------- Panel text extraction — heading-based (top frame only) ----------
// Still used for Glance and CARFAX, which really do live in the top
// frame's own document, and as a last-resort fallback for Condition
// Report on a page layout that doesn't match the iframe structure above.

// Confirmed live on a real Manheim page: the vAuto page itself has a small
// dashboard tile that literally says "Condition Report" (a few words —
// heading + grade, nothing else), while the real expandable table lives
// inside the Manheim iframe and is titled "CONDITION DETAILS" — a
// different string, in a different document entirely. Try every known
// spelling per panel regardless.
const PANEL_ALIASES = {
  "Condition Report": ["condition report", "condition details"],
  "Glance": ["glance"],
  "CARFAX": ["carfax"],
};

function findPanelElement(titleText, allTitles) {
  const aliases = PANEL_ALIASES[titleText] || [titleText.toLowerCase()];
  const otherAliases = allTitles
    .filter((t) => t !== titleText)
    .flatMap((t) => PANEL_ALIASES[t] || [t.toLowerCase()]);

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  let best = null;
  let bestLength = 0;

  while ((node = walker.nextNode())) {
    const nodeText = node.textContent.trim().toLowerCase();
    if (!aliases.includes(nodeText)) continue;

    let el = node.parentElement;
    let candidate = el;
    // Climb as long as we keep picking up more content, but stop the
    // moment the ancestor's text starts including another panel's own
    // heading — that's the sign we've climbed past this panel's
    // boundary into a container it shares with its siblings.
    for (let i = 0; i < 16 && el && el.parentElement; i++) {
      const parent = el.parentElement;
      const parentText = (parent.innerText || "").toLowerCase();
      const ownText = (el.innerText || "").toLowerCase();
      const crossedIntoSibling = otherAliases.some(
        (t) => parentText.includes(t) && !ownText.includes(t)
      );
      if (crossedIntoSibling) break;
      el = parent;
      candidate = el;
      if ((el.innerText || "").length > 20000) break; // hard cap either way
    }

    // There can be more than one match for the same heading text on a
    // page (a summary tile plus the real panel) — a small tile will
    // always have far less text than the real content-bearing panel, so
    // keep whichever candidate actually has the most text rather than
    // just the first one encountered in document order.
    const candidateLength = candidate ? (candidate.innerText || "").length : 0;
    if (candidateLength > bestLength) {
      best = candidate;
      bestLength = candidateLength;
    }
  }

  return best;
}

function findPanelText(titleText, allTitles) {
  const el = findPanelElement(titleText, allTitles);
  return el ? el.innerText.slice(0, 20000) : null;
}

// Shared by guessVin() below and extractVehicleHeaderLine() further down —
// one definition so both always agree on what counts as a VIN-shaped token
// (17 chars, excluding I/O/Q per the VIN spec, which is why this isn't
// just \w{17}).
const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/;

function guessVin() {
  const match = document.body.innerText.match(VIN_PATTERN);
  return match ? match[0] : null;
}

// ---------- Condition Report extraction via row anchor ----------
// Runs in WHICHEVER document actually has the table — the Manheim iframe
// on the sites we've confirmed, but written generically so it also works
// if a future layout renders this table directly in the top frame.

// Confirmed live via DevTools against a real Manheim Condition Details
// table: every individual defect row carries this class fragment,
// regardless of what heading (if any) sits above the table or how that
// heading is spelled or punctuated.
const ROW_SELECTOR = '[class*="damage-row-item"]';

// PAGE-SOURCED SEVERITY — the page already color-codes each condition
// line's own severity with a small marker (confirmed visually: a
// yellow/orange/red dot per row, matching the None→Severe legend on the
// Condition Details diagram at the top of the panel). Reusing that is far
// more consistent than asking the model to judge severity itself, which
// is exactly the kind of free judgment call that drifted between
// identical runs. Rather than hunting for that marker's exact class name
// (unconfirmed, and this codebase has been burned twice already by
// guessing at exact selectors instead of verifying them), this reads it
// structurally: the first small, meaningfully-saturated colored element
// inside the row, bucketed by hue into the same scale the page's own
// legend uses. It degrades to null (no tag added, model judges as
// before) rather than guessing wrong, so a markup change can't make this
// silently misleading — worth reconfirming against DevTools on a live
// row if the resulting tags ever look off.
function bucketSeverityColor(cssColor) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(cssColor || "");
  if (!m) return null;
  const r = +m[1], g = +m[2], b = +m[3];
  const a = m[4] === undefined ? 1 : +m[4];
  if (a < 0.3) return null; // effectively invisible — not a real marker
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0) return null;
  const sat = (max - min) / max;
  if (sat < 0.25) return null; // grayscale — text/icon, not a colored severity marker
  let hue;
  if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 20) return "severe"; // red
  if (hue < 45) return "moderate"; // orange
  if (hue < 70) return "minor"; // yellow
  return null; // some other hue — not part of this severity scale
}

function pageSeverityForRow(row) {
  const children = row.querySelectorAll("*");
  for (const el of children) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.width > 16 || rect.height > 16) continue; // looking for a small dot/marker only
    const style = getComputedStyle(el);
    const bucket = bucketSeverityColor(style.backgroundColor) || bucketSeverityColor(style.color);
    if (bucket) return bucket;
  }
  return null;
}

function collectConditionReportRows() {
  return Array.from(document.querySelectorAll(ROW_SELECTOR))
    .map((row) => ({
      text: (row.innerText || "").trim().replace(/\s+/g, " "),
      img: row.querySelector("img"),
      pageSeverity: pageSeverityForRow(row),
    }))
    .filter((r) => r.text);
}

// CONFIRMED LIVE 2026-09-15, via a live re-test on the Ram TRX right after
// the allConditionItems scope-creep fix: with that fix working correctly
// (exactly one real item), the model then flagged a "severe mileage
// discrepancy" that doesn't actually exist — the page's own Condition
// Report clearly shows "Odo 81,732" right next to the VIN, one mile off
// CARFAX's 81,733, well inside the prompt's own documented ~50-mile noise
// allowance. The text sent to the model never included that line at all.
// Root cause: collectConditionReportText() below only ever read the
// per-item damage rows (ROW_SELECTOR) — real, but narrow, since a row is
// only rendered for an actual reported issue. The VIN/odometer/vehicle
// line that sits above those rows was never part of "the row anchor," so
// it silently never made it into the text sent to the backend, and with
// nothing to go on the model had to guess at mileage from CARFAX alone —
// producing a hedge that reads like a real discrepancy when there isn't
// one, on a car that would otherwise have gotten a clean PASS-to-BUY read.
//
// Deliberately not tied to a CSS class or specific page layout (this
// codebase has been burned twice already by guessing at exact selectors)
// — instead scans the document's own visible text for a line carrying
// BOTH a VIN-shaped token and the word "Odo", which is specific enough
// that it doesn't accidentally match unrelated odometer mentions
// elsewhere on the page (e.g. the Glance panel's own "rBook Avg
// Odometer" tile label, which never has a VIN sitting next to it). If no
// such line exists in this document, this returns null and nothing about
// the rest of the pipeline changes — same "degrade to null rather than
// guess wrong" pattern used by pageSeverityForRow above.
function extractVehicleHeaderLine() {
  const text = document.body ? document.body.innerText : "";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const headerLine = lines.find((l) => l.length < 200 && VIN_PATTERN.test(l) && /odo/i.test(l));
  return headerLine || null;
}

// QUICK-CHECK ICONS — a row of pass/fail icons (Start, Int Odor, Drivable,
// No Structural Damage) sits right next to the Condition Details table, in
// the same Manheim iframe document, and today NOTHING reads them — they
// were never part of ROW_SELECTOR (they're not defect rows) or the VIN/Odo
// header line above (they're a different line).
//
// CONFIRMED LIVE 2026-09-16 via DevTools on a real listing (Hyundai Ioniq,
// KMHC85LC3HU030909, Manheim Charlotte) — a first pass of this (before
// this confirmation) guessed wrong in three ways, all fixed below:
//   1. Label text was wrong for some items — the real text is "No
//      Structural Damage" (one text node, not split), not "Structural
//      Issue" or "No Structural" (those don't exist as exact matches on
//      the page; "Structural Issue" is a separate diagram-legend caption
//      with no marker near it — checked and excluded).
//   2. Key/Fob aren't pass/fail icons at all — they're numeric counts
//      ("Key 2", "Fob 0"). Searching near them for a small colored marker
//      DOES find something, but only 5-6 DOM levels up — far enough that
//      it's an unrelated element elsewhere on the page, not a real
//      Key/Fob status color. Dropped from this vocabulary entirely rather
//      than risk a false, misattributed "flagged" tag.
//   3. Tires shows graduated tread-depth readings per corner (a "6 6" /
//      "5 5" style pair), not one pass/fail state — a single color read
//      here would misrepresent a multi-value reading as one verdict.
//      Dropped for the same reason.
//   Confirmed instead: Start, Int Odor, Drivable, and No Structural
//   Damage each render as a small (≤20px) colored SVG path/rect/ellipse
//   inside the icon's own container, genuinely close to the label (1-2
//   DOM levels up — findSmallColoredMarkerNear climbs incrementally and
//   stops at the first level that finds something, so it can't
//   accidentally reach past the icon's own container into a neighbor's).
//   A decorative navy (~#1E3866) fill used throughout these icons'
//   illustration lines was confirmed NOT to fall in bucketPassFailColor's
//   green/red hue windows, so it's already excluded without extra logic.
// "Prior Paint" was seen in an earlier screenshot of a different vehicle
// but its exact text wasn't confirmed on this one (not present, or split
// across lines the same way "Int Odor"/"OK" are two lines) — left out
// rather than guessed; worth adding once its real text is confirmed live.
const QUICK_CHECK_LABELS = ["Start", "Int Odor", "Drivable", "No Structural Damage"];

function bucketPassFailColor(cssColor) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(cssColor || "");
  if (!m) return null;
  const r = +m[1], g = +m[2], b = +m[3];
  const a = m[4] === undefined ? 1 : +m[4];
  if (a < 0.3) return null;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0) return null;
  const sat = (max - min) / max;
  if (sat < 0.25) return null; // grayscale — not a real state marker
  let hue;
  if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue >= 90 && hue <= 160) return "pass"; // green
  if (hue < 20 || hue > 340) return "fail"; // red
  return null; // amber or another hue — ambiguous, don't guess
}

// Climbs incrementally (1 level, then 2, then 3) and stops at the FIRST
// level that finds a colored marker — confirmed live this matters: some
// labels' icon sits 1 DOM level up, others 2, and searching too wide in
// one jump risks picking up a neighboring icon's marker instead of this
// label's own one. Stopping at the first hit keeps each label's own
// nearest marker, never a farther one that happens to match too.
function findSmallColoredMarkerNear(labelEl) {
  if (!labelEl) return null;
  let el = labelEl;
  for (let level = 1; level <= 3; level++) {
    el = el.parentElement;
    if (!el || !el.querySelectorAll) return null;
    const candidates = el.querySelectorAll("*");
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.width > 30 || rect.height > 30) continue; // icon-sized only — confirmed real badges run 10-19px
      const style = getComputedStyle(candidate);
      const bucket =
        bucketPassFailColor(style.fill) ||
        bucketPassFailColor(style.backgroundColor) ||
        bucketPassFailColor(style.color);
      if (bucket) return bucket;
    }
  }
  return null;
}

function extractQuickCheckSignals() {
  if (!document.body) return [];
  const results = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const nodeText = node.textContent.trim();
    if (!nodeText || nodeText.length > 40) continue;
    const match = QUICK_CHECK_LABELS.find((label) => nodeText.toLowerCase() === label.toLowerCase());
    if (!match || seen.has(match)) continue;
    const bucket = findSmallColoredMarkerNear(node.parentElement);
    if (!bucket) continue; // no readable marker near this label — say nothing rather than guess
    seen.add(match);
    results.push(`[Quick Check] ${match}: ${bucket === "pass" ? "OK / no issue indicated" : "flagged / needs attention"}`);
  }
  return results;
}

// AUTOCHECK — its own compact box (Score, Owners, Accidents, Titles/Probs,
// ODO) sits in the same Manheim iframe document, near the Condition
// Details table but outside both ROW_SELECTOR and the header line — a
// genuine fourth report, distinct from CARFAX despite sitting visually
// close to it. Not currently read by anything. Same defensive
// text-window approach as extractVehicleHeaderLine: find the line, grab
// a bounded window after it, degrade to null if the shape isn't there.
// Tagged explicitly so the prompt (and the model) never mistakes this
// for a Condition Report line item — see promptBuilder.js step 5.
function extractAutoCheckBlock() {
  const text = document.body ? document.body.innerText : "";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const startIdx = lines.findIndex((l) => /autocheck/i.test(l));
  if (startIdx === -1) return null;
  const windowText = lines.slice(startIdx, startIdx + 8).join(" ").slice(0, 400);
  return `[AutoCheck — separate report, not a Condition Report line] ${windowText}`;
}

function collectConditionReportText(rows) {
  const headerLine = extractVehicleHeaderLine();
  const autoCheckLine = extractAutoCheckBlock();
  const quickCheckLines = extractQuickCheckSignals();
  // A car with a genuinely clean Condition Report can have zero row-level
  // issues — that's real signal, not missing data (see promptBuilder.js
  // step 5), so this no longer bails out just because there are no rows.
  // It only gives up if there's truly nothing usable at all: no rows, no
  // header line, no AutoCheck box, and no quick-check icons either.
  if ((!rows || !rows.length) && !headerLine && !autoCheckLine && !quickCheckLines.length) return null;
  // Section headers ("Exterior (9)", "Interior (1)", "Structure (0)", …)
  // add useful grouping context and are cheap to include when present.
  const sectionHeaders = Array.from(document.querySelectorAll('[class*="damage-section"]'))
    .map((el) => (el.innerText || "").trim())
    .filter(Boolean);
  // Append the page's own severity read as a bracketed tag the backend
  // prompt explicitly knows to copy verbatim rather than re-judge — see
  // promptBuilder.js's step 5.
  const rowLines = (rows || []).map((r) => (r.pageSeverity ? `${r.text} [pageSeverity: ${r.pageSeverity}]` : r.text));
  // Header line and AutoCheck/quick-check tags go first so they read
  // naturally and can never get cut off by the 20000-char cap below.
  return [
    ...new Set([
      ...(headerLine ? [headerLine] : []),
      ...(autoCheckLine ? [autoCheckLine] : []),
      ...quickCheckLines,
      ...sectionHeaders,
      ...rowLines,
    ]),
  ]
    .join("\n")
    .slice(0, 20000);
}

// ---------- Market-benchmark tiles (Glance panel) ----------
// Same tile labels GLANCE_TILE_MARKERS further down already knows about —
// there they only detect "wrong panel matched." Here they're the actual
// extraction, so numbers like Ready Logistics Transport Cost and MMR
// Adjusted reach the backend as their own clearly-tagged field instead of
// sitting unused in the raw Glance text. Label, then look at the next few
// lines for something value-shaped — the grid's exact label/value line
// offset isn't guaranteed across vehicles/themes, so this tolerates a
// little slop rather than assuming a fixed offset; returns nothing for a
// tile it can't confidently find rather than guessing a number.
const MARKET_BENCHMARK_LABELS = [
  "Ready Logistics Transport Cost",
  "rBook Avg Odometer",
  "rBook Avg List Price",
  "MMR Adjusted",
  "ProfitTime GPS Appraised Value",
  "ProfitTime GPS Max Bid",
  "ProfitTime GPS Source Estimate",
  "J.D. POWER Clean Trade-In",
];
const BENCHMARK_VALUE_RE = /^\$?[\d][\d,]*(?:\.\d+)?\s*(?:mi|miles)?$/i;

function extractMarketBenchmarks(glanceText) {
  if (!glanceText) return {};
  const lines = glanceText.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = {};
  MARKET_BENCHMARK_LABELS.forEach((label) => {
    const idx = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
    if (idx === -1) return;
    for (let i = idx + 1; i < Math.min(idx + 4, lines.length); i++) {
      if (BENCHMARK_VALUE_RE.test(lines[i])) {
        out[label] = lines[i];
        break;
      }
    }
  });
  return out;
}

// ---------- Flagged-photo discovery (URLs only — fetching happens in background.js) ----------

function isLikelyIcon(img) {
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  // Real condition-report photos are meaningfully sized; UI icons/checkmarks are tiny.
  // (0 just means "not loaded yet / unknown" — don't filter those out.)
  return (w && w < 48) || (h && h < 48);
}

function findAncestorRowText(img) {
  // Climb from the image up to the nearest ancestor that actually has
  // text — the row/item container naming this defect. These grids are
  // div-based, not <table>/<tr>, and the <img> sits inside several empty
  // wrapper levels below the row that carries the actual text.
  let el = img.parentElement;
  for (let i = 0; i < 8 && el; i++) {
    const text = (el.innerText || "").trim();
    if (text.length >= 4) return text.replace(/\s+/g, " ");
    el = el.parentElement;
  }
  return "";
}

function gatherFlaggedPhotosFromRows(rows) {
  // Primary strategy — reuses the same row objects used for text, so
  // there's no separate DOM search.
  const candidates = [];
  const seenSrc = new Set();
  (rows || []).forEach(({ text, img }) => {
    if (!text || !img || !img.src || isLikelyIcon(img) || seenSrc.has(img.src)) return;
    if (!PHOTO_KEYWORDS.some((k) => text.toLowerCase().includes(k))) return;
    seenSrc.add(img.src);
    candidates.push({ label: text.slice(0, 100), src: img.src });
  });
  return candidates.slice(0, MAX_PHOTOS);
}

function gatherFlaggedPhotosInPanel(panelEl) {
  // Fallback only — used when nothing else found any condition-report
  // content at all, via the older heading-based panel search.
  if (!panelEl) return [];
  const candidates = [];
  const seenSrc = new Set();

  panelEl.querySelectorAll("tr").forEach((row) => {
    const rowText = (row.innerText || "").trim();
    if (!rowText) return;
    if (!PHOTO_KEYWORDS.some((k) => rowText.toLowerCase().includes(k))) return;
    const img = row.querySelector("img");
    if (!img || !img.src || isLikelyIcon(img) || seenSrc.has(img.src)) return;
    seenSrc.add(img.src);
    candidates.push({ label: rowText.slice(0, 100), src: img.src });
  });

  if (candidates.length === 0) {
    panelEl.querySelectorAll("img").forEach((img) => {
      if (!img.src || seenSrc.has(img.src) || isLikelyIcon(img)) return;
      const rowText = findAncestorRowText(img);
      if (!rowText || !PHOTO_KEYWORDS.some((k) => rowText.toLowerCase().includes(k))) return;
      seenSrc.add(img.src);
      candidates.push({ label: rowText.slice(0, 100), src: img.src });
    });
  }

  if (candidates.length === 0) {
    panelEl.querySelectorAll("img").forEach((img) => {
      if (!img.src || seenSrc.has(img.src) || isLikelyIcon(img)) return;
      const caption = (img.alt || img.title || "").trim();
      if (!PHOTO_KEYWORDS.some((k) => caption.toLowerCase().includes(k))) return;
      seenSrc.add(img.src);
      candidates.push({ label: caption.slice(0, 100) || "Flagged photo", src: img.src });
    });
  }

  return candidates.slice(0, MAX_PHOTOS);
}

// ======================================================================
// MANHEIM IFRAME MODE — this instance is running inside the cross-origin
// Manheim panel itself, not the vAuto page. No button, no overlay — just
// watch for the Condition Details table and relay it to background.js
// the moment it has real content, so the top frame's click handler can
// pick it up later without ever needing to reach across the frame
// boundary itself.
// ======================================================================

let lastRelayedSignature = "";

function relayConditionDetailsIfChanged() {
  if (!chrome.runtime || !chrome.runtime.id) return; // context invalidated — nothing to relay to
  const rows = collectConditionReportRows();
  // Used to bail out here whenever there were zero rows — but zero rows
  // is the correct, honest state for a genuinely clean Condition Report,
  // not a sign nothing loaded yet. Bail out only when there's truly
  // nothing usable: collectConditionReportText() returns null in that
  // case (no rows AND no VIN/odometer header line found either), which
  // now doubles as the real "has this table actually rendered yet?"
  // check instead of rows.length.
  const text = collectConditionReportText(rows);
  if (!text) return;
  const photos = gatherFlaggedPhotosFromRows(rows);
  // Cheap change check so we're not spamming background.js on every
  // unrelated DOM mutation inside this iframe (hover states, etc).
  const signature = text.length + ":" + photos.length + ":" + rows.length;
  if (signature === lastRelayedSignature) return;
  lastRelayedSignature = signature;
  try {
    chrome.runtime.sendMessage({ type: "CONDITION_DETAILS_UPDATE", text, photos });
  } catch (e) {
    // Extension context invalidated mid-flight — the top frame's own
    // click handler will surface a real error if this data is missing.
  }
}

function startManheimFrameWorker() {
  relayConditionDetailsIfChanged();
  const frameObserver = new MutationObserver(() => relayConditionDetailsIfChanged());
  frameObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Answers the top frame's REQUEST_FRESH_EXTRACT (sent on every Analyze
  // click, see requestFreshExtraction() in top-frame mode below) by
  // re-extracting and relaying right now, bypassing the normal
  // signature-based "only relay if it actually changed" dedup — the point
  // here is to force a push even in the unlikely case the current DOM
  // state happens to hash the same as something already relayed, so the
  // top frame is never left waiting on a relay that dedup logic decided
  // not to send.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "FORCE_REEXTRACT") {
      lastRelayedSignature = "";
      relayConditionDetailsIfChanged();
    }
  });
}

// ======================================================================
// TOP FRAME MODE — the vAuto/Stockwave page: button, click handling,
// overlay UI.
// ======================================================================

function requestCachedConditionDetails() {
  return new Promise((resolve) => {
    if (!chrome.runtime || !chrome.runtime.id) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "GET_CONDITION_DETAILS" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// CONFIRMED LIVE 2026-09-15 — a real race condition: click "Analyze" on a
// vehicle right after switching to it from a different one (same tab, the
// Manheim panel loads a new car via its own in-page routing rather than a
// full page navigation), and background.js's cache can still be holding
// the PREVIOUS vehicle's Condition Details — the iframe's own re-extraction
// (triggered by its MutationObserver) hadn't finished yet. One live test
// produced a verdict blending a totally unrelated car's 22 defect items
// into this car's real 3. Wrong-car data driving a real bid is the worst
// failure mode this tool has, so rather than trust whatever's already
// cached, every Analyze click now asks the iframe to re-extract RIGHT NOW
// and gives it a moment to relay the fresh result before reading the cache
// — closing the window instead of hoping the cache happened to catch up in
// time on its own. Adds a small, deliberate delay to every click; worth it.
function requestFreshExtraction() {
  return new Promise((resolve) => {
    if (!chrome.runtime || !chrome.runtime.id) {
      resolve();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "REQUEST_FRESH_EXTRACT" }, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

// ---------- Overlay UI ----------

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.id = "ac-overlay";
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function showBadge(text) {
  const el = ensureOverlay();
  el.className = "ac-badge";
  el.innerHTML = `<span class="ac-dot"></span><span>${text}</span>`;
}

function showError(message) {
  const el = ensureOverlay();
  el.className = "ac-card ac-card-error";
  el.innerHTML = `
    <div class="ac-head">🔦 Auction Copilot</div>
    <div class="ac-sub">Couldn't complete the read</div>
    <div class="ac-error">${escapeHtml(message)}</div>
  `;
}

function decisionClass(decision) {
  const d = (decision || "").toUpperCase();
  if (d.includes("BUY")) return "ac-decision-good";
  if (d.includes("PASS")) return "ac-decision-danger";
  return "ac-decision-warn"; // bid ceiling / conditional / anything else
}

// Same good/danger/warn bucketing as decisionClass, but as the suffix
// used for the card's left-edge accent border class
// (ac-card-accent-good/danger/warn) — kept as one small helper so the
// banner color and the card's own edge color can never drift apart.
function severityFromDecision(decision) {
  const d = (decision || "").toUpperCase();
  if (d.includes("BUY")) return "good";
  if (d.includes("PASS")) return "danger";
  return "warn";
}

// buyRating is its own five-tier scale (see promptBuilder.js step 8),
// deliberately more granular than the three-way decision banner above —
// this is "how good a deal is this," not "buy or don't."
const BUY_RATING_LABELS = {
  GOOD_BUY: "Good buy",
  PROFITABLE_BUY: "Profitable buy",
  NEEDS_WORK_BUY: "Needs work",
  FLAG_BUY: "Flag — recon shop only",
  BAD_BUY: "Bad buy",
};
const BUY_RATING_CLASSES = {
  GOOD_BUY: "ac-rating-good",
  PROFITABLE_BUY: "ac-rating-profitable",
  NEEDS_WORK_BUY: "ac-rating-needswork",
  FLAG_BUY: "ac-rating-flag",
  BAD_BUY: "ac-rating-bad",
};

// allConditionItems severity is a separate, four-tier scale sourced
// directly from the page's own color-coded markers where available (see
// pageSeverityForRow in the iframe-worker section) — deliberately not
// the same three-tier good/warn/danger vocabulary keyFindings uses,
// since the point here is to mirror the page's own None/Minor/
// Moderate/Severe scale as closely as possible.
const ITEM_SEVERITY_CLASSES = {
  none: "ac-inv-none",
  minor: "ac-inv-minor",
  moderate: "ac-inv-moderate",
  severe: "ac-inv-severe",
};

function showVerdict(v, vin) {
  const el = ensureOverlay();
  el.className = `ac-card ac-card-accent-${severityFromDecision(v.decision)}`;

  // Snapshot the context a correction would need, so "Suggest a
  // correction" can send it along automatically later without the buyer
  // having to say which car or which number they mean.
  currentFeedbackContext = {
    vin: vin || "",
    vehicle: v.vehicle || "",
    decision: v.decision || "",
    bidCeiling: v.bidCeiling || "",
    buyRating: v.buyRating || "",
  };

  // The decision is the product — everything else is supporting
  // evidence. Layout order below is deliberate: decision banner first
  // (largest, boldest thing on the card), then the buy-rating tier (a
  // finer-grained "how good a deal" read, always visible — not worth
  // burying behind a toggle), then a one-line coverage count, then the
  // headline. Everything else — key findings (collapsed by default,
  // expand per item), the cross-source check, the COMPLETE item
  // inventory, and reasoning — lives behind "Show full breakdown" so
  // the card isn't a wall of text on open.
  const allItems = Array.isArray(v.allConditionItems) ? v.allConditionItems : [];
  const keyFindingsList = v.keyFindings || v.flags || [];
  const reviewedCount = typeof v.itemsReviewedCount === "number" ? v.itemsReviewedCount : allItems.length;
  const reasoningBullets = Array.isArray(v.reasoning) ? v.reasoning : v.reasoning ? [v.reasoning] : [];

  const buyRatingKey = (v.buyRating || "").toUpperCase();
  const buyRating = BUY_RATING_LABELS[buyRatingKey]
    ? `<div class="ac-rating ${BUY_RATING_CLASSES[buyRatingKey]}">
        <span class="ac-rating-label">${escapeHtml(BUY_RATING_LABELS[buyRatingKey])}</span>
        ${v.buyRatingReason ? `<span class="ac-rating-reason">${escapeHtml(v.buyRatingReason)}</span>` : ""}
      </div>`
    : "";

  const coverage = reviewedCount || allItems.length
    ? `<div class="ac-coverage">${escapeHtml(String(reviewedCount))} item${reviewedCount === 1 ? "" : "s"} reviewed · ${keyFindingsList.length} flagged as material to this call</div>`
    : "";

  const caveat = v.dataConfidence === "partial" && v.dataCaveat
    ? `<div class="ac-caveat">⚠ ${escapeHtml(v.dataCaveat)}</div>`
    : "";

  // server.js independently double-checks/fills a couple of specific
  // things (see "Server-side verdict reconciliation" there) rather than
  // trusting the model's raw response outright — e.g. recomputing
  // bidCeiling when the model's own reasoning didn't actually add up to
  // the number it returned. When that happens, verdict.serverCorrections
  // says what changed and why; shown here rather than silently swapping
  // the number, so the buyer sees a correction happened, not just a
  // different figure than they might have expected.
  const serverCorrectionsList = Array.isArray(v.serverCorrections) ? v.serverCorrections : [];
  const serverNote = serverCorrectionsList.length
    ? `<div class="ac-server-note">🛠 ${serverCorrectionsList.map((s) => escapeHtml(s)).join("<br>")}</div>`
    : "";

  // Each key finding starts collapsed, showing only its label and
  // severity — clicking expands the specific evidence behind it. Keeps
  // the highlight reel scannable at a glance instead of a wall of detail
  // text for every item whether you need it or not.
  //
  // SECURITY: f.severity, f.title, and f.detail all ultimately trace back
  // to page content the model read (an auction listing's own text is
  // attacker-influenceable — this extension has no control over what a
  // seller writes into a Condition Report). Everything rendered as text
  // goes through escapeHtml() below. f.severity additionally gets used to
  // build a CSS *class name*, which sits inside an HTML attribute — that
  // needs its own whitelist rather than escapeHtml() (which only guards
  // element text, not attribute-breaking characters used to build a
  // string that's then concatenated unescaped into markup). Never
  // interpolate a model-sourced string directly into a class/id/attribute
  // again without going through a fixed lookup map like this one.
  const FLAG_SEVERITY_CLASSES = { danger: "ac-flag-danger", warn: "ac-flag-warn", good: "ac-flag-good" };
  const findings = keyFindingsList
    .map((f, i) => {
      const flagClass = FLAG_SEVERITY_CLASSES[(f.severity || "").toLowerCase()] || FLAG_SEVERITY_CLASSES.warn;
      return `
      <div class="ac-flag ${flagClass}">
        <button class="ac-flag-toggle" data-flag-index="${i}">
          <span class="ac-flag-title">${escapeHtml(f.title || "")}</span>
          <span class="ac-flag-caret">▾</span>
        </button>
        <div class="ac-flag-detail" id="ac-flag-detail-${i}" hidden>${escapeHtml(f.detail || "")}</div>
      </div>`;
    })
    .join("");

  const reconciliation = (v.reconciliation || [])
    .map(
      (r) => `<div class="ac-recon-item">
        <b>${escapeHtml(r.field || "")}</b> — ${escapeHtml(r.note || "")}
      </div>`
    )
    .join("");

  // The complete, unfiltered inventory — every item the model read, not
  // just the handful that made keyFindings. Severity here mirrors the
  // page's own color-coded scale (none/minor/moderate/severe), sourced
  // directly off the page where possible rather than re-judged — see
  // pageSeverityForRow. Severe items get an explicit text tag, not just
  // a colored dot, so they can't be missed scanning the list.
  const inventoryRows = allItems
    .map((it) => {
      const sev = (it.severity || "").toLowerCase();
      const cls = ITEM_SEVERITY_CLASSES[sev] || ITEM_SEVERITY_CLASSES.moderate;
      return `<div class="ac-inv-item ${cls}">
        <span class="ac-inv-dot"></span>
        <span>${escapeHtml(it.item || "")}</span>
        ${sev === "severe" ? `<span class="ac-inv-severe-tag">SEVERE</span>` : ""}
      </div>`;
    })
    .join("");
  const inventory = allItems.length
    ? `<div class="ac-inventory">
        <div class="ac-recon-title">Full item inventory (${allItems.length})</div>
        ${inventoryRows}
      </div>`
    : "";

  const reasoning = reasoningBullets.length
    ? `<div class="ac-recon-title">Full reasoning</div>
       <ul class="ac-reasoning-list">${reasoningBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
    : "";

  // Market comparison — deliberately its own block, never merged into
  // ac-recon (the cross-source check above). Reconciliation is about
  // whether sources agree on facts ABOUT THIS VIN; this is "how does the
  // bid ceiling compare to the market," sourced from the same
  // rBook/MMR/ProfitTime tiles that step 3 in promptBuilder.js explicitly
  // says must never be treated as a competing claim about this car. Kept
  // visually and structurally separate so that discipline can't erode.
  const marketComparisonRows = Array.isArray(v.marketComparison) ? v.marketComparison : [];
  const marketComparison = marketComparisonRows.length
    ? `<div class="ac-market"><div class="ac-recon-title">Market comparison</div>${marketComparisonRows
        .map(
          (m) => `<div class="ac-market-item">
            <b>${escapeHtml(m.label || "")}</b> ${escapeHtml(m.value || "")} — ${escapeHtml(m.note || "")}
          </div>`
        )
        .join("")}</div>`
    : "";

  const transportRow = v.transportCost
    ? `<div class="ac-est"><span>Transport cost</span><b>${escapeHtml(v.transportCost)}</b></div>`
    : "";

  el.innerHTML = `
    <div class="ac-head">🔦 Auction Copilot</div>
    <div class="ac-sub">${escapeHtml(v.vehicle || "")}${v.grade ? " · Grade " + escapeHtml(v.grade) : ""}</div>
    <div class="ac-decision ${decisionClass(v.decision)}">
      <span class="ac-decision-label">${escapeHtml(v.decision || "VERDICT")}</span>
      ${v.bidCeiling ? `<span class="ac-decision-ceiling">${escapeHtml(v.bidCeiling)}</span>` : ""}
    </div>
    ${buyRating}
    ${coverage}
    <div class="ac-headline">${escapeHtml(v.headline || v.verdict || "")}</div>
    <button class="ac-feedback-toggle" id="ac-feedback-toggle">💬 Suggest a correction</button>
    <div class="ac-feedback-form" id="ac-feedback-form" hidden>
      <textarea class="ac-feedback-text" id="ac-feedback-text" maxlength="4000" rows="4" placeholder="What should we know? A missed defect, a number that looks off, anything at all — the more detail the better."></textarea>
      <button class="ac-feedback-submit" id="ac-feedback-submit">Send feedback</button>
      <div class="ac-feedback-status" id="ac-feedback-status" hidden></div>
    </div>
    <button class="ac-details-toggle" id="ac-details-toggle">Show full breakdown ▾</button>
    <div class="ac-details" id="ac-details" hidden>
      ${findings ? `<div class="ac-recon-title">Key findings</div>${findings}` : ""}
      ${reconciliation ? `<div class="ac-recon"><div class="ac-recon-title">Cross-source check</div>${reconciliation}</div>` : ""}
      ${inventory}
      <div class="ac-est"><span>Est. recon</span><b>${escapeHtml(v.reconEstimate || "n/a")}</b></div>
      ${transportRow}
      ${marketComparison}
      ${reasoning}
      ${caveat}
      ${serverNote}
    </div>
    <button class="ac-close" id="ac-close-btn">Dismiss</button>
  `;
  const toggle = document.getElementById("ac-details-toggle");
  const details = document.getElementById("ac-details");
  if (toggle && details) {
    toggle.addEventListener("click", () => {
      const isHidden = details.hasAttribute("hidden");
      if (isHidden) {
        details.removeAttribute("hidden");
        toggle.textContent = "Hide full breakdown ▴";
      } else {
        details.setAttribute("hidden", "");
        toggle.textContent = "Show full breakdown ▾";
      }
    });
  }
  el.querySelectorAll(".ac-flag-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const detail = document.getElementById(`ac-flag-detail-${btn.dataset.flagIndex}`);
      const caret = btn.querySelector(".ac-flag-caret");
      if (!detail) return;
      const isHidden = detail.hasAttribute("hidden");
      if (isHidden) {
        detail.removeAttribute("hidden");
        if (caret) caret.textContent = "▴";
      } else {
        detail.setAttribute("hidden", "");
        if (caret) caret.textContent = "▾";
      }
    });
  });
  const close = document.getElementById("ac-close-btn");
  if (close) close.addEventListener("click", () => { el.remove(); overlayEl = null; });

  const feedbackToggle = document.getElementById("ac-feedback-toggle");
  const feedbackForm = document.getElementById("ac-feedback-form");
  if (feedbackToggle && feedbackForm) {
    feedbackToggle.addEventListener("click", () => {
      const isHidden = feedbackForm.hasAttribute("hidden");
      if (isHidden) {
        feedbackForm.removeAttribute("hidden");
        feedbackToggle.textContent = "💬 Suggest a correction ▴";
        const textarea = document.getElementById("ac-feedback-text");
        if (textarea) textarea.focus();
      } else {
        feedbackForm.setAttribute("hidden", "");
        feedbackToggle.textContent = "💬 Suggest a correction";
      }
    });
  }
  const feedbackSubmit = document.getElementById("ac-feedback-submit");
  if (feedbackSubmit) feedbackSubmit.addEventListener("click", onSubmitFeedbackClick);
}

function setFeedbackStatus(message, isError) {
  const statusEl = document.getElementById("ac-feedback-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = "ac-feedback-status " + (isError ? "ac-feedback-status-error" : "ac-feedback-status-ok");
  statusEl.removeAttribute("hidden");
}

// Sends whatever the buyer typed, plus the auto-attached verdict context
// captured in currentFeedbackContext when this card was rendered, to
// background.js — same "background.js owns where requests actually go"
// pattern as onAnalyzeClick, so this endpoint gets the shared-secret
// header treatment for free rather than needing its own copy of that
// logic here.
function onSubmitFeedbackClick() {
  const textarea = document.getElementById("ac-feedback-text");
  const submitBtn = document.getElementById("ac-feedback-submit");
  const comment = textarea ? textarea.value.trim() : "";

  if (!comment) {
    setFeedbackStatus("Write something first — even a couple of words helps.", true);
    return;
  }
  if (!chrome.runtime || !chrome.runtime.id) {
    setFeedbackStatus(
      "Auction Copilot's connection to this tab was reset — refresh the page (F5) and try again.",
      true
    );
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
  }
  setFeedbackStatus("Sending…", false);

  const ctx = currentFeedbackContext || {};
  chrome.runtime.sendMessage(
    {
      type: "SUBMIT_FEEDBACK",
      vin: ctx.vin || "",
      vehicle: ctx.vehicle || "",
      decision: ctx.decision || "",
      bidCeiling: ctx.bidCeiling || "",
      buyRating: ctx.buyRating || "",
      comment,
    },
    (response) => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send feedback";
      }
      if (chrome.runtime.lastError) {
        setFeedbackStatus(chrome.runtime.lastError.message, true);
        return;
      }
      if (!response || !response.ok) {
        setFeedbackStatus((response && response.error) || "Couldn't send feedback — try again.", true);
        return;
      }
      setFeedbackStatus("✓ Thanks — sent.", false);
      if (textarea) textarea.value = "";
    }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Trigger flow ----------

async function onAnalyzeClick() {
  // Chrome invalidates a content script's connection to the extension the
  // moment the extension reloads (dev testing, an update) while this tab
  // was already open. After that, ANY chrome.* call throws synchronously.
  // chrome.runtime.id goes undefined the instant the context is
  // invalidated, so checking it up front catches this before any work is
  // done and shows a clear, actionable message instead of a silent hang.
  if (!chrome.runtime || !chrome.runtime.id) {
    showError(
      "Auction Copilot's connection to this tab was reset — this happens after the extension reloads. Refresh this page (F5) and try again."
    );
    return;
  }

  showBadge("Auction Copilot — reading the full report…");

  try {
    // The Condition Details table renders inside a cross-origin Manheim
    // iframe (see the top-of-file note) — a separate copy of this script
    // running inside that iframe extracts it and relays it to
    // background.js the moment it's on screen.
    //
    // Ask it to re-extract RIGHT NOW rather than trusting whatever's
    // already cached — confirmed live that jumping straight from one
    // vehicle to another and clicking Analyze immediately can otherwise
    // win a race against the iframe's own re-extraction, pulling the
    // PREVIOUS vehicle's data into this one's verdict. 350ms is enough for
    // a same-document DOM query + one extension message round trip; it's
    // not waiting on any network call.
    await requestFreshExtraction();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const cached = await requestCachedConditionDetails();
    let conditionText = cached && cached.text ? cached.text : null;
    let photos = cached && Array.isArray(cached.photos) ? cached.photos.slice(0, MAX_PHOTOS) : [];

    // Fallback A: maybe this page renders the table directly in the top
    // frame after all (a different layout than the one confirmed above).
    if (!conditionText) {
      const localRows = collectConditionReportRows();
      if (localRows.length) {
        conditionText = collectConditionReportText(localRows);
        if (!photos.length) photos = gatherFlaggedPhotosFromRows(localRows);
      }
    }

    // Fallback B: the old heading-based search, last resort.
    if (!conditionText) {
      conditionText = findPanelText("Condition Report", PANEL_TITLES);
      if (!photos.length) {
        const conditionReportEl = findPanelElement("Condition Report", PANEL_TITLES);
        photos = gatherFlaggedPhotosInPanel(conditionReportEl);
      }
    }

    // CONFIRMED LIVE 2026-09-15, via a server-side debug log: when
    // Fallback B runs before the Manheim panel's real Condition Details
    // table has ever been opened, findPanelText("Condition Report", ...)
    // can match the small Glance summary TILE instead — a few words of
    // column headers ("ProfitTime GPS Max Bid", "rBook Avg Odometer",
    // "Stockwave Strategy Action"), not one single real defect line. That
    // text is non-empty, so the `!conditionText` check right below never
    // caught it, and it went straight to Gemini, which still produced a
    // confident-looking PASS/BAD_BUY verdict built on essentially nothing
    // — exactly the "invented placeholder data" failure this file was
    // originally rewritten to prevent, just via a different path than the
    // one documented at the top of this file. These labels only ever
    // appear on that summary tile, never inside the real Condition Details
    // table, so their presence is a reliable tell that the wrong element
    // was matched — treat it the same as not having found anything.
    const GLANCE_TILE_MARKERS = [
      "ProfitTime GPS Max Bid", "rBook Avg Odometer", "Stockwave Strategy Action",
      "ProfitTime GPS Appraised Value", "J.D. POWER Clean Trade-In", "Ready Logistics Transport Cost",
    ];
    if (conditionText && GLANCE_TILE_MARKERS.some((marker) => conditionText.includes(marker))) {
      conditionText = null;
    }

    if (!conditionText) {
      // Being honest here beats sending the backend an empty panel and
      // getting a confident-looking verdict built on 23 invented,
      // generic "not expanded" placeholder lines — which is exactly
      // what happened before this was diagnosed.
      showError(
        'Auction Copilot couldn\'t read the Condition Details table yet. Open "Condition Details" in the Manheim panel for this vehicle so it renders on screen, then click Analyze again.'
      );
      return;
    }

    const panels = {
      "Condition Report": conditionText,
      Glance: findPanelText("Glance", PANEL_TITLES),
      CARFAX: findPanelText("CARFAX", PANEL_TITLES),
    };
    const vin = guessVin();
    const marketBenchmarks = extractMarketBenchmarks(panels.Glance);

    if (photos.length) {
      showBadge(`Auction Copilot — pulling ${photos.length} flagged photo${photos.length === 1 ? "" : "s"}…`);
    }

    chrome.runtime.sendMessage(
      { type: "ANALYZE_REQUEST", vin, panels, photos, marketBenchmarks },
      (response) => {
        if (chrome.runtime.lastError) {
          showError(chrome.runtime.lastError.message);
          return;
        }
        if (!response || !response.ok) {
          showError((response && response.error) || "No response from backend. Is the local server running?");
          return;
        }
        showVerdict(response.verdict, vin);
      }
    );
  } catch (err) {
    const message = (err && err.message) || "";
    if (message.includes("Extension context invalidated")) {
      showError(
        "Auction Copilot's connection to this tab was reset — this happens after the extension reloads. Refresh this page (F5) and try again."
      );
    } else {
      showError(message || "Unexpected error while reading the page.");
    }
  }
}

// ---------- Bootstrap ----------

if (IS_TOP_FRAME) {
  // vAuto is a single-page app — content changes without a full page
  // load, so watch the DOM rather than relying on run_at alone.
  const observer = new MutationObserver(() => {
    ensureButton();
    ensureScopeHint();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
  ensureScopeHint();
} else {
  startManheimFrameWorker();
}