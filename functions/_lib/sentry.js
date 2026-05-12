// Cloudflare Pages Function — Sentry envelope error reporter (FIX #9).
// No SDK dependency. Posts errors directly to Sentry's envelope endpoint.
// Get SENTRY_DSN from Sentry project Settings → Client Keys (DSN);
// this is a SEPARATE DSN from the frontend Loader Script.
// `_lib` underscore prefix prevents CF Pages from routing this file.

export async function reportError(err, env, context = {}) {
  if (!env || !env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const projectId = dsn.pathname.slice(1);
    const publicKey = dsn.username;
    const envelopeUrl = `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/?sentry_key=${publicKey}&sentry_version=7`;

    const eventId = crypto.randomUUID().replace(/-/g, "");
    const timestamp = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp,
      level: "error",
      platform: "javascript",
      logger: "cloudflare-pages-functions",
      tags: { runtime: "cf-pages", ...(context.tags || {}) },
      extra: context.extra || {},
      exception: {
        values: [{
          type: err.name || "Error",
          value: err.message || String(err),
          stacktrace: { frames: parseStack(err.stack) },
        }],
      },
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: timestamp }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    await fetch(envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
    });
  } catch { /* never crash on reporter failure */ }
}

function parseStack(stack) {
  if (!stack) return [];
  return stack.split("\n").slice(1, 11).map(line => {
    const m = line.match(/at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)/);
    return m ? { function: m[1] || "?", filename: m[2], lineno: parseInt(m[3]), colno: parseInt(m[4]) } : { raw: line.trim() };
  });
}
