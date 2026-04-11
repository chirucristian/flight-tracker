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

async function extractFromDom(page, targetTime) {
  const flights = await page.evaluate(() => {
    const selectors = [
      '[class*="flight-select"]',
      '[class*="flight-row"]',
      '[class*="flight-card"]',
      '[data-test*="flight"]',
      '[class*="timetable"]',
    ];
    let matchedSelector = null;
    let elements = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        elements = Array.from(els);
        matchedSelector = sel;
        break;
      }
    }

    return {
      matchedSelector,
      elementCount: elements.length,
      flights: elements.map((el) => {
        const text = el.textContent || "";
        const timeMatch = text.match(/(\d{2}:\d{2})/);
        const priceMatch = text.match(/(\d[\d.,]*)\s*(RON|EUR|€|lei|GBP|£)/i);
        return {
          hasTime: !!timeMatch,
          hasPrice: !!priceMatch,
          departureTime: timeMatch?.[1] || null,
          priceRaw: priceMatch?.[1] || null,
          currency: priceMatch?.[2] || null,
          raw: priceMatch?.[0] || null,
          textSnippet: text.substring(0, 200),
        };
      }),
    };
  });

  console.log(`    DOM selector matched: ${flights.matchedSelector || "none"} (${flights.elementCount} elements)`);
  for (const f of flights.flights) {
    console.log(`    DOM element: time=${f.departureTime} price=${f.priceRaw} ${f.currency} | "${f.textSnippet.substring(0, 80)}..."`);
  }

  const candidates = flights.flights
    .filter((f) => f.hasTime && f.hasPrice)
    .map((f) => {
      let cur = f.currency;
      if (cur === "€") cur = "EUR";
      if (cur === "£") cur = "GBP";
      return {
        departureTime: f.departureTime,
        price: parsePrice(f.priceRaw),
        currency: cur,
        raw: f.raw,
      };
    })
    .filter((f) => f.price !== null);

  console.log(`    DOM candidates with time+price: ${candidates.length}`);
  return findBestMatch(candidates, targetTime);
}

function extractFromText(text, targetTime) {
  const lines = text.split("\n");
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const timeMatch = lines[i].match(/(\d{2}:\d{2})/);
    if (!timeMatch) continue;

    const nearby = lines.slice(Math.max(0, i - 3), i + 8).join(" ");
    const priceMatch = nearby.match(/(\d[\d.,]*)\s*(RON|EUR|€|lei|GBP|£)/i);
    if (priceMatch) {
      let cur = priceMatch[2];
      if (cur === "€") cur = "EUR";
      if (cur === "£") cur = "GBP";
      const price = parsePrice(priceMatch[1]);
      if (price !== null) {
        console.log(`    Text match: line ${i + 1} time=${timeMatch[1]} price=${price} ${cur}`);
        candidates.push({
          departureTime: timeMatch[1],
          price,
          currency: cur,
          raw: priceMatch[0],
        });
      }
    }
  }

  console.log(`    Text candidates: ${candidates.length}`);
  return findBestMatch(candidates, targetTime);
}

async function scrapeFlight(browser, flight) {
  const url = buildUrl(flight.from, flight.to, flight.date);
  const id = flightId(flight);
  const label = flightLabel(flight);

  console.log(`\n========================================`);
  console.log(`Scraping: ${label}`);
  console.log(`  URL: ${url}`);
  console.log(`  ID: ${id}`);
  console.log(`  Target time: ${flight.time}`);
  console.log(`========================================`);

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
  });

  try {
    // Anti-detection: hide webdriver flag before any page JS runs
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Remove Playwright/Chrome automation indicators
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    // Navigation
    console.log(`  Navigating...`);
    console.log(`  >>> TARGET URL: ${url}`);
    const navStart = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const currentUrl = page.url();
    console.log(`  Page loaded in ${Date.now() - navStart}ms`);
    console.log(`  >>> LANDED URL: ${currentUrl}`);
    if (currentUrl !== url) {
      console.log(`  >>> REDIRECT DETECTED`);
    }
    await page.waitForTimeout(3000);

    // Cookie consent
    try {
      const acceptBtn = page.locator('button:has-text("Accept all")').first();
      if (await acceptBtn.isVisible({ timeout: 3000 })) {
        await acceptBtn.click();
        console.log(`  Cookie consent accepted`);
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log(`  Cookie handling: ${e.message}`);
    }

    // Wait for flight content to render (async JS needs time)
    console.log(`  Waiting for flight content...`);
    await page.waitForTimeout(10000);

    // Screenshot for debugging
    const ssPath = path.join(DATA_DIR, `debug-${id}.png`);
    await page.screenshot({ path: ssPath, fullPage: true });
    console.log(`  Screenshot saved: debug-${id}.png`);

    // Page text for debugging + text extraction
    const pageText = await page.evaluate(() => document.body.innerText);
    const textPath = path.join(DATA_DIR, `debug-text-${id}.txt`);
    fs.writeFileSync(textPath, pageText);
    console.log(`  Page text saved: debug-text-${id}.txt (${pageText.length} chars)`);

    // Check for "no flights" message
    if (pageText.includes("No flights on this date")) {
      console.log(`  >>> Page says "No flights on this date" — skipping extraction`);
      return { price: null, currency: null, raw: "no flights on this date" };
    }

    // Strategy 1: DOM scraping
    console.log(`  Strategy 1: DOM scraping`);
    const domResult = await extractFromDom(page, flight.time);
    if (domResult) {
      console.log(`  >>> FOUND via DOM: ${domResult.price} ${domResult.currency}`);
      return { price: domResult.price, currency: domResult.currency, raw: domResult.raw };
    }
    console.log(`  DOM: no matching flight found`);

    // Strategy 2: Full page text parsing
    console.log(`  Strategy 2: Text parsing`);
    const textResult = extractFromText(pageText, flight.time);
    if (textResult) {
      console.log(`  >>> FOUND via text: ${textResult.price} ${textResult.currency}`);
      return { price: textResult.price, currency: textResult.currency, raw: textResult.raw };
    }
    console.log(`  Text: no matching flight found`);

    console.log(`  ALL STRATEGIES FAILED — no price found`);
    return { price: null, currency: null, raw: null };
  } catch (err) {
    console.error(`  FATAL ERROR scraping ${id}: ${err.message}`);
    console.error(`  Stack: ${err.stack}`);
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
  console.log(`\n  RETRY: No price found for ${id}, retrying in 5 minutes...`);
  await sleep(5 * 60 * 1000);

  const retry = await scrapeFlight(browser, flight);
  if (retry.price !== null) return retry;

  console.error(`  FAILED: Scrape failed after retry for ${id}`);
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
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Flight Tracker - Wizzair Scraper`);
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

  const browser = await chromium.launch({ headless: "new" });
  console.log("Browser launched (headless)");

  const results = [];

  try {
    for (const flight of flights) {
      const result = await scrapeFlightWithRetry(browser, flight);
      results.push({ flight, result });
    }
  } finally {
    await browser.close();
    console.log("\nBrowser closed");
  }

  const repo = process.env.GITHUB_REPOSITORY || "";
  const owner = repo.split("/")[0] || "OWNER";
  const repoName = repo.split("/")[1] || "flight-tracker";
  const chartUrl = `https://${owner}.github.io/${repoName}/`;

  console.log(`\n--- Results ---`);
  for (const { flight, result } of results) {
    const id = flightId(flight);
    console.log(`  ${id}: ${result.price !== null ? `${result.price} ${result.currency}` : "FAILED"}`);

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
