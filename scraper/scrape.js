const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const DATA_PATH = path.join(__dirname, "..", "data", "prices.json");
const DATA_DIR = path.join(__dirname, "..", "data");

const PRICE_SELECTORS = [
  '[class*="price"]',
  "span[data-gs]",
  '[aria-label*="price"]',
  '[aria-label*="total"]',
];

function parsePrice(raw) {
  if (!raw) return null;
  // Remove currency symbols and whitespace
  let cleaned = raw.replace(/[RON€EURlei\s]/gi, "").trim();
  if (!cleaned) return null;
  // Handle European format: 1.234,56 → 1234.56
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }
  // Handle format: 1,234.56
  else if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, "");
  }
  // Handle simple comma as decimal: 123,45
  else if (/^\d+(,)\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(",", ".");
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractPriceFromText(text) {
  // Try RON patterns first
  const ronPatterns = [
    /(\d[\d.,]*)\s*(?:RON|lei)/i,
    /(?:RON|lei)\s*(\d[\d.,]*)/i,
  ];
  for (const pat of ronPatterns) {
    const m = text.match(pat);
    if (m) {
      const price = parsePrice(m[1]);
      if (price !== null) return { price, currency: "RON", raw: m[0] };
    }
  }
  // EUR fallback
  const eurPatterns = [
    /€\s*(\d[\d.,]*)/i,
    /(\d[\d.,]*)\s*€/i,
    /EUR\s*(\d[\d.,]*)/i,
  ];
  for (const pat of eurPatterns) {
    const m = text.match(pat);
    if (m) {
      const price = parsePrice(m[1]);
      if (price !== null) return { price, currency: "EUR", raw: m[0] };
    }
  }
  return null;
}

async function scrapeFlight(browser, flight) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-RO",
  });

  try {
    console.log(`Scraping: ${flight.label}`);
    await page.goto(flight.url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(8000);

    // Save debug screenshot
    const screenshotPath = path.join(DATA_DIR, `debug-${flight.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  Screenshot saved: debug-${flight.id}.png`);

    // Strategy 1: Try known CSS selectors
    for (const selector of PRICE_SELECTORS) {
      try {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const text = await el.textContent();
          if (text) {
            const result = extractPriceFromText(text);
            if (result) {
              console.log(
                `  Found via selector "${selector}": ${result.price} ${result.currency}`
              );
              return result;
            }
          }
        }
      } catch {
        // selector not found, try next
      }
    }

    // Strategy 2: Full page text regex
    const pageText = await page.evaluate(() => document.body.textContent);
    if (pageText) {
      const result = extractPriceFromText(pageText);
      if (result) {
        console.log(
          `  Found via page text: ${result.price} ${result.currency}`
        );
        return result;
      }
    }

    console.log("  No price found");
    return { price: null, currency: null, raw: null };
  } catch (err) {
    console.error(`  Error scraping ${flight.id}: ${err.message}`);
    return { price: null, currency: null, raw: null };
  } finally {
    await page.close();
  }
}

async function createScrapeFailureIssue(flight) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;

  const title = `Scrape failed: ${flight.label}`;
  const body = [
    `## Scrape Failure`,
    ``,
    `Flight **${flight.label}** failed to return a price after 2 attempts (with a 5-minute retry).`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| Flight ID | \`${flight.id}\` |`,
    `| Timestamp | ${new Date().toISOString()} |`,
    ``,
    `Check \`data/debug-${flight.id}.png\` for a screenshot of what the page looked like.`,
    ``,
    `Common causes: Google CAPTCHA, changed DOM selectors, network timeout.`,
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
      console.error(`  Failed to create failure issue: ${res.status}`);
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

  console.log(`  No price found for ${flight.id}, retrying in 5 minutes...`);
  await sleep(5 * 60 * 1000);

  const retry = await scrapeFlight(browser, flight);
  if (retry.price !== null) return retry;

  console.error(`  Scrape failed after retry for ${flight.id}`);
  await createScrapeFailureIssue(flight);
  return retry;
}

async function createGitHubIssue(flight, newPrice, currency, previousLow, dataPoints, chartUrl) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("  Skipping GitHub Issue (no token/repo)");
    return;
  }

  const drop = previousLow
    ? (((previousLow - newPrice) / previousLow) * 100).toFixed(1)
    : null;

  const title = `New low: ${newPrice} ${currency} — ${flight.label}`;
  const body = [
    `## New Price Low: ${flight.label}`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| **New Price** | **${newPrice} ${currency}** |`,
    previousLow ? `| Previous Low | ${previousLow} ${currency} |` : null,
    drop ? `| Drop | ${drop}% |` : null,
    `| Timestamp | ${new Date().toISOString()} |`,
    ``,
    `**[Book this flight](${flight.url})**`,
    ``,
    `[View Price Chart](${chartUrl})`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          title,
          body,
          labels: ["price-alert"],
        }),
      }
    );
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
  // Read config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  console.log(`Loaded ${config.length} flight(s) from config`);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Read existing data
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (typeof data !== "object" || data === null) data = {};
  } catch {
    data = {};
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  console.log("Browser launched");

  const results = [];

  try {
    for (const flight of config) {
      const result = await scrapeFlightWithRetry(browser, flight);
      results.push({ flight, result });
    }
  } finally {
    await browser.close();
    console.log("Browser closed");
  }

  // Determine chart URL for issue links
  const repo = process.env.GITHUB_REPOSITORY || "";
  const owner = repo.split("/")[0] || "OWNER";
  const repoName = repo.split("/")[1] || "flight-tracker";
  const chartUrl = `https://${owner}.github.io/${repoName}/`;

  // Update data and check for new lows
  for (const { flight, result } of results) {
    if (!data[flight.id]) data[flight.id] = [];

    const entry = {
      timestamp: new Date().toISOString(),
      price: result.price,
      currency: result.currency,
      raw: result.raw,
    };
    const previousEntries = data[flight.id];

    data[flight.id].push(entry);

    // Check for new low
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
          `  NEW LOW for ${flight.id}: ${result.price} ${result.currency}` +
            (previousLow ? ` (was ${previousLow})` : " (first reading)")
        );
        await createGitHubIssue(
          flight,
          result.price,
          result.currency,
          previousLow,
          data[flight.id].length,
          chartUrl
        );
      }
    }
  }

  // Write data
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("Data written to prices.json");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
