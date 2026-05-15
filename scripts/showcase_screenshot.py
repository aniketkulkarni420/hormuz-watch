#!/usr/bin/env python3
"""showcase_screenshot.py — boot a real headless browser, navigate to the
deployed /showcase/, wait for it to settle, screenshot every card section,
and FAIL the job if the in-page self-test or any per-card assertion fires.

This is the "human-out-of-the-loop" layer (blindspot #6). It runs in CI on
every push, so a design regression cannot ship by going unnoticed.

ENV:
  SHOWCASE_URL  default https://hormuz-watch-2.pages.dev/showcase/
  OUT_DIR       default /tmp/showcase

Exit codes:
  0  — all assertions passed, screenshots captured
  1  — at least one assertion failed; check uploaded screenshots + logs
"""
import os
import sys
from pathlib import Path

SHOWCASE_URL = os.environ.get("SHOWCASE_URL", "https://hormuz-watch-2.pages.dev/showcase/")
OUT = Path(os.environ.get("OUT_DIR", "/tmp/showcase"))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium")
        return 2

    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000}, device_scale_factor=2)
        page = ctx.new_page()
        print(f"Navigating to {SHOWCASE_URL} ...")
        page.goto(SHOWCASE_URL, wait_until="networkidle", timeout=45000)
        # Wait for the in-page self-test to render + settle
        page.wait_for_selector("#assertSummary", timeout=15000)
        page.wait_for_timeout(2500)

        # ── Self-test summary
        summary = (page.text_content("#assertSummary") or "").strip()
        print(f"\nSelf-test summary: {summary}")

        # ── Self-test issues list
        issue_items = page.query_selector_all("#assertList li")
        if issue_items:
            print(f"\n[FAIL] Self-test overflow tripwire — {len(issue_items)} issue(s):")
            for it in issue_items:
                txt = (it.text_content() or "").strip()
                print(f"   - {txt}")
                failures.append(("overflow", txt))

        # ── Per-card explicit assertions
        per_card_fails = page.query_selector_all(".assert-card.fail")
        if per_card_fails:
            print(f"\n[FAIL] Per-card assertions — {len(per_card_fails)} failure(s):")
            for f in per_card_fails[:50]:
                txt = (f.text_content() or "").strip()
                perm = f.evaluate("e => e.closest('.perm')?.dataset?.label || '?'")
                print(f"   - [{perm}] {txt}")
                failures.append(("assertion", f"{perm}: {txt}"))

        # ── Per-section screenshots
        sections = page.query_selector_all(".section")
        print(f"\nCapturing {len(sections)} card sections...")
        for sec in sections:
            title_el = sec.query_selector(".section-title")
            title = (title_el.text_content() if title_el else "section").strip()
            slug = title.lower().replace(" ", "-").replace("/", "-")
            target = OUT / f"{slug}.png"
            sec.screenshot(path=str(target))
            print(f"   - {target.name}")

        # ── Full-page screenshot for the PR comment
        full = OUT / "_full.png"
        page.screenshot(path=str(full), full_page=True)
        print(f"   - {full.name} (full page)")

        # ── Iterate width toggles (blindspot for mobile-sidebar regressions)
        for w in ("280", "480"):
            btn = page.query_selector(f'.wbtn[data-w="{w}"]')
            if not btn:
                continue
            btn.click()
            page.wait_for_timeout(800)
            screenshot_path = OUT / f"_full_w{w}.png"
            page.screenshot(path=str(screenshot_path), full_page=True)
            print(f"   - {screenshot_path.name} (width {w}px)")
            # Re-check assertions at this width too
            w_fails = page.query_selector_all(".assert-card.fail")
            w_issues = page.query_selector_all("#assertList li")
            if w_fails or w_issues:
                print(f"  [FAIL] width={w}px: {len(w_fails)} assertion failures + {len(w_issues)} overflow issues")
                for f in w_fails[:20]:
                    failures.append((f"width-{w}", (f.text_content() or "").strip()))
                for f in w_issues[:20]:
                    failures.append((f"width-{w}", (f.text_content() or "").strip()))

        browser.close()

    if failures:
        print(f"\n{'='*60}\n[X] FAIL — {len(failures)} issue(s) detected")
        for kind, msg in failures[:30]:
            print(f"   [{kind}] {msg}")
        print(f"\nScreenshots written to {OUT}/ — review them to see the regression.")
        return 1

    print(f"\n{'='*60}\n[OK] All design-bug tripwires passed. {len(sections)} cards screenshotted to {OUT}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
