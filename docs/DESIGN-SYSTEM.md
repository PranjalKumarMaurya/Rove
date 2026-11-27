# Rove design system

This file is the source for how Rove looks and moves. Every screen takes its spacing, sizes, radii, colours, type and motion from here, through the CSS tokens named below. If a screen needs something this file doesn't have, add it here first, then use it. Never hand-pick a one-off value.

Related: [TYPOGRAPHY.md](TYPOGRAPHY.md) (type scale and fonts). The motion tokens are in `src/styles/motion.css`.

## 1. Spacing: one 4px grid

Every padding, margin and gap is one of these steps:

| Token | px | Use |
|---|---|---|
| `--space-1` | 4 | Icon to its label, tight inline pairs |
| `--space-2` | 8 | Gap inside a row (avatar to name, chip to chip) |
| `--space-3` | 12 | Gap between rows in a list; small card padding |
| `--space-4` | 16 | Card padding; gap between items in a card; form field gap |
| `--space-5` | 20 | Screen side gutter (left and right of every screen) |
| `--space-6` | 24 | Gap between sections on a screen |
| `--space-8` | 32 | Large breaks (before a footer action, after a hero) |
| `--space-10` | 40 | Bottom of a screen above the tab bar (plus the bar height) |

**Rules**
- The screen gutter is always `--space-5` (20px). Cards, lists, headers and horizontally scrolling strips all line up to it. A horizontal strip may run to the screen edge, but its first item starts at the gutter (`scroll-padding-inline` is the gutter).
- Sections on a screen are `--space-6` apart. Items inside a section are `--space-3` apart. Content inside a card is `--space-4` apart.
- Card padding is `--space-4`. A dense list card may use `--space-3` vertically and `--space-4` horizontally.
- No negative margins except to bleed a horizontal strip to the screen edge, which is then undone with matching padding.

## 2. Sizes

| Token | Value | Use |
|---|---|---|
| `--tap` | 44px | Minimum touch target (Apple HIG), for every button, row action and icon button |
| `--icon-sm` / `--icon-md` / `--icon-lg` | 16 / 20 / 24px | Icons inline with text / in buttons / in navigation |
| `--avatar-sm` / `--avatar-md` / `--avatar-lg` | 28 / 40 / 72px | Avatars in rows / in list headers / in Profile |
| `--field-h` | 48px | Text fields and selects; field text is 16px so iPhone doesn't zoom |
| `--button-h` / `--button-h-lg` / `--button-h-sm` | 44 / 48 / 36px (`sm` only inside dense rows) | Buttons |
| `--tab-bar-height` | 56px | Bottom bar, plus the home-indicator inset |

## 3. Radii

| Token | px | Use |
|---|---|---|
| `--radius-sm` | 8 | Small chips inside cards, inline code |
| `--radius-md` | 12 | Fields, buttons that aren't pills, list items |
| `--radius-lg` | 16 | Cards and sections |
| `--radius-xl` | 22 | Sheets and dialogs |
| `--radius-pill` | 999 | Pills, round icon buttons, toggles |

All of §1–§3 are CSS tokens on `:root` in `src/styles/global.css`.

A card inside a card uses the next radius down, so nested corners look concentric.

## 4. Surfaces and layers

- **Page:** `--bg-base`. **Card:** `.surface` (`--bg-card`, 1px `--border`, `--radius-lg`). **Raised** (sheets, dialogs): `--bg-elevated`.
- **Layer order:** content, the top fade (`z 4`), sticky headers inside content (`z 5`), the top bar edge (`z 30`), bottom bars (`z 40`), overlays and dialogs (`z 50`, portals), the status-bar shield (`10001`), native sheets (top layer).
- **Sticky headers** (like the Split day headers) stick just below the top shield: `top: var(--safe-top)`. They have a solid background matching what's behind them, so content never shows through or seems to overlap. They sit above the top fade, so a pinned header stays crisp.
- **Top edge:** when the page scrolls, a `--top-fade` (16px) fade from `--bg-base` to transparent appears along the shield's bottom edge (`index.html` `.status-fade`, shown while `html[data-scrolled]`). Content slides softly under it instead of being cut by a hard line. It is its own element rather than part of the shield, so it can sit below sticky headers and dialogs.

## 5. Layout rules

- **Grow, don't spill.** Text containers use `min-height`, never fixed `height`. Fixed-width tiles (like crew status) use `min-width` and let text wrap to two lines, then truncate.
- **Names never break mid-word.** Person and place names use `overflow-wrap: normal` and truncate with an ellipsis on one line where space is fixed (table cells, chips). Long free text (notes, chat) wraps with `overflow-wrap: anywhere`.
- **Money columns** are right-aligned and tabular (`.t-num`) and never wrap. When space runs out the label column truncates, never the amount.
- **One line per row heading.** A row's title truncates, its meta line may wrap, and its amount sits top-right.
- Everything must work from 320px wide up to the 480px column, at every text size (Profile → Text size) and with Bold text on.
- **Safe areas.** The top uses `var(--safe-top)` (status bar, plus the iPhone home-screen blur band). The bottom uses `env(safe-area-inset-bottom)` plus the bar height.

## 6. Components (one look each)

| Component | Spec |
|---|---|
| Screen header | Gutter padding; back or icon buttons at `--tap`; title `t-display`; subtitle `t-footnote` secondary; `--space-6` before content (`ScreenHeader.tsx` for pushed screens) |
| Pushed screen | A full screen above another (a Trip's To-dos and Settings): `.pushed-screen`, then `.pushed-content` with the gutter and `--space-6` between sections; no tab bar |
| Settings section | `.settings-section`: `t-title2` heading (`.settings-section__head` for one with an action), `--space-3` to its cards; `.settings-card` is a card with `--space-4` padding and `--space-3` gap; `.settings-actions` is a wrapping row of buttons `--space-2` apart |
| Icon button badge | `.round-btn__badge`: accent pill, top-right of a round icon button, `t-caption` tabular count (the Trip header's open to-dos) |
| Section | `t-title2` heading, an optional action on the right aligned to the heading's baseline, `--space-3` to the content |
| Card | `.surface`, padding `--space-4`, internal gap `--space-3` |
| List row | min-height `--tap`; leading avatar or icon (`--space-3` gap); title `t-headline`; meta `t-footnote`; trailing amount `t-headline t-num` |
| Primary button | Accent fill, `--button-h` lg, pill radius; label `t-headline`; states via AsyncButton (Save → Saving… → ✓ Saved) |
| Secondary button | Outline `--border-strong`, same sizes |
| Icon button | Round, `--tap` square, `--icon-md` icon, no label (aria-label required) |
| Field | `--field-h`, `--radius-md`, label `t-footnote` above with a `--space-2` gap, hint and error `t-caption` below |
| Pill / chip | Pill radius, min-height 36, horizontal padding `--space-3`, `t-callout` |
| Segmented control | Pill track; the selected segment is `--accent-soft`; min-height 36 |
| Bottom bar | `--tab-bar-height`; icons `--icon-lg`; labels `t-caption`, capped so they never wrap |

## 7. Checking

Before a UI change ships, the UI tour (`npm run test:ui:tour`) and the overflow check run at phone width. No horizontal scroll, no text outside its box, and no element hidden under the top or bottom bars.
