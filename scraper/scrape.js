const fs = require("fs");
const path = require("path");
const { analyze } = require("./analyze");

const FLIGHTS_PATH = path.join(__dirname, "flights.json");
const DATA_PATH = path.join(__dirname, "..", "data", "prices.json");
const DATA_DIR = path.join(__dirname, "..", "data");
const DEBUG_DIR = path.join(__dirname, "..", "debug");
const HEURISTIC_LOG_PATH = path.join(DEBUG_DIR, "heuristic-log.jsonl");
const HEURISTIC_STATE_PATH = path.join(DATA_DIR, "heuristic-state.json");
const WINDOW_CACHE_PATH = path.join(DATA_DIR, "window-cache.json");
const ANALYSIS_PATH = path.join(DATA_DIR, "analysis.json");

function buildUrl(from, to, date) {
  return `https://www.wizzair.com/en-gb/booking/select-flight/${from}/${to}/${date}/null/1/0/0/null`;
}

function flightId(f) {
  return `${f.from}-${f.to}-${f.date}`.toLowerCase();
}

function flightLabel(f) {
  return `${f.from} → ${f.to} · ${f.date} · ${f.time}`;
}

function calculateRealPrice(chartPrice) {
  const withMarkup = chartPrice + 50;
  return Math.ceil((withMarkup - 9) / 10) * 10 + 9;
}

function getApiUrl() {
  const version = fs.readFileSync(path.join(__dirname, "api-version.txt"), "utf-8").trim();
  const apiUrl = `https://be.wizzair.com/${version}`;
  console.log(`  API: ${apiUrl}`);
  return apiUrl;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

// Single farechart API call centered at `centerDate`. With dayInterval=10,
// the response covers [centerDate-10, centerDate+10] (21 days).
async function fetchFareChartBlock(apiUrl, flight, centerDate, debugSuffix) {
  const id = flightId(flight);
  const url = `${apiUrl}/Api/asset/farechart`;
  const body = {
    isRescueFare: false,
    adultCount: 1,
    childCount: 0,
    dayInterval: 10,
    wdc: false,
    isFlightChange: false,
    flightList: [
      {
        departureStation: flight.from,
        arrivalStation: flight.to,
        date: `${centerDate}T00:00:00`,
      },
    ],
  };

  console.log(`  POST ${url} (center=${centerDate}${debugSuffix || ""})`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-GB,en;q=0.9",
      Origin: "https://www.wizzair.com",
      Referer: "https://www.wizzair.com/",
    },
    body: JSON.stringify(body),
  });

  console.log(`    Response: ${res.status} ${res.statusText}`);

  const resText = await res.text();
  const debugName = `farechart-${id}${debugSuffix}-${res.status}.json`;
  fs.writeFileSync(path.join(DEBUG_DIR, debugName), resText);

  if (!res.ok) {
    console.error(`    Error body: ${resText.substring(0, 300)}`);
    return { ok: false, flights: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(resText);
  } catch (err) {
    console.error(`    Failed to parse response: ${err.message}`);
    return { ok: false, flights: [] };
  }
  const flights = parsed.outboundFlights || [];
  console.log(`    Got ${flights.length} entries`);
  return { ok: true, flights };
}

// Extract the matched price for the flight's target date from a list of entries.
function extractTargetMatch(flight, entries) {
  for (const entry of entries) {
    const entryDate = (entry.date || "").substring(0, 10);
    if (
      entryDate === flight.date &&
      entry.priceType === "price" &&
      entry.price?.amount > 0
    ) {
      const chartPrice = entry.price.amount;
      const price = calculateRealPrice(chartPrice);
      const currency = entry.price.currencyCode;
      console.log(
        `  >>> FOUND: chart=${chartPrice}, real=${price} ${currency} (date ${entryDate})`
      );
      return { price, currency, raw: `${price} ${currency}` };
    }
  }
  return { price: null, currency: null, raw: null };
}

