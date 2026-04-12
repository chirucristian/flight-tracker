const fs = require("fs");
const path = require("path");
const { analyze } = require("./analyze");

const FLIGHTS_PATH = path.join(__dirname, "flights.json");
const DATA_PATH = path.join(__dirname, "..", "data", "prices.json");
const DATA_DIR = path.join(__dirname, "..", "data");
const DEBUG_DIR = path.join(__dirname, "..", "debug");
const HEURISTIC_LOG_PATH = path.join(DEBUG_DIR, "heuristic-log.jsonl");
const HEURISTIC_STATE_PATH = path.join(DATA_DIR, "heuristic-state.json");

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

async function fetchFareChart(apiUrl, flight) {
  const id = flightId(flight);
  const label = flightLabel(flight);

  console.log(`\n========================================`);
  console.log(`Fetching: ${label}`);
  console.log(`  ID: ${id}`);
  console.log(`========================================`);

  const url = `${apiUrl}/Api/asset/farechart`;
  const body = {
    isRescueFare: false,
    adultCount: 1,
    childCount: 0,
    dayInterval: 7,
    wdc: false,
    isFlightChange: false,
    flightList: [
      {
        departureStation: flight.from,
        arrivalStation: flight.to,
        date: `${flight.date}T00:00:00`,
      },
    ],
  };

  console.log(`  POST ${url}`);
  console.log(`  Body: ${JSON.stringify(body)}`);

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

  console.log(`  Response: ${res.status} ${res.statusText}`);

  const resText = await res.text();

  // Save full response to debug/
  fs.writeFileSync(
    path.join(DEBUG_DIR, `farechart-${id}-${res.status}.json`),
    resText
  );
  console.log(`  Saved response to debug/farechart-${id}-${res.status}.json`);

  if (!res.ok) {
    console.error(`  Error body: ${resText.substring(0, 500)}`);
    return { price: null, currency: null, raw: null, windowEntries: [] };
  }

  const data = JSON.parse(resText);
  const flights = data.outboundFlights || [];
  console.log(`  Got ${flights.length} outbound flight entries`);

  let match = { price: null, currency: null, raw: null };
  for (const entry of flights) {
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
      match = { price, currency, raw: `${price} ${currency}` };
      break;
    }
  }

  if (match.price === null) {
    console.log(`  No price match for ${flight.date}`);
  }

  return { ...match, windowEntries: flights };
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
    `| Urgency | ${analysis.urgency} (${analysis.urgencyScore}) |`,
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

      // ---- Run heuristic analysis ----
      let analysis = null;
      try {
        analysis = analyze({
          flightDate: flight.date,
          currentPrice: result.price,
          currency: result.currency,
          windowEntries: result.windowEntries,
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

        heuristicState[id] = {
          lastTier: analysis.tier,
          lastPrice: result.price,
          lastTimestamp: entry.timestamp,
        };
      }
    }
  }

  saveHeuristicState(heuristicState);

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`\nData written to prices.json`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
