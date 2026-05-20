// Cloudflare Pages Function — admin refresh fanout
//
// One-URL endpoint that dispatches all time-sensitive GHA scrapers in parallel.
// Pair with an external pinger (cron-job.org, EasyCron, etc.) for true ~10-min
// cadence regardless of GHA's schedule-event throttling.
//
//   POST /api/admin/refresh
//   Header: X-Admin-Token: <ADMIN_TOKEN>      (same token as /api/brief POST)
//   Body:   (optional) { workflows: [...] }   — defaults to the 7 below
//
// Returns: { ok, dispatched: [...], failed: [...], elapsedMs }
//
// CF env vars needed (one-time setup, ~3 min):
//   ADMIN_TOKEN    — already set, reused
//   GH_REFRESH_PAT — fine-grained PAT, this repo only, "Actions: read+write"
//                    (NOT the snapshot scraper PATs — those don't have
//                    workflow_dispatch permission on free tier)
//
// cron-job.org wire-up:
//   URL:     https://hormuz-watch-2.pages.dev/api/admin/refresh
//   Method:  POST
//   Headers: X-Admin-Token: <your ADMIN_TOKEN>
//   Body:    {}
//   Cron:    */10 * * * *   (every 10 min)
//
// This single endpoint replaces the 7-workflow shell-loop approach. CF Workers
// don't have GHA's anti-recursion safety, so a PAT in env vars works directly.

const OWNER = "aniketkulkarni420";
const REPO = "hormuz-watch";
const DEFAULT_WORKFLOWS = [
  "oil-stooq.yml",
  "vessel-scrape.yml",
  "news-scraper.yml",
  "gdelt-scraper.yml",
  "currency-scraper.yml",
  "aircraft-scraper.yml",
  "ais-scraper.yml",
];

export async function onRequestPost({ request, env }) {
  const t0 = Date.now();

  // Auth — also trim trailing/leading whitespace before comparing because
  // pasting tokens into cron-job.org / Cloudflare's UI is the #1 cause of
  // 401s. (2026-05-20: cron-job.org test fire returned 401.)
  const rawToken = request.headers.get("X-Admin-Token")
                || request.headers.get("X-Snapshot-Token")
                || "";
  const token = rawToken.trim();
  const envToken = (env.ADMIN_TOKEN || "").trim();

  if (!envToken || token !== envToken) {
    // Safe diagnostic: no token bytes leaked, just shape info so the
    // operator can pin the failure (whitespace, wrong value, missing env).
    return _json({
      error: "unauthorized",
      diag: {
        env_admin_token_configured: !!env.ADMIN_TOKEN,
        env_admin_token_len_after_trim: envToken.length,
        header_received: !!rawToken,
        header_len_raw: rawToken.length,
        header_len_after_trim: token.length,
        header_had_whitespace: rawToken !== token,
        first_3_chars_match: envToken && token ? envToken.slice(0,3) === token.slice(0,3) : false,
        last_3_chars_match:  envToken && token ? envToken.slice(-3) === token.slice(-3) : false,
        hint: !envToken ? "CF env var ADMIN_TOKEN missing / empty in Production. Cloudflare → Pages → Settings → Environment variables → Production tab."
            : !rawToken ? "Request did not carry an X-Admin-Token header. Check cron-job.org Headers section."
            : rawToken !== token ? "Header value has leading/trailing whitespace. Re-paste without quotes or newline."
            : envToken.length !== token.length ? `Length mismatch: header=${token.length}, env=${envToken.length}. Likely truncated paste or different token.`
            : "Tokens are same length but bytes differ. Most likely wrong token used on one side.",
      },
    }, 401);
  }
  if (!env.GH_REFRESH_PAT) {
    return _json({
      error: "GH_REFRESH_PAT not configured",
      hint: "Add fine-grained PAT (Actions: read+write, this repo) to CF Pages env vars."
    }, 500);
  }

  // Parse body
  let body = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const workflows = Array.isArray(body.workflows) && body.workflows.length
    ? body.workflows
    : DEFAULT_WORKFLOWS;

  // Fanout in parallel
  const results = await Promise.all(workflows.map(async (wf) => {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${wf}/dispatches`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GH_REFRESH_PAT}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "hormuz-watch-refresh/1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      });
      if (r.status === 204) {
        return { wf, ok: true };
      }
      let detail = "";
      try { detail = (await r.text()).slice(0, 240); } catch {}
      return { wf, ok: false, status: r.status, detail };
    } catch (e) {
      return { wf, ok: false, error: String(e).slice(0, 160) };
    }
  }));

  const dispatched = results.filter(r => r.ok).map(r => r.wf);
  const failed = results.filter(r => !r.ok);
  return _json({
    ok: failed.length === 0,
    dispatched,
    failed,
    elapsedMs: Date.now() - t0,
  }, failed.length === 0 ? 200 : 207);
}

// Reject non-POST so casual visitors get a clear hint.
export function onRequestGet() {
  return _json({
    error: "POST only",
    usage: "POST with X-Admin-Token header. See functions/api/admin/refresh.js header for setup.",
  }, 405);
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