// Fetch a ~61-day window covering [target-30, target+30] via 3 API calls
// with dayInterval=10 centered at target-20, target, target+20.
// The primary (center=target) call is authoritative for the target-date price;
// before/after calls are best-effort and only extend the analysis window.
async function fetchFareChart(apiUrl, flight) {
  const id = flightId(flight);
  const label = flightLabel(flight);

  console.log(`\n========================================`);
  console.log(`Fetching: ${label}`);
  console.log(`  ID: ${id}`);
  console.log(`========================================`);

  const targetDate = flight.date;
  const beforeCenter = addDays(targetDate, -20);
  const afterCenter = addDays(targetDate, 20);

  // Primary call — required for the target-date price.
  const primary = await fetchFareChartBlock(apiUrl, flight, targetDate, "");

  // Extended calls — best effort.
  let beforeEntries = [];
  let afterEntries = [];
  try {
    const before = await fetchFareChartBlock(
      apiUrl,
      flight,
      beforeCenter,
      "-before"
    );
    beforeEntries = before.flights;
  } catch (err) {
    console.warn(`  Before-window fetch threw: ${err.message}`);
  }
  try {
    const after = await fetchFareChartBlock(
      apiUrl,
      flight,
      afterCenter,
      "-after"
    );
    afterEntries = after.flights;
  } catch (err) {
    console.warn(`  After-window fetch threw: ${err.message}`);
  }

  // Merge by date (dedupe; primary wins on overlapping seams), then sort.
  const seen = new Map();
  for (const entry of [...beforeEntries, ...primary.flights, ...afterEntries]) {
    const d = (entry.date || "").substring(0, 10);
    if (!d) continue;
    if (!seen.has(d)) seen.set(d, entry);
  }
  const merged = Array.from(seen.values()).sort((a, b) =>
    (a.date || "").localeCompare(b.date || "")
  );

  console.log(
    `  Merged window: ${merged.length} unique dates (primary=${primary.flights.length}, before=${beforeEntries.length}, after=${afterEntries.length})`
  );

  const match = extractTargetMatch(flight, primary.flights);
  if (match.price === null) {
    console.log(`  No price match for ${flight.date}`);
  }

  return { ...match, windowEntries: merged };
}

async function createScrapeFailureIssue(flight) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("  Skipping failure issue (no token/repo)");
    return;
  }

  const id = flightId(flight);
  const label = flightLabel(flight);
  const url = buildUrl(flight.from, flight.to, flight.date);
  const title = `Scrape failed: ${label}`;
  const body = [
    `## Scrape Failure`,
    ``,
    `Flight **${label}** failed to return a price.`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| Flight ID | \`${id}\` |`,
    `| Timestamp | ${new Date().toISOString()} |`,
    ``,
    `**[Check on Wizzair](${url})**`,
  ].join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ title, body, labels: ["scrape-failure"] }),
    });
    if (res.ok) {
      const issue = await res.json();
      console.log(`  Failure issue created: #${issue.number}`);
    } else {
      const text = await res.text();
      console.error(
        `  Failed to create failure issue: ${res.status} ${text}`
      );
    }
  } catch (err) {
    console.error(`  Error creating failure issue: ${err.message}`);
  }
}

