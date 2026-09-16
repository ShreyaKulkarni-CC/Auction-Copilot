require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const { buildPrompt } = require("./promptBuilder");

const PORT = process.env.PORT || 8787;
// "gemini-2.0-flash" (the old default here) was retired by Google
// sometime after this project started — confirmed live on 2026-09-15 via
// a real 404 from the API: "This model models/gemini-2.0-flash is no
// longer available... We recommend you to use ... models/gemini-3.6-flash."
// Google can retire models again in the future without warning, so if
// /analyze starts failing with a 404 mentioning a model name, that's the
// fix: check https://ai.google.dev/gemini-api/docs/models for the current
// name and update GEMINI_MODEL in server/.env (preferred — no code change
// needed) or this fallback.
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------
// SECURITY NOTES — read this before deploying somewhere public.
//
// This backend has no user accounts, no login, and no database — it's a
// single stateless endpoint that turns page text + photos into one
// Gemini call. So most of a typical "review the auth system" / "prevent
// IDOR" checklist doesn't have anything to attach to here: there's no
// password to hash, no session to expire, no per-user row that could
// leak into another user's response, because there are no user accounts
// and no stored rows. What DOES apply once this endpoint is reachable
// from the public internet instead of just localhost: a stranger who
// finds the URL burning your paid Gemini quota, or sending oversized /
// malformed bodies. That's what everything below defends against.
// ---------------------------------------------------------------------

const app = express();

// Render (and most PaaS hosts) sit one reverse-proxy hop in front of this
// process. Without this, req.ip is always the proxy's own address, which
// would put every visitor in the same rate-limit bucket instead of
// limiting each one individually. Harmless locally (there's no proxy, so
// this has nothing to do).
app.set("trust proxy", 1);

app.use(helmet()); // sane default security headers; also drops X-Powered-By

// Once this server is hosted somewhere public, it's reachable by anyone
// who finds the URL, not just buyers running the extension. ALLOWED_ORIGINS
// lets you lock that down without another code change: leave it unset (or
// "*") while testing, then in the hosting provider's dashboard set it to
// the extension's own origin, e.g. "chrome-extension://<the extension's
// id>" (comma-separate a list for more than one). Worth knowing this is a
// browser-only protection — CORS does nothing to stop a non-browser client
// (curl, a script) from calling the endpoint directly, which is why the
// rate limiting and optional shared-secret check further down exist too.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS,
  })
);

app.use(express.json({ limit: "15mb" })); // screenshots are base64, need headroom

// Force HTTPS once deployed. Render terminates TLS at its edge and always
// forwards to this process over plain HTTP internally, setting
// x-forwarded-proto to say what the original visitor actually used — so
// this redirects anyone who somehow reaches the app over http:// without
// creating a redirect loop on Render's own internal requests. No-op
// locally (NODE_ENV isn't "production" there).
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    if (req.headers["x-forwarded-proto"] === "https") return next();
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  });
}

// Lightweight request logging — enough to spot abuse patterns (a burst of
// 401s, a burst of 429s, one IP hitting /analyze nonstop) without logging
// the actual page content/photos that pass through the endpoint.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    const line = `${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms}ms ip=${req.ip}`;
    if (res.statusCode >= 400) console.warn(line);
    else console.log(line);
  });
  next();
});

let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
  console.warn(
    "⚠️  GEMINI_API_KEY is not set. Copy .env.example to .env and add your key — " +
      "the server will start, but /analyze will return an error until it's set."
  );
}

app.get("/health", (req, res) => {
  res.json({ ok: true, model: MODEL_NAME, hasApiKey: !!process.env.GEMINI_API_KEY });
});

// ---------- Abuse protection ----------
// Two stacked limits per IP: a short burst window (catches a runaway
// retry loop or someone mashing the button) and a generous daily ceiling
// (catches a script left running overnight). A real buyer clicking
// "Analyze this car" while shopping a lane never gets close to either.
const analyzeBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many analyze requests from this IP — wait a minute and try again." },
  handler: (req, res, next, options) => {
    console.warn(`[SECURITY] burst rate limit hit on /analyze ip=${req.ip}`);
    res.status(options.statusCode).json(options.message);
  },
});
const analyzeDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Daily request limit reached for this IP. If this is a real buyer hitting a real ceiling, raise ANALYZE_DAILY_LIMIT." },
  handler: (req, res, next, options) => {
    console.warn(`[SECURITY] daily rate limit hit on /analyze ip=${req.ip}`);
    res.status(options.statusCode).json(options.message);
  },
});

