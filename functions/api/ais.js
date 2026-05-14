// Cloudflare Pages Function — read latest AIS aggregation from KV.
// Populated by .github/workflows/ais-scraper.yml every 10 min.
// Dashboard polls this to show authoritative cross-user transit counts.
export async function onRequestGet({ env }) {
  if (!env.OIL_KV) return json({ error: "KV binding missing" }, 500);
  try {
    const raw = await env.OIL_KV.get("ais_state");
    if (!raw) return json({ error: "no state yet", summary: null }, 200);
    const data = JSON.parse(raw);
    const ageSec = Math.floor(Date.now() / 1000) - data.fetchedAt;
    const summary = data.summary || {};

    // Freshness / liveness gating (Batch A · 2026-05-14)
    // AISStream has had multi-week provider outages: the scraper still runs
    // (fresh fetchedAt) but processes 0 messages. A fresh ageSec alone is NOT
    // proof the feed is live — never present zero-message data as authoritative.
    const msgs = (data.messagesProcessed != null) ? data.messagesProcessed
               : (summary.messagesProcessed != null ? summary.messagesProcessed : null);
    const stale = ageSec > 900;                       // >15 min = missed runs
    const degraded = stale || msgs === 0;             // no messages = effectively dead
    const liveness = degraded ? (msgs === 0 ? "no_messages" : "stale") : "live";
    // Pull typeBreakdown / currentInbound / currentOutbound from top-level OR summary
    // (top-level set by new scraper; summary used as fallback for backward compat)
    const typeBreakdown = data.typeBreakdown || summary.typeBreakdown || null;
    const currentInbound = (data.currentInbound != null) ? data.currentInbound
                          : (summary.currentInbound != null ? summary.currentInbound : null);
    const currentOutbound = (data.currentOutbound != null) ? data.currentOutbound
                           : (summary.currentOutbound != null ? summary.currentOutbound : null);
    return json({
      ageSec,
      stale,
      degraded,
      liveness,                    // "live" | "stale" | "no_messages"
      messagesProcessed: msgs,
      summary,
      typeBreakdown,
      currentInbound,
      currentOutbound,
      // Don't return full vesselState/transits arrays by default — they're heavy
      hasState: !!(data.vesselState && Object.keys(data.vesselState).length),
      source: degraded ? "GHA AIS aggregator · DEGRADED" : "GHA AIS aggregator",
    });
  } catch (e) {
    return json({ error: "kv parse failed", detail: String(e) }, 502);
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
