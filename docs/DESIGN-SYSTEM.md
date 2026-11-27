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
| `--space-8` | 32 | Large breaks (before a form's submit button: the form gap plus `mt-4`; after a hero) |
| `--space-10` | 40 | Bottom of a pushed screen (no bar); room for a select's chevron |

**In code.** Tailwind's padding, margin, gap and space utilities take only these steps, and the number is the token: `p-4` is `--space-4`, `gap-6` is `--space-6`, `-mx-5` is minus `--space-5` (`tailwind.config.ts`). Off-grid steps (`p-1.5`, `gap-7`, `mt-0.5`, `p-[13px]`) are not generated at all. Script that sets spacing (a Collapse folding its parent's gap, a list's `--fold-gap`) passes a step to `space()` from `src/components/ui/space.ts`. CSS uses `var(--space-*)`. `tests/unit/layout-tokens.test.mjs` fails on any raw px spacing in classes, inline styles or CSS; a deliberate exception carries `/* layout: why */` on the same line.

**Rules**
- The screen gutter is always `--space-5` (20px), on every screen, dialog and sheet. Cards, lists, headers and horizontally scrolling strips all line up to it. A horizontal strip may run to the screen edge, but its first item starts at the gutter (`scroll-px-5`).
- Sections on a screen are `--space-6` apart. A heading is `--space-3` above its content. Items in a list are `--space-3` apart (cards and rows alike).
- Card padding is `--space-4` on every side (`.card`), and blocks inside a card are `--space-4` apart. A dense list card (an expense, a payment, a document, a to-do) is `.card--row`: `--space-3` above and below, `--space-4` at the sides.
- Pairs that read as one thing stay tight: a title and its meta line `--space-1`, a label and its field `--space-2`.
- The header ends with `--space-3` and the content starts with `--space-3`, so content begins `--space-6` under the header.
- At the end of a screen with a bottom bar, the last content ends exactly `--space-6` above the bar (`--screen-end`; on the Trips home and Profile also above the raised ＋).
- No negative margins except: to bleed a horizontal strip to the screen edge (undone with matching padding), and to let a `--tap` hit area overhang a smaller visible thing (the close cross lines its icon up with the gutter; a chip's remove button; a text action in a section head, `.head-action`).

## 2. Sizes

| Token | Value | Use |
|---|---|---|
| `--tap` | 44px | Minimum touch target (Apple HIG), for every button, row action and icon button |
| `--icon-sm` / `--icon-md` / `--icon-lg` | 16 / 20 / 24px | Icons inline with text / in buttons / in navigation |
| `--avatar-sm` / `--avatar-md` / `--avatar-lg` | 28 / 40 / 72px | Avatars in rows / in list headers / in Profile |
| `--field-h` | 48px | Text fields, selects and date fields (textareas are twice this); field text is 16px so iPhone doesn't zoom |
| `--field-px` | `--space-3` | Inline padding inside fields |
| `--button-h` / `--button-h-lg` / `--button-h-sm` | 44 / 48 / 36px | Buttons. `md` (NeonBtn default) is `--button-h`, `lg` (a screen's main action) is `--button-h-lg`. `sm` is only for a chip or a button inside a field, and then its hit area is extended to `--tap` |
| `--check-size` | 18px | The to-do checkbox |
| `--tab-bar-height` | 56px | Both bottom bars (the Trip tab bar and the Trips home nav), plus `--tab-bar-bottom` above the home indicator |
| `--bar-clear` | bar + offset + 1px | The room a bottom bar takes; `--screen-end` = `--bar-clear` + `--space-6` |
| `--fab-size` / `--fab-rise` | 52px / `--space-6` | The raised ＋ on the Trips home nav and how far it rises above the bar |

Tailwind has the same names for sizes: `min-h-tap`, `min-h-field`, `min-h-button`, `min-h-button-lg`, `size-avatar-sm`, `size-avatar-md` … Icons take `size="sm" | "md" | "lg"` (`icons.tsx`), never a pixel number.

## 3. Radii

| Token | px | Use |
|---|---|---|
| `--radius-sm` | 8 | Small chips inside cards, inline code |
| `--radius-md` | 12 | Fields, buttons that aren't pills, list items |
| `--radius-lg` | 16 | Cards and sections |
| `--radius-xl` | 22 | Sheets and dialogs |
| `--radius-pill` | 999 | Pills, round icon buttons, toggles |

All of §1–§3 are CSS tokens on `:root` in `src/styles/global.css`. Tailwind's `rounded-sm/md/lg/xl/full` are these tokens (there is no other radius).

Every card is `--radius-lg` (`.surface`). A card inside a card or a dialog uses the next radius down (`.card--nested`, `--radius-md`), and a box inside that `--radius-sm`, so nested corners look concentric. Tappable rows (`.row-btn`, `.switch-row`, `.list-option`) and fields are `--radius-md`.

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
- **Docked to the bar.** The Chat composer is the one thing that sits closer than `--space-6` to the tab bar: it docks `--space-2` above it, like a messenger's, and the messages scroll above it. The message column's avatars sit on the gutter; my bubbles' tails take the `--space-2` on the right.

## 6. Components (one look each)

| Component | Spec |
|---|---|
| Screen header | `ScreenHeader.tsx`, the same on every screen with a way back: a Trip, its To-dos and Settings, and Profile's Privacy and Terms pages. Gutter padding; round back button on the left and round icon buttons on the right, all `--tap`; title `t-display`; subtitle `t-footnote` secondary right under it; `--space-6` before content |
| Pushed screen | A full screen above another (a Trip's To-dos and Settings, Profile's legal pages): `.pushed-screen`, then `.pushed-content` with the gutter and `--space-6` between sections; no tab bar |
| Settings section | `.settings-section` (= `.section`): `t-title2` heading (`.settings-section__head` = `.section-head` for one with an action), `--space-3` to its cards; `.settings-card` is a card with `--space-4` padding and `--space-4` between its blocks; `.settings-actions` is a wrapping row of buttons `--space-2` apart |
| Icon button badge | `.round-btn__badge`: accent pill, top-right of a round icon button, `t-caption` tabular count (the Trip header's open to-dos) |
| Section | `.section`: heading, then `--space-3` to the content. `.section-head` puts an action on the right, aligned to the heading's baseline. A text-only action there is `.head-action` (its `--tap` hit area overhangs, so the head is as tall as its text) |
| Card | `.surface .card`: `--radius-lg`, padding `--space-4`, blocks `--space-4` apart. `.card--row` for dense list cards, `.card--nested` inside a card or dialog |
| List row | min-height `--tap`; leading avatar (`--avatar-sm`) or icon (`--space-3` gap); title `t-headline`; meta `t-footnote`; trailing amount `t-headline t-num` |
| Primary button | NeonBtn: accent fill, pill radius, `--button-h` (or `--button-h-lg` with `size="lg"`), `--space-4` (`lg`: `--space-5`) at the sides, icon and label centred `--space-2` apart; states via AsyncButton (Save → Saving… → ✓ Saved) |
| Secondary button | NeonBtn `variant="outline"` or `"ghost"`, same sizes |
| Quiet button | `.btn-quiet`: a secondary action inside a card or row (Edit, Delete, Rename, Map, Copy): `--tap` tall, `--radius-md`, hairline border, `t-footnote` |
| Icon button | Round (`.round-btn`), `--tap` square, `--icon-md` icon, no label (aria-label required) |
| Field | `.field-input` (NeonInput), `.field-select`, `.field-textarea`: `--field-h`, `--field-px` inside, `--radius-md`; label `t-footnote` above with a `--space-2` gap, hint and error `t-footnote` below |
| Pill / chip | A tappable chip (`.chip-btn`, a quick amount, "Change to bill") or a person to tick (`.pill.pill--tap`): pill radius, min-height `--tap`, `--space-3` at the sides. A plain `.pill` is a status badge (not tappable) |
| Segmented control | `.segmented` pill track with `.segmented__item` segments, each `--tap` tall; the selected one is `--accent-soft` |
| Dialog | Centred: `.dialog-overlay` (starts under the top shield; the card sits on the gutter, `--space-6` from top and bottom) and `.dialog-card` (`--radius-xl`, `--space-5` inside); `.dialog-head` holds the title and the close cross, `--space-4` above the content. A native `<dialog>` uses `.action-dialog`, the same box |
| Sheet | Bottom sheet (`Sheet.tsx`): full width, `--radius-xl` top corners, content on the gutter, `--space-6` plus the home-indicator inset at the bottom |
| Bottom bar | `--tab-bar-height` for both bars; icons `--icon-lg`; labels `t-caption`, capped so they never wrap. The Trips home nav's ＋ is `--fab-size`, rising `--fab-rise` above the bar |

## 7. Checking

Before a UI change ships, the UI tour (`npm run test:ui:tour`) and the overflow check run at phone width. No horizontal scroll, no text outside its box, and no element hidden under the top or bottom bars.

Two checks hold this file to the code:

- `tests/unit/layout-tokens.test.mjs` (`npm run test:unit`) reads the source: spacing classes use only the token steps, inline styles set no px spacing or radius, CSS spacing goes through `var(--space-*)`.
- `tests/browser/layout/layout-audit.spec.ts` (`npx playwright test tests/browser/layout`, synthetic data, no backend) opens every screen it can reach (Trips home, Profile and its sheet, Create Trip, join, Trip, To-dos, Settings, a member's actions, Split, Add expense, Settle up, Scan, Chat, FX, Add event, the invite-link popup) at 390×844 and 320×640 and checks:
  1. no horizontal overflow, and nothing cut at the screen's edge outside a scroller;
  2. every visible button, link, tab, switch and summary is at least 44px tall. Exceptions: a link inside running text (`display: inline`, or `data-layout-exempt="inline"`), and a button inside a field (`data-layout-exempt="in-field"`) whose hit area a pseudo-element extends to `--tap`;
  3. elements marked `data-layout="section"` are 24px from the section before them, and top-level ones sit on the 20px gutter; `data-layout="card"` has 16px padding on every side; `data-layout="row"` has 12px above and below and 16px at the sides;
  4. scrolled to the end, nothing sits under the bottom bar (or the raised ＋), and the last content ends 24px above it (Chat's composer is the documented exception).

  Mark new sections, cards and rows with `data-layout` as you add them. `LAYOUT_SHOTS=<folder>` also saves a screenshot of each screen.
