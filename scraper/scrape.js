const fs = require("fs");
const path = require("path");

const FLIGHTS_PATH = path.join(__dirname, "flights.json");
const DATA_PATH = path.join(__dirname, "..", "data", "prices.json");
const DATA_DIR = path.join(__dirname, "..", "data");
const DEBUG_DIR = path.join(__dirname, "..", "debug");

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
    return { price: null, currency: null, raw: null };
  }

  const data = JSON.parse(resText);
  const flights = data.outboundFlights || [];
  console.log(`  Got ${flights.length} outbound flight entries`);

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
      return { price, currency, raw: `${price} ${currency}` };
    }
  }

  console.log(`  No price match for ${flight.date}`);
  return { price: null, currency: null, raw: null };
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

  // Clear old debug files
  for (const f of fs.readdirSync(DEBUG_DIR)) {
    fs.unlinkSync(path.join(DEBUG_DIR, f));
  }
  console.log(`Cleared debug/ directory`);

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
      delete data[key];
      console.log(`  Cleaning up orphaned key: ${key} (${data[key].length} price entries)`);
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
    }
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`\nData written to prices.json`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
