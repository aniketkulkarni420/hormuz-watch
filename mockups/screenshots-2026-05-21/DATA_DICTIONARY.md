# Data dictionary — every metric explained

Designer reference: what each number means, why it matters, what ranges to expect, what a "good" vs "bad" reading looks like.

## Primary signals (the 5 in the signal bar)

### Brent crude oil ($/bbl)
- **What:** Global benchmark crude price, $/barrel
- **Source:** Cross-verified Stooq CB.F + OilPriceAPI demo + Yahoo BZ=F
- **Refresh cadence:** ~5-10 min during US/UK sessions
- **Typical range:** $70-$110 in calm periods, up to $140+ in crisis
- **Why it matters:** Direct gauge of supply-disruption risk pricing
- **"Good" reading:** $80-$90, stable WoW
- **"Bad" reading:** >$110 with steep upward trajectory + widening Brent-WTI spread

### WTI crude oil ($/bbl)
- **What:** US benchmark crude, $/barrel
- **Source:** Same as Brent (CL.F + WTI_USD)
- **Refresh cadence:** Same
- **Typical range:** $65-$100, usually $4-$7 below Brent (the spread)
- **Why it matters:** US-side reference; spread vs Brent reveals trans-Atlantic stress
- **"Good" reading:** Normal spread ($4-$7)
- **"Bad" reading:** Spread > $10 = Atlantic tightness or Hormuz risk pricing

### BDTI (Baltic Dirty Tanker Index)
- **What:** Cost-of-shipping index for crude oil tankers, dimensionless
- **Source:** StockQ (scraped) daily Mon-Fri
- **Refresh cadence:** Daily ~14:00 UTC (Baltic publishes ~13:00 UTC)
- **Typical range:** 800-1500 (calm), 2000-3500 (stressed), 4000+ (crisis)
- **Why it matters:** Freight cost = market's bet on tanker demand. Rising BDTI without rising oil = market expects supply disruption requiring more tankers
- **"Good" reading:** 800-1200 stable
- **"Bad" reading:** 2500+ with sustained WoW increases
- **Current as of 2026-05-21:** 2307, WoW -6.3%

### Transits / 24h
- **What:** Number of vessels passing through the strait in the last 24h
- **Source:** Live AIS (currently dormant) → web-scraped port counts as fallback
- **Refresh cadence:** Live (when AIS up), every 10 min (web scrape)
- **Typical range:** 130-160 (normal), <100 (suppression), <60 (closure scenario)
- **Why it matters:** Direct measurement of actual flow through Hormuz
- **"Good" reading:** 130-150 (baseline ~140)
- **"Bad" reading:** <100 with no apparent weather/holiday cause

### India via Hormuz (%)
- **What:** Fraction of India's total crude imports flowing through Hormuz
- **Source:** Static (~62% based on historical data)
- **Refresh cadence:** Quarterly review (research-led)
- **Why it matters:** India is one of the largest single buyers of Gulf crude. A closure scenario affects India's energy security and INR/USD acutely
- **Note:** This is a structural number, not a daily-changing metric

## Secondary signals (right panel)

### IRR/USD spread (%)
- **What:** Gap between Iran's official rate and the black-market rate
- **Source:** bonbast.com + exchangerate-api
- **Refresh cadence:** Every 4-10h (cron throttled)
- **Typical range:** 20-50% (stressed Iran economy baseline), 60-100% (crisis-pricing)
- **Why it matters:** Domestic Iran stress proxy. Wide spread = domestic confidence collapse, often precedes geopolitical escalation
- **"Good" reading:** Spread < 30%
- **"Bad" reading:** Spread > 70%

### OFAC Iran-related actions / 30d
- **What:** Count of US Treasury Iran-sanctions enforcement actions in the last 30 days
- **Source:** US Treasury press releases (scraped)
- **Refresh cadence:** Daily
- **Typical range:** 0-5 (baseline), 10+ (active enforcement phase)
- **Why it matters:** Enforcement cadence = US policy posture. Rising count = US tightening; sudden zero = pivot or paralysis

