-- Hormuz Watch — hourly snapshot schema
-- Cloudflare D1 (SQLite). Migration: applied via `wrangler d1 execute hormuz-watch-data --file=schema.sql`

CREATE TABLE IF NOT EXISTS snapshots (
  ts                    INTEGER PRIMARY KEY,    -- unix epoch seconds
  -- vessel state (from B+ engine)
  transits_24h          INTEGER,                -- gate-crossing count over rolling 24h
  vessels_transiting    INTEGER,                -- snapshot: SOG>=5kn in TSS corridor
  vessels_anchored      INTEGER,                -- snapshot: SOG<0.5kn
  vessels_approach      INTEGER,                -- snapshot: moving but not classified transit
  -- prices
  brent_price           REAL,                   -- USD/bbl, current best estimate
  brent_source          TEXT,                   -- 'twelvedata' | 'eia' | 'etf+eia'
  wti_price             REAL,
  bw_spread             REAL,
  -- freight + incidents
  bdti                  INTEGER,                -- Baltic Dirty Tanker Index level
  bdti_wow              REAL,                   -- last published % WoW change
  gfw_encounters        INTEGER,                -- 30-day rolling count
  gfw_loitering         INTEGER,
  dark_pct              REAL,                   -- GFW events / (AIS + GFW)
  -- macro
  india_via_hormuz_pct  REAL,                   -- static for now (62)
  -- system health
  source_health         TEXT,                   -- JSON: {ais: 'fresh', eia: 'fresh', ...}
  verdict               TEXT                    -- computed risk verdict: NORMAL | ELEVATED | HIGH | CRITICAL
);

-- Index for time-range queries (DESC for fastest recent-row lookups)
CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts DESC);

-- Event log: notable threshold breaches, source failures, etc. (for alerts in Tier 2)
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,                  -- 'threshold' | 'source_failure' | 'crisis_signal'
  severity      TEXT NOT NULL,                  -- 'info' | 'warn' | 'critical'
  source        TEXT,                           -- which data source/metric
  payload       TEXT                            -- JSON details
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

-- Source-health log: every freshness check from the monitor worker
CREATE TABLE IF NOT EXISTS health_checks (
  ts            INTEGER NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL,                  -- 'ok' | 'fail'
  latency_ms    INTEGER,
  http_status   INTEGER,
  error         TEXT,
  PRIMARY KEY (ts, source)
);

CREATE INDEX IF NOT EXISTS idx_health_checks_source_ts ON health_checks(source, ts);

-- ─── Analyst commentary (Tier 2.4) ────────────────────────
CREATE TABLE IF NOT EXISTS commentary (
  ts            INTEGER PRIMARY KEY,                  -- unix seconds when posted
  author        TEXT DEFAULT 'aniket',
  title         TEXT,                                 -- optional one-line headline
  body_md       TEXT NOT NULL,                        -- body (plain text / lightweight markdown)
  signal_ctx    TEXT,                                 -- JSON of dashboard state at posting time (optional)
  display_until INTEGER,                              -- when banner retires (NULL = always)
  visibility    TEXT DEFAULT 'public'                 -- 'public' | 'subscriber' (gated later)
);
CREATE INDEX IF NOT EXISTS idx_commentary_ts ON commentary(ts);
CREATE INDEX IF NOT EXISTS idx_commentary_display_until ON commentary(display_until);

-- ─── Email digest subscribers (Tier 2.2) ──────────────────
CREATE TABLE IF NOT EXISTS subscribers (
  email           TEXT PRIMARY KEY,
  joined_ts       INTEGER NOT NULL,
  confirmed       INTEGER DEFAULT 0,                  -- 0 = unconfirmed, 1 = confirmed
  confirm_token   TEXT,
  segment         TEXT DEFAULT 'free',                -- 'free' | 'pro' | 'institutional'
  unsubscribed_ts INTEGER,
  source          TEXT                                -- where they signed up from (e.g. 'footer-form')
);
CREATE INDEX IF NOT EXISTS idx_subscribers_confirmed ON subscribers(confirmed);

-- Digest run history
CREATE TABLE IF NOT EXISTS digest_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,                   -- when generated
  week_starting   TEXT,                               -- YYYY-MM-DD
  preview_html    TEXT,
  reviewed        INTEGER DEFAULT 0,
  sent_ts         INTEGER,
  sent_count      INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'draft'                -- 'draft' | 'reviewed' | 'sent' | 'failed'
);
CREATE INDEX IF NOT EXISTS idx_digest_runs_ts ON digest_runs(ts);

-- ─── Feature usage analytics (FIX #8) ────────────────────
-- Lightweight event log for tracking which dashboard features users actually use.
-- Distinct from the system `events` table above (which is for threshold/source
-- alerts). Allow-list enforced server-side in /api/event.
CREATE TABLE IF NOT EXISTS feature_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  props TEXT,         -- JSON
  ip_hash TEXT,       -- SHA-256 of IP+salt for uniqueness without PII
  ua_short TEXT       -- "Chrome/Mac", "Safari/iOS" etc. — no fingerprinting
);
CREATE INDEX IF NOT EXISTS idx_feature_events_ts ON feature_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_feature_events_name ON feature_events(event);
