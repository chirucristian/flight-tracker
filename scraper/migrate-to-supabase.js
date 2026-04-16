// One-time migration script: JSON files → Supabase
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... MIGRATE_EMAIL=cchiru40@gmail.com node scraper/migrate-to-supabase.js
//
// Prerequisites:
//   - Sign in at https://chirucristian.github.io/flight-tracker/ at least once
//     with the MIGRATE_EMAIL account so the user exists in auth.users.

const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const MIGRATE_EMAIL = process.env.MIGRATE_EMAIL;

const FLIGHTS_PATH = path.join(__dirname, "flights.json");
const PRICES_PATH = path.join(__dirname, "..", "data", "prices.json");
const WINDOW_CACHE_PATH = path.join(__dirname, "..", "data", "window-cache.json");

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !MIGRATE_EMAIL) {
  console.error("Required env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, MIGRATE_EMAIL");
  process.exit(1);
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function findUserByEmail(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list users: ${res.status} ${text}`);
  }
  const body = await res.json();
  const users = body.users || [];
  const match = users.find(
    (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
  );
  return match || null;
}

async function supabaseInsertBatch(table, rows, { upsert = false, onConflict } = {}) {
  const prefer = upsert
    ? "resolution=merge-duplicates,return=minimal"
    : "return=minimal";
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (upsert && onConflict) url += `?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers({ Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST ${table} failed: ${res.status} ${text}`);
  }
}

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// Build a map from old flightId (e.g. "otp-ory-2026-05-30") to flight_key (e.g. "OTP-ORY-2026-05-30")
function buildFlightKeyMap(flights) {
  const map = {};
  for (const f of flights) {
    const oldId = `${f.from}-${f.to}-${f.date}`.toLowerCase();
    const newKey = `${f.from}-${f.to}-${f.date}`.toUpperCase();
    map[oldId] = newKey;
  }
  return map;
}

async function main() {
  console.log("=== Flight Tracker: Migrate to Supabase ===\n");

  // 1. Look up user
  console.log(`Looking up user: ${MIGRATE_EMAIL}`);
  const user = await findUserByEmail(MIGRATE_EMAIL);
  if (!user) {
    console.error(
      `\nUser with email "${MIGRATE_EMAIL}" not found.\n` +
        `Sign in once first at https://chirucristian.github.io/flight-tracker/ to create the account, then re-run this script.`
    );
    process.exit(1);
  }
  console.log(`Found user: ${user.id} (${user.email})\n`);
  const userId = user.id;

  // 2. Load local data
  const flights = loadJSON(FLIGHTS_PATH);
  if (!flights || flights.length === 0) {
    console.error("No flights found in flights.json");
    process.exit(1);
  }
  const keyMap = buildFlightKeyMap(flights);

  const pricesData = loadJSON(PRICES_PATH) || {};
  const windowCacheData = loadJSON(WINDOW_CACHE_PATH) || {};

  // 3. Migrate flights
  console.log(`Migrating ${flights.length} flight(s) to tracked_flights...`);
  const flightRows = flights.map((f) => ({
    user_id: userId,
    origin: f.from.toUpperCase(),
    destination: f.to.toUpperCase(),
    date: f.date,
    time: f.time || null,
  }));
  await supabaseInsertBatch("tracked_flights", flightRows, { upsert: true, onConflict: "user_id,origin,destination,date" });
  console.log(`  Done: ${flightRows.length} flight(s) upserted.\n`);

  // 4. Migrate price_history
  console.log("Migrating price_history...");
  let totalPriceRows = 0;
  for (const [oldId, entries] of Object.entries(pricesData)) {
    const fKey = keyMap[oldId];
    if (!fKey) {
      console.log(`  Skipping unknown flight ID: ${oldId}`);
      continue;
    }

    const rows = entries
      .filter((e) => e.price != null)
      .map((e) => ({
        flight_key: fKey,
        timestamp: e.timestamp,
        price: e.price,
        currency: e.currency || "RON",
        raw: e.raw ? { raw: e.raw } : null,
      }));

    // Insert in batches of 500
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await supabaseInsertBatch("price_history", batch);
      totalPriceRows += batch.length;
      console.log(
        `  Migrated ${Math.min(i + 500, rows.length)}/${rows.length} rows for ${fKey}...`
      );
    }
  }
  console.log(`  Done: ${totalPriceRows} price_history row(s) inserted.\n`);

  // 5. Migrate window_cache
  console.log("Migrating window_cache...");
  let totalWindowRows = 0;
  for (const [oldId, entries] of Object.entries(windowCacheData)) {
    const fKey = keyMap[oldId];
    if (!fKey) {
      console.log(`  Skipping unknown flight ID: ${oldId}`);
      continue;
    }

    const rows = entries
      .filter((e) => e && e.priceType === "price" && e.price && e.price.amount > 0)
      .map((e) => ({
        flight_key: fKey,
        date: (e.date || "").substring(0, 10),
        price: e.price.amount,
        currency: e.price.currencyCode || "RON",
        observed_at: e.observedAt || null,
      }));

    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await supabaseInsertBatch("window_cache", batch);
      totalWindowRows += batch.length;
      console.log(
        `  Migrated ${Math.min(i + 500, rows.length)}/${rows.length} rows for ${fKey}...`
      );
    }
  }
  console.log(`  Done: ${totalWindowRows} window_cache row(s) inserted.\n`);

  // 6. Summary
  console.log("=== Migration complete ===");
  console.log(`  Flights:       ${flightRows.length}`);
  console.log(`  Price history: ${totalPriceRows}`);
  console.log(`  Window cache:  ${totalWindowRows}`);
  console.log(
    `  Heuristic state: skipped (will be rebuilt on next scraper run)\n`
  );
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
