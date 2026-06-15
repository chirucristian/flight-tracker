// Manual end-to-end test for the buy-alert email pipeline.
//
// Forces a BUY NOW analysis for a user's tracked flight and runs the real
// sendBuyAlerts() — exercising fan-out, preferences lookup, dedup/re-arm,
// and the Resend email send. Intended to run inside GitHub Actions (via the
// test-alert workflow) so secrets stay server-side.
//
// Env:
//   SUPABASE_URL, SUPABASE_SECRET_KEY, RESEND_API_KEY  (from Actions secrets)
//   TEST_EMAIL    (required) — account to notify; must be your Resend account
//                 owner address while using onboarding@resend.dev.
//   TEST_ORIGIN, TEST_DEST, TEST_DATE (optional) — specific flight to use;
//                 if omitted, the user's most recent tracked flight is used.

const { sendBuyAlerts } = require("./notify");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const TEST_EMAIL = process.env.TEST_EMAIL;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sget(table, q) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, { headers: headers() });
  if (!r.ok) throw new Error(`GET ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supabase(method, table, q, row, prefer) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${q ? "?" + q : ""}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: row ? JSON.stringify(row) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${table} ${r.status}: ${await r.text()}`);
}

async function findUserByEmail(email) {
  for (let page = 1; ; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: headers(),
    });
    if (!r.ok) throw new Error(`admin/users ${r.status}: ${await r.text()}`);
    const body = await r.json();
    const users = body.users || [];
    const match = users.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (users.length < 200) return null;
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !process.env.RESEND_API_KEY) {
    throw new Error("SUPABASE_URL, SUPABASE_SECRET_KEY and RESEND_API_KEY must be set.");
  }
  if (!TEST_EMAIL) throw new Error("TEST_EMAIL is required.");

  console.log(`Looking up user: ${TEST_EMAIL}`);
  const user = await findUserByEmail(TEST_EMAIL);
  if (!user) {
    throw new Error(
      `No auth user with email ${TEST_EMAIL}. Sign in at the site once first to create the account.`
    );
  }
  console.log(`  user_id=${user.id}`);

  // Resolve the flight to test with.
  let origin = (process.env.TEST_ORIGIN || "").toUpperCase();
  let dest = (process.env.TEST_DEST || "").toUpperCase();
  let date = process.env.TEST_DATE || "";
  let insertedFlight = false;

  if (origin && dest && date) {
    // Make sure it's tracked by this user so fan-out finds them.
    const existing = await sget(
      "tracked_flights",
      `select=id&user_id=eq.${user.id}&origin=eq.${origin}&destination=eq.${dest}&date=eq.${date}`
    );
    if (existing.length === 0) {
      await supabase("POST", "tracked_flights", null, {
        user_id: user.id, origin, destination: dest, date,
      }, "return=minimal");
      insertedFlight = true;
      console.log(`  inserted temporary tracked flight ${origin}-${dest}-${date}`);
    }
  } else {
    const flights = await sget(
      "tracked_flights",
      `select=origin,destination,date&user_id=eq.${user.id}&order=date.desc&limit=1`
    );
    if (flights.length === 0) {
      throw new Error("User has no tracked flights; pass TEST_ORIGIN/TEST_DEST/TEST_DATE.");
    }
    origin = flights[0].origin;
    dest = flights[0].destination;
    date = flights[0].date;
  }

  const flight = { origin, destination: dest, date };
  const flightKey = `${origin}-${dest}-${date}`.toUpperCase();
  console.log(`  using flight ${flightKey}`);

  // Ensure alerts are on with this email on file.
  await supabase("POST", "notification_preferences", null, {
    user_id: user.id,
    email: user.email,
    alerts_enabled: true,
    min_tier: "GOOD DEAL",
    max_price: null,
    updated_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=minimal");
  console.log("  preferences upserted (alerts on, GOOD DEAL+)");

  // Clear any prior alert state so this fires (armed = default true).
  await supabase(
    "DELETE", "user_flight_alert_state",
    `user_id=eq.${user.id}&flight_key=eq.${encodeURIComponent(flightKey)}`
  );

  const analysis = {
    tier: "BUY NOW",
    quality: 92,
    confidence: "high",
    daysToDeparture: 60,
    reasons: [
      "TEST ALERT — forced BUY NOW to verify email delivery",
      "at or near all-time low for this flight",
      "cheap for this weekday in the window",
    ],
    siblingSuggestion: null,
  };

  console.log("Running sendBuyAlerts()...");
  await sendBuyAlerts({
    flight,
    flightKey,
    analysis,
    price: 1, // tiny so any max_price passes
    currency: "RON",
    chartUrl: "https://chirucristian.github.io/flight-tracker/",
  });

  // Re-arm so this test doesn't suppress a future real alert.
  await supabase(
    "DELETE", "user_flight_alert_state",
    `user_id=eq.${user.id}&flight_key=eq.${encodeURIComponent(flightKey)}`
  );
  if (insertedFlight) {
    await supabase(
      "DELETE", "tracked_flights",
      `user_id=eq.${user.id}&origin=eq.${origin}&destination=eq.${dest}&date=eq.${date}`
    );
    console.log("  cleaned up temporary tracked flight");
  }

  console.log("\nDone. If RESEND_API_KEY is valid you should receive an email shortly.");
}

main().catch((err) => {
  console.error("TEST FAILED:", err.message);
  process.exit(1);
});
