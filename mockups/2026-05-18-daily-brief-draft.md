# Daily brief — draft for 2026-05-18

Computed from live `/api/snapshot`, `/api/oil`, `/api/bdti`, `/api/verdict` at ~11:45 UTC.
Today's headline read (verdict NORMAL, score 0.99) is the **divergence** between oil and freight.

---

## Draft option A — divergence-focused (358 chars · within 20–800 limit)

> Brent $110 / WTI $102 holding the post-spike range but BDTI 2375 down 7.7% WoW — the tanker market is saying the supply scare is priced. Strait traffic 143 vessels, baseline 140. IRR black-market spread blown out to 62%, OFAC 3 Iran actions this month. Watch BDTI Tuesday print and OFAC mid-week for next inflection.

## Draft option B — brief / direct (260 chars)

> Brent $110, WTI $102 — elevated but BDTI 2375 down 7.7% WoW says the tanker market doesn't believe in sustained disruption. Strait traffic at baseline (143 vs 140). IRR parallel spread 62% — domestic stress, no flow-side panic yet.

## Draft option C — what-changed-today (236 chars)

> BDTI 2375 (−7.7% WoW) is the standout: tanker rates softening while Brent still at $110. Combined with strait traffic at baseline (143 vs 140) and only 3 OFAC Iran actions this month, the market is reading the spike as priced rather than escalating.

---

## To publish

Pick / edit, then post via the admin form:

```
https://hormuz-watch-2.pages.dev/admin/brief/
```

Or by curl (replace `<TOKEN>` with `ADMIN_TOKEN`):

```bash
curl -X POST https://hormuz-watch-2.pages.dev/api/brief \
  -H "X-Admin-Token: <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Brent $110, WTI $102 — elevated but BDTI 2375 down 7.7% WoW says the tanker market doesn'"'"'t believe in sustained disruption. Strait traffic at baseline (143 vs 140). IRR parallel spread 62% — domestic stress, no flow-side panic yet.","author":"Aniket"}'
```

Brief goes stale at 36 h, so post a fresh one each morning (or whenever the read changes).
