const fs = require("fs");
const path = require("path");
const { analyze } = require("./analyze");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const FLIGHTS_PATH = path.join(__dirname, "flights.json");
const DEBUG_DIR = path.join(__dirname, "..", "debug");
const HEURISTIC_LOG_PATH = path.join(DEBUG_DIR, "heuristic-log.jsonl");

// ---- Supabase REST helpers ----

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function supabaseGet(table, query = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabaseInsert(table, rows, { upsert = false } = {}) {
  const prefer = upsert
    ? "resolution=merge-duplicates,return=minimal"
    : "return=minimal";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...supabaseHeaders(), Prefer: prefer },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST ${table} failed: ${res.status} ${text}`);
  }
}

// ---- Flight helpers ----

function buildUrl(from, to, date) {
  return `https://www.wizzair.com/en-gb/booking/select-flight/${from}/${to}/${date}/null/1/0/0/null`;
}

function flightKey(f) {
  return `${f.origin}-${f.destination}-${f.date}`.toUpperCase();
}

function flightId(f) {
  return `${f.origin}-${f.destination}-${f.date}`.toLowerCase();
}

function flightLabel(f) {
  return `${f.origin} → ${f.destination} · ${f.date}${f.time ? " · " + f.time : ""}`;
}

function calculateRealPrice(chartPrice) {
  return chartPrice + 10;
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

// ---- Fare chart fetching (unchanged logic) ----

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
        departureStation: flight.origin,
        arrivalStation: flight.destination,
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

  const primary = await fetchFareChartBlock(apiUrl, flight, targetDate, "");

  let beforeEntries = [];
  let afterEntries = [];
  try {
    const before = await fetchFareChartBlock(apiUrl, flight, beforeCenter, "-before");
    beforeEntries = before.flights;
  } catch (err) {
    console.warn(`  Before-window fetch threw: ${err.message}`);
  }
  try {
    const after = await fetchFareChartBlock(apiUrl, flight, afterCenter, "-after");
    afterEntries = after.flights;
  } catch (err) {
    console.warn(`  After-window fetch threw: ${err.message}`);
  }

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

// ---- GitHub Issues (unchanged) ----

async function createScrapeFailureIssue(flight) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("  Skipping failure issue (no token/repo)");
    return;
  }

  const id = flightId(flight);
  const label = flightLabel(flight);
  const url = buildUrl(flight.origin, flight.destination, flight.date);
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
      console.error(`  Failed to create failure issue: ${res.status} ${text}`);
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
  const url = buildUrl(flight.origin, flight.destination, flight.date);
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
  const url = buildUrl(flight.origin, flight.destination, flight.date);

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

// ---- Heuristic log (local debug file — kept as-is) ----

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

// ---- Window cache helpers (same merge logic, now backed by Supabase) ----

function mergeWindowEntries(existing, newEntries, observedAt) {
  const toAdd = newEntries
    .filter((e) => e && e.priceType === "price" && e.price?.amount > 0)
    .map((e) => ({ ...e, observedAt }));
  return [...existing, ...toAdd];
}

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

// ---- Supabase data access ----

