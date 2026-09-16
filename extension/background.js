/**
 * Auction Copilot — background service worker
 *
 * Content scripts can't capture a screenshot of their own tab, so the
 * content script asks the background script to do it. The background
 * script is also the one that calls the local backend (keeps the fetch
 * off the page, avoiding any site CSP the vAuto page itself might set),
 * and the one that fetches flagged condition-report photos directly —
 * a background/service-worker context gets the extension's host
 * permissions on cross-origin requests, which a content-script fetch
 * would not, so doing it here avoids likely CORS failures against an
 * auction site's image CDN.
 *
 * CONDITION DETAILS RELAY — the Manheim Condition Details table renders
 * inside a cross-origin <iframe> the vAuto page embeds (router.manheim.com),
 * a separate document that the top-frame content script can never read
 * directly — browsers block that outright, regardless of extraction
 * strategy (confirmed by directly inspecting the live page; see the long
 * note at the top of content.js). The extension now also injects
 * content.js into *.manheim.com frames, and that copy relays whatever it
 * extracts here via CONDITION_DETAILS_UPDATE the moment the table is on
 * screen. This script just caches the latest one per tab so the top
 * frame's click handler (GET_CONDITION_DETAILS) has something to read —
 * it's a mailbox between two documents that can't otherwise talk.
 *
 * BACKEND_URL lives here, not in content.js, and the ANALYZE_REQUEST
 * handler below ignores any backendUrl a message might carry — this is
 * the one place in the extension that's allowed to decide where analysis
 * requests go. Small thing, but it means a compromised/mis-injected
 * content script can't redirect page data (VIN, condition-report text,
 * screenshots) to an attacker-controlled endpoint just by putting a
 * different URL in its message.
 *
 * TODO once you have a real hosted URL (see server/render.yaml): change
 * this from localhost to the public https:// URL Render gives you, e.g.
 * "https://auction-copilot-backend.onrender.com/analyze".
 */
const BACKEND_URL = "http://localhost:8787/analyze";
// Derived, not a second hardcoded constant to keep in sync — whenever
// BACKEND_URL above gets updated to the real hosted URL, this follows
// automatically.
const FEEDBACK_URL = BACKEND_URL.replace(/\/analyze$/, "/feedback");

// Optional shared secret sent as an "X-Extension-Key" header on every
// /analyze call. Leave this empty while the backend is only reachable at
// localhost — there's nothing to protect yet. Once the backend is public,
// set this to match the server's own EXTENSION_SHARED_SECRET env var (see
// server/server.js) and rebuild/redistribute the extension.
//
// Be clear-eyed about what this does and doesn't buy you: anyone who
// unzips this extension (trivial — "Load unpacked" ships as plain,
// unobfuscated files) can read this constant straight out of the source.
// It is NOT a login system and does not identify which buyer is calling.
// What it does do: stop the wide-open public URL from being usable by
// search engines, scanners, or a stranger who stumbles on it with curl,
// without first at least fetching or disassembling your extension. Real
// per-buyer accountability would need actual per-user auth (e.g. each
// buyer signs in, gets their own token) — worth doing if this grows past
// a small trusted pilot group.
const EXTENSION_SHARED_SECRET = "";

// tabId -> { text, photos, updatedAt }
const conditionDetailsByTab = new Map();

// Stale data is worse than no data — if the table hasn't been re-extracted
// in a while, something's probably wrong (the user navigated to a
// different vehicle and this frame hasn't updated yet), so don't hand it
// out as if it were still current.
const CONDITION_DETAILS_MAX_AGE_MS = 20 * 60 * 1000;

// A fresh top-level navigation means a different vehicle is likely about
// to load — drop whatever was cached for this tab so a stale Condition
// Report can't get attached to the wrong VIN if the iframe is slow to
// re-extract.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    conditionDetailsByTab.delete(tabId);
  }
});

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // avoid blowing the call stack on large images
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(binary);
}

async function fetchPhotoAsDataUrl(src) {
  if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size === 0) return null;
    return await blobToBase64(blob);
  } catch (e) {
    // A single failed photo (CORS, 404, timeout) shouldn't fail the
    // whole analysis — it's just dropped.
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relayed from the content-script copy running inside the Manheim
  // iframe — cache it against this tab so the top frame can ask for it
  // later. No response expected.
  if (message.type === "CONDITION_DETAILS_UPDATE") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      conditionDetailsByTab.set(tabId, {
        text: message.text || null,
        photos: Array.isArray(message.photos) ? message.photos : [],
        updatedAt: Date.now(),
      });
    }
    return false;
  }

  // Asked by the top-frame content script right before it builds the
  // ANALYZE_REQUEST — hand back whatever the iframe has most recently
  // relayed for this tab, or null if there's nothing usable.
  if (message.type === "GET_CONDITION_DETAILS") {
    const tabId = sender.tab && sender.tab.id;
    const entry = tabId != null ? conditionDetailsByTab.get(tabId) : null;
    const isFresh = entry && Date.now() - entry.updatedAt < CONDITION_DETAILS_MAX_AGE_MS;
    sendResponse(isFresh ? entry : null);
    return false;
  }

  // Sent by the top frame right before every Analyze click (see
  // requestFreshExtraction() in content.js) — forwarded to every frame in
  // this tab, including the Manheim iframe, so its copy of content.js
  // re-extracts and re-relays immediately instead of the top frame trusting
  // whatever was last cached. Omitting frameId here sends to every frame
  // in the tab, which is exactly what's wanted — the top frame's own copy
  // of content.js just ignores a message type it doesn't handle.
  if (message.type === "REQUEST_FRESH_EXTRACT") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "FORCE_REEXTRACT" }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  // "Suggest a correction" on the verdict card — a much smaller,
  // synchronous-ish request than ANALYZE_REQUEST (no screenshot, no photo
  // fetching), so it doesn't need its own captureVisibleTab/tabId dance.
  if (message.type === "SUBMIT_FEEDBACK") {
    fetch(FEEDBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EXTENSION_SHARED_SECRET ? { "X-Extension-Key": EXTENSION_SHARED_SECRET } : {}),
      },
      body: JSON.stringify({
        vin: message.vin,
        vehicle: message.vehicle,
        decision: message.decision,
        bidCeiling: message.bidCeiling,
        buyRating: message.buyRating,
        comment: message.comment,
      }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error((body && body.error) || "Backend returned " + r.status);
        return body;
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (message.type !== "ANALYZE_REQUEST") return false;

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "No active tab to screenshot." });
    return false;
  }

  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 70 }, async (screenshotDataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: "Screenshot failed: " + chrome.runtime.lastError.message });
      return;
    }

    const candidates = Array.isArray(message.photos) ? message.photos : [];
    const resolvedPhotos = (
      await Promise.all(
        candidates.map(async (c) => ({
          label: c && c.label,
          dataUrl: await fetchPhotoAsDataUrl(c && c.src),
        }))
      )
    ).filter((p) => p.dataUrl);

    fetch(BACKEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EXTENSION_SHARED_SECRET ? { "X-Extension-Key": EXTENSION_SHARED_SECRET } : {}),
      },
      body: JSON.stringify({
        vin: message.vin,
        panels: message.panels,
        screenshot: screenshotDataUrl,
        photos: resolvedPhotos,
        marketBenchmarks: message.marketBenchmarks || {},
      }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error((body && body.error) || "Backend returned " + r.status);
        return body;
      })
      .then((verdict) => sendResponse({ ok: true, verdict }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
  });

  // Keep the message channel open for the async response above.
  return true;
});