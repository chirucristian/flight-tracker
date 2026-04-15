// Fare analysis heuristic for Wizz Air / Ryanair style low-cost carriers.
//
// Quality score (0-100) from 6 signals with graceful degradation:
//   1. DOW-normalized window percentile (30 pts, 20 when fallback)
//        — cheap for this weekday? Uses mid-rank percentile (outlier-robust).
//   2. Bucket position (25 pts) — which rung of the detected fare ladder?
//   3. DTD-floor proximity (15 pts) — best seen at this booking stage?
//   4. Sibling-date independence (15 pts) — is a nearby date cheaper?
//        Searches ±5 days; partially restores score for structurally cheaper siblings.
//   5. Absolute-floor proximity (10 pts) — close to all-time min for this flight?
//   6. Window price trend (10 pts, hist only) — is the surrounding window dropping?
//
// Urgency level (low/medium/high) from:
//   - Days-to-departure curve
//   - 7-day rising trend (baseline = median of earlier half, not single oldest)
//   - Bucket ceiling proximity (only with ≥3 samples in current bucket)
//   - Bucket transition (moved up a bucket since last observation)
//   - Rising fare window trend
//
// Decision tier comes from a Quality x Urgency matrix — urgency amplifies
// good deals but never rescues bad ones. Low confidence then downgrades the
// tier by one step (BUY NOW → GOOD DEAL → HOLD) so sparse-data calls never
// produce a false-positive buy signal.
//
// historicalWindowEntries (optional): full window-cache array for this flight.
// When absent or empty all historical signals degrade gracefully to current-
// snapshot behaviour — no behaviour change for callers that omit the field.

