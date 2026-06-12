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

  // Whitelist allowed datasets to prevent abuse of the JWT.
  // 2026-05-28: the "-carriers" loitering slug 404s on GFW v3. Added the
  // current non-carriers slug. Keeping the old one whitelisted is harmless
  // (it just 404s upstream) but the client now requests the working slug.
  const allowed = new Set([
    "public-global-encounters-events:latest",
    "public-global-loitering-events:latest",
    "public-global-loitering-events-carriers:latest", // legacy, may 404
    // 2026-06-11 (P1-1): AIS gap events — "likely disabling". Powers the
    // going-dark tile that replaces the dead Dark/suspect dash.
    "public-global-gaps-events:latest"
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

  // ── Live GFW fetch with timeout + stale-cache fallback ─────────────────────
  // 2026-05-28: GFW upstream sometimes hangs, producing a Cloudflare 524 that
  // blocks the dark-vessel tile. Now: 20s AbortController timeout; on ANY
  // failure (timeout, 5xx, network) we serve the last cached payload of any
  // age rather than erroring. The tile shows slightly-stale data instead of
  // breaking. Only if there's no cache at all do we return an error.
  const url = "https://gateway.api.globalfishingwatch.org/v3/events?limit=200&offset=0";

  const serveStale = async (reason) => {
    if (env.OIL_KV) {
      try {
        const cached = await env.OIL_KV.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          return new Response(JSON.stringify(parsed.data), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=3600",
              "access-control-allow-origin": "*",
              "X-Cache": "STALE",
              "X-Stale-Reason": reason,
            }
          });
        }
      } catch { /* fall through to error */ }
    }
    return json({ error: "gfw unavailable + no cache", reason }, 503);
  };

  let r, text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);  // 20s hard cap
    try {
      r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.GFW_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cf: { cacheTtl: 1800, cacheEverything: true }
      });
    } finally {
      clearTimeout(timer);
    }
    text = await r.text();
  } catch (e) {
    // Timeout or network error — serve stale rather than 524/502
    return await serveStale("fetch_failed:" + String(e).slice(0, 60));
  }

  // Upstream returned but with an error status (404 bad slug, 5xx, etc.)
  if (!r.ok) {
    // 404 = bad dataset slug → no point serving stale of a different query;
    // surface it so the client can fall back. Other errors → serve stale.
    if (r.status >= 500) {
      const stale = await serveStale("upstream_" + r.status);
      if (stale.headers.get("X-Cache") === "STALE") return stale;
    }
    return new Response(text, {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "X-Cache": "MISS-ERR"
      }
    });
  }

  // Success — store in KV
  if (env.OIL_KV) {
    try {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      await env.OIL_KV.put(cacheKey, JSON.stringify({ cachedAt: Date.now(), data: parsed }),
        { expirationTtl: 7 * 86400 }  // keep 7d so stale-fallback has something
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
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
}
