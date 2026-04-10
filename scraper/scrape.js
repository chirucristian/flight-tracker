const { chromium } = require("playwright");
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

function timeDiffMin(a, b) {
  const [h1, m1] = a.split(":").map(Number);
  const [h2, m2] = b.split(":").map(Number);
  return Math.abs(h1 * 60 + m1 - (h2 * 60 + m2));
}

function parsePrice(raw) {
  if (!raw) return null;
  let cleaned = raw.toString().replace(/[^0-9.,]/g, "").trim();
  if (!cleaned) return null;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, "");
  } else if (/^\d+(,)\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(",", ".");
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function findBestMatch(candidates, targetTime) {
  if (candidates.length === 0) return null;
  const sorted = candidates
    .map((c) => ({ ...c, diff: timeDiffMin(c.departureTime, targetTime) }))
    .sort((a, b) => a.diff - b.diff);
  if (sorted[0].diff <= 180) return sorted[0];
  return null;
}

function extractFromApi(responses, targetTime) {
  for (const data of responses) {
    const flights = data.outboundFlights || data.flights || [];
    if (!Array.isArray(flights) || flights.length === 0) continue;

    const candidates = [];
    for (const f of flights) {
      const dep = f.departureDateTime || f.departureDateTimeUtc || "";
      const depTime = dep.substring(11, 16);
      if (!depTime || !/^\d{2}:\d{2}$/.test(depTime)) continue;

      let bestPrice = null;
      let currency = null;

      if (f.fares && Array.isArray(f.fares)) {
        for (const fare of f.fares) {
          const priceObj =
            fare.discountedPrice || fare.price || fare.basePrice;
          if (priceObj && priceObj.amount != null) {
            if (bestPrice === null || priceObj.amount < bestPrice) {
              bestPrice = priceObj.amount;
              currency = priceObj.currencyCode;
            }
          }
        }
      }

      if (bestPrice !== null) {
        candidates.push({
          departureTime: depTime,
          price: bestPrice,
          currency,
          raw: `${bestPrice} ${currency}`,
        });
      }
    }

    const match = findBestMatch(candidates, targetTime);
    if (match) return match;
  }
  return null;
}

async function extractFromDom(page, targetTime) {
  const flights = await page.evaluate(() => {
    const results = [];
    const selectors = [
      '[class*="flight-select"]',
      '[class*="flight-row"]',
      '[class*="flight-card"]',
      '[data-test*="flight"]',
      '[class*="timetable"]',
    ];
    let elements = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        elements = Array.from(els);
        break;
      }
    }

    for (const el of elements) {
      const text = el.textContent || "";
      const timeMatch = text.match(/(\d{2}:\d{2})/);
      const priceMatch = text.match(/(\d[\d.,]*)\s*(RON|EUR|€|lei|GBP|£)/i);
      if (timeMatch && priceMatch) {
        let cur = priceMatch[2];
        if (cur === "€") cur = "EUR";
        if (cur === "£") cur = "GBP";
        results.push({
          departureTime: timeMatch[1],
          priceRaw: priceMatch[1],
          currency: cur,
          raw: priceMatch[0],
        });
      }
    }
    return results;
  });

  const candidates = flights
    .map((f) => ({
      departureTime: f.departureTime,
      price: parsePrice(f.priceRaw),
      currency: f.currency,
      raw: f.raw,
    }))
    .filter((f) => f.price !== null);

  return findBestMatch(candidates, targetTime);
}

async function scrapeFlight(browser, flight) {
  const url = buildUrl(flight.from, flight.to, flight.date);
  const id = flightId(flight);
  const label = flightLabel(flight);

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
  });

  try {
    console.log(`Scraping: ${label}`);
    console.log(`  URL: ${url}`);

    // Intercept API responses
    const apiResponses = [];
    page.on("response", async (response) => {
      const reqUrl = response.url();
      if (
        reqUrl.includes("/Api/search/search") ||
        reqUrl.includes("/Api/search/timetable")
      ) {
        try {
          const json = await response.json();
          apiResponses.push(json);
          console.log(`  Intercepted API: ${reqUrl}`);
        } catch {}
      }
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(5000);

    // Handle cookie consent
    try {
      const cookieBtn = await page.$(
        'button[data-test="button-cookie-accept-all"], #onetrust-accept-btn-handler'
      );
      if (cookieBtn) {
        await cookieBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    await page.waitForTimeout(3000);

    // Debug screenshot
    const ssPath = path.join(DATA_DIR, `debug-${id}.png`);
    await page.screenshot({ path: ssPath, fullPage: true });
    console.log(`  Screenshot: debug-${id}.png`);

    // Strategy 1: Intercepted API response
    if (apiResponses.length > 0) {
      const apiPath = path.join(DATA_DIR, `debug-api-${id}.json`);
      fs.writeFileSync(apiPath, JSON.stringify(apiResponses, null, 2));

      const result = extractFromApi(apiResponses, flight.time);
      if (result) {
        console.log(
          `  Found via API: ${result.price} ${result.currency} (dep ${result.departureTime})`
        );
        return { price: result.price, currency: result.currency, raw: result.raw };
      }
    }

    // Strategy 2: DOM scraping
    const domResult = await extractFromDom(page, flight.time);
    if (domResult) {
      console.log(`  Found via DOM: ${domResult.price} ${domResult.currency}`);
      return { price: domResult.price, currency: domResult.currency, raw: domResult.raw };
    }

    console.log("  No price found");
    return { price: null, currency: null, raw: null };
  } catch (err) {
    console.error(`  Error scraping ${id}: ${err.message}`);
    return { price: null, currency: null, raw: null };
  } finally {
    await page.close();
  }
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
    `Flight **${label}** failed to return a price after 2 attempts.`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| Flight ID | \`${id}\` |`,
    `| Timestamp | ${new Date().toISOString()} |`,
    ``,
    `Check \`data/debug-${id}.png\` for a screenshot.`,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeFlightWithRetry(browser, flight) {
  const result = await scrapeFlight(browser, flight);
  if (result.price !== null) return result;

  const id = flightId(flight);
  console.log(`  No price found for ${id}, retrying in 5 minutes...`);
  await sleep(5 * 60 * 1000);

  const retry = await scrapeFlight(browser, flight);
  if (retry.price !== null) return retry;

  console.error(`  Scrape failed after retry for ${id}`);
  await createScrapeFailureIssue(flight);
  return retry;
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
  const flights = JSON.parse(fs.readFileSync(FLIGHTS_PATH, "utf-8"));
  console.log(`Loaded ${flights.length} flight(s) from flights.json`);

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

  const browser = await chromium.launch({ headless: true });
  console.log("Browser launched");

  const results = [];

  try {
    for (const flight of flights) {
      const result = await scrapeFlightWithRetry(browser, flight);
      results.push({ flight, result });
    }
  } finally {
    await browser.close();
    console.log("Browser closed");
  }

  const repo = process.env.GITHUB_REPOSITORY || "";
  const owner = repo.split("/")[0] || "OWNER";
  const repoName = repo.split("/")[1] || "flight-tracker";
  const chartUrl = `https://${owner}.github.io/${repoName}/`;

  for (const { flight, result } of results) {
    const id = flightId(flight);
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
  console.log("Data written to prices.json");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
