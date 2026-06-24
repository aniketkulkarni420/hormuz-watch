// Cloudflare Pages Function — Daily brief
//
//   GET  /api/brief    — public, returns latest brief from KV
//   POST /api/brief    — token-gated (X-Admin-Token), writes new brief
//
// KV key: "daily_brief" → { text, ts, author }
//
// Phase 2 #3 · 2026-05-17. Editorial layer for the dashboard hero. You write
// 2-3 sentences; this stores them; the dashboard reads. Future enhancement:
// Claude-drafted button that posts a generated draft for one-click approval.
import { reportError } from "../_lib/sentry.js";
import { safeEqual } from "../_lib/auth.js";

const MIN_LEN = 20;
const MAX_LEN = 800;
const STALE_AFTER_HOURS = 36;   // a 36h-old brief reads as stale on the live tile

export async function onRequestGet(ctx) {
  try { return await _handleBriefGet(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/brief", method: "GET" } });
    throw e;
  }
}

async function _handleBriefGet({ env }) {
  if (!env.OIL_KV) return _json({ text: null, ts: null, author: null, ageHours: null, stale: true, origin: "no-kv" });
  try {
    const raw = await env.OIL_KV.get("daily_brief");
    if (!raw) return _json({ text: null, ts: null, author: null, ageHours: null, stale: true, origin: "empty" });
    const data = JSON.parse(raw);
    const ts = data.ts || 0;
    const ageHours = ts > 0 ? (Date.now() / 1000 - ts) / 3600 : null;
    return _json({
      text: String(data.text || ""),
      author: String(data.author || "Aniket"),
      ts,
      ageHours: ageHours != null ? Math.round(ageHours * 10) / 10 : null,
      stale: ageHours == null || ageHours > STALE_AFTER_HOURS,
      origin: "kv",
    });
  } catch (e) {
    return _json({ text: null, ts: null, author: null, ageHours: null, stale: true, origin: "parse-error" });
  }
}

export async function onRequestPost(ctx) {
  try { return await _handleBriefPost(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/brief", method: "POST" } });
    throw e;
  }
}

async function _handleBriefPost({ request, env }) {
  if (!env.OIL_KV) return _json({ error: "KV binding missing" }, 500);
  const token = request.headers.get("X-Admin-Token") || request.headers.get("X-Snapshot-Token");
  const valid = safeEqual(token, env.ADMIN_TOKEN);
  if (!valid) return _json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return _json({ error: "invalid JSON body" }, 400); }

  const text = String(body.text || "").trim();
  if (text.length < MIN_LEN) return _json({ error: `text too short (min ${MIN_LEN} chars)` }, 400);
  if (text.length > MAX_LEN) return _json({ error: `text too long (max ${MAX_LEN} chars)` }, 400);

  const author = String(body.author || "Aniket").slice(0, 60);
  const ts = Math.floor(Date.now() / 1000);
  const payload = { text, author, ts };

  await env.OIL_KV.put("daily_brief", JSON.stringify(payload));
  return _json({ ok: true, ...payload });
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      // Brief is editorial; allow short edge-cache so updates propagate within a minute.
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
