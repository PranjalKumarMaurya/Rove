# Design brief: the Rove website

Design and build the marketing homepage for **Rove**, a web app that friends use to run a group trip together: one shared itinerary, bill splitting, ticket scanning and live "who's where" status. I want a single long, scrollable, fully working page (HTML, CSS and JavaScript) with real motion, in both light and dark mode, at desktop (1440px) and phone (390px) widths.

The page has one job: a person who is planning a trip with friends should understand in ten seconds what Rove does, enjoy scrolling to the end, and press **Start a trip**.

## Who it's for

Indian friend groups in their twenties and thirties planning a trip together: a Goa long weekend, Manali, Bali. Today they plan in a WhatsApp group, which means lost ticket PDFs, "who paid for dinner?" and nobody knowing what time the ferry is. Use rupees (₹), UPI and WhatsApp in every example, because the app really does "Pay via UPI" and "Share on WhatsApp".

Use one cast everywhere so the page feels like a real trip. Five friends, each with a fixed colour that follows them through every section: **Aanya** (lime), **Kabir** (sky), **Meera** (pink), **Dev** (lilac), **Zoya** (butter). Their trip: Bali, six nights.

## The idea: Flip

The whole visual system is one rule. Every section owns a **colour pair**: one bright colour and one deep shade of the same hue.

- In **light mode** the section's background is the bright colour and its type is the deep one.
- In **dark mode** they swap: deep background, bright type.

This is why the site is equally colourful in both modes, and it gives every interaction a natural answer: things flip. Hovering a card swaps its two colours. The theme toggle flips the whole page. Status pills flip to their next state. Please treat "flip" as the site's one signature and keep everything else disciplined.

| Section | Bright | Deep |
|---|---|---|
| Hero, final call to action | Lime `#D2F74B` | Forest `#0F3A2B` |
| Itinerary | Sky `#8ED1FF` | Navy `#0B2B5E` |
| Splitting bills | Pink `#FF7AB8` | Wine `#4D0C2E` |
| Ticket scanning | Lilac `#C7B5FF` | Indigo `#25145E` |
| Crew status | Butter `#FFDD55` | Cocoa `#472B06` |
| Neutral sections | Chalk `#F5F7EE` | Ink `#0E1410` |

Rules for using them:

- Cards inside a section use the inverse of the section (deep card with bright type on a bright section), or another pair's colours when the card belongs to a friend or a different feature.
- On the neutral sections, each card takes a different pair, and may carry a 2px border in a neighbouring pair's bright colour. This is where the "colourful cards and borders" live.
- Surfaces are flat fills. Depth comes from layering, scale and colour, never from drop shadows, glows, gradients or glass blur.
- Corners are generous and vary by size: 28px on large cards, 18px on small ones, full pills on buttons and status chips.
- As the reader scrolls from one section to the next, the page background tweens from one pair to the next, and the floating navigation and the cursor take the inverse of whatever section is under them.

## Type

- **Headlines:** Anybody (Google Fonts, variable, width axis 50 to 150, weight 900). It can stretch, and that is the second half of the signature: a headline arrives narrow (width about 60) and widens to its resting width (100) as it scrolls into view, and a hovered headline word stretches a little further (about 125). Size headlines large: about `clamp(56px, 11vw, 168px)` in the hero and `clamp(40px, 6.5vw, 96px)` for section heads, line-height about 0.92. Reserve space for the widest state so nothing reflows while it animates.
- **Reading text and interface:** DM Sans, 400 to 700. Body 18px on desktop and 16px on phone, lines under 65 characters. Use tabular numbers for money and times.
- Sentence case everywhere. No all-caps labels and no small "eyebrow" label above headings.

## What the pictures are

The visuals are **pieces of the app itself**, drawn fresh in this Flip language: itinerary rows, a bill, friend avatars (coloured circles with initials), status pills, a to-do list. Do not imitate any existing app screenshot; design these pieces new, so they look like they belong to this site. No photography, no illustrations of places, no 3D objects.

## Page, section by section

### Navigation
A floating pill at the top: the wordmark "rove" set in Anybody, links (How it works, Features, Privacy, Questions), a theme toggle, and a **Start a trip** button. It hides when scrolling down and returns when scrolling up.

