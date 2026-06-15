// Per-user buy-alert emails.
//
// Called once per flight at the end of the scrape loop. Fans the computed
// deal tier out to every user tracking that flight, respecting each user's
// notification_preferences, and emails them via Resend — with a per-user
// "armed" flag so each buy episode produces at most one email.
//
// Re-arm: when a flight is no longer a qualifying buy for a user, their
// alert state is re-armed so the *next* genuine buy window emails again.
//
// No-ops cleanly when RESEND_API_KEY is unset (e.g. local/dev runs).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM = process.env.ALERT_FROM || "Flight Tracker <onboarding@resend.dev>";
const SITE_URL =
  process.env.ALERT_SITE_URL || "https://chirucristian.github.io/flight-tracker/";

const TIER_RANK = { SKIP: 0, HOLD: 1, "GOOD DEAL": 2, "BUY NOW": 3 };

function tierMeets(tier, minTier) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[minTier] ?? 99);
}

// ---- Supabase REST helpers (service role) ----

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseGet(table, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function supabaseUpsert(table, row, onConflict) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (onConflict) url += `?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert ${table} failed: ${res.status} ${await res.text()}`);
  }
}

// ---- Email rendering ----

function wizzairUrl(flight) {
  return `https://www.wizzair.com/en-gb/booking/select-flight/${flight.origin}/${flight.destination}/${flight.date}/null/1/0/0/null`;
}

function buildEmail(flight, price, currency, analysis, chartUrl) {
  const label = `${flight.origin} → ${flight.destination} · ${flight.date}`;
  const tier = analysis.tier;
  const reasons =
    analysis.reasons && analysis.reasons.length
      ? analysis.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
      : "<li>Price has reached a level the heuristic rates as a good buy.</li>";

  const sibling = analysis.siblingSuggestion
    ? `<p style="margin:12px 0;padding:10px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:14px;color:#166534;">
         💡 <strong>${escapeHtml(analysis.siblingSuggestion.date)}</strong> is
         ${escapeHtml(String(analysis.siblingSuggestion.price))} ${escapeHtml(currency)} —
         ${escapeHtml(String(analysis.siblingSuggestion.savingsPct))}% cheaper than ${escapeHtml(flight.date)}.
       </p>`
    : "";

  const subject = `${tier}: ${price} ${currency} — ${flight.origin}→${flight.destination} ${flight.date}`;

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
        <span style="display:inline-block;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#15803d;background:#dcfce7;border:1px solid #86efac;padding:5px 11px;border-radius:6px;">${escapeHtml(tier)}</span>
        <h1 style="font-size:20px;color:#0f172a;margin:16px 0 4px;">${escapeHtml(label)}</h1>
        <p style="font-size:28px;font-weight:700;color:#0f172a;margin:8px 0;">${escapeHtml(String(price))} ${escapeHtml(currency)}</p>
        <table style="font-size:13px;color:#475569;border-collapse:collapse;margin:12px 0;">
          <tr><td style="padding:2px 12px 2px 0;">Quality</td><td style="font-weight:600;">${escapeHtml(String(analysis.quality))} / 100</td></tr>
          <tr><td style="padding:2px 12px 2px 0;">Confidence</td><td style="font-weight:600;">${escapeHtml(String(analysis.confidence))}</td></tr>
          <tr><td style="padding:2px 12px 2px 0;">Days to departure</td><td style="font-weight:600;">${escapeHtml(String(analysis.daysToDeparture))}</td></tr>
        </table>
        <p style="font-size:13px;font-weight:600;color:#475569;margin:16px 0 6px;">Why now</p>
        <ul style="font-size:13px;color:#475569;margin:0;padding-left:18px;line-height:1.6;">${reasons}</ul>
        ${sibling}
        <div style="margin:20px 0 4px;">
          <a href="${wizzairUrl(flight)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px;">Check on Wizzair →</a>
          <a href="${escapeHtml(chartUrl)}" style="display:inline-block;color:#2563eb;text-decoration:none;font-size:14px;padding:10px 12px;">Price chart</a>
        </div>
      </div>
      <p style="font-size:11px;color:#94a3b8;text-align:center;margin:16px 0 0;">
        You're getting this because email alerts are on for this flight.
        <a href="${escapeHtml(SITE_URL)}" style="color:#94a3b8;">Manage alerts</a>.
      </p>
    </div>
  </body></html>`;

  return { subject, html };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendEmail(to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: ALERT_FROM, to: [to], subject, html }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

// ---- Main entry ----

async function sendBuyAlerts({ flight, flightKey, analysis, price, currency, chartUrl }) {
  if (!RESEND_API_KEY) {
    console.log("  [notify] RESEND_API_KEY not set — skipping email alerts");
    return;
  }
  if (!analysis || price == null) return;

  const tier = analysis.tier;

  // 1. Users tracking this exact flight.
  const trackers = await supabaseGet(
    "tracked_flights",
    `select=user_id&origin=eq.${encodeURIComponent(flight.origin)}` +
      `&destination=eq.${encodeURIComponent(flight.destination)}` +
      `&date=eq.${encodeURIComponent(flight.date)}`
  );
  const userIds = [...new Set(trackers.map((t) => t.user_id).filter(Boolean))];
  if (userIds.length === 0) return;

  const inList = `in.(${userIds.join(",")})`;

  // 2. Preferences + current alert state for those users.
  const [prefsRows, stateRows] = await Promise.all([
    supabaseGet("notification_preferences", `select=*&user_id=${inList}`),
    supabaseGet(
      "user_flight_alert_state",
      `select=*&flight_key=eq.${encodeURIComponent(flightKey)}&user_id=${inList}`
    ),
  ]);
  const prefsByUser = new Map(prefsRows.map((p) => [p.user_id, p]));
  const stateByUser = new Map(stateRows.map((s) => [s.user_id, s]));

  for (const userId of userIds) {
    const prefs = prefsByUser.get(userId);
    if (!prefs || !prefs.email) continue; // no address on file → can't notify

    const state = stateByUser.get(userId);
    const armed = state ? state.armed : true;

    const qualifies =
      prefs.alerts_enabled !== false &&
      tierMeets(tier, prefs.min_tier || "GOOD DEAL") &&
      (prefs.max_price == null || price <= Number(prefs.max_price));

    if (qualifies && armed) {
      try {
        const { subject, html } = buildEmail(flight, price, currency, analysis, chartUrl);
        await sendEmail(prefs.email, subject, html);
        await supabaseUpsert(
          "user_flight_alert_state",
          {
            user_id: userId,
            flight_key: flightKey,
            last_notified_tier: tier,
            last_notified_price: price,
            last_notified_at: new Date().toISOString(),
            armed: false,
          },
          "user_id,flight_key"
        );
        console.log(`  [notify] emailed ${prefs.email} for ${flightKey} (${tier})`);
      } catch (err) {
        console.error(`  [notify] failed for ${prefs.email} / ${flightKey}: ${err.message}`);
      }
    } else if (!qualifies && !armed) {
      // Flight is no longer a buy for this user — re-arm for the next episode.
      try {
        await supabaseUpsert(
          "user_flight_alert_state",
          { user_id: userId, flight_key: flightKey, armed: true },
          "user_id,flight_key"
        );
        console.log(`  [notify] re-armed ${userId} for ${flightKey}`);
      } catch (err) {
        console.error(`  [notify] re-arm failed for ${userId} / ${flightKey}: ${err.message}`);
      }
    }
  }
}

module.exports = { sendBuyAlerts, tierMeets, buildEmail };
