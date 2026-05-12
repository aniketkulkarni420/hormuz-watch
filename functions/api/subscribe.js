// Cloudflare Pages Function — Email digest subscription (Tier 2.2 scaffold)
//   POST /api/subscribe        body: { email }    → creates subscriber (unconfirmed)
//   GET  /api/subscribe?confirm=TOKEN              → confirms subscription
//
// Currently this stores subscribers in D1. Confirmation email sending is wired
// only if env.RESEND_KEY is set; otherwise subscribers are stored as
// 'confirmation_pending' and we surface a friendly message.
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "D1 binding missing" }, 500);

  // ── IP rate limit: max 3 subscribe attempts / hour / IP ─────────────────
  // Prevents abuse where someone POSTs other people's emails to spam them
  // with confirmation emails from our domain.
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  if (env.OIL_KV && ip !== "unknown") {
    try {
      const rlKey = `sub_rl_${ip}`;
      const raw = await env.OIL_KV.get(rlKey);
      const cnt = raw ? parseInt(raw, 10) : 0;
      if (cnt >= 3) {
        return json({ error: "rate limit — try again in an hour" }, 429);
      }
      await env.OIL_KV.put(rlKey, String(cnt + 1), { expirationTtl: 3600 });
    } catch { /* KV blip — allow through, don't block legitimate subscribers */ }
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "valid email required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomUUID().replace(/-/g, "");

  try {
    const existing = await env.DB.prepare("SELECT email, confirmed FROM subscribers WHERE email = ?").bind(email).first();
    if (existing && existing.confirmed === 1) {
      return json({ ok: true, alreadySubscribed: true, message: "You're already on the list." });
    }
    // Upsert (re-confirm if unconfirmed)
    await env.DB.prepare(
      `INSERT INTO subscribers (email, joined_ts, confirmed, confirm_token, segment, source)
       VALUES (?, ?, 0, ?, 'free', ?)
       ON CONFLICT(email) DO UPDATE SET confirm_token=excluded.confirm_token`
    ).bind(email, now, token, body.source || "footer-form").run();
  } catch (e) {
    return json({ error: "subscribe failed", detail: String(e) }, 500);
  }

  // Send confirmation email if Resend configured; otherwise queue
  const confirmUrl = new URL(request.url).origin + "/api/subscribe?confirm=" + token;
  let emailSent = false;
  if (env.RESEND_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.RESEND_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.RESEND_FROM || "Hormuz Watch <hello@hormuz-watch-7cd.pages.dev>",
          to: [email],
          subject: "Confirm your Hormuz Watch subscription",
          html:
            '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#222">' +
            '<h2 style="color:#f09014;margin:0 0 14px">Confirm your subscription</h2>' +
            '<p>You signed up for the Hormuz Watch weekly digest. Click below to confirm — takes 5 seconds.</p>' +
            '<p style="margin:22px 0"><a href="' + confirmUrl + '" style="background:#f09014;color:#000;padding:12px 22px;text-decoration:none;border-radius:5px;font-weight:700">Confirm subscription</a></p>' +
            '<p style="font-size:12px;color:#666">If you didn\'t sign up, ignore this email. No further messages will be sent.</p>' +
            '<p style="font-size:11px;color:#999;margin-top:30px">Hormuz Watch · by Aniket Kulkarni · <a href="https://hormuz-watch-7cd.pages.dev" style="color:#999">hormuz-watch-7cd.pages.dev</a></p>' +
            '</div>',
        }),
      });
      emailSent = r.ok;
    } catch (e) { /* swallow */ }
  }

  return json({
    ok: true,
    emailSent,
    message: emailSent
      ? "Check your inbox for the confirmation link."
      : "We've got your address. Confirmation email service is being finalised; we'll send the confirmation as soon as it's live.",
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "D1 binding missing" }, 500);
  const url = new URL(request.url);
  const token = url.searchParams.get("confirm");
  if (!token) return json({ error: "missing confirm token" }, 400);
  try {
    const row = await env.DB.prepare("SELECT email FROM subscribers WHERE confirm_token = ? AND confirmed = 0").bind(token).first();
    if (!row) {
      return new Response(htmlPage("Link expired or already confirmed", "If you've already confirmed, you're all set."), {
        status: 200, headers: { "content-type": "text/html" },
      });
    }
    await env.DB.prepare("UPDATE subscribers SET confirmed = 1, confirm_token = NULL WHERE email = ?").bind(row.email).run();
    return new Response(htmlPage("Subscribed ✓", "You'll get the weekly Hormuz digest every Monday morning."), {
      status: 200, headers: { "content-type": "text/html" },
    });
  } catch (e) {
    return json({ error: "confirm failed", detail: String(e) }, 500);
  }
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} · Hormuz Watch</title>
<style>body{background:#07090e;color:#cdd8e8;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:420px;text-align:center}
h1{color:#f09014;margin:0 0 14px;font-size:28px}
p{font-size:14px;line-height:1.6;color:#8099b3}
a{color:#38aaff;text-decoration:none;display:inline-block;margin-top:24px;font-size:13px}
</style></head><body><div class="box"><h1>${title}</h1><p>${body}</p><a href="/">← Back to dashboard</a></div></body></html>`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
