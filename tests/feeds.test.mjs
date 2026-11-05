// Regression tests for the 2026-11-05 first-click QA fixes.
//
// 1. /api/stooq returns WTI spot for the SAME EIA print date as Brent, so the
//    page can show Brent, WTI, change and spread from one source on one date.
// 2. /api/integrity flags an old IMF PortWatch file as stale. It compared
//    seconds with milliseconds and read a 3-month-old file as "ok".
//
// Run: node --test   (no dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as stooqGet } from "../functions/api/stooq.js";
import { onRequestGet as integrityGet } from "../functions/api/integrity.js";

function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return fn().finally(() => { globalThis.fetch = real; });
}

// EIA v2 rows: both series interleaved, newest period first.
const EIA_ROWS = [
  { period: "2026-11-03", series: "RBRTE", value: "107.03" },
  { period: "2026-11-03", series: "RWTC",  value: "100.21" },
  { period: "2026-11-02", series: "RBRTE", value: "107.39" },
  { period: "2026-11-02", series: "RWTC",  value: "100.80" },
  { period: "2026-10-30", series: "RBRTE", value: "118.00" },
];

test("stooq: Brent change is EIA vs EIA, WTI is the same print date", async () => {
  await withFetch(async () => new Response(JSON.stringify({ response: { data: EIA_ROWS } })), async () => {
    const r = await stooqGet({ env: { EIA_KEY: "x" } });
    const d = await r.json();
    assert.equal(d.today, 107.03);
    assert.equal(d.yesterday, 107.39);
    assert.equal(d.todayDate, "2026-11-03");
    assert.equal(d.yesterdayDate, "2026-11-02");
    assert.ok(Math.abs(d.pct - (-0.3352)) < 0.001, "pct " + d.pct);
    assert.equal(d.wti, 100.21);
    assert.equal(d.wtiDate, "2026-11-03");
  });
});

test("stooq: no WTI for the Brent date gives wti null, not an older print", async () => {
  const rows = EIA_ROWS.filter(x => !(x.series === "RWTC" && x.period === "2026-11-03"));
  await withFetch(async () => new Response(JSON.stringify({ response: { data: rows } })), async () => {
    const d = await (await stooqGet({ env: { EIA_KEY: "x" } })).json();
    assert.equal(d.today, 107.03);
    assert.equal(d.wti, null);
    assert.equal(d.wtiDate, null);
  });
});

function kvWith(map) {
  return { get: async (k) => (k in map ? JSON.stringify(map[k]) : null) };
}

test("integrity: PortWatch data 80 days old is stale", async () => {
  const now = Math.floor(Date.now() / 1000);
  const asOf = new Date((now - 80 * 86400) * 1000).toISOString().slice(0, 10);
  const r = await integrityGet({ env: { OIL_KV: kvWith({
    portwatch_state: { as_of: asOf, fetchedAt: now - 79 * 86400, latest: { total: 1 }, pct_of_prewar: 6 },
  }) } });
  const d = await r.json();
  assert.equal(d.feeds.portwatch.status, "stale");
});

test("integrity: PortWatch data 6 days old is ok with a positive age", async () => {
  const now = Math.floor(Date.now() / 1000);
  const asOf = new Date((now - 6 * 86400) * 1000).toISOString().slice(0, 10);
  const r = await integrityGet({ env: { OIL_KV: kvWith({
    portwatch_state: { as_of: asOf, fetchedAt: now - 3600, latest: { total: 40 }, pct_of_prewar: 60 },
  }) } });
  const d = await r.json();
  assert.equal(d.feeds.portwatch.status, "ok");
  assert.equal(d.feeds.portwatch.ageMin, 60);
});
