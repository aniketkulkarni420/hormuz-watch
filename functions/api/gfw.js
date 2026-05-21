// Cloudflare Pages Function — Global Fishing Watch v3 proxy
// Holds GFW_TOKEN (JWT) server-side. Client POSTs JSON body, we forward + add auth.
// KV caching: GFW satellite data updates every 4-12h, so we cache for 4h per unique query.
import { reportError } from "../_lib/sentry.js";

export async function onRequestPost(ctx) {
  try { return await _handleGfwPost(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/gfw", method: "POST" } });
    throw e;
  }
}

async function _handleGfwPost({ request, env }) {
  if (!env.GFW_TOKEN) {
    return json({ error: "GFW_TOKEN not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  // Whitelist allowed datasets to prevent abuse of the JWT
  const allowed = new Set([
    "public-global-encounters-events:latest",
    "public-global-loitering-events-carriers:latest"
  ]);
  if (!Array.isArray(body.datasets) || !body.datasets.every(d => allowed.has(d))) {
    return json({ error: "dataset not allowed" }, 400);
  }

  // ── KV cache check ────────────────────────────────────────────────────────
  // 2026-05-21: cache key collision bug — old code did btoa(...).slice(0,20)
  // which truncated BEFORE the differing `dataset` name (it was the last
  // field in the object), so encounters and loitering both hashed to the
  // same key. Second call returned first call's data. Fixed by (a) putting
  // dataset FIRST so the differing bytes appear early in the base64 and
  // (b) keeping the full hash instead of truncating.
  const cacheKey = "gfw_" + btoa(JSON.stringify({
    dataset: body.datasets?.[0],
    start: body.startDate,
    end: body.endDate,
  }));

  const FOUR_HOURS = 4 * 3600 * 1000;

  if (env.OIL_KV) {
    try {
      const cached = await env.OIL_KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.cachedAt && (Date.now() - parsed.cachedAt) < FOUR_HOURS) {
          return new Response(JSON.stringify(parsed.data), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=14400",
              "access-control-allow-origin": "*",
              "X-Cache": "HIT"
            }
          });
        }
      }
    } catch { /* fall through to live fetch */ }
  }

  // ── Live GFW fetch ────────────────────────────────────────────────────────
  const url = "https://gateway.api.globalfishingwatch.org/v3/events?limit=200&offset=0";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.GFW_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      cf: { cacheTtl: 1800, cacheEverything: true }
    });
    const text = await r.text();

    // Store in KV on success
    if (r.ok && env.OIL_KV) {
      try {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        await env.OIL_KV.put(cacheKey, JSON.stringify({ cachedAt: Date.now(), data: parsed }),
          { expirationTtl: 86400 }  // auto-expire after 24h as safety net
        );
      } catch { /* non-fatal */ }
    }

    return new Response(text, {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=14400",
        "access-control-allow-origin": "*",
        "X-Cache": "MISS"
      }
    });
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
}
