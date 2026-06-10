// Cloudflare Pages Function — self-healing watchdog (Tier 2D + 2E · 2026-05-28)
//
// Pinged every ~15 min (cron-job.org). On each run:
//   1. Read /api/integrity (the validator — freshness + sanity + accuracy)
//   2. For each BLOCKING feed (stale/suspect/dead, excluding known-degraded):
//        - map it to its GitHub workflow
//        - re-dispatch that workflow via GH_REFRESH_PAT (auto-remediation)
//        - track the incident in KV (selfheal_state): firstSeen, attempts
//   3. ESCALATION (smart alerting, deduped):
//        - a feed that survives >=2 self-heal attempts AND is CRITICAL
//          severity → flag for escalation + (if RESEND configured) email ONCE
//        - re-alert only if still broken after 6h (no spam)
//   4. When a feed recovers, clear its incident (+ optional recovery note)
//
// Self-protecting: per-feed remediation cooldown (don't re-dispatch the same
// feed more than once per 20 min) + a global lock so overlapping pings don't
// double-dispatch.

import { sendAlert } from "../_lib/notify.js";

const OWNER = "aniketkulkarni420";
const REPO = "hormuz-watch";

// feed -> the workflow that refreshes it
const FEED_WORKFLOW = {
  oil:       "oil-stooq.yml",
  vessel:    "vessel-scrape.yml",
  aircraft:  "aircraft-scraper.yml",
  news:      "news-scraper.yml",
  currency:  "currency-scraper.yml",
  weather:   "weather-scraper.yml",
  seismic:   "seismic-scraper.yml",
  gdelt:     "gdelt-scraper.yml",
  ofac:      "ofac-scraper.yml",
  bdti:      "bdti-weekly.yml",
  ukmto:     "ukmto-scraper.yml",
  verdict:   "oil-scraper.yml",   // data-refresh computes + writes verdict_latest
};

// Severity drives alerting cadence. CRITICAL = core showcase metric, escalate
// fast. WARNING = supporting signal, daily digest is enough.
const SEVERITY = {
  oil: "critical", verdict: "critical", bdti: "critical", vessel: "critical",
  currency: "warning", news: "warning", ofac: "warning", weather: "warning",
  seismic: "warning", gdelt: "warning", aircraft: "warning",
  ukmto: "critical",   // conflict-event feed drives the verdict — escalate fast
};

const REMEDIATION_COOLDOWN_MS = 20 * 60 * 1000;  // don't re-dispatch a feed within 20 min
const ESCALATE_AFTER_ATTEMPTS = 2;               // self-heal tries twice before alerting
const REALERT_AFTER_MS = 6 * 3600 * 1000;        // re-alert at most every 6h per incident

