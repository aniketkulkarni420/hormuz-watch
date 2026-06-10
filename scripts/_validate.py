"""Shared write-time validation for scrapers (Tier 1A · 2026-05-28).

Defense-in-depth: before a scraper overwrites a good KV value with a fresh
fetch, it should confirm the fetch is (a) within sane bounds and (b) not an
absurd jump vs the prior value. This catches the failure class where a source
returns garbage (frozen constant, parse error, API-cap number) that passes a
naive "we got a number" check.

Oil (scrape_oil_stooq) and BDTI (scrape_bdti) already have bespoke guards;
this module is for the scrapers that don't, and standardises the pattern.

All functions are pure + import-light so any scraper can use them.
"""

# Per-metric plausibility bounds. Generous — these catch GARBAGE, not
# normal market moves. Tighten only if a real failure slips through.
BOUNDS = {
    "brent_usd":        (30.0, 250.0),
    "wti_usd":          (30.0, 250.0),
    "bdti":             (500.0, 6000.0),
    "irr_spread_pct":   (0.0, 150.0),
    "irr_usd":          (50_000.0, 5_000_000.0),
    "vessel_total":     (0, 1500),   # raised 500->1500 (2026-05-29): parser now reads authoritative "Ships in port: N" per port (was undercounting via linked rows); 8 ports sum far higher
    "aircraft_count":   (0, 300),
    "wind_knots":       (0.0, 120.0),
    "earthquake_mag":   (0.0, 10.0),
    "opec_mbpd":        (10.0, 40.0),
}


def in_bounds(metric, value):
    """True if value is finite and within the metric's plausibility band."""
    if metric not in BOUNDS:
        return True   # unknown metric — don't block
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    lo, hi = BOUNDS[metric]
    return lo <= v <= hi


def anomaly_ok(prev, new, max_pct=60.0):
    """True if `new` is within max_pct% of `prev`. Used to reject absurd jumps
    (the +219% BDTI bug). If prev is missing/zero, always allow (first run)."""
    try:
        p = float(prev)
        n = float(new)
    except (TypeError, ValueError):
        return True
    if p == 0:
        return True
    jump = abs(n - p) / abs(p) * 100.0
    return jump <= max_pct


def validate(metric, value, prev=None, max_pct=60.0):
    """Combined gate. Returns (ok: bool, reason: str).

    Usage in a scraper:
        ok, why = validate("irr_spread_pct", spread, prev=prev_spread)
        if not ok:
            print(f"  ✗ rejecting write: {why}")
            # ...skip the KV put, preserve the prior good value...
    """
    if not in_bounds(metric, value):
        return False, f"{metric}={value} out of bounds {BOUNDS.get(metric)}"
    if prev is not None and not anomaly_ok(prev, value, max_pct):
        return False, f"{metric} jumped >{max_pct}% ({prev} -> {value})"
    return True, "ok"
