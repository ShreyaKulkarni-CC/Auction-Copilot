# Auction Copilot

A Chrome extension and a small Node/Express backend that read a vehicle
listing on vAuto/Manheim — Condition Report, Glance, CARFAX, AutoCheck,
and the page's own quick-check icons — and use Gemini to produce one
decisive verdict for a wholesale auction buyer before they bid: BUY,
PASS, or a specific BID CEILING, with a five-tier buy rating and the
reasoning behind it. It runs in shadow mode — it only reads the page and
shows a verdict; it never places a bid or touches vAuto's own controls.

A "Suggest a correction" button on the verdict card lets a buyer send
free-text feedback, which is logged to a Google Sheet for review.

## What's working now

Click "Analyze this car" on a vAuto/Manheim vehicle page and the
extension pulls the Condition Report, Glance, and CARFAX panel text, an
overview screenshot, and any flagged close-up defect photos, sends them
to the backend, and renders the verdict as an overlay card directly on
the page.

On top of that core loop, the following are built and have been
confirmed against real listings:

- **AutoCheck reconciliation.** AutoCheck's Score/Owners/Accidents/
  Titles-Probs/ODO summary is read as its own fourth source and
  cross-checked against CARFAX and the Condition Report, kept separate
  from the itemized condition list so it's never mistaken for a
  Condition Report line.
- **Quick-check icon reads.** The page's own small pass/fail icons
  (Start, Interior Odor, Drivable, No Structural Damage) are read by
  color the same way per-item defect severity already is.
- **Transport cost folded into the bid ceiling.** The Ready Logistics
  transport figure is subtracted as its own step in the bid-ceiling
  formula and shown on the card; the server fills this in from the
  extracted data directly if the model's response leaves it out.
- **Market comparison**, kept structurally separate from the
  per-vehicle fact-check, showing how the bid ceiling compares to MMR
  Adjusted, rBook, and the other Glance benchmark tiles.
- **Out-of-scope hint** on a vAuto page that looks like a single
  vehicle but has no Condition Report/Glance to analyze, instead of
  silently showing no button.
- **Server-side bid-ceiling verification.** The model reports the
  individual numbers behind its formula, and the backend independently
  recomputes the bid ceiling from them and corrects it if it doesn't
  reconcile, rather than trusting a self-reported final figure — caught
  and corrected a real live mismatch during testing ($3,200 stated vs.
  $2,000 the model's own numbers actually computed to).
- **Headline/badge consistency check.** The backend flags — rather than
  silently trusts — a case where the card's headline sentence states a
  different dollar figure than the verified bid ceiling badge above it;
  the prompt also now forbids the model from stating one there at all.
- **Market-comparison notes stay in sync with a corrected bid ceiling.**
  If the bid ceiling above had to be corrected, any market-comparison
  note the model already wrote — e.g. "your bid ceiling of $3,200 is
  38% below MMR Adjusted" — was comparing against its own stale figure,
  so those notes are rebuilt server-side against the corrected number
  rather than left contradicting the badge.

Known, deliberate limitations at this stage: it only covers Manheim
listings reached through vAuto, with one manual trigger per vehicle; the
overview screenshot only captures whatever's visible on screen at the
moment of the click, not the whole page or every tab; recon-cost
estimates are marked illustrative until real dealership cost history is
loaded in; and it's shadow mode only, meant to sit alongside a buyer's
own judgment, not replace it.

## Future scope

- **Stop depending on which tab happens to be open.** Have the
  extension visit and expand every known section (Condition Details,
  AutoCheck, Quick Check) itself before analyzing, instead of only
  seeing whatever the buyer happened to have open when they clicked.
- **Title-status extraction**, reconciled against accident history so a
  reported accident alongside an unclear title status gets flagged.
- **Comp-count / confidence signal** for market benchmarks — a
  benchmark backed by few or zero comps should be treated as less
  certain than one with many.
- **A bounded follow-up question** under the verdict card — a buyer can
  ask something like "check the title status," answered from a small,
  fixed set of things the extension is allowed to go re-check, never
  anything transactional on the page.
- **"What would you do?"** — capture the buyer's own decision and bid
  ceiling on every vehicle, not just when something's wrong, to build a
  real log of AI-vs-buyer judgment over time.
- **Retrieval against that log** — once there's a few weeks of real
  buyer decisions logged, pull the most similar past vehicles into the
  prompt so the model calibrates to this dealership's actual risk
  tolerance rather than a generic target margin.
- **Broader platform coverage** — ADESA and EDGE Pipeline, pending
  access to those platforms.
- **Reasoning-engine comparison** — evaluating Claude or OpenAI models
  against Gemini on the same listings for reasoning quality and
  consistency.