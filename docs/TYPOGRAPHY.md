# Rove typography

Researched on 2026-11-27. These are the type rules for the app; change them here first.

## Who reads Rove, and what that demands

- **Readers.** Mostly 15–40 year olds who travel a lot and use the app many times a day on a trip. Their parents and older relatives join the same Trips.
- **Reading conditions.** On the move: sun glare, a phone in one hand, quick glances between a cab and a check-in desk.
- **What the text is.** Short, dense things: times, amounts, names, flight codes, who paid. There are very few long paragraphs.
- **What that means.**
  - The text face must stay clear at small sizes.
  - Its numbers must line up in columns.
  - It must still have enough warmth and personality to feel like a travel product, not a bank.

## The families (all free, OFL, from Google Fonts)

| Role | Family | Why |
|---|---|---|
| Display: screen titles, trip names, big numbers in headings | **Fraunces** (variable: optical size, weight, softness) | A soft, warm serif that reads like a travel journal and is already part of the Rove look. Design write-ups in 2026 pair it with Inter for "built-in contrast and clear hierarchy" ([Muzli](https://muz.li/blog/font-pairings-2026/), [Getly](https://www.getly.store/blog/font-pairing-guide-2026-best-font-combinations-that-look-pro)). The optical-size axis keeps big titles elegant and smaller ones sturdy. |
| Text and interface: everything else | **Inter** (variable, with `opsz`) | Built for screens. It has tall lowercase letters, open shapes, tabular figures (`tnum`) and an unambiguous `1/l/I` (`cv05`, `cv08`). Guides for travel and booking interfaces recommend plain, highly legible sans serifs over decorative faces for dense lists ([Font Alternatives](https://fontalternatives.com/best-fonts-for/travel-hospitality/), [FontAdvice](https://fontadvice.com/font-collections/travel-app-fonts/)). |
| Codes only: PNR, booking references, flight numbers | **JetBrains Mono** | Replaces Share Tech Mono, which is narrow and "techy" and was used at 10–11px for labels. Those labels were too hard to read, especially for older readers. Monospace is kept only where characters must be compared one by one, such as a reference read out at a desk. |

Times, money and countdowns use **Inter with tabular figures**, not a monospace face, so they line up and stay as readable as the text around them.

## The scale

Based on Apple's text styles (Large Title 34 and Title 28, from the [HIG](https://developer.apple.com/design/human-interface-guidelines/typography)), adjusted for a web app:

| Token | Size / line height | Face, weight | Used for |
|---|---|---|---|
| `display` | 34 / 40 | Fraunces 500, opsz 72 | Screen titles ("Your Trips", trip name) |
| `title1` | 28 / 34 | Fraunces 500 | Section heroes, the balance figure |
| `title2` | 22 / 28 | Fraunces 500 | Section headings ("Itinerary", "Split") |
| `title3` | 19 / 25 | Fraunces 500 | Card titles that should feel special (event titles) |
| `headline` | 17 / 22 | Inter 600 | List-row titles, trip card names, amounts |
| `body` | 16 / 24 | Inter 400 | Paragraphs and form text |
| `callout` | 15 / 21 | Inter 400 | Secondary lines in cards |
| `footnote` | 13 / 18 | Inter 400/500 | Meta lines (who paid, dates), hints |
| `caption` | 12 / 16 | Inter 500 | Small labels, badges, field hints |
| `eyebrow` | 12 / 16, tracking 0.08em, uppercase | Inter 600 | Section labels ("UPCOMING", "PAST") |

**Rules**

- **Nothing smaller than 12px.** A review of mobile font-size research for older adults found legibility drops below about 11px (8.25pt) on phones, and that larger sizes are preferred up to a point ([Hou et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9376262/)). 12px is the floor, and the common reading sizes are 15–17px.
- **Fields are 16px.** Below that, iPhone Safari zooms into the field on focus.
- **Weights.** Normal 400, emphasis 500, titles and amounts 600. There are no thin weights (300). They wash out in sunlight and for older eyes, and contrast matters more than size.
- **Italic.** Fraunces italic is used only for the friendly voice: greetings ("Hi Pranjal. Where to next?"), "the crew, right now" and empty-state lines. Interface text is never italic.
- **Underline.** Only for links inside running text, with a 3px offset and a 1px line. Buttons and tappable rows are not underlined; their shape shows they can be tapped.
- **Uppercase.** Only for the short `eyebrow` labels, always with added letter spacing, never for sentences.
- **Numbers.** `font-variant-numeric: tabular-nums` everywhere money, times, dates in lists, or counts appear, so columns don't shimmer as values change.
- **Colour hierarchy.** `--text-primary` for the thing itself, `--text-secondary` for its details, and `--text-tertiary` only for hints and metadata, never for anything a person must read to act.

## How it's built

### Files

- `src/styles/type.css`: every token and role class. It is imported in `src/main.tsx` right after `fonts.css` (whose remote `@import` must lead the bundle) and before `global.css`.
- `src/styles/fonts.css`: one Google Fonts request with `display=swap`:
  - Fraunces with `ital,opsz,wght,SOFT` (weights 400–700, upright and italic);
  - Inter with `opsz,wght` (400–700);
  - JetBrains Mono at 400–600.
  
  Share Tech Mono is gone. The ranges reach 700 only so that Bold text can add 100 to 600.
- `tailwind.config.ts`: Tailwind's `text-xs`/`text-sm`… sizes are replaced by role aliases (`text-caption`, `text-footnote`, `text-callout`, `text-body`, `text-headline`). `font-normal`/`font-medium`/`font-semibold` (and `font-bold`, which equals semibold) follow the weight tokens.
- `src/lib/textSize.ts`: reads, saves and applies the Text size and Bold text choices. `src/features/profile/TextSizeSettings.tsx` is the Profile control.

### Tokens (on `:root`)

| Token | Value |
|---|---|
| `--text-scale` | 1 by default; set on `<html>` by Text size |
| `--weight-boost` | 0, or 100 with Bold text |
| `--font-display`, `--font-ui`, `--font-mono` | Fraunces, Inter, JetBrains Mono (with system fallbacks) |
| `--w-regular`, `--w-medium`, `--w-semibold` | `calc(400 / 500 / 600 + var(--weight-boost))` |
| `--type-display` / `--lh-display` | `min(40px, 34px × scale)` / `min(46px, 40px × scale)` |
| `--type-title1` / `--lh-title1` | `min(33px, 28px × scale)` / `min(39px, 34px × scale)` |
| `--type-title2` / `--lh-title2` | 22 / 28 × scale |
| `--type-title3` / `--lh-title3` | 19 / 25 × scale |
| `--type-headline` / `--lh-headline` | 17 / 22 × scale |
| `--type-body` / `--lh-body` | 16 / 24 × scale (also the `body` default) |
| `--type-callout` / `--lh-callout` | 15 / 21 × scale |
| `--type-footnote` / `--lh-footnote` | `max(12px, 13px × scale)` / `max(17px, 18px × scale)` |
| `--type-caption`, `--type-eyebrow` (+ `--lh-*`) | `max(11px, 12px × scale)` / `max(15px, 16px × scale)` |
| `--type-field` | `max(16px, var(--type-body))`: every input, select and textarea, so iPhone Safari never zooms |
| `--type-nav` / `--lh-nav` | `min(13px, var(--type-caption))` / `min(16px, …)`: bottom nav and tab bar labels |

Component CSS uses these tokens directly (for example `.pill`, `.chip`, `.notice`, `.row-btn`, `.topbar-btn`, `.nav-tab` and `.home-nav__item`). It never uses pixel font sizes.

### Classes

- **Roles:** `.t-display`, `.t-title1`, `.t-title2`, `.t-title3` (Fraunces 500, optical size from the font size, `SOFT` 50) and `.t-headline`, `.t-body`, `.t-callout`, `.t-footnote`, `.t-caption`, `.t-eyebrow` (Inter). `.t-eyebrow` is uppercase with 0.08em tracking and defaults to `--text-secondary`.
- **Modifiers** (they keep the role's size):
  - `.t-num`: tabular figures, for money, times, dates in lists and counts;
  - `.t-code`: JetBrains Mono at 0.93em with a slashed zero, for PNRs, booking references, flight numbers and UPI IDs;
  - `.t-voice`: Fraunces italic, for the friendly voice only;
  - `.t-medium` and `.t-semibold`;
  - `.t-link`: underline 1px, offset 3px, for inline links only.
- **How screens use them:**
  - Screen titles (Your Trips, the trip name, Profile) use `t-display`.
  - Tab and sheet headings (Itinerary, Split, Crew, dialog titles) use `t-title2`.
  - Sub-section and event titles use `t-title3`.
  - Section labels (UPCOMING, GROUP TOTALS, TO DO) use `t-eyebrow`.
  - List-row titles and amounts use `t-headline` (amounts add `t-num`).
  - Secondary lines and notices use `t-callout`.
  - Meta lines, hints, field labels and errors use `t-footnote`.
  - Field components keep `.field-label`/`.field-hint`/`.field-error` for colour only.
  - Empty states and greetings use a size role with `t-voice`.

### Text size and Bold text (Profile › Text size)

- **The slider.** It is an `<input type="range">` with 0–4 stops. They map `--text-scale` to **0.9, 0.95, 1 (default), 1.12 and 1.25**. Tick marks sit under the track, with a small "Aa" at one end and a large "Aa" at the other. A preview ("Day 2 · Mon 16 Nov" and "Dinner at Ganga View · ₹1,350") is the only element that animates between sizes (`.text-size-preview`, 160ms, off under reduced motion). The rest of the app changes in one step, so nothing re-lays out frame by frame.
- **Bold text.** This is a `Switch` that sets `--weight-boost` to 100, so 400 → 500, 500 → 600 and 600 → 700. The fonts are variable, so these are true weights. `<strong>` follows `--w-semibold`.
- **Saving and applying.** The choice is saved per device in `localStorage` under `rove.textSize` as `{ step, bold }`, with every access wrapped in try/catch. It is applied to `<html>` (`--text-scale`, `--weight-boost`, `data-text-step`, `data-bold-text`) in `src/main.tsx` before React renders, so the app never shows a flash of the default size.
- **Floors and caps.**
  - At the smallest step, captions and eyebrows stay at 11px or more, and footnotes at 12px or more.
  - Fields never drop below 16px.
  - At the largest step, display stops at 40px and title1 at 33px.
  - Nav and tab bar labels stop at 13px. They never wrap: they truncate with an ellipsis, and their icons keep a fixed size.
- **Layout.** Containers that hold text grow: they use `min-height` and wrap or truncate as in docs/DESIGN-SYSTEM.md §5.
  - Crew status tiles are 120–150px wide and follow the scale; the status wraps to two lines.
  - In Split's Group totals, names truncate and amounts never wrap. Below about 31em of footnote text, each name moves to its own line above that person's amounts (a container query in `splitTimeline.css`).
  - Each step was checked at 390×844, with Bold text on and off, on the Trips home, a Trip's Trip, Split, Scan and Crew tabs, Add expense, Trip settings and Profile. Nothing scrolled sideways or overflowed.
