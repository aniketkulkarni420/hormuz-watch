#!/usr/bin/env python3
"""check_mirror.py — verify showcase/index.html's MIRRORED CSS blocks match
their live counterparts in index.html. Drift = silent showcase inaccuracy =
false negatives in the design-bug safety net.

How it works:
  - showcase/index.html marks each block of live-mirrored CSS with
      /* BEGIN-MIRRORED: <label> */
      ... rules ...
      /* END-MIRRORED */
  - For every CSS selector that appears inside ANY mirrored block, this
    script extracts that selector's rule from BOTH files, normalises
    whitespace, and compares.
  - Any mismatch is printed and exits non-zero (CI-friendly).

When a mismatch fires:
  (a) Update showcase/index.html to mirror the live change, OR
  (b) Decide the showcase intentionally diverges and move the rule OUT
      of the BEGIN-MIRRORED block (with a comment explaining why).

Run:    python3 scripts/check_mirror.py
Run-CI: same; non-zero exit fails the job.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIVE = ROOT / "index.html"
SHOW = ROOT / "showcase" / "index.html"


def extract_mirrored_blocks(text: str):
    """Return [(label, body), ...] for every /* BEGIN-MIRRORED: X */ ... /* END-MIRRORED */ in text."""
    # Accept END-MIRRORED with or without a label: /* END-MIRRORED */ and
    # /* END-MIRRORED: theme vars */ both close a block.
    pat = re.compile(
        r"/\*\s*BEGIN-MIRRORED:\s*(?P<label>[^*]+?)\s*\*/(?P<body>.*?)/\*\s*END-MIRRORED(?::[^*]*)?\s*\*/",
        re.S,
    )
    return [(m.group("label").strip(), m.group("body")) for m in pat.finditer(text)]


# Match a single CSS rule. Handles nested-free declarations (no @media or nested
# selectors inside our mirrored blocks — keep it that way).
RULE_RE = re.compile(r"^\s*(?P<sel>[^\s{}][^{}]*?)\s*\{(?P<decl>[^{}]*)\}", re.M)


def selectors_in(body: str):
    """Yield (selector, declaration_text) for each rule in a CSS body."""
    for m in RULE_RE.finditer(body):
        sel = m.group("sel").strip()
        decl = m.group("decl")
        yield sel, decl


def find_rule_in_text(text: str, selector: str):
    """Find a CSS rule for a given selector anywhere in text. Returns the
    declarations body (between the braces), or None. Selector match is exact
    after whitespace normalisation."""
    norm_target = re.sub(r"\s+", " ", selector).strip()
    for m in RULE_RE.finditer(text):
        sel = re.sub(r"\s+", " ", m.group("sel")).strip()
        if sel == norm_target:
            return m.group("decl")
    return None


def normalise_decl(decl: str) -> str:
    # Drop comments
    decl = re.sub(r"/\*.*?\*/", "", decl, flags=re.S)
    # Drop the `transition: none !important` showcase override applied
    # globally — irrelevant when comparing per-rule declarations.
    # Standardise whitespace, semicolons, decl order.
    parts = [p.strip() for p in decl.split(";") if p.strip()]
    parts = [re.sub(r"\s+", " ", p) for p in parts]
    return " ; ".join(sorted(parts))


def main():
    live_text = LIVE.read_text(encoding="utf-8")
    show_text = SHOW.read_text(encoding="utf-8")
    blocks = extract_mirrored_blocks(show_text)
    if not blocks:
        print("check_mirror.py: no BEGIN-MIRRORED blocks found in showcase. Nothing to check.")
        return 0
    print(f"check_mirror.py: checking {len(blocks)} mirrored block(s) for drift...\n")
    issues = []
    total_selectors = 0
    for label, body in blocks:
        sels = list(selectors_in(body))
        print(f"  [{label}] {len(sels)} selector(s)")
        for sel, show_decl in sels:
            total_selectors += 1
            live_decl = find_rule_in_text(live_text, sel)
            if live_decl is None:
                issues.append(f"  [X] [{label}] `{sel}` — not found in index.html (live rule may have been renamed or removed)")
                continue
            show_n = normalise_decl(show_decl)
            live_n = normalise_decl(live_decl)
            if show_n != live_n:
                issues.append(
                    f"  [X] [{label}] `{sel}` — DRIFT\n"
                    f"      live:     {live_n[:160]}{'…' if len(live_n)>160 else ''}\n"
                    f"      showcase: {show_n[:160]}{'…' if len(show_n)>160 else ''}"
                )
    print()
    if not issues:
        print(f"[OK] All clear — {total_selectors} mirrored selector(s) match between live and showcase.")
        return 0
    print(f"[X] {len(issues)} drift issue(s) found across {total_selectors} mirrored selector(s):\n")
    for i in issues:
        print(i)
    print(
        "\nFix paths:\n"
        "  (a) Update showcase/index.html to mirror the live change\n"
        "      (see HARD_RULES.md #11), OR\n"
        "  (b) If the showcase divergence is intentional, move the rule OUT\n"
        "      of its BEGIN-MIRRORED block and document why."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
