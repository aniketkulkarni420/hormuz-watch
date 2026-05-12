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
    return json({
      value: kv_data.value,
      asOf: kv_data.asOf,
      source: kv_data.source || "kv",
      wow_pct: kv_data.wow_pct ?? null,
      ageDays,
      stale: ageDays > 9,        // BDTI publishes weekly — >9d means missed a publish
      origin: "kv",
    });
  }
  // Fallback: legacy env-var default (was set manually by Claude scheduled task)
  const fallback = parseInt(env.HORMUZ_BDTI || "14", 10);
  return json({
    value: fallback,
    asOf: null,
    source: "env-default",
    wow_pct: null,
    ageDays: null,
    stale: true,                  // env-default is definitionally untracked
    origin: "env-fallback",
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
  const wow_pct = (prev && prev.value)
    ? Math.round(((value - prev.value) / prev.value) * 1000) / 10
    : null;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    value: Math.round(value * 10) / 10,
    asOf: body.asOf || new Date().toISOString().slice(0, 10),
    source: body.source || "admin-form",
    wow_pct,
    ts: now,
  };
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