function analyze({
  flightDate,
  currentPrice,
  currency,
  windowEntries,
  historicalWindowEntries,
  history,
  calculateRealPrice,
  now,
}) {
  const nowDate = now ? new Date(now) : new Date();

  // Normalize the current snapshot window to real prices.
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

  // ---- Build historical window structures (from window-cache) ----
  //
  // histWindow      : most-recent observed price per calendar date across all
  //                   scrapes. Richer than a single snapshot; used for DOW,
  //                   bucket, and sibling signals.
  //
  // snapshotGroups  : Map<observedAt (YYYY-MM-DD), Map<calDate, realPrice>>
  //                   Used for bucket-transition and window-trend signals.
  //
  // When historicalWindowEntries is absent/empty, histWindow falls back to
  // the current snapshot and snapshotGroups stays empty — all new signals
  // deactivate automatically via their `active` flags.
  const hasHistorical =
    Array.isArray(historicalWindowEntries) && historicalWindowEntries.length > 0;

  let histWindow = window; // fallback: same as current snapshot
  let distinctObsDays = 0;
  const snapshotGroups = new Map(); // observedAt → Map<calDate, realPrice>

  if (hasHistorical) {
    const latestPerDate = new Map(); // calDate → { price, observedAt }

    for (const e of historicalWindowEntries) {
      if (!e || e.priceType !== "price" || !e.price || !(e.price.amount > 0)) continue;
      const calDate = (e.date || "").substring(0, 10);
      const obsDate = (e.observedAt || "").substring(0, 10);
      if (!calDate || !obsDate) continue;

      // Per-snapshot group (bucket-transition / window-trend analysis)
      if (!snapshotGroups.has(obsDate)) snapshotGroups.set(obsDate, new Map());
      const sg = snapshotGroups.get(obsDate);
      if (!sg.has(calDate)) sg.set(calDate, calculateRealPrice(e.price.amount));

      // Track most-recently-observed price per calendar date
      const prev = latestPerDate.get(calDate);
      if (!prev || obsDate > prev.observedAt) {
        latestPerDate.set(calDate, {
          price: calculateRealPrice(e.price.amount),
          observedAt: obsDate,
        });
      }
    }

    distinctObsDays = snapshotGroups.size;
    if (latestPerDate.size > 0) {
      histWindow = Array.from(latestPerDate.entries()).map(([date, v]) => ({
        date,
        price: v.price,
      }));
    }
  }

  // ---------- Signal 1: DOW-normalized window percentile (max 30) ----------
  const targetDOW = target.getUTCDay();

  // Prefer histWindow (richer dataset) for same-DOW prices; fall back to
  // current snapshot, then all-prices fallback.
  const sameDowHistPrices = histWindow
    .filter((w) => new Date(w.date + "T00:00:00Z").getUTCDay() === targetDOW)
    .map((w) => w.price);
  const sameDowSnapPrices = window
    .filter((w) => new Date(w.date + "T00:00:00Z").getUTCDay() === targetDOW)
    .map((w) => w.price);

  let dowScore = 0;
  let dowActive = false;
  let dowFallback = false;
  // Fallback halves-ish the weight (30 → 20) so a non-DOW-specific percentile
  // can't masquerade as a DOW-specific one in the normalization.
  const dowMaxFull = 30;
  const dowMaxFallback = 20;
  let dowMax = dowMaxFull;
  if (sameDowHistPrices.length >= 4) {
    dowScore = percentileScore(currentPrice, sameDowHistPrices, dowMaxFull);
    dowActive = true;
  } else if (sameDowSnapPrices.length >= 4) {
    dowScore = percentileScore(currentPrice, sameDowSnapPrices, dowMaxFull);
    dowActive = true;
  } else if (histWindow.length >= 4) {
    dowScore = percentileScore(currentPrice, histWindow.map((w) => w.price), dowMaxFallback);
    dowActive = true;
    dowFallback = true;
    dowMax = dowMaxFallback;
  } else if (window.length >= 4) {
    dowScore = percentileScore(currentPrice, window.map((w) => w.price), dowMaxFallback);
    dowActive = true;
    dowFallback = true;
    dowMax = dowMaxFallback;
  }

  // ---------- Signal 2: bucket position (max 25) ----------
  // Use the richer dataset for clustering; more price points → better gaps.
  const clusterSource = histWindow.length > window.length ? histWindow : window;
  const sortedCluster = clusterSource.map((w) => w.price).sort((a, b) => a - b);
  const buckets = clusterBuckets(sortedCluster);
  let bucketScore = 0;
  let bucketActive = false;
  let currentBucketIndex = null;
  if (buckets.length >= 2) {
    currentBucketIndex = findBucketIndex(currentPrice, buckets);
    bucketScore =
      25 * (1 - currentBucketIndex / Math.max(buckets.length - 1, 1));
    bucketActive = true;
  }

  // Bucket transition: did the target date move to a higher/lower bucket?
  // Compare relative bucket position between the two most recent observation days
  // that both contain a price for the target flight date.
  let bucketTransition = null; // 'up' | 'down' | null
  if (hasHistorical && snapshotGroups.size >= 2) {
    const sortedObs = Array.from(snapshotGroups.keys()).sort();
    const snapsWithTarget = sortedObs.filter((d) =>
      snapshotGroups.get(d).has(flightDate)
    );
    if (snapsWithTarget.length >= 2) {
      const prevObs = snapsWithTarget[snapsWithTarget.length - 2];
      const currObs = snapsWithTarget[snapsWithTarget.length - 1];
      const prevSg = snapshotGroups.get(prevObs);
      const currSg = snapshotGroups.get(currObs);
      const prevBuckets = clusterBuckets(
        Array.from(prevSg.values()).sort((a, b) => a - b)
      );
      const currBucketsSnap = clusterBuckets(
        Array.from(currSg.values()).sort((a, b) => a - b)
      );
      if (prevBuckets.length >= 2 && currBucketsSnap.length >= 2) {
        const prevIdx = findBucketIndex(prevSg.get(flightDate), prevBuckets);
        const currIdx = findBucketIndex(currSg.get(flightDate), currBucketsSnap);
        const prevRel = prevIdx / Math.max(prevBuckets.length - 1, 1);
        const currRel = currIdx / Math.max(currBucketsSnap.length - 1, 1);
        if (currRel > prevRel + 0.15) bucketTransition = "up";
        else if (currRel < prevRel - 0.15) bucketTransition = "down";
      }
    }
  }

  // ---------- Signal 3: DTD-floor proximity (max 15) ----------
  // "Lowest price ever observed with at least this many days to departure."
  // Weight reduced from 20 → 15 since it partially overlaps absolute-floor.
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
    dtdFloorScore = 15 * Math.max(0, 1 - ratio / 0.25);
    dtdFloorActive = true;
  }

  // ---------- Signal 4: sibling-date independence (max 15) ----------
  // ±5 day window (was ±3) — wider alternative search for genuinely cheaper dates.
  const targetTs = target.getTime();
  // Use histWindow for sibling prices when it has more data.
  const siblingSource = histWindow.length > window.length ? histWindow : window;
  const siblings = siblingSource.filter((w) => {
    const d = new Date(w.date + "T00:00:00Z").getTime();
    const delta = Math.round((d - targetTs) / 86400000);
    return delta >= -5 && delta <= 5 && w.date !== flightDate;
  });

  let siblingScore = 15;
  let siblingActive = siblings.length > 0;
  let siblingSuggestion = null;
  if (siblings.length > 0) {
    const cheapest = siblings.reduce((a, b) => (a.price < b.price ? a : b));
    const gap = (cheapest.price - currentPrice) / currentPrice;
    if (gap < 0) {
      siblingScore = 15 * Math.max(0, 1 - -gap / 0.25);

      // With enough history, check if the sibling is *persistently* cheaper.
      // A structurally cheaper sibling is less meaningful as a signal, so
      // partially restore the score when it was always cheaper.
      if (hasHistorical && snapshotGroups.size >= 3) {
        const sibDate = cheapest.date;
        const snapsWithBoth = Array.from(snapshotGroups.values()).filter(
          (sg) => sg.has(flightDate) && sg.has(sibDate)
        );
        if (snapsWithBoth.length >= 3) {
          const alwaysCheaper = snapsWithBoth.filter(
            (sg) => sg.get(sibDate) < sg.get(flightDate)
          ).length;
          if (alwaysCheaper / snapsWithBoth.length >= 0.8) {
            // Structural price gap — partial score restoration
            siblingScore = Math.min(15, siblingScore * 1.5);
          }
        }
      }

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

  // ---------- Signal 6: window price trend (max 10, historical only) ----------
  // Median window price per observation day → overall fare-window direction.
  // Dropping window → quality boost (prices softening, good time to buy).
  // Rising window → urgency boost (handled in urgency section; score stays 0).
  // Stable window → neutral (half score).
  let windowTrendScore = 0;
  let windowTrendActive = false;
  let windowTrendDirection = null; // 'dropping' | 'stable' | 'rising'
  let windowTrendPct = null;

  if (hasHistorical && snapshotGroups.size >= 3) {
    const sortedObs = Array.from(snapshotGroups.keys()).sort();
    const medians = sortedObs
      .map((obsDate) => {
        const prices = Array.from(snapshotGroups.get(obsDate).values()).sort(
          (a, b) => a - b
        );
        return prices.length > 0 ? prices[Math.floor(prices.length / 2)] : null;
      })
      .filter((m) => m !== null);

    if (medians.length >= 3) {
      const first = medians[0];
      const last = medians[medians.length - 1];
      const trendFrac = (last - first) / first;
      windowTrendPct = Math.round(trendFrac * 1000) / 10;

      if (trendFrac <= -0.03) {
        windowTrendDirection = "dropping";
        windowTrendScore = 10 * Math.min(1, -trendFrac / 0.15);
        windowTrendActive = true;
      } else if (trendFrac >= 0.03) {
        windowTrendDirection = "rising";
        windowTrendScore = 0; // urgency boosted below instead
        windowTrendActive = true;
      } else {
        windowTrendDirection = "stable";
        windowTrendScore = 5;
        windowTrendActive = true;
      }
    }
  }

  // ---------- Compose quality score with graceful degradation ----------
  const signalDefs = [
    { key: "dowPercentile", value: dowScore, max: dowMax, active: dowActive },
    { key: "bucketPosition", value: bucketScore, max: 25, active: bucketActive },
    { key: "dtdFloor", value: dtdFloorScore, max: 15, active: dtdFloorActive },
    { key: "siblingIndependence", value: siblingScore, max: 15, active: siblingActive },
    { key: "absoluteFloor", value: absFloorScore, max: 10, active: absFloorActive },
    { key: "windowTrend", value: windowTrendScore, max: 10, active: windowTrendActive },
  ];

  const activeMax = signalDefs
    .filter((s) => s.active)
    .reduce((sum, s) => sum + s.max, 0);
  const rawTotal = signalDefs
    .filter((s) => s.active)
    .reduce((sum, s) => sum + s.value, 0);
  const quality = activeMax > 0 ? Math.round((rawTotal / activeMax) * 100) : 0;

  // ---------- Urgency ----------
  // Urgency is still tracked for telemetry/logging, but it is intentionally
  // NOT fed into decideTier — quality alone determines the deal tier.
  let urgencyScore = 0;
  if (daysToDeparture > 120) urgencyScore += 0;
  else if (daysToDeparture > 90) urgencyScore += 2;
  else if (daysToDeparture > 60) urgencyScore += 4;
  else if (daysToDeparture > 30) urgencyScore += 5;
  else if (daysToDeparture > 14) urgencyScore += 4;
  else if (daysToDeparture > 7) urgencyScore += 2;
  else urgencyScore += 1;

  // 7-day rising trend — baseline is the median of the EARLIER HALF of the
  // last week's observations, not the single oldest scrape. One stale or
  // noisy early point shouldn't be able to dictate the whole comparison.
  const sevenDaysAgoTs = nowDate.getTime() - 7 * 86400000;
  const recentSorted = validHistory
    .map((h) => ({ ts: new Date(h.timestamp).getTime(), price: h.price }))
    .filter((h) => h.ts >= sevenDaysAgoTs)
    .sort((a, b) => a.ts - b.ts);

  let sevenDayChange = null;
  if (recentSorted.length >= 2) {
    const half = Math.max(1, Math.floor(recentSorted.length / 2));
    const earlyPrices = recentSorted
      .slice(0, half)
      .map((h) => h.price)
      .sort((a, b) => a - b);
    const baseline = earlyPrices[Math.floor(earlyPrices.length / 2)];
    sevenDayChange = (currentPrice - baseline) / baseline;
    if (sevenDayChange >= 0.2) urgencyScore += 3;
    else if (sevenDayChange >= 0.1) urgencyScore += 2;
    else if (sevenDayChange >= 0.05) urgencyScore += 1;
  } else if (recentSorted.length === 1) {
    const baseline = recentSorted[0].price;
    sevenDayChange = (currentPrice - baseline) / baseline;
    if (sevenDayChange >= 0.2) urgencyScore += 3;
    else if (sevenDayChange >= 0.1) urgencyScore += 2;
    else if (sevenDayChange >= 0.05) urgencyScore += 1;
  }

  // Bucket ceiling proximity — within 5% of the top of the current bucket.
  // Require ≥3 samples in the current bucket so a 1-2 point bucket can't
  // produce a spurious "near ceiling" warning.
  let bucketCeilingWarning = false;
  if (
    currentBucketIndex !== null &&
    buckets.length > 1 &&
    currentBucketIndex < buckets.length - 1 &&
    buckets[currentBucketIndex].length >= 3
  ) {
    const bucketMax = Math.max(...buckets[currentBucketIndex]);
    if (currentPrice >= bucketMax * 0.95) {
      urgencyScore += 2;
      bucketCeilingWarning = true;
    }
  }

  // Bucket transition — moving up a bucket signals escalating price tier.
  if (bucketTransition === "up") urgencyScore += 2;

  // Rising fare window — broad upward pressure across the window.
  if (windowTrendDirection === "rising" && windowTrendPct !== null) {
    if (windowTrendPct >= 20) urgencyScore += 3;
    else if (windowTrendPct >= 10) urgencyScore += 2;
    else if (windowTrendPct >= 3) urgencyScore += 1;
  }

  let urgency = "low";
  if (urgencyScore >= 7) urgency = "high";
  else if (urgencyScore >= 4) urgency = "medium";

  // ---------- Confidence ----------
  const historyDays = calcHistorySpanDays(validHistory);
  // Use the richer dataset for the window-coverage count.
  const windowPriced = histWindow.length;
  const numBuckets = buckets.length;
  let confidence = "low";
  if (historyDays >= 21 && windowPriced >= 12 && numBuckets >= 3) {
    confidence = "high";
  } else if (historyDays >= 7 && windowPriced >= 8 && numBuckets >= 2) {
    confidence = "medium";
  }
  // Historical depth (number of distinct observation days) can promote
  // confidence one level beyond what history span + window size alone support.
  if (distinctObsDays >= 5 && confidence === "medium") confidence = "high";
  if (distinctObsDays >= 3 && confidence === "low" && windowPriced >= 6) {
    confidence = "medium";
  }

  // ---------- Decision matrix (confidence-aware) ----------
  // Runs after confidence so low-confidence calls can be downgraded instead
  // of producing false-positive buy signals on sparse data.
  const tier = decideTier(quality, urgency, confidence);

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
  if (bucketTransition === "up") {
    reasons.push("moved up a fare bucket since last observation — price escalating");
  } else if (bucketTransition === "down") {
    reasons.push("dropped to a lower fare bucket since last observation");
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
  if (windowTrendActive) {
    if (windowTrendDirection === "dropping") {
      reasons.push(
        `fare window trending down ${Math.abs(windowTrendPct)}% — prices softening`
      );
    } else if (windowTrendDirection === "rising") {
      reasons.push(
        `fare window trending up ${windowTrendPct}% — broader price pressure`
      );
    }
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
    bucketTransition,
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
    windowTrendDirection,
    windowTrendPct,
    distinctObsDays,
    reasons,
  };
}

// True rank-based (mid-rank) percentile. A single outlier cheap fare used to
// compress the whole scale with the old min-max approach; rank is robust to
// that. Returns maxPoints when `value` is the cheapest in `values`.
function percentileScore(value, values, maxPoints) {
  if (!values || values.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  // Mid-rank: ties split the equal count so the score is symmetric.
  const rank = (below + 0.5 * equal) / values.length; // 0 = cheapest, 1 = most expensive
  return maxPoints * (1 - Math.max(0, Math.min(1, rank)));
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

function decideTier(quality, _urgency, confidence) {
  // Urgency parameter is intentionally ignored — quality alone drives the tier.
  // Urgency is still tracked upstream for telemetry but does not influence
  // the deal recommendation.
  let tier;
  if (quality >= 85) tier = "BUY NOW";
  else if (quality >= 70) tier = "GOOD DEAL";
  else if (quality >= 55) tier = "HOLD";
  else if (quality >= 40) tier = "HOLD";
  else tier = "SKIP";

  // Low confidence protects against false positives by stepping the tier
  // down one level. It never upgrades — sparse data shouldn't rescue a bad
  // call, only hedge a good one.
  if (confidence === "low") {
    if (tier === "BUY NOW") tier = "GOOD DEAL";
    else if (tier === "GOOD DEAL") tier = "HOLD";
  }
  return tier;
}

function calcHistorySpanDays(history) {
  if (!history || history.length < 2) return 0;
  const timestamps = history.map((h) => new Date(h.timestamp).getTime());
  return (Math.max(...timestamps) - Math.min(...timestamps)) / 86400000;
}

module.exports = { analyze, clusterBuckets, decideTier };
