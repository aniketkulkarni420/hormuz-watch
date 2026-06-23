// Cloudflare Pages Function — News headlines (Hormuz/Iran/tanker pulse).
//
//   GET /api/news?limit=10  — public, returns aggregated RSS headlines from KV.
//
// Storage: KV key "news_headlines" written every 30 min by scripts/scrape_news.py
//   via .github/workflows/news-scraper.yml.
//
// Schema (from scraper):
//   { fetchedAt, headlines: [{title, link, source, published, score}, ...],
//     count, count_24h, sources_succeeded, sources_total, top_keywords, per_source_raw }
import { reportError } from "../_lib/sentry.js";

export async function onRequestGet(ctx) {
  try { return await _handle(ctx); }
  catch (e) {
    await reportError(e, ctx.env, { tags: { endpoint: "/api/news", method: "GET" } });
    throw e;
  }
}

async function _handle({ request, env }) {
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") || "10", 10);
  const limit = Math.max(1, Math.min(20, isFinite(rawLimit) ? rawLimit : 10));

  if (!env.OIL_KV) {
    return json({ error: "KV binding missing", headlines: [], count: 0 }, 500);
  }
  let data = null;
  try {
    const raw = await env.OIL_KV.get("news_headlines");
    if (raw) data = JSON.parse(raw);
  } catch { /* fall through */ }

  if (!data) {
    return json({
      fetchedAt: null,
      ageSec: null,
      stale: true,
      headlines: [],
      count: 0,
      count_24h: 0,
      sources_succeeded: 0,
      top_keywords: [],
      source: "none",
    });
  }

  const ageSec = data.fetchedAt ? Math.floor(Date.now() / 1000 - data.fetchedAt) : null;
  const headlines = Array.isArray(data.headlines) ? data.headlines.slice(0, limit) : [];

  return json({
    fetchedAt: data.fetchedAt || null,
    ageSec,
    stale: ageSec == null ? true : ageSec > 2 * 3600,    // 2h threshold (scraper runs every 30min)
    headlines,
    count: headlines.length,
    total_available: data.count || headlines.length,
    count_24h: data.count_24h || 0,
    sources_succeeded: data.sources_succeeded || 0,
    sources_total: data.sources_total || 0,
    top_keywords: data.top_keywords || [],
    // Direction-aware sentiment (2026-06-23) — escalating | neutral | de-escalating
    sentiment: data.sentiment ?? null,
    net_sentiment: data.net_sentiment ?? null,
    escalation_items_24h: data.escalation_items_24h ?? null,
    deescalation_items_24h: data.deescalation_items_24h ?? null,
    source: "kv:news_headlines",
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "public, max-age=300, s-maxage=300" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
