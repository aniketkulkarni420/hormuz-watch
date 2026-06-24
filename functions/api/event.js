// Cloudflare Pages Function — Feature usage analytics (FIX #8)
//   POST /api/event   body: { event: "backtest_open", props: {...optional...} }
//
// Allow-list of event names enforced server-side. KV rate limit: 60/hr/IP.
// IP is salt-hashed for daily-unique counting; raw IP never persisted.
// Writes to D1 `feature_events` table (distinct from system `events` table).

const ALLOWED_EVENTS = [
  "backtest_open",
  "commentary_expand",
  "methodology_view",
  "verdict_tooltip",
  "admin_bdti_submit",
  "admin_commentary_submit",
];

export async function onRequestPost({ request, env }) {
  if (!env.DB) return new Response(JSON.stringify({ error: "DB missing" }), { status: 500 });

  // Light rate limit: 60 events/hour/IP via KV
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.OIL_KV && ip !== "unknown") {
    try {
      const rlKey = `evt_rl_${ip}`;
      const raw = await env.OIL_KV.get(rlKey);
      const cnt = raw ? parseInt(raw, 10) : 0;
      if (cnt >= 60) return new Response(JSON.stringify({ error: "rate limit" }), { status: 429 });
      await env.OIL_KV.put(rlKey, String(cnt + 1), { expirationTtl: 3600 });
    } catch { /* KV blip — allow through */ }
  }

  let body;
  try { body = await request.json(); } catch { return new Response("invalid", { status: 400 }); }
  if (!body || !ALLOWED_EVENTS.includes(body.event)) {
    return new Response("bad event", { status: 400 });
  }

  const ua = (request.headers.get("user-agent") || "").slice(0, 200);
  // Coarse "Chrome/Mac" style — no version numbers, no fingerprint material
  const uaShort = (() => {
    const m = ua.match(/(Chrome|Firefox|Safari|Edge)/i);
    const p = ua.match(/(Windows|Macintosh|Linux|iPhone|iPad|Android)/i);
    return [m?.[1] || "Other", p?.[1] || "Unknown"].join("/");
  })();

  // IP hash for daily-unique counting; salt makes rainbow tables useless —
  // but ONLY if it's a real secret. G11 (2026-06-24): warn loudly while the
  // public default is in use so the "rainbow tables useless" claim is honest.
  // ACTION: set IP_HASH_SALT in CF Pages env to a random value.
  const salt = env.IP_HASH_SALT || "default-salt-rotate-me";
  if (!env.IP_HASH_SALT) {
    console.warn("SECURITY: IP_HASH_SALT not set — using public default; IP hashes are NOT rainbow-table-resistant. Set the env var.");
  }
  const ipHash = await sha256(ip + salt);
  const props = body.props ? JSON.stringify(body.props).slice(0, 500) : null;

  try {
    await env.DB.prepare(
      "INSERT INTO feature_events (ts, event, props, ip_hash, ua_short) VALUES (?, ?, ?, ?, ?)"
    ).bind(Math.floor(Date.now() / 1000), body.event, props, ipHash, uaShort).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 100) }), { status: 500 });
  }
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
