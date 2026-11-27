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

- Tokens live in `src/styles/global.css` (`--type-*` and `.t-*` classes). Components use the classes instead of inline font sizes.
- Fonts load from Google Fonts with `display=swap`; only the needed axes and weights are requested.
