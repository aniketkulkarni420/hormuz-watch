// Cloudflare Pages Function — Live Brent + WTI quotes via FinnHub
// FinnHub's free tier blocks real futures (BZ=F, CL=F), so we use ETF proxies:
//   BNO (United States Brent Oil Fund) — tracks Brent daily change
//   USO (United States Oil Fund)       — tracks WTI daily change
// We return the ETF change % (which closely tracks underlying commodity %),
// and the dashboard combines this with EIA daily level for the absolute price.
// This gives genuine 5-15 minute intraday updates instead of the 1-2 day EIA lag.
export async function onRequestGet({ env }) {
  if (!env.FINNHUB_KEY) {
    return json({ error: "FINNHUB_KEY not configured" }, 500);
  }
  try {
    const [bnoRes, usoRes] = await Promise.all([
      fetch("https://finnhub.io/api/v1/quote?symbol=BNO&token=" + encodeURIComponent(env.FINNHUB_KEY), {
        cf: { cacheTtl: 300, cacheEverything: true }
      }),
      fetch("https://finnhub.io/api/v1/quote?symbol=USO&token=" + encodeURIComponent(env.FINNHUB_KEY), {
        cf: { cacheTtl: 300, cacheEverything: true }
      })
    ]);
    if (!bnoRes.ok || !usoRes.ok) {
      return json({ error: "finnhub upstream error", bnoStatus: bnoRes.status, usoStatus: usoRes.status }, 502);
    }
    const [bno, uso] = await Promise.all([bnoRes.json(), usoRes.json()]);
    if (!isFinite(bno.c) || bno.c <= 0 || !isFinite(uso.c) || uso.c <= 0) {
      return json({ error: "finnhub returned invalid quotes", bno, uso }, 502);
    }
    // ETF dp (change %) closely tracks underlying commodity %.
    // Apply same % move to a reference Brent/WTI level (caller passes via EIA daily).
    return new Response(JSON.stringify({
      brent: {
        proxy: "BNO ETF",
        proxyPrice: bno.c,
        dp: bno.dp,    // % change — applies to underlying
        d: bno.d,
        h: bno.h,
        l: bno.l,
        t: bno.t,
        prevClose: bno.pc
      },
      wti: {
        proxy: "USO ETF",
        proxyPrice: uso.c,
        dp: uso.dp,
        d: uso.d,
        h: uso.h,
        l: uso.l,
        t: uso.t,
        prevClose: uso.pc
      },
      source: "FinnHub · BNO + USO ETF proxies (free tier doesn't include futures)",
      fetchedAt: Date.now(),
      note: "ETF dp% applied to EIA daily Brent/WTI level for live-tracking estimate"
    }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*"
      }
    });
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*"
    }
  });
}
