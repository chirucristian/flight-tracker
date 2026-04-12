const fs = require("fs");
const path = require("path");

const FLIGHTS_PATH = path.join(__dirname, "flights.json");
const DATA_PATH = path.join(__dirname, "..", "data", "prices.json");
const DATA_DIR = path.join(__dirname, "..", "data");

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
  // Round up so the last digit is 9
  // e.g. 156 → 159, 160 → 169, 159 → 159
  return Math.ceil((withMarkup - 9) / 10) * 10 + 9;
}

async function getApiUrl() {
  console.log("  Discovering Wizzair API version...");
  const metadataUrls = [
    "https://wizzair.com/static_fe/metadata.json",
    "https://www.wizzair.com/static_fe/metadata.json",
  ];
  for (const url of metadataUrls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const meta = await res.json();
        if (meta.apiUrl) {
          console.log(`  API base URL: ${meta.apiUrl} (from ${url})`);
          return meta.apiUrl;
        }
      }
      console.log(`  ${url} returned ${res.status}`);
    } catch (e) {
      console.log(`  ${url} failed: ${e.message}`);
    }
  }
  const fallback = "https://be.wizzair.com/28.6.0";
  console.log(`  Using fallback API URL: ${fallback}`);
  return fallback;
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
    dayInterval: 10,
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

  if (!res.ok) {
    const text = await res.text();
    console.error(`  Error body: ${text.substring(0, 500)}`);
    return { price: null, currency: null, raw: null };
  }

  const data = await res.json();

  // Save debug response
  fs.writeFileSync(
    path.join(DATA_DIR, `debug-farechart-${id}.json`),
    JSON.stringify(data, null, 2)
  );
  console.log(`  Saved debug response to debug-farechart-${id}.json`);

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
    `**[Book this flight](${url})**`,
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

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (typeof data !== "object" || data === null) data = {};
  } catch {
    data = {};
  }
  console.log(`Existing price data: ${Object.keys(data).length} flight(s) tracked`);

  const apiUrl = await getApiUrl();

  const results = [];
  for (const flight of flights) {
    const result = await fetchFareChart(apiUrl, flight);
    if (result.price === null) {
      console.error(`  FAILED: No price found for ${flightId(flight)}`);
      await createScrapeFailureIssue(flight);
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