// Optional shared secret, sent by the extension as "X-Extension-Key" (see
// extension/background.js). Disabled by default (empty string) so local
// testing keeps working with no setup. Once you deploy publicly, set this
// env var on the host AND set the matching constant in
// extension/background.js, then rebuild/redistribute the extension. Be
// honest with yourself about what this is: a shared static string baked
// into an unpacked extension is trivially readable by anyone who unzips
// it — this is not real per-user authentication, it's a low-effort bar
// against a search engine or opportunistic scanner finding the bare URL.
const EXTENSION_SHARED_SECRET = process.env.EXTENSION_SHARED_SECRET || "";
function requireExtensionKey(req, res, next) {
  if (!EXTENSION_SHARED_SECRET) return next();
  const provided = req.get("X-Extension-Key");
  if (provided !== EXTENSION_SHARED_SECRET) {
    console.warn(`[SECURITY] rejected /analyze — missing/invalid X-Extension-Key ip=${req.ip}`);
    return res.status(401).json({ error: "Missing or invalid extension key." });
  }
  next();
}

// ---------- Input validation ----------
// Everything here is untrusted the moment this server is public — even
// though today's only caller is our own extension, a public URL can be
// called by literally anything. Reject what doesn't match the shape the
// extension actually sends, rather than passing arbitrary attacker data
// through to the Gemini prompt or paying to process a huge payload.
const ALLOWED_PANEL_KEYS = ["Condition Report", "Glance", "CARFAX"];
const MAX_PANEL_TEXT_LENGTH = 25000; // content.js caps extraction at 20000; small buffer
const MAX_VIN_LENGTH = 32;
// Same list content.js's MARKET_BENCHMARK_LABELS extracts — validation
// here rejects anything else rather than passing an attacker-supplied key
// straight into the Gemini prompt (see the input-validation note above).
const ALLOWED_BENCHMARK_KEYS = [
  "Ready Logistics Transport Cost",
  "rBook Avg Odometer",
  "rBook Avg List Price",
  "MMR Adjusted",
  "ProfitTime GPS Appraised Value",
  "ProfitTime GPS Max Bid",
  "ProfitTime GPS Source Estimate",
  "J.D. POWER Clean Trade-In",
];
const MAX_BENCHMARK_VALUE_LENGTH = 60; // these are short numbers/mileages, not free text
const MAX_PHOTOS = 6; // content.js caps at 5; small buffer
const MAX_PHOTO_LABEL_LENGTH = 300;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const MAX_DATA_URL_LENGTH = 10 * 1024 * 1024; // ~7.5MB decoded — generous for a screenshot/photo
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

function isValidImageDataUrl(value) {
  if (typeof value !== "string" || value.length > MAX_DATA_URL_LENGTH) return false;
  const match = DATA_URL_RE.exec(value);
  return !!match && ALLOWED_IMAGE_MIME.has(match[1]);
}