### Dark vessels (GFW)
- **What:** Vessels engaging in suspicious behavior (encounters at sea, loitering near sanctioned areas)
- **Source:** Global Fishing Watch API (encounters + loitering datasets)
- **Refresh cadence:** Every 4h (GFW updates ~4-12h)
- **Typical range:** 2-10 events in the bbox over 30d
- **Why it matters:** Dark-fleet activity = sanctions evasion proxy. Rising count = more Iran oil being smuggled

### Verdict (NORMAL / ELEVATED / HIGH / CRITICAL)
- **What:** Aggregate verdict computed from 13 input signals
- **Source:** Internal `/api/verdict` endpoint
- **Refresh cadence:** Every snapshot tick
- **How it's computed:** Weighted average (Stage 1) + override triggers (Stage 2). Score 0-4
- **Thresholds:**
  - NORMAL: score < 1.5
  - ELEVATED: 1.5 ≤ score < 2.5
  - HIGH: 2.5 ≤ score < 3.5
  - CRITICAL: score ≥ 3.5
- **Why it matters:** The 5-second answer for the dashboard's top question

### Aircraft activity (military_aircraft_count)
- **What:** Number of NATO/coalition tactical aircraft callsigns in the Persian Gulf airspace
- **Source:** adsb.lol (free public ADS-B aggregator)
- **Refresh cadence:** Every 10 min
- **Typical range:** 0-2 (calm), 4+ (deliberate posture signaling)
- **Why it matters:** US/UK air activity = strategic posture. Note: Iran/IRGC aircraft rarely broadcast ADS-B, so this is a COALITION-posture proxy, not "all military activity"

### Conditions: weather (max wind kn, rough boolean)
- **What:** Sea state in the strait
- **Source:** Open-Meteo
- **Refresh cadence:** Hourly
- **Why it matters:** Rough weather can suppress transits without any geopolitical cause. Eliminates false alarms

### Conditions: seismic (max mag 7d, count 7d)
- **What:** Iran/UAE/Oman earthquake activity, USGS
- **Refresh cadence:** Hourly
- **Why it matters:** Earthquakes can disrupt port operations independently of conflict

### News (article count 24h, top keywords)
- **What:** Headline volume + top keywords from 9 RSS feeds (Al Jazeera, BBC ME, Hellenic Shipping, Reuters Energy, OilPrice, etc.)
- **Refresh cadence:** Hourly
- **Why it matters:** Sudden volume spike = something is happening. Top keywords reveal what

### GDELT tone (neg_tone_pct)
- **What:** Negative-tone article share from GDELT 2.0 ToneChart
- **Source:** GDELT 2.0 Doc API
- **Refresh cadence:** Hourly
- **Why it matters:** Macro sentiment indicator. >70% negative in 24h = stress

### EIA weekly stocks (commercial crude + SPR)
- **What:** US commercial crude inventory + Strategic Petroleum Reserve, kbbl
- **Source:** EIA API (WCESTUS1 + WCSSTUS1)
- **Refresh cadence:** Weekly, Wed for prior Friday
- **Why it matters:** US buffer capacity vs supply-shock scenarios

### OPEC production (mbpd)
- **What:** OPEC-9 quota members' crude production, million bbl/day
- **Source:** EIA STEO PAPR_OPEC
- **Refresh cadence:** Monthly
- **Typical range:** 19-23 mbpd
- **Why it matters:** Compensating supply if Hormuz tightens

### LNG / Fertilizer / CAPE reroute
- **What:** Static supporting context (LNG volumes via Qatar, fertilizer chokepoint exposure, Cape of Good Hope reroute economics)
- **Refresh cadence:** Quarterly research review
- **Why it matters:** Broadens the crisis context beyond just oil

## Compliance metadata (must always show)

### "Last publish" dates
Every slow-cadence feed (BDTI, EIA daily, OFAC, OPEC) shows the explicit date the data refers to. E.g., "last publish Fri 16 May" prevents users from reading our staleness as their staleness.

### `static_fields` declaration
The `/api/snapshot` response includes a `static_fields[]` array that explicitly lists which fields are structural constants (e.g., `india_import_dependency_pct`, `oil_transit_value_usd_per_day`) and NOT live-tracked. Downstream consumers (IRM) read this to know when to label data as PROVISIONAL.

### Source attribution
Every tile shows a small badge: LIVE / ESTIMATED / OFFICIAL STATS / SATELLITE / etc. The badges map to the verified source confidence tier. Never show data without its tier.