async function loadFlightsFromSupabase() {
  try {
    const rows = await supabaseGet(
      "tracked_flights",
      "select=origin,destination,date,time"
    );
    // Deduplicate across users
    const seen = new Set();
    const flights = [];
    for (const r of rows) {
      const key = `${r.origin}-${r.destination}-${r.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        flights.push({
          origin: r.origin,
          destination: r.destination,
          date: r.date,
          time: r.time || "",
        });
      }
    }
    return flights;
  } catch (err) {
    console.error(`Failed to load flights from Supabase: ${err.message}`);
    return null;
  }
}

async function loadPriceHistory(fKey) {
  try {
    const rows = await supabaseGet(
      "price_history",
      `select=timestamp,price,currency,raw&flight_key=eq.${encodeURIComponent(fKey)}&order=timestamp.asc`
    );
    return rows.map((r) => ({
      timestamp: r.timestamp,
      price: r.price != null ? Number(r.price) : null,
      currency: r.currency,
      raw: r.raw,
    }));
  } catch (err) {
    console.error(`Failed to load price_history for ${fKey}: ${err.message}`);
    return [];
  }
}

async function insertPriceHistory(fKey, entry) {
  try {
    await supabaseInsert("price_history", {
      flight_key: fKey,
      timestamp: entry.timestamp,
      price: entry.price,
      currency: entry.currency,
      raw: entry.raw ? { raw: entry.raw } : null,
    });
  } catch (err) {
    console.error(`Failed to insert price_history for ${fKey}: ${err.message}`);
  }
}

async function loadWindowCache(fKey) {
  try {
    const rows = await supabaseGet(
      "window_cache",
      `select=*&flight_key=eq.${encodeURIComponent(fKey)}&order=observed_at.asc`
    );
    // Convert DB rows back to the farechart-style entries that analyze() expects
    return rows.map((r) => ({
      date: r.date + "T00:00:00",
      price: { amount: Number(r.price), currencyCode: r.currency },
      priceType: "price",
      observedAt: r.observed_at,
    }));
  } catch (err) {
    console.error(`Failed to load window_cache for ${fKey}: ${err.message}`);
    return [];
  }
}

async function insertWindowCacheEntries(fKey, newEntries, observedAt) {
  const rows = newEntries
    .filter((e) => e && e.priceType === "price" && e.price?.amount > 0)
    .map((e) => ({
      flight_key: fKey,
      date: (e.date || "").substring(0, 10),
      price: calculateRealPrice(e.price.amount),
      currency: e.price.currencyCode || "EUR",
      observed_at: observedAt,
    }));
  if (rows.length === 0) return;

  try {
    await supabaseInsert("window_cache", rows);
  } catch (err) {
    console.error(`Failed to insert window_cache for ${fKey}: ${err.message}`);
  }
}

async function loadAnalysisResult(fKey) {
  try {
    const rows = await supabaseGet(
      "analysis_results",
      `select=*&flight_key=eq.${encodeURIComponent(fKey)}`
    );
    if (rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    console.error(`Failed to load analysis_results for ${fKey}: ${err.message}`);
    return null;
  }
}

async function upsertAnalysisResult(fKey, data) {
  try {
    await supabaseInsert("analysis_results", {
      flight_key: fKey,
      tier: data.tier,
      quality: data.quality,
      urgency: data.urgency,
      confidence: data.confidence,
      current_price: data.currentPrice,
      signals: data.signals,
      reasons: data.reasons,
      updated_at: new Date().toISOString(),
    }, { upsert: true });
  } catch (err) {
    console.error(`Failed to upsert analysis_results for ${fKey}: ${err.message}`);
  }
}

// ---- Main ----

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Flight Tracker - Wizzair Farechart API`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`${"=".repeat(50)}\n`);

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
    process.exit(1);
  }

  // Load flights: try Supabase first, fall back to flights.json
  let flights = await loadFlightsFromSupabase();
  if (!flights || flights.length === 0) {
    console.log("No flights from Supabase — falling back to flights.json");
    const raw = JSON.parse(fs.readFileSync(FLIGHTS_PATH, "utf-8"));
    flights = raw.map((f) => ({
      origin: f.from,
      destination: f.to,
      date: f.date,
      time: f.time || "",
    }));
  } else {
    console.log(`Loaded ${flights.length} flight(s) from Supabase (deduplicated)`);
  }

  for (const f of flights) {
    console.log(`  - ${flightLabel(f)} [${flightId(f)}]`);
  }

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // Clear old debug files
  for (const f of fs.readdirSync(DEBUG_DIR)) {
    if (f.startsWith("farechart-")) {
      fs.unlinkSync(path.join(DEBUG_DIR, f));
    }
  }
  console.log(`Cleared farechart-* files from debug/`);

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

  results.sort((a, b) => a.flight.date.localeCompare(b.flight.date));

  console.log(`\n--- Results ---`);
  for (const { flight, result } of results) {
    const id = flightId(flight);
    const fKey = flightKey(flight);
    console.log(
      `  ${id}: ${result.price !== null ? `${result.price} ${result.currency}` : "FAILED"}`
    );

    // Load existing price history from Supabase
    const previousEntries = await loadPriceHistory(fKey);

    const entry = {
      timestamp: new Date().toISOString(),
      price: result.price,
      currency: result.currency,
      raw: result.raw,
    };

    // Insert new price reading
    await insertPriceHistory(fKey, entry);

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

      // ---- Accumulate window entries into Supabase cache ----
      const existingWindowEntries = await loadWindowCache(fKey);

      if (result.windowEntries && result.windowEntries.length > 0) {
        const observedAt = new Date().toISOString().substring(0, 10);
        await insertWindowCacheEntries(fKey, result.windowEntries, observedAt);

        // Build the merged in-memory cache for analyze()
        var allWindowEntries = mergeWindowEntries(
          existingWindowEntries,
          result.windowEntries,
          observedAt
        );
      } else {
        var allWindowEntries = existingWindowEntries;
      }

      // ---- Run heuristic analysis ----
      let analysis = null;
      try {
        analysis = analyze({
          flightDate: flight.date,
          currentPrice: result.price,
          currency: result.currency,
          windowEntries: latestWindowEntries(allWindowEntries),
          historicalWindowEntries: allWindowEntries,
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

        // Check for BUY NOW transition
        const previousAnalysis = await loadAnalysisResult(fKey);
        const previousTier = previousAnalysis?.tier || null;
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

        // Upsert analysis results to Supabase
        const allPrices = [...previousEntries, entry]
          .filter((e) => e.price !== null)
          .map((e) => e.price);
        const allTimeMin = allPrices.length > 0 ? Math.min(...allPrices) : null;

        await upsertAnalysisResult(fKey, {
          tier: analysis.tier,
          quality: analysis.quality,
          urgency: analysis.urgency,
          confidence: analysis.confidence,
          currentPrice: result.price,
          signals: {
            ...analysis.signals,
            urgencyScore: analysis.urgencyScore,
            allTimeMin,
            currency: result.currency,
            daysToDeparture: analysis.daysToDeparture,
            sevenDayChangePct: analysis.sevenDayChangePct,
            dtdFloor: analysis.dtdFloor,
            absoluteMin: analysis.absoluteMin,
            bucketTransition: analysis.bucketTransition,
            windowTrendDirection: analysis.windowTrendDirection,
            windowTrendPct: analysis.windowTrendPct,
            distinctObsDays: analysis.distinctObsDays,
            siblingSuggestion: analysis.siblingSuggestion,
            bucketCeilingWarning: analysis.bucketCeilingWarning,
            buckets: analysis.buckets,
            currentBucketIndex: analysis.currentBucketIndex,
          },
          reasons: analysis.reasons,
        });
      }
    }
  }

  console.log(`\nFinished: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
