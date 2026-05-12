// Cloudflare Pages Function — full-system diagnostic dump.
// Token-gated. Returns freshness/preview for every KV feed + D1 last snapshot.
//
// Usage: curl "https://.../api/_diag?token=$SNAPSHOT_TOKEN"
//   or:  curl -H "X-Snapshot-Token: $SNAPSHOT_TOKEN" https://.../api/_diag

export async function onRequestGet({ request, env }) {
  const token = request.headers.get("X-Snapshot-Token") || new URL(request.url).searchParams.get("token");
  if (token !== env.SNAPSHOT_TOKEN) return new Response("forbidden", { status: 403 });

  const now = Math.floor(Date.now() / 1000);
  const out = { ts: now, feeds: {} };

  // KV reads — for each key, return age + small payload preview
  const kvKeys = ["latest", "ais_state", "scrape_status_oil", "scrape_status_ais", "verdict_latest"];
  for (const k of kvKeys) {
    try {
      const raw = await env.OIL_KV.get(k);
      if (!raw) { out.feeds[k] = { ok: false, reason: "missing" }; continue; }
      const data = JSON.parse(raw);
      const fetchedAt = data.fetchedAt || data.ts || null;
      out.feeds[k] = {
        ok: true,
        ageSec: fetchedAt ? now - fetchedAt : null,
        ageMin: fetchedAt ? Math.round((now - fetchedAt) / 60) : null,
        preview: JSON.stringify(data).slice(0, 200),
      };
    } catch (e) { out.feeds[k] = { ok: false, reason: String(e).slice(0, 100) }; }
  }

  // D1 — last snapshot
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT ts, verdict FROM snapshots ORDER BY ts DESC LIMIT 1").first();
      if (row) {
        out.feeds.d1_snapshot = {
          ok: true,
          ts: row.ts,
          ageSec: now - row.ts,
          ageMin: Math.round((now - row.ts) / 60),
          verdict: row.verdict || null,
        };
      } else {
        out.feeds.d1_snapshot = { ok: false, reason: "no rows" };
      }
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM snapshots").first();
      out.feeds.d1_total_rows = cnt?.c || 0;
    } catch (e) { out.feeds.d1_snapshot = { ok: false, reason: String(e).slice(0, 100) }; }
  }

  // Overall health rollup
  const stale = Object.entries(out.feeds).filter(([_, v]) => v && v.ageMin && v.ageMin > 30);
  out.healthy = stale.length === 0;
  out.staleFeeds = stale.map(([k, v]) => `${k}:${v.ageMin}m`);

  return new Response(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
// force redeploy 1778554043
