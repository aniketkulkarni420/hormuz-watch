// Cloudflare Pages Function — Analyst commentary (Tier 2.4)
//   GET  /api/commentary?limit=5     — public, returns latest reads
//   POST /api/commentary             — token-gated, write new commentary
//
// Auth on POST: X-Admin-Token header must match env.ADMIN_TOKEN secret.
import { reportError } from "../_lib/sentry.js";

export async function onRequestGet(ctx) {
  try { return await _handleCommentaryGet(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/commentary", method: "GET" } });
    throw e;
  }
}

async function _handleCommentaryGet({ request, env }) {
  if (!env.DB) return json({ error: "D1 binding missing" }, 500);
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "5", 10), 50);
  try {
    const result = await env.DB.prepare(
      `SELECT ts, author, title, body_md, display_until FROM commentary
       WHERE visibility = 'public' ORDER BY ts DESC LIMIT ?`
    ).bind(limit).all();
    const now = Math.floor(Date.now() / 1000);
    const items = (result.results || []).map(r => ({
      ts: r.ts,
      author: r.author,
      title: r.title,
      body: r.body_md,
      activeBanner: !r.display_until || r.display_until > now,
    }));
    return json({ items, count: items.length });
  } catch (e) {
    return json({ error: "query failed", detail: String(e) }, 500);
  }
}

export async function onRequestPost(ctx) {
  try { return await _handleCommentaryPost(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/commentary", method: "POST" } });
    throw e;
  }
}

async function _handleCommentaryPost({ request, env }) {
  if (!env.DB) return json({ error: "D1 binding missing" }, 500);
  const token = request.headers.get("X-Admin-Token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const { title, body_md, signal_ctx, display_hours, visibility } = body;
  if (!body_md || typeof body_md !== "string" || body_md.trim().length < 5) {
    return json({ error: "body_md required (min 5 chars)" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const display_until = display_hours && Number(display_hours) > 0
    ? now + Math.floor(Number(display_hours) * 3600)
    : null;

  try {
    await env.DB.prepare(
      `INSERT INTO commentary (ts, author, title, body_md, signal_ctx, display_until, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      now,
      "aniket",
      title || null,
      body_md.trim(),
      signal_ctx ? JSON.stringify(signal_ctx) : null,
      display_until,
      visibility === "subscriber" ? "subscriber" : "public"
    ).run();
    return json({ ok: true, ts: now, display_until });
  } catch (e) {
    return json({ error: "insert failed", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}
