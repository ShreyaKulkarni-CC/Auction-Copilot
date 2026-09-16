const fs = require("fs");
const path = require("path");

const BENCHMARKS_PATH = path.join(__dirname, "cost-benchmarks.json");

/**
 * Loads Bridgeland's own recon-cost history (see cost-benchmarks.json,
 * which should be kept in sync with the Category Benchmarks tab of
 * recon_cost_log.xlsx) and renders it as a text block for the prompt.
 *
 * When a category has no real data yet, we say so explicitly rather than
 * silently falling back — the model is instructed to label any estimate
 * built without real backing data as illustrative, not computed.
 */
function loadBenchmarksSummary() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(BENCHMARKS_PATH, "utf8"));
  } catch (err) {
    return "No recon-cost benchmark file could be loaded. Treat every cost estimate as illustrative and say so.";
  }

  const lines = Object.entries(data.categories || {}).map(([category, stats]) => {
    if (!stats || !stats.count) {
      return `- ${category}: no real data logged yet.`;
    }
    return `- ${category}: ${stats.count} logged case(s), actual cost range $${stats.minCost}–$${stats.maxCost}, average $${stats.avgCost}.`;
  });

  return lines.join("\n");
}

module.exports = { loadBenchmarksSummary };