async function createGitHubIssue(flight, newPrice, currency, previousLow, chartUrl) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("  Skipping GitHub Issue (no token/repo)");
    return;
  }

  const label = flightLabel(flight);
  const url = buildUrl(flight.from, flight.to, flight.date);
  const drop = previousLow
    ? (((previousLow - newPrice) / previousLow) * 100).toFixed(1)
    : null;

  const title = `New low: ${newPrice} ${currency} — ${label}`;
  const body = [
    `## New Price Low: ${label}`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| **New Price** | **${newPrice} ${currency}** |`,
    previousLow ? `| Previous Low | ${previousLow} ${currency} |` : null,
    drop ? `| Drop | ${drop}% |` : null,
    `| Timestamp | ${new Date().toISOString()} |`,
    ``,
    `**[Check on Wizzair](${url})**`,
    ``,
    `[View Price Chart](${chartUrl})`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ title, body, labels: ["price-alert"] }),
    });
    if (res.ok) {
      const issue = await res.json();
      console.log(`  GitHub Issue created: #${issue.number}`);
    } else {
      const text = await res.text();
      console.error(`  Failed to create issue: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`  Error creating issue: ${err.message}`);
  }
}

async function createBuyRecommendationIssue(flight, price, currency, analysis, chartUrl) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("  Skipping buy-recommendation issue (no token/repo)");
    return;
  }

  const label = flightLabel(flight);
  const url = buildUrl(flight.from, flight.to, flight.date);

  const signalRows = Object.entries(analysis.signals)
    .map(([key, s]) =>
      `| ${key} | ${s.active ? `${s.value} / ${s.max}` : "—"} |`
    )
    .join("\n");

  const reasonsBlock =
    analysis.reasons.length > 0
      ? analysis.reasons.map((r) => `- ${r}`).join("\n")
      : "_(no notable signals)_";

  const title = `Buy recommendation: ${price} ${currency} — ${label}`;
  const bodyLines = [
    `## Heuristic says: **${analysis.tier}**`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Price** | **${price} ${currency}** |`,
    `| Quality | ${analysis.quality} / 100 |`,
    `| Confidence | ${analysis.confidence} |`,
    `| Days to departure | ${analysis.daysToDeparture} |`,
    analysis.sevenDayChangePct !== null
      ? `| 7-day change | ${analysis.sevenDayChangePct}% |`
      : null,
    `| Timestamp | ${new Date().toISOString()} |`,
    ``,
    `### Why`,
    reasonsBlock,
    ``,
    `### Signal breakdown`,
    `| Signal | Score |`,
    `|--------|-------|`,
    signalRows,
  ];

  if (analysis.siblingSuggestion) {
    bodyLines.push(
      ``,
      `### Cheaper nearby date`,
      `${analysis.siblingSuggestion.date} is **${analysis.siblingSuggestion.price} ${currency}** — ${analysis.siblingSuggestion.savingsPct}% cheaper than ${flight.date}.`
    );
  }

  if (analysis.bucketCeilingWarning) {
    bodyLines.push(
      ``,
      `### Bucket ceiling warning`,
      `Current price is near the top of its detected fare bucket. If this bucket sells out, expect a jump to the next level.`
    );
  }

  if (analysis.buckets && analysis.buckets.length > 0) {
    bodyLines.push(
      ``,
      `### Detected fare buckets (from current window)`,
      analysis.buckets
        .map(
          (b, i) =>
            `${i + 1}. ${b.min}${b.min !== b.max ? `–${b.max}` : ""} ${currency} (${b.count} obs)${i === analysis.currentBucketIndex ? " ← current" : ""}`
        )
        .join("\n")
    );
  }

  bodyLines.push(
    ``,
    `**[Check on Wizzair](${url})** · [Price chart](${chartUrl})`
  );

  const body = bodyLines.filter(Boolean).join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        title,
        body,
        labels: ["buy-recommendation"],
      }),
    });
    if (res.ok) {
      const issue = await res.json();
      console.log(`  Buy recommendation issue created: #${issue.number}`);
    } else {
      const text = await res.text();
      console.error(
        `  Failed to create buy recommendation issue: ${res.status} ${text}`
      );
    }
  } catch (err) {
    console.error(`  Error creating buy recommendation issue: ${err.message}`);
  }
}

function appendHeuristicLog(flight, price, currency, analysis) {
  const entry = {
    timestamp: new Date().toISOString(),
    flightId: flightId(flight),
    flightDate: flight.date,
    price,
    currency,
    tier: analysis.tier,
    quality: analysis.quality,
    urgency: analysis.urgency,
    urgencyScore: analysis.urgencyScore,
    confidence: analysis.confidence,
    daysToDeparture: analysis.daysToDeparture,
    sevenDayChangePct: analysis.sevenDayChangePct,
    dtdFloor: analysis.dtdFloor,
    absoluteMin: analysis.absoluteMin,
    currentBucketIndex: analysis.currentBucketIndex,
    numBuckets: analysis.buckets ? analysis.buckets.length : 0,
    signals: analysis.signals,
    siblingSuggestion: analysis.siblingSuggestion,
    bucketCeilingWarning: analysis.bucketCeilingWarning,
    reasons: analysis.reasons,
  };
  fs.appendFileSync(HEURISTIC_LOG_PATH, JSON.stringify(entry) + "\n");
}