### 1. Hero: the group chat becomes a plan (lime and forest)
This is the one big orchestrated moment of the page.

- **At rest:** headline *From "who's booking?" to booked.* Below it: *Rove turns your group chat into one plan. The days, the bills and the tickets, shared with everyone who's going.* Buttons: **Start a trip** (main) and **See how it works** (quiet).
- Around the headline float eight to ten chat bubbles in three depth layers (far ones small, near ones large), each in a friend's colour, each tilted a few degrees, drifting very slowly. Messages: "who's booking the villa??", "send me the UPI", "what time is the flight", "did anyone pay the cab guy", "wait, which day is the ferry", "I paid for dinner, remember", "where's the ticket PDF", "are we 5 or 6 now".
- **On load:** the bubbles pop in one after another with a soft spring while the headline widens into place.
- **Parallax:** the three layers move at different speeds on scroll and shift with the cursor (near layers move most).
- **On scroll (the section holds in place for about 1.5 screens):** the bubbles straighten, gather toward the centre, and each one turns into a tidy piece of a trip screen: a "Saturday" day header, three itinerary rows (7:30 am Ferry to Nusa Penida, 2:00 pm Villa check-in, 8:30 pm Dinner at Sardine), a bill line (₹8,400 split 5 ways), and a row of five friend avatars. The headline changes to *One plan. Everyone in.* Then the page releases and the background tweens to sky.

### 2. How it works (chalk and ink)
Headline: *Three steps. Then you're packing.* This is a real sequence, so number the steps.
1. **Start a trip.** Name it and set the dates. It takes a minute.
2. **Drop the link in your group chat.** Share it on WhatsApp. Friends join with one tap.
3. **Everyone adds to one plan.** Flights, stays, dinners, bills. It updates live for the whole group.

Three cards, each in a different colour pair. A line draws itself between them as the reader scrolls. The cards rise in once, slightly staggered.

### 3. Itinerary (sky and navy)
Headline: *Every day, sorted.*
Text: *Flights, ferries, check-ins and dinners on one timeline. Times show in the trip's time zone and in yours, so nobody turns up at the wrong hour.*
Visual: a vertical day timeline with event cards, a "Next flight in 2 d 4 h 12 m" countdown that ticks, and friend avatars showing who is going to each event. Motion: the timeline line draws downward with the scroll and each event card clips on as the line reaches it. Hovering an event opens it to show who's going.

### 4. Splitting bills (pink and wine): showpiece
Headline: *Dinner was ₹8,400. Nobody has to do maths.*
Text: *Add a bill, pick who paid and who's in. Split it equally, by exact amounts, by percent or by shares. Rove keeps the running tally and tells each person exactly who to pay.*
Motion (the section holds in place for about one screen): a bill card "Dinner at Sardine, ₹8,400" sits in the middle. As the reader scrolls it slices into five equal chips of ₹1,680 that fly to the five friends. Keep scrolling and the chips resize to show a split by percent, then by shares. At the end everything collapses into one line, "Kabir pays Meera ₹1,680", with a **Pay via UPI** button that pulses once. Numbers count up as they change.
Three small facts beside it: several people can pay one bill; settle up in just a few payments; pay with any UPI app.

### 5. Ticket scanning (lilac and indigo): showpiece
Headline: *Snap the ticket. Skip the typing.*
Text: *Upload a ticket or booking as a PDF or a photo. Rove reads it and drafts the plan entry: flight number, times, terminal, booking code. You check it and save.*
Motion (the section holds in place for about one screen): a plain ticket document slides in. A scan line sweeps across it. The details lift off the page one at a time (use an invented airline: "Skylark Air SK 482, Delhi to Bali, Sat 6:10 am, Terminal 3, booking code K7QM2X") and settle into a draft event card with a **Looks right? Save** button. Small note: *Your files stay private to your trip.*
Draw the ticket as a simple document. It is here because scanning it is the feature, not as decoration.

### 6. Crew status (butter and cocoa)
Headline: *Know who's where.*
Text: *Rove works out everyone's status from their flights and the trip dates.*
Visual: the five friends in a row, each with a status pill. As the section crosses the screen the pills flip, one friend at a time, through the real states: Not left yet, In the air, At the villa, Heading home, Back home. Hovering a friend shows what they chose to share with the group (phone, emergency contact, food preferences).

