// Standalone logic test for notify.js — mocks fetch, no network/prod access.
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "service-role-key";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.ALERT_FROM = "Test <onboarding@resend.dev>";

const assert = require("assert");

// In-memory alert_state keyed by `${user_id}|${flight_key}`
const stateStore = new Map();
const emailsSent = [];

global.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";

  if (url.includes("/rest/v1/tracked_flights")) {
    return jsonRes([{ user_id: "userA" }, { user_id: "userB" }, { user_id: "userA" }]);
  }
  if (url.includes("/rest/v1/notification_preferences")) {
    return jsonRes([
      { user_id: "userA", email: "a@example.com", alerts_enabled: true, min_tier: "GOOD DEAL", max_price: null },
      { user_id: "userB", email: "b@example.com", alerts_enabled: true, min_tier: "BUY NOW", max_price: null },
    ]);
  }
  if (url.includes("/rest/v1/user_flight_alert_state") && method === "GET") {
    return jsonRes([...stateStore.values()]);
  }
  if (url.includes("/rest/v1/user_flight_alert_state") && method === "POST") {
    const row = JSON.parse(opts.body);
    const key = `${row.user_id}|${row.flight_key}`;
    stateStore.set(key, { ...(stateStore.get(key) || {}), ...row });
    return jsonRes(null, 201);
  }
  if (url.includes("api.resend.com/emails")) {
    emailsSent.push(JSON.parse(opts.body));
    return jsonRes({ id: "email_123" });
  }
  throw new Error("Unexpected fetch: " + method + " " + url);
};

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const { sendBuyAlerts, tierMeets } = require("./notify");

const flight = { origin: "OTP", destination: "ORY", date: "2026-09-01" };
const flightKey = "OTP-ORY-2026-09-01";
const baseAnalysis = (tier) => ({
  tier, quality: 78, confidence: "high", daysToDeparture: 80, reasons: ["cheap for this weekday"],
  siblingSuggestion: null,
});

(async () => {
  // ---- tierMeets unit checks ----
  assert.strictEqual(tierMeets("GOOD DEAL", "GOOD DEAL"), true);
  assert.strictEqual(tierMeets("BUY NOW", "GOOD DEAL"), true);
  assert.strictEqual(tierMeets("GOOD DEAL", "BUY NOW"), false);
  assert.strictEqual(tierMeets("HOLD", "GOOD DEAL"), false);

  // ---- Run 1: tier=GOOD DEAL ----
  // userA (min GOOD DEAL, armed) -> email + disarm. userB (min BUY NOW) -> no email.
  await sendBuyAlerts({ flight, flightKey, analysis: baseAnalysis("GOOD DEAL"), price: 220, currency: "RON", chartUrl: "https://x/" });
  assert.strictEqual(emailsSent.length, 1, "exactly one email on run 1");
  assert.strictEqual(emailsSent[0].to[0], "a@example.com");
  assert.strictEqual(stateStore.get("userA|" + flightKey).armed, false, "userA disarmed");
  assert.ok(!stateStore.has("userB|" + flightKey), "userB has no state (never qualified)");

  // ---- Run 2: tier=GOOD DEAL again ----
  // userA already disarmed -> NO duplicate email.
  await sendBuyAlerts({ flight, flightKey, analysis: baseAnalysis("GOOD DEAL"), price: 220, currency: "RON", chartUrl: "https://x/" });
  assert.strictEqual(emailsSent.length, 1, "no duplicate email on run 2 (dedup works)");

  // ---- Run 3: tier=HOLD ----
  // userA no longer qualifies -> re-arm.
  await sendBuyAlerts({ flight, flightKey, analysis: baseAnalysis("HOLD"), price: 400, currency: "RON", chartUrl: "https://x/" });
  assert.strictEqual(stateStore.get("userA|" + flightKey).armed, true, "userA re-armed after dropping out");
  assert.strictEqual(emailsSent.length, 1, "still no new email on HOLD");

  // ---- Run 4: tier=BUY NOW ----
  // userA re-armed -> emails again. userB (min BUY NOW) now qualifies -> emails.
  await sendBuyAlerts({ flight, flightKey, analysis: baseAnalysis("BUY NOW"), price: 200, currency: "RON", chartUrl: "https://x/" });
  assert.strictEqual(emailsSent.length, 3, "two more emails on BUY NOW (userA re-fired + userB first)");
  const recipients = emailsSent.slice(1).map((e) => e.to[0]).sort();
  assert.deepStrictEqual(recipients, ["a@example.com", "b@example.com"]);

  console.log("All notify.js logic tests passed ✅");
})().catch((err) => {
  console.error("TEST FAILED:", err.message);
  process.exit(1);
});
