// Fare analysis heuristic for Wizz Air / Ryanair style low-cost carriers.
//
// Quality score (0-100) from 5 orthogonal signals with graceful degradation:
//   1. DOW-normalized window percentile (30 pts) — cheap for this weekday?
//   2. Bucket position (25 pts)                  — which rung of the fare ladder?
//   3. DTD-floor proximity (20 pts)              — best seen at this booking stage?
//   4. Sibling-date independence (15 pts)        — is a nearby date cheaper?
//   5. Absolute-floor proximity (10 pts)         — close to all-time min for this flight?
//
// Urgency level (low/medium/high) from:
//   - Days-to-departure curve
//   - 7-day rising trend
//   - Bucket ceiling proximity
//
// Decision tier comes from a Quality x Urgency matrix — urgency amplifies
// good deals but never rescues bad ones.

function analyze({
  flightDate,
  currentPrice,
  currency,
  windowEntries,
  history,
  calculateRealPrice,
  now,
}) {
  const nowDate = now ? new Date(now) : new Date();

  // Normalize the 60-day (currently ~15-day) window to real prices.
  const window = (windowEntries || [])
    .filter((e) => e && e.priceType === "price" && e.price && e.price.amount > 0)
    .map((e) => ({
      date: (e.date || "").substring(0, 10),
      price: calculateRealPrice(e.price.amount),
    }));

  const validHistory = (history || []).filter(
    (h) => h && typeof h.price === "number" && h.price > 0
  );

  const target = new Date(flightDate + "T00:00:00Z");
  const daysToDeparture = Math.max(
    0,
    Math.round((target.getTime() - nowDate.getTime()) / 86400000)
  );

  // ---------- Signal 1: DOW-normalized window percentile (max 30) ----------
  const targetDOW = target.getUTCDay();
  const sameDowPrices = window
    .filter((w) => {
      const d = new Date(w.date + "T00:00:00Z");
      return d.getUTCDay() === targetDOW;
    })
    .map((w) => w.price);

  let dowScore = 0;
  let dowActive = false;
  let dowFallback = false;
  if (sameDowPrices.length >= 4) {
    dowScore = percentileScore(currentPrice, sameDowPrices, 30);
    dowActive = true;
  } else if (window.length >= 4) {
    dowScore = percentileScore(currentPrice, window.map((w) => w.price), 30);
    dowActive = true;
    dowFallback = true;
  }

  // ---------- Signal 2: bucket position (max 25) ----------
  const sortedWindow = window.map((w) => w.price).sort((a, b) => a - b);
  const buckets = clusterBuckets(sortedWindow);
  let bucketScore = 0;
  let bucketActive = false;
  let currentBucketIndex = null;
  if (buckets.length >= 2) {
    currentBucketIndex = findBucketIndex(currentPrice, buckets);
    bucketScore =
      25 * (1 - currentBucketIndex / Math.max(buckets.length - 1, 1));
    bucketActive = true;
  }

  // ---------- Signal 3: DTD-floor proximity (max 20) ----------
  // "Lowest price ever observed with at least this many days to departure."
  let dtdFloorScore = 0;
  let dtdFloorActive = false;
  let dtdFloor = null;
  const historicalAtOrBeyondDTD = validHistory
    .map((h) => {
      const dtd = Math.round(
        (target.getTime() - new Date(h.timestamp).getTime()) / 86400000
      );
      return { price: h.price, dtd };
    })
    .filter((h) => h.dtd >= daysToDeparture);

  if (historicalAtOrBeyondDTD.length >= 5) {
    dtdFloor = Math.min(...historicalAtOrBeyondDTD.map((h) => h.price));
    const ratio = (currentPrice - dtdFloor) / dtdFloor;
    dtdFloorScore = 20 * Math.max(0, 1 - ratio / 0.25);
    dtdFloorActive = true;
  }

  // ---------- Signal 4: sibling-date independence (max 15) ----------
  const targetTs = target.getTime();
  const siblings = window.filter((w) => {
    const d = new Date(w.date + "T00:00:00Z").getTime();
    const delta = Math.round((d - targetTs) / 86400000);
    return delta >= -3 && delta <= 3 && w.date !== flightDate;
  });

  let siblingScore = 15;
  let siblingActive = siblings.length > 0;
  let siblingSuggestion = null;
  if (siblings.length > 0) {
    const cheapest = siblings.reduce((a, b) => (a.price < b.price ? a : b));
    const gap = (cheapest.price - currentPrice) / currentPrice;
    if (gap < 0) {
      // A sibling is cheaper than the queried date.
      siblingScore = 15 * Math.max(0, 1 - -gap / 0.25);
      if (-gap >= 0.15) {
        siblingSuggestion = {
          date: cheapest.date,
          price: cheapest.price,
          savingsPct: Math.round(-gap * 100),
        };
      }
    }
  }

  // ---------- Signal 5: absolute-floor proximity (max 10) ----------
  let absFloorScore = 0;
  let absFloorActive = false;
  let absoluteMin = null;
  if (validHistory.length >= 3) {
    absoluteMin = Math.min(...validHistory.map((h) => h.price));
    const ratio = (currentPrice - absoluteMin) / absoluteMin;
    absFloorScore = 10 * Math.max(0, 1 - ratio / 0.25);
    absFloorActive = true;
  }

  // ---------- Compose quality score with graceful degradation ----------
  const signalDefs = [
    { key: "dowPercentile", value: dowScore, max: 30, active: dowActive },
    { key: "bucketPosition", value: bucketScore, max: 25, active: bucketActive },
    { key: "dtdFloor", value: dtdFloorScore, max: 20, active: dtdFloorActive },
    { key: "siblingIndependence", value: siblingScore, max: 15, active: siblingActive },
    { key: "absoluteFloor", value: absFloorScore, max: 10, active: absFloorActive },
  ];

  const activeMax = signalDefs
    .filter((s) => s.active)
    .reduce((sum, s) => sum + s.max, 0);
  const rawTotal = signalDefs
    .filter((s) => s.active)
    .reduce((sum, s) => sum + s.value, 0);
  const quality = activeMax > 0 ? Math.round((rawTotal / activeMax) * 100) : 0;

  // ---------- Urgency ----------
  let urgencyScore = 0;
  if (daysToDeparture > 120) urgencyScore += 0;
  else if (daysToDeparture > 90) urgencyScore += 2;
  else if (daysToDeparture > 60) urgencyScore += 4;
  else if (daysToDeparture > 30) urgencyScore += 5;
  else if (daysToDeparture > 14) urgencyScore += 4;
  else if (daysToDeparture > 7) urgencyScore += 2;
  else urgencyScore += 1;

  // 7-day rising trend — use the OLDEST observation within the last 7 days
  // as the baseline, so we measure "how much has it moved over the last week".
  const sevenDaysAgoTs = nowDate.getTime() - 7 * 86400000;
  const recentSorted = validHistory
    .map((h) => ({ ts: new Date(h.timestamp).getTime(), price: h.price }))
    .filter((h) => h.ts >= sevenDaysAgoTs)
    .sort((a, b) => a.ts - b.ts);

  let sevenDayChange = null;
  if (recentSorted.length > 0) {
    const baseline = recentSorted[0].price;
    sevenDayChange = (currentPrice - baseline) / baseline;
    if (sevenDayChange >= 0.2) urgencyScore += 3;
    else if (sevenDayChange >= 0.1) urgencyScore += 2;
    else if (sevenDayChange >= 0.05) urgencyScore += 1;
  }

  // Bucket ceiling proximity — within 5% of the top of the current bucket.
  let bucketCeilingWarning = false;
  if (
    currentBucketIndex !== null &&
    buckets.length > 1 &&
    currentBucketIndex < buckets.length - 1
  ) {
    const bucketMax = Math.max(...buckets[currentBucketIndex]);
    if (currentPrice >= bucketMax * 0.95) {
      urgencyScore += 2;
      bucketCeilingWarning = true;
    }
  }

  let urgency = "low";
  if (urgencyScore >= 7) urgency = "high";
  else if (urgencyScore >= 4) urgency = "medium";

  // ---------- Decision matrix ----------
  const tier = decideTier(quality, urgency);

  // ---------- Confidence ----------
  const historyDays = calcHistorySpanDays(validHistory);
  const windowPriced = window.length;
  const numBuckets = buckets.length;
  let confidence = "low";
  if (historyDays >= 21 && windowPriced >= 12 && numBuckets >= 3) {
    confidence = "high";
  } else if (historyDays >= 7 && windowPriced >= 8 && numBuckets >= 2) {
    confidence = "medium";
  }

  // ---------- Human-readable reasons ----------
  const reasons = [];
  if (dowActive) {
    if (dowScore >= 24) {
      reasons.push(
        dowFallback
          ? "cheap versus nearby dates (insufficient same-weekday data)"
          : "cheap for this weekday in the window"
      );
    } else if (dowScore <= 6) {
      reasons.push(
        dowFallback
          ? "expensive versus nearby dates"
          : "expensive for this weekday in the window"
      );
    }
  }
  if (bucketActive) {
    if (currentBucketIndex === 0) {
      reasons.push(`lowest of ${buckets.length} detected fare buckets`);
    } else if (currentBucketIndex >= buckets.length - 1) {
      reasons.push(`top of ${buckets.length} detected fare buckets`);
    } else {
      reasons.push(
        `bucket ${currentBucketIndex + 1}/${buckets.length} (1 = cheapest)`
      );
    }
  }
  if (dtdFloorActive && dtdFloorScore >= 16) {
    reasons.push("at or near the best price seen at this booking stage");
  } else if (dtdFloorActive && dtdFloorScore <= 4) {
    reasons.push("well above best price seen at this booking stage");
  }
  if (siblingSuggestion) {
    reasons.push(
      `${siblingSuggestion.savingsPct}% cheaper on ${siblingSuggestion.date}`
    );
  }
  if (absFloorActive && absFloorScore >= 8) {
    reasons.push("at or near all-time low for this flight");
  }
  if (sevenDayChange !== null && sevenDayChange >= 0.1) {
    reasons.push(
      `up ${Math.round(sevenDayChange * 100)}% in the last 7 days — window closing`
    );
  }
  if (bucketCeilingWarning) {
    reasons.push("near top of current bucket — jump imminent if this fares out");
  }

  const signals = Object.fromEntries(
    signalDefs.map((s) => [
      s.key,
      {
        value: Math.round(s.value * 10) / 10,
        max: s.max,
        active: s.active,
      },
    ])
  );

  return {
    tier,
    quality,
    urgency,
    urgencyScore,
    confidence,
    daysToDeparture,
    signals,
    siblingSuggestion,
    bucketCeilingWarning,
    buckets: buckets.map((b) => ({
      min: Math.min(...b),
      max: Math.max(...b),
      count: b.length,
    })),
    currentBucketIndex,
    sevenDayChangePct:
      sevenDayChange !== null ? Math.round(sevenDayChange * 1000) / 10 : null,
    dtdFloor,
    absoluteMin,
    reasons,
  };
}