function validateAnalyzeBody(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["Request body must be a JSON object."];
  }

  const { vin, panels, screenshot, photos, marketBenchmarks } = body;

  if (vin !== undefined && vin !== null && (typeof vin !== "string" || vin.length > MAX_VIN_LENGTH)) {
    errors.push("vin must be a short string.");
  }

  if (marketBenchmarks !== undefined && marketBenchmarks !== null) {
    if (typeof marketBenchmarks !== "object" || Array.isArray(marketBenchmarks)) {
      errors.push("marketBenchmarks must be an object.");
    } else {
      for (const [key, value] of Object.entries(marketBenchmarks)) {
        if (!ALLOWED_BENCHMARK_KEYS.includes(key)) {
          errors.push(`Unexpected marketBenchmarks key: "${key}".`);
          continue;
        }
        if (value !== null && value !== undefined && (typeof value !== "string" || value.length > MAX_BENCHMARK_VALUE_LENGTH)) {
          errors.push(`marketBenchmarks["${key}"] must be a short string.`);
        }
      }
    }
  }

  if (!panels || typeof panels !== "object" || Array.isArray(panels)) {
    errors.push("panels must be an object.");
  } else {
    for (const [key, value] of Object.entries(panels)) {
      if (!ALLOWED_PANEL_KEYS.includes(key)) {
        errors.push(`Unexpected panel key: "${key}".`);
        continue;
      }
      if (value !== null && value !== undefined && (typeof value !== "string" || value.length > MAX_PANEL_TEXT_LENGTH)) {
        errors.push(`panels["${key}"] must be a string under ${MAX_PANEL_TEXT_LENGTH} characters.`);
      }
    }
  }

  if (screenshot !== undefined && screenshot !== null && screenshot !== "" && !isValidImageDataUrl(screenshot)) {
    errors.push("screenshot must be a PNG/JPEG/WebP data URL under the size cap.");
  }

  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) {
      errors.push(`photos must be an array of at most ${MAX_PHOTOS} items.`);
    } else {
      photos.forEach((p, i) => {
        if (!p || typeof p !== "object") {
          errors.push(`photos[${i}] must be an object.`);
          return;
        }
        if (p.label !== undefined && p.label !== null && (typeof p.label !== "string" || p.label.length > MAX_PHOTO_LABEL_LENGTH)) {
          errors.push(`photos[${i}].label is too long or not a string.`);
        }
        if (p.dataUrl !== undefined && p.dataUrl !== null && !isValidImageDataUrl(p.dataUrl)) {
          errors.push(`photos[${i}].dataUrl must be a PNG/JPEG/WebP data URL under the size cap.`);
        }
      });
    }
  }

  return errors;
}

app.post("/analyze", analyzeBurstLimiter, analyzeDailyLimiter, requireExtensionKey, async (req, res) => {
  const { vin, panels, screenshot, photos, marketBenchmarks } = req.body || {};

  if (!panels || Object.values(panels).every((v) => !v)) {
    return res.status(400).json({ error: "No panel text was captured. Is a vehicle's Condition Report / Glance / CARFAX actually open on the page?" });
  }

  const validationErrors = validateAnalyzeBody(req.body);
  if (validationErrors.length) {
    console.warn(`[SECURITY] rejected malformed /analyze body ip=${req.ip}: ${validationErrors.join(" ")}`);
    return res.status(400).json({ error: "Invalid request: " + validationErrors.join(" ") });
  }

  if (!genAI) {
    return res.status(500).json({ error: "Server has no GEMINI_API_KEY configured. Add one to server/.env and restart." });
  }

  try {
    // No generationConfig here previously meant this ran at Gemini's
    // default temperature (~1.0) — enough sampling variance that a
    // free-text number like the bid ceiling could land differently on
    // back-to-back calls with the *identical* input. A wholesale buyer
    // deciding how much to bid needs that number to be reproducible, not
    // a fresh roll each time, so this is pinned low. Some variance in
    // wording (headline, reasoning bullets) is fine and expected; the
    // dollar figures shouldn't be.
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { temperature: 0.15, topP: 0.85, topK: 40 },
    });
    const prompt = buildPrompt({ vin, panels, marketBenchmarks });

    const parts = [{ text: prompt }];

    function pushImage(dataUrl, caption) {
      if (!dataUrl || !dataUrl.startsWith("data:image")) return;
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.*)$/);
      if (!match) return;
      const [, mimeType, base64] = match;
      if (caption) parts.push({ text: caption });
      parts.push({ inlineData: { mimeType, data: base64 } });
    }

    pushImage(screenshot, "Overview screenshot of the buyer's current view on the page:");
    (Array.isArray(photos) ? photos : []).forEach((p) => {
      pushImage(p && p.dataUrl, `Close-up photo evidence for this specific condition-report line: "${(p && p.label) || "flagged item"}"`);
    });

    const result = await model.generateContent(parts);
    const raw = result.response.text();
    const verdict = parseVerdict(raw);

    if (!verdict) {
      console.error("Could not parse Gemini response as JSON:\n", raw);
      return res.status(502).json({ error: "Gemini returned a response that wasn't valid JSON. Check the server logs for the raw output." });
    }

    // Independently check/fill what the model reported rather than passing
    // its raw response straight through — see the "Server-side verdict
    // reconciliation" section above for what these catch and why.
    reconcileBidCeiling(verdict);
    reconcileMarketData(verdict, marketBenchmarks);
    checkHeadlineConsistency(verdict);
    if (verdict.serverCorrections && verdict.serverCorrections.length) {
      console.warn(`[VERDICT_CORRECTED] vin=${vin || "unknown"}: ${verdict.serverCorrections.join(" | ")}`);
    }

    res.json(verdict);
  } catch (err) {
    console.error("[GEMINI_ERROR]", err);
    const friendly = friendlyGeminiError(err);
    res.status(friendly.status).json({ error: friendly.message });
  }
});

