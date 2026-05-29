// Cloudflare Pages Function — daily readiness digest (Tier 3G, CF edition).
//
// 2026-05-29: moved off GitHub Actions because the Resend key can't be
// duplicated into GitHub secrets (Resend shows a key once; CF masks it after
// save). This endpoint uses the RESEND_KEY + RESEND_FROM ALREADY in Cloudflare
// env vars, so all email-sending lives in ONE place. Ping it once a day via
// cron-job.org (same mechanism as /api/admin/refresh and /api/selfheal).
//
//   GET/POST /api/digest        — build + send the digest
//   GET      /api/digest?dry=1  — build + return it, do NOT send
//
// Verdict logic mirrors readiness-digest.yml: pull /api/integrity, plus an
// independent Brent-vs-Yahoo accuracy cross-check (a once-a-day external call
// is fine here). Emails "SHOWCASE READY" / "NOT READY — fix X".

const DEFAULT_TO = "aniket.kulkarni@unitedbuzzz.com";

async function handle({ request, env }) {
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const lines = [];
  let ready = false;

  // 1) Integrity validator
  let integ = null;
  try {
    const r = await fetch(`${url.origin}/api/integrity?_=${Date.now()}`, { cf: { cacheTtl: 0 } });
    integ = await r.json();
    ready = !!integ.showcase_ready;
    lines.push(`showcase_ready: ${ready}`);
    lines.push(`blocking feeds: ${integ.blocking_count || 0}`);
    (integ.blocking || []).forEach(b => lines.push(`  - ${b}`));
    lines.push("");
    lines.push("per-feed:");
    for (const [k, v] of Object.entries(integ.feeds || {})) {
      lines.push(`  ${k.padEnd(10)} ${String(v.status).padEnd(14)} ${(v.reason || "").slice(0, 70)}`);
    }
  } catch (e) {
    lines.push(`INTEGRITY FETCH FAILED: ${e}`);
    ready = false;
  }

  // 2) Independent oil accuracy cross-check vs Yahoo (daily external call OK)
  try {
    const [oilR, yR] = await Promise.all([
      fetch(`${url.origin}/api/oil`),
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=1d&interval=1d",
        { headers: { "User-Agent": "hormuz-digest/1.0" } }),
    ]);
    const oil = await oilR.json();
    const y = await yR.json();
    const yb = y?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const db = oil?.brent?.level;
    if (db && yb) {
      const diff = Math.abs(db - yb) / yb * 100;
      const flag = diff < 2 ? "OK" : "DRIFT";
      lines.push("");
      lines.push(`oil accuracy: dashboard Brent $${db} vs Yahoo $${yb} = ${diff.toFixed(2)}% [${flag}]`);
      if (diff >= 2) { ready = false; lines.push("  -> Brent drifted >2% from Yahoo — investigate oil scraper"); }
    }
  } catch (e) {
    lines.push(`oil cross-check skipped: ${e}`);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const subject = ready ? "Hormuz Watch — SHOWCASE READY" : "Hormuz Watch — NOT READY (action needed)";
  const body = `Daily readiness digest · ${stamp}\n\n`
    + (ready ? "All systems live + accurate. Safe to showcase.\n\n"
             : "ONE OR MORE FEEDS NEED ATTENTION:\n\n")
    + lines.join("\n")
    + `\n\nFull validator: ${url.origin}/api/integrity\nDashboard: ${url.origin}/`;

  let emailed = false, emailErr = null;
  if (!dry && env.RESEND_KEY) {
    try {
      const er = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.RESEND_FROM || "Hormuz Watch <onboarding@resend.dev>",
          to: [env.ALERT_EMAIL || DEFAULT_TO],
          subject, text: body,
        }),
      });
      emailed = er.ok;
      if (!er.ok) emailErr = `resend ${er.status}: ${(await er.text()).slice(0, 120)}`;
    } catch (e) { emailErr = String(e).slice(0, 120); }
  }

  return new Response(JSON.stringify({
    ready, subject,
    sent_to: env.ALERT_EMAIL || DEFAULT_TO,
    from: env.RESEND_FROM || "(default test sender)",
    emailed, emailErr, dry,
    body_preview: body.slice(0, 600),
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}

export const onRequestGet = handle;
export const onRequestPost = handle;
