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

  // 1b) RELIABILITY TRENDS (7-day) — the "improve along the way" intelligence.
  // Reads the health ledger selfheal builds. Computes per-feed uptime% and
  // names the weakest feed so hardening is data-driven, not guessed.
  let weakest = null;
  try {
    const raw = await env.OIL_KV.get("feed_health_7d");
    const hist = raw ? JSON.parse(raw) : [];
    if (hist.length >= 5) {
      const tally = {};   // feed -> {up, total}
      for (const s of hist) {
        for (const [k, v] of Object.entries(s)) {
          if (k === "ts" || v === null) continue;
          tally[k] = tally[k] || { up: 0, total: 0 };
          tally[k].total += 1; tally[k].up += v;
        }
      }
      lines.push("");
      lines.push(`reliability (7d · ${hist.length} samples):`);
      const ranked = Object.entries(tally)
        .map(([k, t]) => ({ k, pct: t.total ? (t.up / t.total * 100) : 100 }))
        .sort((a, b) => a.pct - b.pct);
      for (const r of ranked) {
        const flag = r.pct < 95 ? "  ⚠ HARDEN" : "";
        lines.push(`  ${r.k.padEnd(10)} ${r.pct.toFixed(1)}% uptime${flag}`);
      }
      if (ranked.length && ranked[0].pct < 95) {
        weakest = ranked[0];
        lines.push("");
        lines.push(`→ weakest feed: ${weakest.k} (${weakest.pct.toFixed(1)}%). Next hardening target — `
          + (["bdti", "vessel"].includes(weakest.k)
              ? "single-source; add a fallback source."
              : "review its scraper / source reliability."));
      }
    }
  } catch (e) {
    lines.push(`reliability trend unavailable: ${e}`);
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

  // ── EMAIL ONLY WHEN ACTIONABLE (2026-05-29) ───────────────────────────────
  // The system runs itself; you hear from it only when action helps. Email if:
  //   - NOT ready (something needs you), OR
  //   - a feed is trending weak (<95% uptime — proactive hardening), OR
  //   - it's Monday (one weekly all-clear summary so silence ≠ "is it dead?"), OR
  //   - ?force=1 (manual test).
  // Healthy weekday runs send NOTHING — no daily noise.
  const isMonday = new Date().getUTCDay() === 1;
  const force = url.searchParams.get("force") === "1";
  const shouldEmail = !ready || weakest != null || isMonday || force;
  const emailReason = !ready ? "not_ready" : weakest ? "weak_feed" : isMonday ? "weekly_summary" : force ? "forced" : "suppressed_healthy";

  let emailed = false, emailErr = null;
  if (!dry && shouldEmail && env.RESEND_KEY) {
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
    shouldEmail, emailReason, emailed, emailErr, dry,
    body_preview: body.slice(0, 700),
  }, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}

export const onRequestGet = handle;
export const onRequestPost = handle;