// ---------- Feedback (buyer suggestions / corrections) ----------
// A buyer's "Suggest a correction" note on the verdict card lands here and
// gets appended as a row to a Google Sheet, so it's reviewable/filterable
// over time rather than a one-off message someone has to remember. Photo
// upload is deliberately NOT part of v1 — text only, by design (see the
// note above GOOGLE_SHEET_ID). This endpoint gets the same treatment as
// /analyze: rate-limited, validated, and it fails closed with a clear
// error rather than a crash if the Sheet isn't configured yet.

// A service account, not your own Google login, is what writes to the
// sheet — that's what lets this run unattended on a server with no
// browser and no human to click through an OAuth consent screen. Get
// these three values by following the setup steps this response ends
// with; until they're set, /feedback returns a clear "not configured yet"
// error instead of crashing, so shipping this endpoint doesn't block on
// having the Sheet ready first.
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
// Render (like most hosts) can't store a literal multi-line env var
// cleanly, so the private key is pasted with \n escape sequences instead
// of real newlines — this line converts them back before handing the key
// to the JWT signer, which needs the real PEM format to work.
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const FEEDBACK_SHEET_HEADERS = [
  "Timestamp", "VIN", "Vehicle", "Decision", "Bid Ceiling", "Buy Rating", "Buyer Feedback", "Status",
];

// Cached after the first successful load so every submission doesn't
// re-fetch the sheet's metadata — cleared only on a fresh process start,
// which is fine since the sheet's identity/columns don't change at
// runtime. Intentionally NOT cached on failure (wrong credentials, sheet
// not yet shared with the service account) so a fix on Google's side
// takes effect on the very next request rather than needing a restart.
let cachedFeedbackSheet = null;

async function getFeedbackSheet() {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) return null;
  if (cachedFeedbackSheet) return cachedFeedbackSheet;

  const auth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["Feedback"] || doc.sheetsByIndex[0];
  if (!sheet) throw new Error("No sheet/tab found in that spreadsheet.");
  // Set the header row once, the first time this ever runs against a
  // blank sheet — never overwrites headers a human already typed in, so
  // it's safe to leave this in place permanently rather than a one-time
  // setup script.
  //
  // sheet.headerValues is a GETTER that itself THROWS ("Header values are
  // not yet loaded") if read before loadHeaderRow() has ever succeeded —
  // it does not just come back empty/undefined the way a normal property
  // would. loadHeaderRow() already throws on a genuinely blank sheet (no
  // header row at all), which is the exact case this code exists to
  // handle, so both the load AND the very next read of headerValues have
  // to be inside the same try/catch, or a brand-new sheet throws again on
  // the second line and never gets its header row written. Confirmed live
  // 2026-09-15 — this was the actual bug behind every /feedback 502 during
  // setup, not a credentials/sharing problem.
  let existingHeaders = [];
  try {
    await sheet.loadHeaderRow();
    existingHeaders = sheet.headerValues;
  } catch (e) {
    existingHeaders = []; // blank sheet — expected on the very first run
  }
  if (!existingHeaders || !existingHeaders.length) {
    await sheet.setHeaderRow(FEEDBACK_SHEET_HEADERS);
  }
  cachedFeedbackSheet = sheet;
  return cachedFeedbackSheet;
}