### 7. The small things (chalk and ink)
Headline: *And the small things.*
Six cards in an uneven grid, each in a different colour pair, each flipping its colours on hover:
- **One shared to-do list.** Ticks show who did it.
- **Currency converter.** Live rates for trips abroad. It keeps working without signal, using the last rates.
- **Invite on WhatsApp.** One link, one tap.
- **Add it to your home screen.** Opens like an app. No app store.
- **Owner and members.** The owner runs the trip, and can hand it over.
- **Trips in India or abroad.** Rupees by default. Switch on extra currencies when you're going overseas.

### 8. Privacy and safety (the neutral pair, inverted)
For one serious beat, use the neutral pair the other way round: ink background in light mode, chalk in dark mode.
Headline: *Your trip stays in your group.*
- **Only your group sees it.** Everything in a trip is visible only to the people in it.
- **Tickets stay private.** Files are stored privately and open only for trip members.
- **The maths is checked.** A split that doesn't add up is refused before it's saved.
- **About the ticket reader.** When you scan a ticket, the file is sent to Claude, Anthropic's AI, to read it. Each person can scan 20 a day.

### 9. Questions (chalk and ink)
An accordion; opening and closing is the only motion here.
- **Is it free?** Yes.
- **Do I need to install anything?** No. Rove runs in your browser. You can add it to your home screen if you like.
- **Does everyone need an account?** Yes. Sign up with an email, then join with the invite link.
- **Does it work without internet?** The app opens and the currency converter uses the last rates. Plans and bills need a connection.
- **Can I use it for a trip within India?** Yes. It uses rupees and hides the currency tools.
- **Who can see my trip?** Only the people you invite.

### 10. Final call to action (lime and forest)
Headline, as large as the hero's: *Your group chat deserves a break.* Button: **Start a trip**. The chat bubbles from the hero return here, already tidy. Then a simple footer: wordmark, Privacy, Terms, Contact.

## Motion rules

- **Scroll:** the hero and the two showpieces (bills, tickets) hold in place and play in step with the scroll. Every other section gets one quick entrance (about 400 to 600ms, a slight overshoot, staggered by 60ms) that plays once and never replays.
- **Section change:** the background colour tween between pairs is the main scroll effect outside the showpieces. Keep it smooth and tied to scroll position.
- **Hover:** cards flip their pair and lift slightly; buttons pull up to 6px toward the pointer; headline words stretch; hero layers shift.
- **Custom cursor (desktop, fine pointers only):** a 14px dot in the inverse colour of the section under it, trailing the pointer slightly. Over links and buttons it grows into a 56px ring. Over the showpieces it shows the word "Scroll". Keep the normal text cursor in form fields, hide the custom cursor on touch screens, and keep clear keyboard focus rings everywhere.
- **Theme toggle:** flips every pair at once in about 400ms. Follow the system setting by default and remember the visitor's choice.
- **Performance:** animate only transform, opacity, background colour and the font's width axis. It should stay smooth on a mid-range Android phone.
- **Reduced motion:** when the visitor asks for less motion, show each animated section in its finished state, change colours instantly, and switch the custom cursor off.
- **Phone:** fewer hero bubbles (five), shorter hold distances, no cursor effects, and hover effects become tap or simply rest in their default state.

## Please avoid

These were tried and rejected, or would make the page look like a template:

- Sunset or coral orange, neon colours on black, and serif headlines.
- Scrapbook or sticker styling: thick black outlines, hard offset shadows, taped or torn paper.
- Travel clip-art used as decoration: planes, passport stamps, luggage tags, globes, palm trees, map pins.
- Gradient blobs, glass blur, glows, grey drop shadows, stock photos, emoji as icons.
- A fade-and-slide-up on every single element, or animations that loop forever (the hero's slow drift and the countdown are the only exceptions).
- Everything centred. Let layouts sit left, right and off-grid where the content suits it.

## Before you finish

Check the page against this list: every section is colourful in both light and dark mode; every headline is readable on its background; the hero works on a phone; nothing overlaps or clips at 390px or 1440px; the page still makes sense with motion reduced; and "flip" is the thing a visitor would remember.
