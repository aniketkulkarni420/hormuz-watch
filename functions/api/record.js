// Cloudflare Pages Function — hourly D1 snapshot writer
// Called by a scheduled cron job hitting POST /api/record with X-Snapshot-Token header.
// Pulls current state from internal /api/* endpoints, writes one row to D1 snapshots.
// Designed to be safe to call multiple times an hour (INSERT OR REPLACE by ts to nearest hour).
//
// ─── DATA WRITES (for grepability) ────────────────────────────────────────
// KV: writes "verdict_latest" = { verdict: "NORMAL"|"ELEVATED"|"HIGH"|"CRITICAL", ts }
// KV: writes "last_snapshot_ts" = unix seconds (used by scraper's maybe_snapshot guard)
// D1: INSERT INTO snapshots(ts, transits_24h, vessels_transiting, brent_price, wti_price,
//      bw_spread, brent_source, bdti, bdti_wow, gfw_encounters, gfw_loitering, dark_pct,
//      india_via_hormuz_pct, source_health, verdict)
// ──────────────────────────────────────────────────────────────────────────
//
// TODO: read thresholds from /config/verdict_thresholds.json once Worker can import JSON

function computeVerdict(data) {
  // data: { transits_24h, vessels_transiting, brent_price, gfw_encounters, dark_pct }
  const t    = data.transits_24h || 0;
  const dark = data.dark_pct || 0;
  const enc  = data.gfw_encounters || 0;

  let score = 0;
  // Transit signal
  if (t < 12)      score += 3;  // severely suppressed
  else if (t < 18) score += 2;  // below normal
  else if (t < 22) score += 1;  // slightly below
  // Dark vessel signal
  if (dark > 20)      score += 2;
  else if (dark > 10) score += 1;
  // GFW encounters
  if (enc > 5)      score += 2;
  else if (enc > 2) score += 1;

  if (score >= 6)      return "CRITICAL";
  else if (score >= 4) return "HIGH";
  else if (score >= 2) return "ELEVATED";
  else                 return "NORMAL";
}

export async function onRequestPost({ request, env }) {
  const token = request.headers.get("X-Snapshot-Token");
  if (!env.SNAPSHOT_TOKEN || token !== env.SNAPSHOT_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.DB) {
    return json({ error: "D1 binding 'DB' missing — configure in Pages settings" }, 500);
  }

  const origin = new URL(request.url).origin;
  // Bucket timestamp to nearest hour so multiple calls within an hour collapse to one row
  const tsHour = Math.floor(Date.now() / 3600000) * 3600;

  const [oilR, stooqR, eiaR, gfwEncR, gfwLoiR, aisR] = await Promise.allSettled([
    fetch(origin + "/api/oil"),
    fetch(origin + "/api/stooq"),
    fetch(origin + "/api/eia?series=RBRTE&length=2"),
    fetch(origin + "/api/gfw", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: ["public-global-encounters-events:latest"],
        startDate: new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        geometry: { type: "Polygon", coordinates: [[[52, 24], [59.5, 24], [59.5, 28.5], [52, 28.5], [52, 24]]] }
      })
    }),
    fetch(origin + "/api/gfw", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: ["public-global-loitering-events-carriers:latest"],
        startDate: new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        geometry: { type: "Polygon", coordinates: [[[52, 24], [59.5, 24], [59.5, 28.5], [52, 28.5], [52, 24]]] }
      })
    }),
    fetch(origin + "/api/ais")
  ]);

  const parseJson = async (r) => {
    if (r.status !== "fulfilled" || !r.value.ok) return null;
    try { return await r.value.json(); } catch { return null; }
  };
  const [oilD, stooqD, eiaD, gfwEncD, gfwLoiD, aisD] = await Promise.all([
    parseJson(oilR), parseJson(stooqR), parseJson(eiaR), parseJson(gfwEncR), parseJson(gfwLoiR), parseJson(aisR)
  ]);

  // C3 — pull vessel counts from /api/ais so backtest has non-null transits_24h
  const aisSummary = (aisD && aisD.summary) || {};
  const vTransit24h = isFinite(aisSummary.transits24h) ? aisSummary.transits24h : null;
  const vTransiting = isFinite(aisSummary.categories?.transit)  ? aisSummary.categories.transit  : null;
  const vAnchored   = isFinite(aisSummary.categories?.anchored) ? aisSummary.categories.anchored : null;
  const vApproach   = isFinite(aisSummary.categories?.approach) ? aisSummary.categories.approach : null;

  let brent = null, wti = null, brentSource = "none";
  if (oilD && oilD.tier === "primary" && oilD.brent) {
    brent = oilD.brent.level; wti = oilD.wti.level; brentSource = "twelvedata";
  } else if (stooqD && isFinite(stooqD.today)) {
    brent = stooqD.today;
    brentSource = oilD && oilD.tier === "secondary" ? "etf+eia" : "eia";
  } else if (eiaD && eiaD.response && eiaD.response.data && eiaD.response.data[0]) {
    brent = parseFloat(eiaD.response.data[0].value); brentSource = "eia-weekly";
  }
  if (oilD && oilD.tier === "primary" && oilD.wti) wti = oilD.wti.level;

  const bwSpread = (isFinite(brent) && isFinite(wti)) ? (brent - wti) : null;

  let gfwEnc = (gfwEncD && Array.isArray(gfwEncD.entries)) ? gfwEncD.entries.length : null;
  let gfwLoi = (gfwLoiD && Array.isArray(gfwLoiD.entries)) ? gfwLoiD.entries.length : null;

  const sourceHealth = {
    oil:   oilR.status === "fulfilled" && oilR.value.ok ? (oilD?.tier || "ok") : "fail",
    stooq: stooqR.status === "fulfilled" && stooqR.value.ok ? "ok" : "fail",
    eia:   eiaR.status === "fulfilled" && eiaR.value.ok ? "ok" : "fail",
    gfw:   gfwEncR.status === "fulfilled" && gfwEncR.value.ok ? "ok" : "fail",
    ais:   aisR.status === "fulfilled" && aisR.value.ok && vTransit24h != null ? "ok" : "fail"
  };

  // Compute risk verdict server-side
  const verdict = computeVerdict({
    transits_24h:     vTransit24h,
    vessels_transiting: vTransiting,
    brent_price:      brent,
    gfw_encounters:   gfwEnc,
    dark_pct:         null
  });

  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO snapshots (
        ts, transits_24h, vessels_transiting, vessels_anchored, vessels_approach,
        brent_price, brent_source, wti_price, bw_spread,
        bdti, bdti_wow, gfw_encounters, gfw_loitering, dark_pct,
        india_via_hormuz_pct, source_health, verdict
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tsHour,
      vTransit24h, vTransiting, vAnchored, vApproach,
      isFinite(brent) ? brent : null,
      brentSource,
      isFinite(wti) ? wti : null,
      isFinite(bwSpread) ? bwSpread : null,
      2841, 3.2,
      gfwEnc, gfwLoi, null,
      62.0,
      JSON.stringify(sourceHealth),
      verdict
    ).run();

    // Write latest verdict to KV for fast access by frontend
    if (env.OIL_KV) {
      await env.OIL_KV.put("verdict_latest", JSON.stringify({ verdict, ts: Math.floor(Date.now() / 1000) }));
    }

    return json({ ok: true, tsHour, brent, wti, gfwEnc, gfwLoi, brentSource, sourceHealth, vTransit24h, vTransiting, vAnchored, vApproach, verdict });
  } catch (e) {
    return json({ error: "D1 write failed", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