// A relatively generous limit compared to /analyze's — this doesn't spend
// your Gemini quota, just a free Sheets API call, so the main thing worth
// guarding against is someone spamming the sheet with junk rows.
const feedbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many feedback submissions from this IP — wait a minute and try again." },
  handler: (req, res, next, options) => {
    console.warn(`[SECURITY] rate limit hit on /feedback ip=${req.ip}`);
    res.status(options.statusCode).json(options.message);
  },
});

const MAX_FEEDBACK_COMMENT_LENGTH = 4000;
const MAX_FEEDBACK_FIELD_LENGTH = 200; // vehicle/decision/bidCeiling/buyRating are short display strings

function validateFeedbackBody(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["Request body must be a JSON object."];
  }
  const { vin, vehicle, decision, bidCeiling, buyRating, comment } = body;

  if (typeof comment !== "string" || !comment.trim()) {
    errors.push("comment is required.");
  } else if (comment.length > MAX_FEEDBACK_COMMENT_LENGTH) {
    errors.push(`comment must be under ${MAX_FEEDBACK_COMMENT_LENGTH} characters.`);
  }

  [["vin", vin, MAX_VIN_LENGTH], ["vehicle", vehicle, MAX_FEEDBACK_FIELD_LENGTH],
   ["decision", decision, MAX_FEEDBACK_FIELD_LENGTH], ["bidCeiling", bidCeiling, MAX_FEEDBACK_FIELD_LENGTH],
   ["buyRating", buyRating, MAX_FEEDBACK_FIELD_LENGTH]].forEach(([name, value, maxLen]) => {
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > maxLen)) {
      errors.push(`${name} must be a short string.`);
    }
  });

  return errors;
}