function percentileScore(value, values, maxPoints) {
  if (!values || values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return maxPoints;
  const normalized = (value - min) / (max - min);
  return maxPoints * Math.max(0, Math.min(1, 1 - normalized));
}

// Gap-based clustering: split whenever the gap to the next price exceeds
// a fraction of the median. 7% is a starting value tuned for LCC bucket jumps.
function clusterBuckets(sortedPrices, thresholdRatio = 0.07) {
  if (!sortedPrices || sortedPrices.length === 0) return [];
  if (sortedPrices.length === 1) return [[sortedPrices[0]]];

  const median = sortedPrices[Math.floor(sortedPrices.length / 2)];
  const threshold = Math.max(1, median * thresholdRatio);

  const buckets = [[sortedPrices[0]]];
  for (let i = 1; i < sortedPrices.length; i++) {
    const gap = sortedPrices[i] - sortedPrices[i - 1];
    if (gap > threshold) {
      buckets.push([sortedPrices[i]]);
    } else {
      buckets[buckets.length - 1].push(sortedPrices[i]);
    }
  }
  return buckets;
}

function findBucketIndex(price, buckets) {
  for (let i = 0; i < buckets.length; i++) {
    const bMin = Math.min(...buckets[i]);
    const bMax = Math.max(...buckets[i]);
    if (price >= bMin && price <= bMax) return i;
  }
  // Price falls outside all observed buckets — snap to nearest by mean.
  let nearest = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < buckets.length; i++) {
    const mean = buckets[i].reduce((a, b) => a + b, 0) / buckets[i].length;
    const dist = Math.abs(price - mean);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = i;
    }
  }
  return nearest;
}

function decideTier(quality, urgency) {
  const u = urgency === "low" ? 0 : urgency === "medium" ? 1 : 2;
  if (quality >= 85) return u >= 1 ? "BUY NOW" : "GOOD DEAL";
  if (quality >= 70) return u >= 2 ? "BUY NOW" : u >= 1 ? "GOOD DEAL" : "HOLD";
  if (quality >= 55) return u >= 2 ? "GOOD DEAL" : "HOLD";
  if (quality >= 40) return u >= 1 ? "HOLD" : "SKIP";
  return "SKIP";
}

function calcHistorySpanDays(history) {
  if (!history || history.length < 2) return 0;
  const timestamps = history.map((h) => new Date(h.timestamp).getTime());
  return (Math.max(...timestamps) - Math.min(...timestamps)) / 86400000;
}

module.exports = { analyze, clusterBuckets, decideTier };
