// functions/_lib/notify.js — alert router + Resend daily-cap circuit breaker.
//
// WHY (2026-05-29): Resend free tier = 100 emails/DAY, and this account is
// SHARED with ANSK Consulting's client-facing inquiry form. Hormuz monitoring
// noise (selfheal escalations, digests) must NOT eat the quota that ANSK needs
// for real client emails. So:
//
//   • Monitoring alerts (selfheal, digest)  -> Telegram (free, unlimited,
//     OFF the Resend quota) when configured; Resend only as a capped fallback.
//   • Transactional mail (subscribe confirm) -> Resend, but guarded by a daily
//     cap so form-abuse can never exhaust the shared quota.
//
// All Hormuz Resend sends increment a per-day KV counter; once it hits
// DAILY_CAP we stop sending (and try to ping Telegram about it). The cap is a
// Hormuz-side self-limit — it leaves headroom under the real 100/day for ANSK.

const DAILY_CAP = 60;   // Hormuz's own daily Resend ceiling (real limit 100, shared w/ ANSK)

function _todayKey() {
  // ISO date — resets at UTC midnight. (Date.now-free APIs aren't available in
  // Workers the way they are in workflow scripts; new Date() is fine here.)
  return "resend_send_" + new Date().toISOString().slice(0, 10);
}

export async function resendSendCount(env) {
  if (!env.OIL_KV) return 0;
  try { const raw = await env.OIL_KV.get(_todayKey()); return raw ? (parseInt(raw, 10) || 0) : 0; }
  catch { return 0; }
}

async function _bump(env) {
  if (!env.OIL_KV) return;
  try {
    const n = await resendSendCount(env);
    await env.OIL_KV.put(_todayKey(), String(n + 1), { expirationTtl: 2 * 86400 });
  } catch { /* non-fatal */ }
}

async function _telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch { return false; }
}

async function _resend(env, { subject, text, to, from }) {
  if (!env.RESEND_KEY) return { ok: false, reason: "no_key" };
  if (await resendSendCount(env) >= DAILY_CAP) return { ok: false, reason: "daily_cap" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: from || env.RESEND_FROM || "Hormuz Watch <onboarding@resend.dev>",
        to: to || [env.ALERT_EMAIL || "aniket.kulkarni@unitedbuzzz.com"],
        subject, text,
      }),
    });
    if (r.ok) await _bump(env);
    return { ok: r.ok, reason: r.ok ? null : `resend_${r.status}` };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 80) }; }
}

// Monitoring alert: Telegram first (free, off-quota). Resend is used as a capped
// fallback ONLY when fallbackResend !== false. Callers that must never touch the
// Resend quota (e.g. selfheal) pass { fallbackResend: false } — if Telegram isn't
// configured those alerts are simply skipped (channel "telegram_unset").
// Returns: "telegram" | "resend" | "capped" | "telegram_unset" | "none".
export async function sendAlert(env, { subject, text, fallbackResend = true }) {
  if (await _telegram(env, `${subject}\n\n${text}`)) return "telegram";
  if (fallbackResend === false) return "telegram_unset";
  const r = await _resend(env, { subject, text });
  if (r.ok) return "resend";
  return r.reason === "daily_cap" ? "capped" : "none";
}

// Transactional mail (subscriber confirmation): must use Resend, but respect the
// daily cap so abuse of the public form can't starve the shared quota.
// Returns { ok, reason }.
export async function sendTransactional(env, payload) {
  if (!env.RESEND_KEY) return { ok: false, reason: "no_key" };
  if (await resendSendCount(env) >= DAILY_CAP) return { ok: false, reason: "daily_cap" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok) await _bump(env);
    return { ok: r.ok, reason: r.ok ? null : `resend_${r.status}` };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 80) }; }
}