function loadHeuristicState() {
  try {
    const raw = fs.readFileSync(HEURISTIC_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveHeuristicState(state) {
  fs.writeFileSync(HEURISTIC_STATE_PATH, JSON.stringify(state, null, 2));
}

function loadWindowCache() {
  try {
    const raw = fs.readFileSync(WINDOW_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveWindowCache(cache) {
  fs.writeFileSync(WINDOW_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Append new farechart entries to the cache for a flight, tagging each with
// today's date so we know when it was observed.
function mergeWindowEntries(existing, newEntries, observedAt) {
  const toAdd = newEntries
    .filter((e) => e && e.priceType === "price" && e.price?.amount > 0)
    .map((e) => ({ ...e, observedAt }));
  return [...existing, ...toAdd];
}

// For each calendar date, return only the most recently observed entry.
// This is what gets passed to analyze() so sibling and bucket signals
// reflect the latest known prices, not stale historical observations.
function latestWindowEntries(entries) {
  const latest = new Map();
  for (const e of entries) {
    const d = (e.date || "").substring(0, 10);
    if (!d) continue;
    if (!latest.has(d) || (e.observedAt || "") > (latest.get(d).observedAt || "")) {
      latest.set(d, e);
    }
  }
  return Array.from(latest.values());
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Flight Tracker - Wizzair Farechart API`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`${"=".repeat(50)}\n`);

  const flights = JSON.parse(fs.readFileSync(FLIGHTS_PATH, "utf-8"));
  console.log(`Loaded ${flights.length} flight(s) from flights.json`);
  for (const f of flights) {
    console.log(`  - ${flightLabel(f)} [${flightId(f)}]`);
  }

  for (const dir of [DATA_DIR, DEBUG_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Clear old debug files — but preserve the heuristic log, which is
  // append-only across runs.
  for (const f of fs.readdirSync(DEBUG_DIR)) {
    if (f.startsWith("farechart-")) {
      fs.unlinkSync(path.join(DEBUG_DIR, f));
    }
  }
  console.log(`Cleared farechart-* files from debug/`);

  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (typeof data !== "object" || data === null) data = {};
  } catch {
    data = {};
  }
  console.log(`Existing price data: ${Object.keys(data).length} flight(s) tracked`);

  // Remove orphaned flights no longer in flights.json
  const activeIds = new Set(flights.map(flightId));
  for (const key of Object.keys(data)) {
    if (!activeIds.has(key)) {
      console.log(`  Cleaning up orphaned key: ${key} (${data[key].length} price entries)`);
      delete data[key];
    }
  }

  const apiUrl = getApiUrl();

  const results = [];
  for (const flight of flights) {
    const result = await fetchFareChart(apiUrl, flight);
    if (result.price === null) {
      console.log(`  No price for ${flightId(flight)} — skipping`);
    }
    results.push({ flight, result });
  }

  const repo = process.env.GITHUB_REPOSITORY || "";
  const owner = repo.split("/")[0] || "OWNER";
  const repoName = repo.split("/")[1] || "flight-tracker";
  const chartUrl = `https://${owner}.github.io/${repoName}/`;

  const heuristicState = loadHeuristicState();
  const windowCache = loadWindowCache();
  const analysisResults = {}; // id → analysis (collected for analysis.json)

  results.sort((a, b) => a.flight.date.localeCompare(b.flight.date));

  console.log(`\n--- Results ---`);
  for (const { flight, result } of results) {
    const id = flightId(flight);
    console.log(
      `  ${id}: ${result.price !== null ? `${result.price} ${result.currency}` : "FAILED"}`
    );

    if (!data[id]) data[id] = [];

    const entry = {
      timestamp: new Date().toISOString(),
      price: result.price,
      currency: result.currency,
      raw: result.raw,
    };
    const previousEntries = data[id].slice();
    data[id].push(entry);

    if (result.price !== null) {
      const previousPrices = previousEntries
        .filter((e) => e.price !== null)
        .map((e) => e.price);

      if (
        previousPrices.length === 0 ||
        result.price < Math.min(...previousPrices)
      ) {
        const previousLow =
          previousPrices.length > 0 ? Math.min(...previousPrices) : null;
        console.log(
          `  NEW LOW for ${id}: ${result.price} ${result.currency}` +
            (previousLow ? ` (was ${previousLow})` : " (first reading)")
        );
        await createGitHubIssue(
          flight,
          result.price,
          result.currency,
          previousLow,
          chartUrl
        );
      }

      // ---- Accumulate window entries into cache ----
      if (result.windowEntries && result.windowEntries.length > 0) {
        const observedAt = new Date().toISOString().substring(0, 10);
        windowCache[id] = mergeWindowEntries(
          windowCache[id] || [],
          result.windowEntries,
          observedAt
        );
      }

      // ---- Run heuristic analysis ----
      let analysis = null;
      try {
        analysis = analyze({
          flightDate: flight.date,
          currentPrice: result.price,
          currency: result.currency,
          windowEntries: latestWindowEntries(windowCache[id] || []),
          historicalWindowEntries: windowCache[id] || [],
          history: previousEntries,
          calculateRealPrice,
        });
      } catch (err) {
        console.error(`  Heuristic analysis error for ${id}: ${err.message}`);
      }

      if (analysis) {
        console.log(
          `  Heuristic: ${analysis.tier} · quality=${analysis.quality} · urgency=${analysis.urgency} · confidence=${analysis.confidence}`
        );
        if (analysis.reasons.length > 0) {
          console.log(`    Reasons: ${analysis.reasons.join("; ")}`);
        }
        try {
          appendHeuristicLog(flight, result.price, result.currency, analysis);
        } catch (err) {
          console.error(
            `  Failed to append heuristic log for ${id}: ${err.message}`
          );
        }

        // Emit a BUY issue only on a fresh transition into BUY NOW — prevents
        // hourly spam when the tier stays BUY NOW across runs.
        const previousTier = heuristicState[id]?.lastTier || null;
        if (analysis.tier === "BUY NOW" && previousTier !== "BUY NOW") {
          console.log(
            `  BUY NOW transition for ${id} (was ${previousTier || "none"}) — creating issue`
          );
          await createBuyRecommendationIssue(
            flight,
            result.price,
            result.currency,
            analysis,
            chartUrl
          );
        }

        analysisResults[id] = {
          flight,
          price: result.price,
          currency: result.currency,
          analysis,
        };

        heuristicState[id] = {
          lastTier: analysis.tier,
          lastPrice: result.price,
          lastTimestamp: entry.timestamp,
        };
      }
    }
  }

  saveHeuristicState(heuristicState);
  saveWindowCache(windowCache);

  // Write analysis.json — latest heuristic result per flight for the frontend.
  const analysisOutput = {};
  for (const [id, { flight, price, currency, analysis }] of Object.entries(analysisResults)) {
    const allPrices = (data[id] || []).filter((e) => e.price !== null).map((e) => e.price);
    const allTimeMin = allPrices.length > 0 ? Math.min(...allPrices) : null;
    analysisOutput[id] = {
      tier: analysis.tier,
      quality: analysis.quality,
      urgency: analysis.urgency,
      urgencyScore: analysis.urgencyScore,
      confidence: analysis.confidence,
      currentPrice: price,
      currency,
      allTimeMin,
      daysToDeparture: analysis.daysToDeparture,
      sevenDayChangePct: analysis.sevenDayChangePct,
      dtdFloor: analysis.dtdFloor,
      absoluteMin: analysis.absoluteMin,
      bucketTransition: analysis.bucketTransition,
      windowTrendDirection: analysis.windowTrendDirection,
      windowTrendPct: analysis.windowTrendPct,
      distinctObsDays: analysis.distinctObsDays,
      signals: analysis.signals,
      reasons: analysis.reasons,
      siblingSuggestion: analysis.siblingSuggestion,
      bucketCeilingWarning: analysis.bucketCeilingWarning,
      buckets: analysis.buckets,
      currentBucketIndex: analysis.currentBucketIndex,
      timestamp: new Date().toISOString(),
    };
  }
  fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(analysisOutput, null, 2));
  console.log(`Analysis written to analysis.json`);

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`\nData written to prices.json`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