app.post("/feedback", feedbackLimiter, requireExtensionKey, async (req, res) => {
  const validationErrors = validateFeedbackBody(req.body);
  if (validationErrors.length) {
    console.warn(`[SECURITY] rejected malformed /feedback body ip=${req.ip}: ${validationErrors.join(" ")}`);
    return res.status(400).json({ error: "Invalid request: " + validationErrors.join(" ") });
  }

  try {
    const sheet = await getFeedbackSheet();
    if (!sheet) {
      return res.status(500).json({
        error: "Feedback isn't wired up yet — GOOGLE_SHEET_ID/GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY aren't all set on the server.",
      });
    }
    const { vin, vehicle, decision, bidCeiling, buyRating, comment } = req.body;
    await sheet.addRow({
      "Timestamp": new Date().toISOString(),
      "VIN": vin || "",
      "Vehicle": vehicle || "",
      "Decision": decision || "",
      "Bid Ceiling": bidCeiling || "",
      "Buy Rating": buyRating || "",
      "Buyer Feedback": comment.trim(),
      "Status": "",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[FEEDBACK_ERROR]", err);
    res.status(502).json({ error: "Couldn't reach the feedback sheet. Check GOOGLE_SHEET_ID and that the sheet is shared with the service account." });
  }
});

// ---------- Server-side verdict reconciliation ----------
// Two independent, verifiable fixes added 2026-09-16 after live testing on
// a real vehicle (Hyundai Ioniq, KMHC85LC3HU030909, Manheim Charlotte)
// surfaced both gaps directly: (1) the model can narrate one bid-ceiling
// arithmetic chain in its reasoning bullets and return a DIFFERENT final
// bidCeiling number — confirmed live, a real $365 gap ($1,835 computed vs
// $2,200 returned) on that vehicle. A number that drives a real bid
// shouldn't be trusted just because the model sounds confident stating it.
// (2) the model reliably USES the extracted marketBenchmarks data
// (transport cost, MMR Adjusted, etc.) in its prose, but doesn't reliably
// ECHO it into the transportCost/marketComparison structured fields the
// card actually renders — confirmed live via direct DOM query showing
// both empty despite the concept appearing in the headline/keyFindings.
// Both fixes work from data already on hand for this same request
// (bidCeilingInputs the model now reports per-component, and the raw
// marketBenchmarks already sent to Gemini) rather than just asking the
// model to try harder at echoing itself correctly.

const BID_CEILING_TOLERANCE = 50; // dollars — leaves room for the model's own $100 rounding step

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function computeExpectedBidCeiling(inputs) {
  if (!inputs || typeof inputs !== "object") return null;
  const benchmarkValue = toNumber(inputs.benchmarkValue);
  const reconCostMidpoint = toNumber(inputs.reconCostMidpoint);
  const targetMargin = toNumber(inputs.targetMargin);
  const transportCost = toNumber(inputs.transportCost) || 0;
  if (benchmarkValue == null || reconCostMidpoint == null || targetMargin == null) return null;
  const raw = benchmarkValue - reconCostMidpoint - transportCost - targetMargin;
  return Math.round(raw / 100) * 100;
}

// Recomputes bidCeiling from the model's own reported bidCeilingInputs and
// overrides it — rather than trusting the model's self-reported final
// number — whenever the two disagree by more than rounding. The original
// model figure is preserved in bidCeilingModelStated so nothing is hidden,
// just corrected. Silently does nothing when bidCeilingInputs wasn't
// returned in a usable shape (e.g. an older model response, or a BUY/PASS
// with no ceiling) rather than guessing.
function reconcileBidCeiling(verdict) {
  const stated = toNumber(verdict.bidCeiling);
  const expected = computeExpectedBidCeiling(verdict.bidCeilingInputs);
  if (stated == null || expected == null) return verdict;
  if (Math.abs(stated - expected) > BID_CEILING_TOLERANCE) {
    const modelStated = verdict.bidCeiling;
    verdict.bidCeilingModelStated = modelStated;
    verdict.bidCeiling = `$${expected.toLocaleString()}`;
    verdict.serverCorrections = (verdict.serverCorrections || []).concat([
      `bidCeiling recomputed server-side: the model stated ${modelStated}, but its own reported inputs (benchmark $${toNumber(
        verdict.bidCeilingInputs.benchmarkValue
      )} minus recon $${toNumber(verdict.bidCeilingInputs.reconCostMidpoint)}, transport $${toNumber(
        verdict.bidCeilingInputs.transportCost
      ) || 0}, margin $${toNumber(verdict.bidCeilingInputs.targetMargin)}) compute to $${expected.toLocaleString()}. Using the computed figure.`,
    ]);
  }
  return verdict;
}

// Fills transportCost / marketComparison from the SAME marketBenchmarks
// data this request already sent to Gemini, whenever the model's own
// response left them empty. Never overrides a value the model DID
// provide — this only fills gaps, it doesn't second-guess populated data.
function reconcileMarketData(verdict, marketBenchmarks) {
  const benchmarks = marketBenchmarks && typeof marketBenchmarks === "object" ? marketBenchmarks : {};

  const rawTransport = benchmarks["Ready Logistics Transport Cost"];
  if (rawTransport && !verdict.transportCost) {
    verdict.transportCost = rawTransport;
    verdict.serverCorrections = (verdict.serverCorrections || []).concat([
      "transportCost was empty in the model's response; filled in server-side from the extracted Ready Logistics Transport Cost benchmark.",
    ]);
  }

  const existing = Array.isArray(verdict.marketComparison) ? verdict.marketComparison : [];
  const existingLabels = new Set(existing.map((e) => e && e.label));
  const bidCeilingNum = toNumber(verdict.bidCeiling);
  const additions = [];
  for (const [label, value] of Object.entries(benchmarks)) {
    if (!value || existingLabels.has(label)) continue;
    const valueNum = toNumber(value);
    let note = "Extracted from the Glance panel.";
    if (bidCeilingNum != null && valueNum) {
      const pct = Math.round(((bidCeilingNum - valueNum) / valueNum) * 100);
      note = `Your bid ceiling is ${Math.abs(pct)}% ${pct >= 0 ? "above" : "below"} this benchmark.`;
    }
    additions.push({ label, value, note });
  }
  if (additions.length) {
    verdict.marketComparison = existing.concat(additions);
    verdict.serverCorrections = (verdict.serverCorrections || []).concat([
      `marketComparison was missing ${additions.length} extracted benchmark(s) (${additions
        .map((a) => a.label)
        .join(", ")}); filled in server-side.`,
    ]);
  }

  return verdict;
}

// Defense-in-depth for the same failure mode reconcileBidCeiling fixes,
// but in prose rather than a structured field. CONFIRMED LIVE 2026-09-16:
// across two runs on the same real vehicle, the headline sentence stated
// a dollar figure ("$3,235", then "$2,200") that matched neither the
// decision badge nor any other known input for that run (transport cost,
// benchmark value, recon midpoint, margin) — an unexplained number the
// buyer would read as the bid ceiling, sitting right next to the actual
// one. promptBuilder.js's step 8 now explicitly forbids the model from
// restating a bid-ceiling figure in headline at all, but prose
// instructions aren't reliably followed — that's the entire reason
// bidCeilingInputs exists for the structured field — so this checks
// rather than trusts. It only WARNS: rewriting a sentence via regex risks
// producing broken grammar, so the fix here is visibility for the buyer
// (via the same serverCorrections note already rendered on the card),
// not silent surgery on the model's prose.
function checkHeadlineConsistency(verdict) {
  if (!verdict.headline || typeof verdict.headline !== "string") return verdict;
  const bidCeilingNum = toNumber(verdict.bidCeiling);
  if (bidCeilingNum == null) return verdict; // no ceiling was computed, nothing to check headline against

  const knownFigures = [bidCeilingNum];
  const inputs = verdict.bidCeilingInputs || {};
  [inputs.benchmarkValue, inputs.reconCostMidpoint, inputs.transportCost, inputs.targetMargin, toNumber(verdict.transportCost)].forEach(
    (v) => {
      const n = toNumber(v);
      if (n != null) knownFigures.push(n);
    }
  );

  const dollarMatches = verdict.headline.match(/\$[\d][\d,]*/g) || [];
  const unexplained = dollarMatches
    .map((m) => toNumber(m))
    .filter((n) => n != null && !knownFigures.some((k) => Math.abs(k - n) <= BID_CEILING_TOLERANCE));

  if (unexplained.length) {
    verdict.serverCorrections = (verdict.serverCorrections || []).concat([
      `headline mentions $${unexplained[0].toLocaleString()}, which doesn't match the verified bidCeiling ($${bidCeilingNum.toLocaleString()}) or any other known figure for this vehicle — treat the badge above as authoritative, not the headline text.`,
    ]);
  }
  return verdict;
}

// Gemini's raw error for a quota problem is a wall of JSON — fine in the
// server log, useless surfaced verbatim in the extension's small overlay
// card mid-test. This turns the two cases that actually matter to
// someone clicking "Analyze this car" into one clear sentence each: a
// genuine per-minute rate limit (worth an immediate retry) vs. the
// free-tier's per-DAY cap being fully used up (retrying won't help —
// this needs a wait, a different model, or billing).
function friendlyGeminiError(err) {
  const status = err && err.status;
  if (status !== 429) {
    return { status: 500, message: (err && err.message) || "Unknown error calling Gemini." };
  }
  const detailsText = JSON.stringify((err && err.errorDetails) || "");
  const isDailyQuota = /PerDay/i.test(detailsText);
  if (isDailyQuota) {
    return {
      status: 429,
      message:
        `Gemini's free-tier daily request limit for model "${MODEL_NAME}" is used up for today ` +
        `(the free tier caps this at a small number of requests per day, separate per model). ` +
        `It resets at midnight Pacific time. To keep testing sooner: set GEMINI_MODEL in server/.env ` +
        `to a different model (each has its own separate free-tier quota) and restart the server, ` +
        `or enable billing on the project in Google AI Studio for a much higher limit.`,
    };
  }
  return {
    status: 429,
    message: "Gemini is rate-limiting requests right now — wait a few seconds and click Analyze again.",
  };
}

function parseVerdict(raw) {
  // Strip markdown code fences if the model added them despite instructions.
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`Auction Copilot backend listening on http://localhost:${PORT}`);
  console.log(`Using model: ${MODEL_NAME}`);
  console.log(`Extension shared-key check: ${EXTENSION_SHARED_SECRET ? "ENABLED" : "disabled (set EXTENSION_SHARED_SECRET to enable)"}`);
});