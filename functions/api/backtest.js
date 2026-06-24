// Cloudflare Pages Function — backtest data export (public read).
//
//   GET /api/backtest?days=180
//
// Returns the joined snapshot history needed to validate the verdict: each row
// has the market columns (brent/wti/bdti/transits) AND the verdict band+score
// parsed out of the D1 `verdict` JSON column. Public — same sensitivity as
// /api/history (it's the dashboard's own past output).
//
// LIMITATION (documented for honesty): D1 only persists the verdict BAND/SCORE,
// not the 13 per-signal inputs (those only ever lived in the latest KV
// snapshot). So this export can validate the verdict and the oil/freight/transit
// columns, but NOT the other 10 signals — they were never stored. Fixing that
// (persisting the signal vector) is a schema change recommended for ongoing
// validation; it can't recover the past.
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "D1 binding 'DB' missing" }, 500);
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "180", 10) || 180, 1), 365);
  const fromTs = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const rows = await env.DB.prepare(
      "SELECT ts, brent_price, wti_price, bdti, transits_24h, verdict " +
      "FROM snapshots WHERE ts >= ? ORDER BY ts ASC"
    ).bind(fromTs).all();

    const out = (rows.results || []).map((r) => {
      let band = null, score = null, triggers = null;
      if (r.verdict) {
        try {
          const v = JSON.parse(r.verdict);
          band = v.verdict ?? v.structural_verdict ?? null;
          score = (v.structural_score != null) ? v.structural_score : null;
          triggers = (v.triggers_fired != null) ? v.triggers_fired : null;
        } catch { /* leave nulls */ }
      }
      return {
        ts: r.ts,
        brent: r.brent_price,
        wti: r.wti_price,
        bdti: r.bdti,
        transits: r.transits_24h,
        band, score, triggers,
      };
    });

    return json({ days, count: out.length, rows: out });
  } catch (e) {
    return json({ error: "D1 query failed", detail: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=600",
      "access-control-allow-origin": "*",
    },
  });
}
