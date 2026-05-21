# Design Tokens — current state (extract from `index.html` `:root`)

## Colors

### Brand
| Token | Hex | Use |
|---|---|---|
| `--amber` | `#f09014` | Primary brand color · verdict signal · cargo ticker headline · brent trend line |
| `--green` | `#2cce81` | Calm / healthy / normal verdict / positive delta |
| `--red` | `#ff3e52` | High / critical / negative delta / errors |
| `--blue` | `#4aa0f0` | Informational / proxy data / WTI · IRR currency |

### Surfaces (dark theme, no light theme)
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#07090e` | Page background |
| `--panel` | `#11161f` | Card/panel background |
| `--panel2` | `#0c1119` | Secondary panel (inputs, code blocks) |
| `--border` | `#1a2230` | Subtle borders |
| `--border2` | `#222d3f` | Stronger borders / hover state |

### Text
| Token | Hex | Use |
|---|---|---|
| `--text` | `#cdd8e8` | Body text |
| `--muted` | `#8099b3` | Secondary text · labels |
| `--muted2` | `#627a95` | Tertiary text · timestamps |

### Status (semantic)
| State | Color | Background tint | Border tint |
|---|---|---|---|
| Live | `--green` | `rgba(44,206,129,0.10)` | `rgba(44,206,129,0.20)` |
| Estimated | `--amber` | `rgba(240,144,20,0.10)` | `rgba(240,144,20,0.20)` |
| Official-stat | `--blue` | `rgba(74,160,240,0.10)` | `rgba(74,160,240,0.20)` |
| Stale / error | `--red` | `rgba(255,62,82,0.10)` | `rgba(255,62,82,0.20)` |

## Typography

### Families
| Family | CSS var | Use |
|---|---|---|
| Sans | `'Manrope', -apple-system, system-ui, sans-serif` | Prose, body, headings |
| Mono | `'JetBrains Mono', ui-monospace, Menlo, monospace` | All numerics, labels, badges, timestamps |

Both loaded from Google Fonts in the `<head>`.

### Scale
| Size | px | Use |
|---|---|---|
| 9 | 9 | Tertiary labels, timestamps, badges (mono only) |
| 10 | 10 | Card titles, secondary labels — **mobile floor** |
| 11 | 11 | Body small, badge text |
| 12 | 12 | Body |
| 14 | 14 | Signal-bar values |
| 16 | 16 | Section headers, mobile signal value |
| 18 | 18 | Card price headlines |
| 22 | 22 | Brent main price (desktop) |
| 24+ | 24+ | Cargo ticker headline |

### Weights
- 400 — body
- 600 — labels, secondary headlines
- 700 — primary headlines, badges, all mono numbers

### Letter-spacing
- Body sans: default (0)
- Mono labels: `0.04em`–`0.08em`
- Mono uppercase badges: `0.06em`–`0.10em`

### Font-variant
- `font-variant-numeric: tabular-nums` — **required on all numeric tiles**

## Spacing

No formal scale exists; values used are: `2px 4px 5px 6px 8px 9px 10px 12px 14px 16px 18px 20px 22px 24px`. Designer should consolidate to a 4px or 8px grid in the redesign.

## Radii

| Use | Radius |
|---|---|
| Tags, badges | 3px |
| Buttons, inputs | 4-5px |
| Cards | 6px |
| Pills, large surfaces | 8px |
| Round dots | 50% |

## Borders

- Default: `1px solid var(--border)`
- Strong: `1px solid var(--border2)`
- Accent: `1px solid rgba(240,144,20,0.30)` (etc.)

## Shadows / elevation

Largely absent. The dashboard relies on borders + color, not shadows. Subtle box-shadow only on hover-tooltips.

## Animations

| Element | Property | Duration | Easing |
|---|---|---|---|
| Hover tooltips | opacity, transform | 180ms | ease |
| Tab switch | (none) | 0 | — |
| Cargo ticker count-up | text content | 1000ms | linear |
| Intel-tab pulse (mobile, until first tap) | box-shadow | 1.6s | `cubic-bezier(.66,0,0,1)` |
| Map zoom | (Leaflet default) | — | — |

## Iconography

- **Inline emoji** for compact icons (🚢 📊 ⚡) — pragmatic, no SVG sprite needed
- **Leaflet built-in icons** for map markers (custom SVGs in JS)
- **No icon library** (no Font Awesome, no Heroicons) — saves payload

## Special UI patterns

### `.sig` tile (signal-bar item)
3-row stack: value (mono 14-16px) · direction% (mono 9-10px) · label + source-tag (mono 9-10px). Tabular-nums required.

### `.rblock` (right-panel card)
Padding 16-18px, border-bottom only. Title in mono uppercase 10px, body in sans 12-14px.

### `.ip-layer` (India panel 3-layer compliance treatment)
Three stacked rows: `.ip-tag.data` (blue) · `.ip-tag.interp` (amber) · `.ip-tag.notice` (muted). Tags are inline-block, font-size 10px, padding 1.5px 6px, radius 3px.

### Pills with backgrounds
Pattern: `color: var(--X)` + `background: rgba(X, 0.10)` + `border: 1px solid rgba(X, 0.20)` + uppercase mono 9-10px.

## Designer task

Replicate / consolidate these into a Figma library or token JSON. Drop `--muted2` if it's redundant with `--muted`. Establish a real 4px or 8px spacing scale instead of the current 14-value ad-hoc.
