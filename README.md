# Hormuz Watch

A single-file dashboard monitoring the Strait of Hormuz with five live data signals — vessel traffic, dark-ship detection, freight rates, conflict events, and India crude exposure.

**Live:** https://hormuz-watch-7cd.pages.dev
**Methodology:** https://hormuz-watch-7cd.pages.dev/methodology

## Stack

- `index.html` — self-contained dashboard (Leaflet + vanilla JS, no build)
- `functions/api/*.js` — Cloudflare Pages Functions (API proxies for EIA, GFW, FinnHub, Twelve Data, oil aggregator)
- `functions/api/record.js` + `history.js` — D1 historical snapshot writer + reader
- `scripts/scrape_oil.py` — GitHub Actions Python scraper for live Brent/WTI/tanker stocks via yfinance → Cloudflare KV
- AISStream WebSocket — vessel positions

## Data sources

| Signal | Source | Refresh |
|---|---|---|
| Vessel positions | AISStream.io WebSocket | real-time |
| Brent + WTI (live futures) | yfinance (BZ=F, CL=F) via GitHub Action → Cloudflare KV | 15 min |
| Brent + WTI (fallback) | EIA daily | 1-2 day lag |
| Dark ships / loitering | Global Fishing Watch v3 | 4 h |
| Tanker freight (BDTI) | Baltic Exchange (manual weekly) | weekly |
| Conflict events (ACLED) | pending API access | — |
| Equity exposure | PPAC + company filings | quarterly review |

## Local development

```
npx wrangler pages dev .
```

Create `.dev.vars` (gitignored) from the example:

```
cp .dev.vars.example .dev.vars
# fill in: EIA_KEY, GFW_TOKEN, FINNHUB_KEY, TWELVE_KEY, SNAPSHOT_TOKEN
```

## Deploy

Auto-deploys on push to `main` via Cloudflare Pages. Required env vars in Pages production settings:
- `EIA_KEY`, `GFW_TOKEN`, `FINNHUB_KEY`, `TWELVE_KEY`, `SNAPSHOT_TOKEN`

D1 + KV bindings configured in `wrangler.toml`.

## Author

Built by [Aniket Kulkarni](https://www.linkedin.com/in/aniket-kulkarni-equity-research/).
