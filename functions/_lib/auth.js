// Shared auth helpers (G7 · 2026-06-24).
//
// safeEqual: constant-time string comparison for API tokens. Workers don't
// expose Node's crypto.timingSafeEqual, so this is a manual XOR-accumulate.
// It accepts EXACTLY the same tokens as `a === b` (so swapping it in can never
// lock anyone out) — it just doesn't short-circuit on the first mismatched
// byte. Length is allowed to leak (standard for token compare).
//
// NOTE on query-string tokens: /api/diag still accepts `?token=` for back-compat
// with external pingers; that exposes the token in request logs. Prefer the
// X-Snapshot-Token header. Removing the query path is deferred (would need
// confirming no live caller depends on it).
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
