# Hormuz Watch

Single-page dashboard combining live vessel-tracking data, satellite signals, oil prices, and freight indices for the Strait of Hormuz. Built for equity analysts watching Indian oil & gas, tanker stocks, and Middle East tension as a macro signal.

**Live:** https://hormuz-watch-2.pages.dev
**Methodology:** https://hormuz-watch-2.pages.dev/methodology
**Terms:** https://hormuz-watch-2.pages.dev/terms

## Architecture (high-level)

- `index.html` — single-file dashboard (Leaflet + vanilla JS)
- `functions/api/*` — Cloudflare Pages Functions (server-side data proxies)
- `methodology/` — public methodology page
- `terms/` — terms of use page
- `scripts/` — scheduled data collection
- Backend: Cloudflare D1 (historical snapshots) + KV (live cache)

## Local development

```
npx wrangler pages dev .
```

Requires `.dev.vars` with environment variables (see deployment configuration).

## License & Use

© 2026 Aniket Kulkarni. All rights reserved.

The dashboard interface is open for viewing and personal research use. The methodology, verdict logic, threshold values, port classifications, and OMC exposure analysis are proprietary research products. Commercial replication of the dashboard's analytical framework requires written permission.

See [/terms](https://hormuz-watch-2.pages.dev/terms) for full terms of use.

## Author

[Aniket Kulkarni](https://www.linkedin.com/in/aniket-kulkarni-equity-research/)