async function handle({ request, env }) {
  const t0 = Date.now();
  const now = Date.now();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";

  if (!env.GH_REFRESH_PAT) {
    return json({ error: "GH_REFRESH_PAT not configured" }, 500);
  }

  // 1) Read the validator
  let integ;
  try {
    const r = await fetch(`${url.origin}/api/integrity?_=${now}`, { cf: { cacheTtl: 0 } });
    integ = await r.json();
  } catch (e) {
    return json({ error: "integrity fetch failed", detail: String(e) }, 502);
  }

  // 2) Load incident state
  let state = {};
  if (env.OIL_KV) {
    try { const raw = await env.OIL_KV.get("selfheal_state"); if (raw) state = JSON.parse(raw); }
    catch { state = {}; }
  }

  const feeds = integ.feeds || {};
  const actions = [];
  const escalations = [];
  const recoveries = [];   // 2026-05-28: feeds that recovered AFTER we'd alerted

  // 3) Walk every feed
  for (const [feed, v] of Object.entries(feeds)) {
    const blocking = (v.status === "stale" || v.status === "suspect" || v.status === "dead");

    if (!blocking) {
      // Recovered? clear any open incident
      if (state[feed]) {
        const openMin = Math.round((now - state[feed].firstSeen) / 60000);
        actions.push({ feed, action: "recovered", wasOpenFor: openMin + "m" });
        // Only notify recovery if we'd actually alerted about the down-incident
        // (lastAlert > 0). Self-healed blips that never escalated stay silent.
        if ((state[feed].lastAlert || 0) > 0) {
          recoveries.push({ feed, openFor: openMin, severity: state[feed].severity });
        }
        delete state[feed];
      }
      continue;
    }

    // Blocking — open or update incident
    const wf = FEED_WORKFLOW[feed];
    const sev = SEVERITY[feed] || "warning";
    const inc = state[feed] || { firstSeen: now, attempts: 0, lastAttempt: 0, lastAlert: 0, severity: sev, status: v.status };
    inc.severity = sev; inc.status = v.status; inc.reason = v.reason;

    // 3a) Auto-remediation — re-dispatch the workflow if cooldown elapsed
    let dispatched = false;
    if (wf && (now - inc.lastAttempt) >= REMEDIATION_COOLDOWN_MS) {
      if (!dryRun) {
        try {
          const gr = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${wf}/dispatches`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GH_REFRESH_PAT}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "hormuz-selfheal/1.0",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ref: "main" }),
          });
          dispatched = gr.status === 204;
        } catch { dispatched = false; }
      } else { dispatched = "dry-run"; }
      inc.lastAttempt = now;
      inc.attempts = (inc.attempts || 0) + 1;
    }
    actions.push({ feed, status: v.status, severity: sev, workflow: wf || "none",
                   redispatched: dispatched, attempts: inc.attempts });

    // 3b) Escalation — alert if survived >= N attempts AND critical, deduped 6h
    const overThreshold = inc.attempts >= ESCALATE_AFTER_ATTEMPTS;
    const dueForAlert = (now - (inc.lastAlert || 0)) >= REALERT_AFTER_MS;
    if (overThreshold && sev === "critical" && dueForAlert) {
      escalations.push({ feed, status: v.status, reason: v.reason, attempts: inc.attempts });
      inc.lastAlert = now;
    }

    state[feed] = inc;
  }

  // 4) Persist incident state
  if (env.OIL_KV && !dryRun) {
    try { await env.OIL_KV.put("selfheal_state", JSON.stringify(state), { expirationTtl: 7 * 86400 }); }
    catch { /* non-fatal */ }
  }

  // 4b) HEALTH LEDGER — the system's memory (2026-05-29). Each run appends a
  // per-feed status sample so we can compute 7-day uptime + spot chronically
  // flaky feeds. This is the basis for "improve along the way": the digest
  // reads this to name the weakest feed to harden. No scraper edits needed —
  // we derive it from the integrity snapshot we already fetched.
  if (env.OIL_KV && !dryRun) {
    try {
      let hist = [];
      const raw = await env.OIL_KV.get("feed_health_7d");
      if (raw) hist = JSON.parse(raw);
      const sample = { ts: Math.floor(now / 1000) };
      for (const [k, v] of Object.entries(feeds)) {
        // 1 = healthy, 0 = blocking, null = known-degraded (excluded from uptime)
        sample[k] = (v.status === "ok") ? 1 : (v.status === "known-degraded") ? null : 0;
      }
      hist.push(sample);
      // prune older than 7 days
      const cutoff = Math.floor(now / 1000) - 7 * 86400;
      hist = hist.filter(s => s.ts >= cutoff);
      // cap to ~700 samples (7d × ~96/day) to bound KV size
      if (hist.length > 800) hist = hist.slice(-800);
      await env.OIL_KV.put("feed_health_7d", JSON.stringify(hist), { expirationTtl: 8 * 86400 });
    } catch { /* non-fatal — ledger is best-effort */ }
  }

  // 5) Send escalation alert(s) — only for critical feeds past threshold, deduped
  //    6h (above). Routes via sendAlert: Telegram first (free, off the Resend
  //    quota shared with ANSK), Resend only as a daily-capped fallback. (2026-05-29)
  let emailed = false, escalationChannel = "none";
  if (escalations.length && !dryRun) {
    const body = "Self-heal could not recover these CRITICAL feeds after "
      + ESCALATE_AFTER_ATTEMPTS + " auto-retries:\n\n"
      + escalations.map(e => `  • ${e.feed} [${e.status}] — ${e.reason} (${e.attempts} attempts)`).join("\n")
      + `\n\nThe dashboard is auto-degrading these tiles (visitors see 'unavailable', not wrong data).\n`
      + `Validator: ${url.origin}/api/integrity\nDashboard: ${url.origin}/`;
    escalationChannel = await sendAlert(env, {
      subject: `Hormuz Watch — self-heal escalation (${escalations.map(e=>e.feed).join(", ")})`,
      text: body,
      fallbackResend: false,   // Telegram-only — never touch the Resend quota
    });
    emailed = escalationChannel === "telegram" || escalationChannel === "resend";
  }

  // 6) Send recovery note(s) — only for incidents we'd previously alerted on,
  // so a "down" alert is always closed by a matching "recovered" alert and
  // nothing else. (2026-05-28) — same Telegram-first routing. (2026-05-29)
  let recoveryEmailed = false, recoveryChannel = "none";
  if (recoveries.length && !dryRun) {
    const body = "These feeds RECOVERED (self-heal or natural):\n\n"
      + recoveries.map(rc => `  ✓ ${rc.feed} — was down ${rc.openFor} min [${rc.severity}]`).join("\n")
      + `\n\nNo action needed. Dashboard tiles are live again.\n`
      + `Validator: ${url.origin}/api/integrity`;
    recoveryChannel = await sendAlert(env, {
      subject: `Hormuz Watch — recovered (${recoveries.map(r=>r.feed).join(", ")})`,
      text: body,
      fallbackResend: false,   // Telegram-only — never touch the Resend quota
    });
    recoveryEmailed = recoveryChannel === "telegram" || recoveryChannel === "resend";
  }

  return json({
    ts: now,
    showcase_ready: integ.showcase_ready,
    blocking_count: integ.blocking_count,
    actions,
    open_incidents: Object.keys(state),
    escalations,
    recoveries,
    emailed,
    recoveryEmailed,
    escalationChannel,
    recoveryChannel,
    dryRun,
    elapsedMs: Date.now() - t0,
  });
}

export const onRequestGet = handle;
export const onRequestPost = handle;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
