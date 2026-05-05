# Hormuz Watch

A single-file dashboard monitoring the Strait of Hormuz with five live data signals — vessel traffic, dark-ship detection, freight rates, geopolitical incidents, and India crude exposure. Built for an equity analyst workflow at [KamayaKya](https://kamayakya.com) (SEBI RA INH000009883).

**Live:** https://hormuz-watch-7cd.pages.dev

## Stack

- `index.html` — self-contained dashboard (Leaflet + vanilla JS, no build)
- `functions/api/eia.js` — Cloudflare Pages Function proxying EIA v2 weekly oil prices
- `functions/api/gfw.js` — Pages Function proxying Global Fishing Watch v3 events
- AISStream WebSocket — called directly from the browser (free-tier key, low blast radius)

## Data sources

| Signal | Source | Refresh |
|---|---|---|
| Vessel positions | AISStream.io WebSocket | live |
| Dark ships / loitering | Global Fishing Watch v3 | 4h |
| Brent / WTI weekly | EIA v2 | 6h |
| Tanker freight (BDTI) | simulated | — |
| Incidents (ACLED) | not yet wired | — |

## Local development

```
npx wrangler pages dev .
```

Create `.dev.vars` (gitignored) from the example:

```
cp .dev.vars.example .dev.vars
# then fill in EIA_KEY and GFW_TOKEN
```

## Deploy

Auto-deploys on push to `main` via Cloudflare Pages. Required env vars in the Pages project settings (Production):

- `EIA_KEY`
- `GFW_TOKEN`

## License

All rights reserved · ANSK Consulting Private Limited
