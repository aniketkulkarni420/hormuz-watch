// Cloudflare Pages Function — Baltic Dirty Tanker Index (BDTI)
//
//   GET  /api/bdti              — public, returns latest BDTI value + asOf
//   POST /api/bdti              — token-gated (X-Admin-Token), updates value
//
// Storage: KV key "bdti_latest" → { value, asOf, source, wow_pct, ts }
// Falls back to env.HORMUZ_BDTI legacy default if KV empty.
import { reportError } from "../_lib/sentry.js";

export async function onRequestGet(ctx) {
  try { return await _handleBdtiGet(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/bdti", method: "GET" } });
    throw e;
  }
}

async function _handleBdtiGet({ env }) {
  let kv_data = null;
  if (env.OIL_KV) {
    try {
      const raw = await env.OIL_KV.get("bdti_latest");
      if (raw) kv_data = JSON.parse(raw);
    } catch { /* fall through */ }
  }
  if (kv_data && kv_data.value) {
    const ageMs = Date.now() - (kv_data.ts || 0) * 1000;
    const ageDays = Math.floor(ageMs / 86400000);
    // Sanity guard on read: BDTI is a weekly index — a real week-over-week
    // move is physically bounded. Anything beyond ±60% is a data artifact
    // (wrong index scraped, comparison against an unrelated prior value),
    // not a freight move. Suppress it rather than serve a false signal —
    // this also neutralises any bad wow_pct already frozen in KV without
    // needing a re-POST.
    const rawWow = kv_data.wow_pct;
    const wow_pct = (typeof rawWow === "number" && isFinite(rawWow) && Math.abs(rawWow) <= 60)
      ? rawWow : null;
    return json({
      value: kv_data.value,
      asOf: kv_data.asOf,
      source: kv_data.source || "kv",
      wow_pct,
      ageDays,
      stale: ageDays > 9,        // BDTI publishes weekly — >9d means missed a publish
      origin: "kv",
      // Scraper-supplied cross-verify metadata (optional · null for admin-form posts)
      confidence: kv_data.confidence ?? null,
      sources: kv_data.sources ?? null,
      min: kv_data.min ?? null,
      max: kv_data.max ?? null,
    });
  }
  // No KV data and no manual entry — return null rather than inventing a
  // value. The old fallback (env.HORMUZ_BDTI || "14") was nonsensical: real
  // BDTI runs ~800–3000, and 14 scores as "calm" in the verdict engine —
  // a broken feed must never read as all-clear. (Batch A · 2026-05-14)
  return json({
    value: null,
    asOf: null,
    source: "unavailable",
    wow_pct: null,
    ageDays: null,
    stale: true,
    origin: "no-data",
  });
}

export async function onRequestPost(ctx) {
  try { return await _handleBdtiPost(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/bdti", method: "POST" } });
    throw e;
  }
}

async function _handleBdtiPost({ request, env }) {
  if (!env.OIL_KV) return json({ error: "KV binding missing" }, 500);
  const token = request.headers.get("X-Admin-Token") || request.headers.get("X-Snapshot-Token");
  // Accept either ADMIN_TOKEN (manual via /admin/bdti form) or SNAPSHOT_TOKEN (scraper)
  const valid = (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) ||
                (env.SNAPSHOT_TOKEN && token === env.SNAPSHOT_TOKEN);
  if (!valid) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const value = parseFloat(body.value);
  if (!isFinite(value) || value < 100 || value > 5000) {
    // BDTI typically 400-2500; sanity bounds slightly wider
    return json({ error: "value must be a number between 100 and 5000" }, 400);
  }

  // Fetch prev to compute WoW
  let prev = null;
  try {
    const raw = await env.OIL_KV.get("bdti_latest");
    if (raw) prev = JSON.parse(raw);
  } catch { /* ignore */ }

  // Confidence gate: scraper (SNAPSHOT_TOKEN) writes must not overwrite a high-quality
  // manual entry with a low-confidence auto-scrape. Manual entries (ADMIN_TOKEN) always win.
  const isAdminWrite = env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
  const isScraperWrite = !isAdminWrite;
  const newConfidence = body.confidence || (isAdminWrite ? "manual" : "unknown");
  if (isScraperWrite && prev && prev.source === "manual-verified-BDTI" && newConfidence === "low") {
    return json({
      ok: false,
      skipped: true,
      reason: "scraper low-confidence value rejected — manual entry preserved",
      preserved: prev.value,
      attempted: value,
      newConfidence,
    }, 200);
  }
  // Also reject scraper writes that diverge >25% from a manual entry less than 14 days old
  if (isScraperWrite && prev && prev.source === "manual-verified-BDTI" && prev.ts) {
    const prevAgeDays = (Math.floor(Date.now() / 1000) - prev.ts) / 86400;
    if (prevAgeDays < 14) {
      const divergencePct = Math.abs(value - prev.value) / prev.value * 100;
      if (divergencePct > 25) {
        return json({
          ok: false,
          skipped: true,
          reason: "scraper value diverges " + Math.round(divergencePct) + "% from recent manual entry — preserved",
          preserved: prev.value,
          attempted: value,
        }, 200);
      }
    }
  }

  // ── Week-over-week, computed honestly ──────────────────────────────────
  // BDTI publishes weekly, so "WoW" must compare against a value roughly one
  // publish ago — NOT against "whatever was last in KV", which could be a
  // same-day re-scrape or an unrelated bad value. (That bug produced a
  // +219% "WoW" on the live site: a 3063 manual entry diffed against a ~960
  // value left by an earlier scrape that hit the wrong index.)
  // We keep a small dated history and compare against the entry closest to
  // 7 days prior, accepting a 4–11 day gap. No suitable prior entry → null.
  const newAsOf = body.asOf || new Date().toISOString().slice(0, 10);
  const newValue = Math.round(value * 10) / 10;

  let history = [];
  try {
    const rawH = await env.OIL_KV.get("bdti_history");
    if (rawH) history = JSON.parse(rawH);
  } catch { /* ignore */ }
  if (!Array.isArray(history)) history = [];

  // Merge any scraper-supplied dated history (StockQ ships ~20 recent daily
  // rows on the page). This makes WoW computable on the very first run instead
  // of accumulating one entry per scrape over weeks.
  if (Array.isArray(body.history)) {
    const tsNow = Math.floor(Date.now() / 1000);
    for (const h of body.history) {
      if (!h || typeof h.value !== "number" || !isFinite(h.value)) continue;
      if (h.value < 100 || h.value > 5000) continue;
      if (!h.asOf || !/^\d{4}-\d{2}-\d{2}$/.test(h.asOf)) continue;
      history = history.filter((x) => x && x.asOf !== h.asOf);
      history.push({ value: Math.round(h.value * 10) / 10, asOf: h.asOf, ts: tsNow });
    }
  }

  const newAsOfMs = Date.parse(newAsOf + "T00:00:00Z");
  let wow_pct = null;
  if (isFinite(newAsOfMs)) {
    let best = null, bestGap = Infinity;
    for (const h of history) {
      if (!h || typeof h.value !== "number" || !h.asOf) continue;
      const hMs = Date.parse(h.asOf + "T00:00:00Z");
      if (!isFinite(hMs)) continue;
      const gapDays = (newAsOfMs - hMs) / 86400000;
      if (gapDays < 4 || gapDays > 11) continue;        // not ~1 publish apart
      if (Math.abs(gapDays - 7) < bestGap) { bestGap = Math.abs(gapDays - 7); best = h; }
    }
    if (best && best.value > 0) {
      const w = Math.round(((newValue - best.value) / best.value) * 1000) / 10;
      wow_pct = Math.abs(w) <= 60 ? w : null;           // same physical bound as the GET guard
    }
  }

  // Upsert this publish into history (one entry per asOf date), keep last 20.
  history = history.filter((h) => h && h.asOf !== newAsOf);
  history.push({ value: newValue, asOf: newAsOf, ts: Math.floor(Date.now() / 1000) });
  history.sort((a, b) => (Date.parse(a.asOf) || 0) - (Date.parse(b.asOf) || 0));
  if (history.length > 20) history = history.slice(-20);
  await env.OIL_KV.put("bdti_history", JSON.stringify(history));

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    value: newValue,
    asOf: newAsOf,
    source: body.source || "admin-form",
    wow_pct,
    ts: now,
  };
  // Optional cross-verify metadata from multi-source scraper (preserved
  // verbatim — admin-form posts simply omit these fields).
  if (body.confidence != null) payload.confidence = String(body.confidence);
  if (Array.isArray(body.sources)) payload.sources = body.sources.slice(0, 8).map(String);
  if (body.min != null && isFinite(parseFloat(body.min))) payload.min = Math.round(parseFloat(body.min) * 10) / 10;
  if (body.max != null && isFinite(parseFloat(body.max))) payload.max = Math.round(parseFloat(body.max) * 10) / 10;
  if (body.url) payload.url = String(body.url).slice(0, 500);
  if (body.matched) payload.matched = String(body.matched).slice(0, 500);
  await env.OIL_KV.put("bdti_latest", JSON.stringify(payload));
  return json({ ok: true, ...payload, prev: prev?.value || null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "public, max-age=3600" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
