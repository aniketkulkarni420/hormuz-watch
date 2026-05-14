# MODES.md — The 5 Rendering Modes

Every visual element in the right sidebar MUST be reviewed in ALL 5 modes before any change ships.

## The modes

### 1. AIS-mode
- **Trigger:** `snapshot.data_source !== "web_scrape" && !snapshot.is_static`
- **Indicators:** Real AIS data flowing. AISStream feeding `ais_state` KV.
- **What renders:** Direction split bar (E/W), 3-tile category grid (Transit/Anchored/Approach), live type breakdown
- **Badge color:** green (`src-green`)

### 2. Scrape-mode
- **Trigger:** `snapshot.data_source === "web_scrape" || snapshot.is_static`
- **Indicators:** AISStream broken. VesselFinder web scrape filling vessel counts.
- **What renders:** Port-activity headline (148 vessels in 5 Gulf ports), per-port bars, scraped type mix, banner "AIS feed degraded · using port-activity proxy"
- **MUST hide:** AIS-era direction bar, E/W text, 3-tile category grid (those numbers do not exist in scrape data)
- **Badge color:** blue (`src-blue`) labeled "WEB FEED · 4h"

### 3. Empty-mode
- **Trigger:** All upstream data null / 0 / fetch returned no usable values
- **What renders:** Em-dash placeholders, "DATA PENDING" or "—" badge
- **Badge color:** muted (`src-muted` / no class)
- **MUST NOT:** label anything as LIVE

### 4. Loading-mode
- **Trigger:** Initial page load, before fetch responses arrive
- **What renders:** "loading..." text, em-dashes, skeleton bars
- **Duration:** transient (typically <2s)
- **MUST NOT:** flicker between loading and empty repeatedly

### 5. Error-mode
- **Trigger:** Endpoint fetch failed (404, 500, network error, parse error)
- **What renders:** Em-dash + error badge red (`src-red`), do NOT show stale cached numbers as "LIVE"
- **Console:** error logged (Sentry if configured)
- **Badge color:** red (`src-red`)

## Rule

Before any visual change, document in your Pre-Change Checklist:

> Modes affected: [list which of the 5]
> Modes tested: [list which were verified to render correctly after change]

If you can't list both, you haven't done the work.

## Card-by-card mode inventory

| Card | AIS | Scrape | Empty | Loading | Error |
|---|---|---|---|---|---|
| Vessel Movement | full | port-activity reframe | em-dash | "loading..." | em-dash |
| Vessel Type Mix | AIS breakdown | scraped types + Ports/Vessels tiles | global-fleet ref | "loading..." | em-dash |
| Market Pulse | n/a (oil unaffected) | n/a | em-dash | "loading..." | em-dash |
| Cross-Signal Verification | 10 live rows | 10 rows w/ scrape labels | em-dash rows | "loading..." | em-dash |
| Political Signals | live | live | em-dash | "loading..." | em-dash |
| Macro Context | n/a | n/a | em-dash | "loading..." | em-dash |
| Conditions | live | live | em-dash | "loading..." | em-dash |
