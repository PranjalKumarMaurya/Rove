# Chat plan

What Rove's in-trip group chat should become, and in what order. Phase 1 is built (in code and tested locally, not deployed; see [Phase 1: what was built](#phase-1-what-was-built)); the rest is still a plan. Written 2026-11-27 from the current code (`src/features/chat/`, migration 095), `docs/STATUS.md`, and the research in [Sources](#sources).

**Where chat was before Phase 1:** text only, realtime (Supabase Realtime plus a 30 s catch-up), optimistic send with a client id so retries never post twice, links made tappable, iMessage-style runs (name above, avatar on the last bubble, tail), "Delivered / Sending… / Not delivered · Tap to retry". No edit, no delete, no replies, no reactions, no notifications.

**The owner's goal:** "People shouldn't have to go back to WhatsApp for anything about the trip. The whole app should feel like one smooth flow, remove the stress of noting and tracking everything while travelling."

---

## 1. Principles

What makes Rove's chat better than a WhatsApp group *for this job*. WhatsApp will always win at general chat; Rove wins only where chat is connected to the trip.

1. **Every decision lands somewhere.** A chat message is gone after 200 more ([travel planner blog](https://thetravelplanner.com.au/blog/how-to-organise-a-group-trip), [CrewsCanvas](https://crewscanvas.com/blog/why-the-group-chat-is-the-worst-place-to-plan-a-trip)). In Rove, anything decided in chat (a booking, a cost, a meeting point, a task) becomes a row in the itinerary, Split or To-dos, and the chat card links to it. The chat is the conversation; the tabs are the memory.
2. **Cards, not copies.** Shared things are live pointers to Rove data, not pasted text. If the flight time changes, the card in chat shows the new time. No "which version is right?"
3. **Ask people one clear question.** Chats are "terrible for making decisions with more than three people" ([MonkeyTravel](https://monkeytravel.app/blog/group-travel-mistakes-to-avoid)); in a group of six only two or three answer planning messages ([CrewsCanvas](https://crewscanvas.com/blog/why-the-group-chat-is-the-worst-place-to-plan-a-trip)). Fix the bystander effect by design: few options, a deadline, a visible "waiting on Priya, Rahul" list, and a one-tap nudge.
4. **Cheap ways to answer.** Reactions and one-tap votes let people respond without typing; research describes reactions as "lightweight", nearly costless feedback that cuts noise ([Telegram reactions study](https://arxiv.org/html/2508.06349), [Messenger reacji study](https://linguistics.upd.edu.ph/wp-content/uploads/2024/07/13-Contrasting-the-Functions-of-the-Reacji-and-of-the-Standard-Emoji-in-Messenger-Conversations.pdf)).
5. **Fewer, better notifications.** Group-chat bursts are a known stressor ([Korean messenger study](https://aodr.org/xml/04150/04150.pdf), [Pielot & Rello](https://arxiv.org/pdf/1612.02314)). Notify loudly only for things that need *you*: a mention, a decision you haven't answered, money you owe, a plan change.
6. **Respect who's on what.** Private bookings (migration 093, `can_see_event`) stay private in chat too. A card never shows more than the viewer could see in the tab.
7. **Feels like iMessage, looks like Rove.** Bubbles, tapbacks, swipe-to-reply, long-press menu; all spacing, radii and type from `DESIGN-SYSTEM.md` / `TYPOGRAPHY.md`. Cards are `.card--nested`-style blocks inside a bubble, never a new visual language.
8. **Built for the 55-year-old uncle too.** Big targets (`--tap`), text labels next to icons on decision cards, no hidden gestures as the *only* way to do something (every swipe has a long-press menu twin).

---

## 2. Feature list

Effort: **S** about a day or two, **M** about a week, **L** two weeks or more (one developer, with tests, in this codebase).

### Tier 1: core people expect

| # | Feature | Effort |
|---|---|---|
| 1.1 | Replies (quote a message) | M |
| 1.2 | Reactions (tapbacks) | M |
| 1.3 | Mentions (@name, @everyone) | M |
| 1.4 | Unread marker, unread badge, jump to latest | S–M |
| 1.5 | Push notifications (see §4) | L |
| 1.6 | Photos (and a shared trip album) | M–L |
| 1.7 | Edit and unsend (time-limited) | M |
| 1.8 | Long-press menu: copy, reply, react, add to…, report | S |
| 1.9 | Mute this Trip's chat | S |
| 1.10 | Search | M |
| 1.11 | Typing indicator | S |

**1.1 Replies**
- *What:* swipe right on a bubble (or long-press → Reply) to quote it; the reply shows a small quoted strip above the text; tapping the strip scrolls to and flashes the original.
- *Why:* every major messenger has it; in a busy group it's how you answer the right question. Discord built threads out of replies precisely so busy chats stay "easily traceable" ([TechCrunch](https://techcrunch.com/2021/07/27/discord-threads)).
- *Rove data:* `trip_messages.reply_to uuid` (same group, FK). Reply to a *card* (e.g. a booking) quotes the card title.
- *UI:* iMessage inline reply style: quoted strip inside the bubble, `t-footnote`, `--text-secondary`, a 2px accent bar on the left, `--radius-sm`. Composer shows "Replying to Asha" with a close cross.
- *Risks:* quoting an unsent (deleted) message shows "Message unsent". Quoting a card the viewer can't see shows "A private booking".

**1.2 Reactions**
- *What:* double-tap or long-press → a row of 6 reactions (👍 ❤️ 😂 😮 😢 ✅) plus "+" for any emoji. Counts sit as a small pill on the bubble's corner; tap the pill to see who reacted.
- *Why:* the cheapest way to answer; reduces "ok"/"done" messages ([reacji study](https://linguistics.upd.edu.ph/wp-content/uploads/2024/07/13-Contrasting-the-Functions-of-the-Reacji-and-of-the-Standard-Emoji-in-Messenger-Conversations.pdf), [User2 on WhatsApp](https://user2.net/how-to-get-the-most-from-whatsapp-groups/)). Note GitHub found reactions *don't always* cut comment noise ([arXiv](https://arxiv.org/pdf/2108.08094)), so don't expect them to replace decision cards.
- *Rove data:* `trip_message_reactions (message_id, member_id, emoji)`, unique per member + emoji. Including ✅ makes "I've done it / I've paid" one tap.
- *UI:* iMessage tapback bubble at the top corner of the bubble (left for mine, right for others'), `t-caption`, `--bg-elevated` pill with hairline border.
- *Risks:* reactions must **not** notify by default (iMessage-style "Asha liked …" floods are a top complaint pattern); at most a quiet badge for reactions to *your* message.

**1.3 Mentions**
- *What:* typing `@` opens a picker of Trip members (avatar + name); `@everyone` for the whole crew. Mentioned names render bold/accent; you get a push even if the chat is muted.
- *Why:* WhatsApp just shipped `@all` that breaks through mute, admin-only in large groups ([WhatsApp blog](https://blog.whatsapp.com/your-group-chats-upgraded-introducing-better-polls-all-and-more), [MacRumors](https://www.macrumors.com/2026/08/04/whatsapp-adds-all-mentions-and-poll-upgrades/)). Naming people directly is also the best-known counter to diffusion of responsibility ([Decision Lab](https://thedecisionlab.com/reference-guide/psychology/diffusion-of-responsibility)).
- *Rove data:* `trip_message_mentions (message_id, member_id)` or a `mentions uuid[]` column, from `group_members`. Body stores a token (`@[member_id]`) so renames show the current name.
- *UI:* picker as a list above the composer (`--avatar-sm`, `t-headline`), like iMessage's mention suggestions.
- *Risks:* `@everyone` abuse: limit to Owner, or rate-limit (e.g. 3 per person per day), and let each person turn off "@everyone breaks mute".

**1.4 Unread marker and badge**
- *What:* a "New messages" divider where you left off; open the chat at that divider, not the bottom; a ↓ button with a count when scrolled up; an unread count on the Chat tab and on the Trip's card on the Trips home.
- *Why:* catching up is the first thing anyone does after a flight. WhatsApp now even offers AI summaries of unread piles ([Android Central](https://www.androidcentral.com/apps-software/meta/whatsapp-unread-texts-message-summaries-meta-ai-rollout)).
- *Rove data:* `trip_chat_reads (group_id, member_id, last_read_at)`. Private to the person (see *what not to build*: no per-message "seen by").
- *UI:* divider `t-caption` accent text with hairlines; tab badge reuses `.round-btn__badge`.
- *Risks:* none notable. Keep `last_read_at` readable only by its owner.

**1.5 Push notifications.** See [§4](#4-notifications-strategy). Without push, people *will* go back to WhatsApp; this is the single biggest gap.

**1.6 Photos and a trip album**
- *What:* send photos from the camera roll (several at once); thumbnails in a bubble grid; tap opens full-screen with swipe between. A "Photos" view (from the chat header) shows every photo in the Trip, by day.
- *Why:* photos are the main non-text content in travel groups; LINE's shared Albums and Notes exist so things don't drown in the chat ([LINE Help](https://help.line.me/line/?contentId=20000246)). WhatsApp users complain old media goes missing from "Media, links and docs" ([TechIssuesToday](https://techissuestoday.com/old-whatsapp-photos-videos-missing-from-media-section)).
- *Rove data:* a private `trip-chat-media` bucket, same pattern as `trip-documents` (signed URLs, member-only). Reuse `prepareImage.ts` from Scan for resizing and HEIC handling. Day grouping reuses Split's timeline day logic (`timeline.ts`) and the Trip timezone.
- *UI:* iMessage photo stack/grid inside the bubble, `--radius-lg`, no bubble padding around images.
- *Risks:* storage cost on the free tier (resize to ~1600px, cap per Trip); never cache in the service worker (it caches no data today; keep that rule).

**1.7 Edit and unsend**
- *What:* edit your own text for 15 minutes ("Edited" label); unsend your own message for 24 hours (leaves "Asha unsent a message"). Owner can remove any message (abuse).
- *Why:* expected everywhere: WhatsApp edit window 15 min at launch, Telegram 48 h ([TechCrunch](https://techcrunch.com/?p=2546830)); Signal edit within 24 h, delete-for-everyone within 24 h ([Signal support](https://support.signal.org/hc/articles/6255134251546-Edit-Message), [Signal delete](https://support.signal.org/hc/en-us/articles/360050426432-Delete-for-everyone)).
- *Rove data:* `edited_at`, `deleted_at` on `trip_messages`; an RPC that checks the window and authorship (keep the table insert-only for clients). Realtime needs UPDATE events (replica identity is already FULL).
- *UI:* long-press menu items; "Edited" as `t-caption` under the bubble like iMessage.
- *Risks:* editing a message after people voted/reacted on it can mislead: show "Edited" clearly; don't allow edit on decision cards after the first vote.

**1.8 Long-press menu**
- *What:* iMessage-style focus: the bubble lifts, background dims, reaction row above, menu below: Reply, Copy, Edit, Unsend, **Add to To-dos**, **Add to Split**, **Add to Trip**, Report.
- *Why:* one entry point for every action, including the Tier 2 "turn this into…" actions; makes gestures discoverable for older users.
- *Rove data:* none new. *UI:* native-feeling `ActionSheet`/popover, `--radius-xl`, `--tap` rows. *Effort:* S once 1.1/1.2 exist.

**1.9 Mute**
- *What:* per-Trip: All messages / Only mentions and decisions / Off, and "mute for 8 hours / until tomorrow".
- *Why:* muting is the main coping strategy for group overload ([aodr](https://aodr.org/xml/04150/04150.pdf), [WNY STEM](https://www.wnystem.org/people-quietly-leave-group-chats-or-mute-friends/)).
- *Rove data:* `trip_chat_prefs (group_id, member_id, level, muted_until)`, read by the push sender.

**1.10 Search**
- *What:* search messages in this Trip; filters for Photos, Links, Documents, Decisions.
- *Why:* "finding the booking link" is the classic WhatsApp travel pain; in-chat search fails for links and files without captions ([MakeUseOf](https://www.makeuseof.com/whatsapp-search-chats-messages-media-links/)).
- *Rove data:* Postgres full-text index on `body` (`to_tsvector('simple', …)`), RLS as for SELECT. Cards are found by their target's title.
- *Note:* Tier 2 cards make search *less* needed, which is the point.

**1.11 Typing indicator**
- *What:* "Asha is typing…" (iOS 26 added this to group chats, [MacRumors](https://www.macrumors.com/2025/06/09/apple-announces-ios-26-messages-app-features/)).
- *Rove data:* Supabase Realtime **presence/broadcast** only, never stored. S.
- *Risks:* minor social pressure; fine to have, easy to skip.

### Tier 2: trip-native (where Rove beats WhatsApp)

All Tier 2 cards share one mechanism: a message has a `kind` (`text`, `card`, `decision`, `poll`, `location`, `system`) and, for cards, a `ref_type` + `ref_id` pointing at a Rove row. The card is rendered from the *live* row, read under that row's RLS, so it updates when the row changes and never leaks private data.

| # | Feature | Effort |
|---|---|---|
| 2.1 | Share an expense, booking, event or day plan as a card | M |
| 2.2 | "I'll book X: in or out?" decision cards | L |
| 2.3 | Polls | M |
| 2.4 | Meet-up point and live location | M / L |
| 2.5 | Turn a message into a To-do (or expense, or event) | S–M |
| 2.6 | Scanned documents in chat | M |
| 2.7 | Pinned "Trip essentials" | M |
| 2.8 | Trip activity in chat (system messages) | M |
| 2.9 | "Settle up" nudge cards with UPI | S–M |

**2.1 Rich cards for Rove data**
- *What:* from any expense, event, flight, booking or day in the itinerary, "Share to chat"; or the composer's ＋ → "Trip item". Card shows the essentials: expense (title, amount, who paid, your share), event/flight (time in Trip time and yours, place, Map), day plan (the day's events as a short list), with an "Open" that jumps to the tab.
- *Why:* booking links get "lost under a TikTok and a few heart reactions" ([CrewsCanvas](https://crewscanvas.com/blog/why-the-group-chat-is-the-worst-place-to-plan-a-trip)); reviewers note Wanderlog has no chat, so coordination still happens in WhatsApp with the plan pasted in ([tripsil](https://tripsil.com/5-best-apps-for-group-travel-in-2026-honest-review-no-sponsored-rankings/)). A live card ends "is this the latest?".
- *Rove data:* `trip_events` (+ `trip_event_audience`), `trip_expenses` / payers / shares, `itinerary.ts` for day plans, `NextFlight` for flights, `tripTime.ts` for the two-timezone line.
- *UI:* a nested card inside a wider bubble (`--radius-md`, `--space-3` padding), title `t-headline`, meta `t-footnote`, amount `t-num` right-aligned; one quiet "Open" action. Sent-by-me cards keep the neutral card colour (not the accent bubble fill) so money/time stay readable.
- *Risks:* **privacy**: sharing a private booking to the whole chat. Rule: the card re-reads under RLS; a viewer who can't see it gets "A booking shared with some of the crew" (no title, no price). When sharing a private item, the share sheet warns "Only 3 of 6 can see this. Share anyway / Share with them only (later)". **Deleted rows:** card says "This expense was deleted".

**2.2 Decision cards: "I'll book X — in or out?"**
- *What:* the owner's headline example. A person proposes something concrete: *what* (free text or a pasted link: "Scuba at Tarkarli, 10am Sat"), *cost per person* (optional), *deadline* ("answer by 8pm"), *who's asked* (everyone or some). Others tap **In / Out / Maybe**. The card shows who's in, and **"Waiting on: Rahul, Neha"** with a "Nudge" button. When the proposer taps **Book it**: it creates the itinerary event with exactly the "in" people as the audience ("who's on this"), and optionally an expense in Split split among the "in" people. The card then turns into a "Booked" card linking to both.
- *Why:* this is the one thing WhatsApp can't do. Chats create "the illusion of a decision being made without anyone actually making one" ([Globe](https://areuglobe.com/blog/why-your-group-chat-is-the-worst-place-to-plan-a-trip)); advice for flaky groups is concrete options plus a real deadline ([Juntos](https://ourjuntos.app/blog/friends-wont-respond-about-trip)); the bystander effect grows with group size ([Darley & Latané via Simply Psychology](https://www.simplypsychology.org/bystander-effect.html), [Atlantis Press review](https://www.atlantis-press.com/article/125974974.pdf)), so naming who hasn't answered matters. WhatsApp Events have RSVP but stop there; nothing flows into a plan or a bill ([WhatsApp blog](https://blog.whatsapp.com/new-feature-roundup-updates-to-group-chats-events-calls-channels-and-more)). Troupe's popular part is voting and RSVP ([App Store](https://apps.apple.com/us/app/troupe/id1610022190)).
- *Rove data:* `trip_decisions (id, group_id, created_by, title, link, cost_minor, currency, deadline, audience)` + `trip_decision_votes (decision_id, member_id, answer)`; "Book it" calls existing event and expense RPCs (audience from the "in" list; split equally among them via Split's existing modes). Deadline in Trip timezone.
- *UI:* a card with three big pill buttons (`.pill--tap`, labelled "I'm in", "Out", "Maybe", not just icons) and avatar stacks for each answer; your choice gets `--accent-soft`; "Waiting on" in `t-footnote`. Changeable until booked.
- *Risks:* **social pressure**: "Out" must be as easy and neutral as "In" (no red); keep answers visible (people need to know who's coming), but never show "seen". **Nudge abuse:** one nudge per person per decision per few hours. **Money surprise:** the "Book it" step shows exactly what will be created before it creates it.

**2.3 Polls**
- *What:* question + 2–6 options, single or multiple choice, optional deadline, optional "add options". Special case: **date poll** (pick days) for planning before the Trip has dates. Results live; closed polls show the winner.
- *Why:* now standard in WhatsApp (with deadlines and anonymous voting since Aug 2026, [WhatsApp blog](https://blog.whatsapp.com/your-group-chats-upgraded-introducing-better-polls-all-and-more)) and iMessage on iOS 26 ([MacRumors](https://www.macrumors.com/2025/06/09/apple-announces-ios-26-messages-app-features/)), Telegram and Discord. Keep options few: choice-overload findings are contested but consistent enough to argue for short lists ([APA Monitor](https://www.apa.org/monitor/jun04/toomany), [BPS on replication limits](https://www.bps.org.uk/research-digest/less-always-more-testing-limits-choice-paradox)).
- *Rove data:* can share the decision tables (`kind = poll`, options table). A finished poll can "Add winner to Trip" (creates an event) or set Trip dates (Owner only, through Trip settings rules).
- *UI:* iMessage poll look: option rows with a fill bar and avatar stack, `--tap` rows, `t-body`.
- *Risks:* anonymous voting is a WhatsApp feature, but for a friend trip named votes reduce ghosting; offer anonymous only as an option. Polls with no deadline rot: default deadline 24 h with a reminder.

**2.4 Meet-up point and live location**
- *What (M):* **Meet-up pin**: "Meet at Baga Beach shack, 7:30pm": a place (search or drop a pin or "my current spot"), time, and an **"On my way / Here"** status per person. Opens in Apple/Google Maps.
- *What (L):* **Live location**, opt-in per person, always time-limited (15 min / 1 h / until the meet-up), visible only to the Trip, with a persistent "You're sharing your location · Stop" banner.
- *Why:* "Where are we meeting" is a core travel pain; WhatsApp, iMessage, Telegram and Google Maps all have live location ([Digital Trends](https://digitaltrends.com/mobile/whatsapp-location-sharing)). Forgotten sessions are a recognised privacy risk ([Lokmat Times](https://www.lokmattimes.com/technology/whatsapp-privacy-tips-how-to-check-who-has-access-to-your-live-location-a510/amp)); child-safety groups criticised always-on location ([Marie Claire](https://marieclaire.co.uk/news/whatsapp-update-545333)).
- *Rove data:* meet-up = a `trip_events` row of a "meet-up" type (so it's in the itinerary too) + statuses; Crew status strip (`crewStatus.ts`) can show "Here ✓". Live location = Realtime broadcast with a short-lived server row, auto-expiring.
- *Limits:* a PWA has **no background location on iOS**; live location only updates while the app is open. Say so in the UI ("Updates while Rove is open"). This is why the meet-up pin with "On my way / Here" is the priority and true live location is later.
- *UI:* a map snapshot card (static map image) with place name `t-headline`, time `t-footnote`, and status pills.
- *Risks:* privacy (default off, hard expiry, never stored history); battery; static-map provider cost and keys.

**2.5 Turn a message into a To-do / expense / event**
- *What:* long-press → "Add to To-dos" (prefills the text, lets you assign a person); "Add to Split" (opens Split's form with any amount found in the text: "paid 2400 for the cab"); "Add to Trip" (opens EventDialog with parsed time). A small "Added to To-dos ✓" chip links back.
- *Why:* principle 1. Planning "falls to one person" who notes everything ([tripsil](https://tripsil.com/why-group-chats-fail-trip-planning/)); this removes the noting.
- *Rove data:* existing `trip_todos`, `ExpenseForm` / `expenseDraft.ts`, `EventDialog`; `trip_todos.source_message_id` for the backlink. Later, AI parse (the Scan reader) can suggest the form fields, within the existing AI limits.
- *UI:* the backlink chip under the bubble, `t-caption`. *Effort:* S for To-dos, M for the parsers.

**2.6 Scanned documents in chat**
- *What:* send a ticket, voucher, ID-free booking PDF or bill from the composer ＋ → "Document". It goes through **Scan** (same reader, same daily limits): bookings land in the itinerary, bills in Split; the chat shows the resulting card. Also "Share to chat" from Trip documents.
- *Why:* "finding the booking link/PDF" is the WhatsApp travel pain; Scan already does the hard part.
- *Rove data:* `trip_documents` (private bucket, signed URLs), `parse-document`, `trip_parse_usage`; the card points at the document and its event/expense.
- *UI:* document card with a file icon, name, kind ("Booking · Flight"), and "Open". Image documents show a thumbnail.
- *Risks:* passports/IDs: warn on "ID" kinds and don't auto-share; documents for a private booking follow the booking's audience.

**2.7 Pinned "Trip essentials"**
- *What:* a strip at the top of the chat: up to 3 pins (any message or card), plus an always-there **Essentials** sheet: stay address(es), next flight, today's plan, meet-up point, emergency contacts (from crew info), Wi-Fi/house rules note, the UPI ID of whoever's collecting.
- *Why:* WhatsApp and Telegram pin messages; LINE has Notes as a board beside the chat ([LINE Help](https://help.line.me/line/?contentId=20000246)). Most essentials already exist as Rove data, so Rove can fill this automatically.
- *Rove data:* computed from `trip_events` (stays, flights), `itinerary.ts` (today), meet-up events, crew info (`crewInfo.ts`, respecting what each member shares), profile UPI. Manual pins: `trip_pins (group_id, message_id, pinned_by)`.
- *UI:* a single-line pinned bar under the header like iMessage's pinned banner; tap opens a `Sheet`.
- *Risks:* emergency contacts are personal: show only what the member chose to share (existing crew info rules).

**2.8 Trip activity in chat**
- *What:* small centred system lines: "Asha added *Dinner at Thalassa* to Sat", "Rahul paid ₹2,400 for the cab", "Flight 6E-123 is delayed 40 min" (when edited), "Neha joined the Trip". Batched (one line per person per few minutes) and collapsible.
- *Why:* people learn about changes in WhatsApp today; making the change itself announce removes "did you see I updated the plan?" messages.
- *Rove data:* triggers or app-side events on `trip_events`, `trip_expenses`, `trip_settlements`, `group_members`; respects audience (private bookings only announced to their audience).
- *UI:* centred `t-caption`, `--text-tertiary`, like iMessage's "X named the conversation".
- *Risks:* noise. Settings: "Show Trip activity in chat: On / Only plan changes / Off". Never push-notify these except plan changes affecting you.

**2.9 Settle-up cards**
- *What:* from Split's balances, "Remind in chat": a card "You owe Asha ₹1,250 · Pay via UPI" visible to the debtor's eyes as a button, to others as plain text; marks itself "Settled ✓" when a settlement is recorded.
- *Why:* "who's paying / who owes" is the other big travel-group friction; WhatsApp Pay is barely used for this (about 0.65% UPI share, [The Federal](https://thefederal.com/latest-news/whatsapp-pay-india-market-share-kunal-shah-upi-247884)), so people still ask in chat and pay elsewhere. Rove already has the balance and the UPI deep link.
- *Rove data:* `ledger.ts`, `upi.ts`, `trip_settlements`.
- *Risks:* public shaming. Default to a gentle wording and allow only the creditor (or Owner) to post one, at most once a day per person.

### Tier 3: later

| Feature | Why later |
|---|---|
| Voice notes | Big in India (survey: 66% feel most connected through voice notes, [ThePrint](https://theprint.in/feature/indian-social-media-users-voice-messaging-frnd-survey/3011813/); 7 bn/day on WhatsApp, [TechCrunch](https://techcrunch.com/2022/03/30/people-are-sending-7-billion-voice-messages-on-whatsapp-every-day)) and good for older relatives; but recording/playback in an iOS PWA (MediaRecorder, audio session quirks) needs device testing. Strong Tier 3 candidate, possibly early. |
| Videos | Storage cost and transcoding on the free tier. |
| "Catch me up" AI summary of unread | WhatsApp has it ([Android Central](https://www.androidcentral.com/apps-software/meta/whatsapp-unread-texts-message-summaries-meta-ai-rollout)); Rove's reader could do it, but it sends chat text to Anthropic: needs the privacy text first and fits the existing AI limits. |
| Sub-chats ("Goa scuba people") | Per-booking chats for the "in" people of a decision. Useful for big groups; adds complexity; do after audiences are proven. |
| Message translation | Useful for international destinations (chat with a local host); not core. |
| Link previews | Needs a server-side fetcher (and safety: no fetching internal URLs). Nice, not essential once cards exist. |
| Stickers/GIFs | Fun, but a whole content pipeline. |
| Day-end recap card | "Today: 4 events, ₹8,300 spent, 23 photos": a nice memory feature on top of 2.8 and 1.6. |
| Calls / voice rooms | WhatsApp does this well; not worth rebuilding. Deep-link to a WhatsApp/FaceTime call instead. |

---

## 3. What NOT to build, and why

| Don't build | Why |
|---|---|
| **Per-message "seen by" read receipts** | Research ties read receipts to anxiety and pressure to reply, more so for recipients ([Hoyle et al., CHI](https://www.cs.oberlin.edu/~rhoyle/papers/hoyle-chi17.pdf), [MedieKultur study](https://tidsskrift.dk/mef-journal/article/download/28781/25181), [Aalto](https://aaltodoc.aalto.fi/items/175570ce-49d9-4d24-bfd9-46927f6f46ce)). Rove gets accountability where it matters (decision cards' "Waiting on") without making every message a test. Keep the current "Delivered" for my own messages. |
| **"Last seen" / online status** | Same pressure, plus privacy for family members. The Crew status strip already says where people are in the journey. |
| **Full Slack-style threads** | Slack's own team said threads made channels harder to read; threads are easy to miss and get ignored ([Slack Engineering](https://slack.engineering/weaving-threads/), [Medium #threadfail](https://medium.com/@brad.robertson/slack-threading-failure-threadfail-977859586d5a)). A trip group is 4–20 people; inline replies plus cards are enough. |
| **Telegram-style topics / WhatsApp Communities** | Built for 200+ member groups ([Telegram](https://telegram.org/blog/topics-in-groups-collectible-usernames/ko?setln=en)). Rove's structure is already the Trip tabs. |
| **Reactions that notify** | Turns every 👍 into a buzz; the opposite of principle 5. |
| **Disappearing messages, end-to-end encryption** | Rove's value is that the trip is remembered and searchable; and server-side cards, search and AI need the server to read rows. Be honest in the privacy text instead (data stays in the Trip, private storage, RLS). |
| **Payments inside chat** | UPI deep links already work; holding or moving money brings regulation. Settle-up cards only point to the user's UPI app. |
| **Channels, broadcast, public groups, stranger DMs** | Abuse surface with no trip value. Chat is only between active Members. |
| **1-to-1 DMs (for now)** | People already have WhatsApp for that; splitting the trip conversation across DMs recreates the problem. Revisit only if users ask. |
| **Rebuilding WhatsApp import/export of chats** | Low value; the Bali import is about trip data, not old messages. |

---

## 4. Notifications strategy

### What iOS allows
- Web Push works on iOS/iPadOS 16.4+ **only for web apps installed to the Home Screen** (Rove's main use), not in Safari tabs ([WebKit](https://webkit.org/?p=13878)).
- Needs a **manifest** (Rove has one) and **permission asked in response to a user tap** ([WebKit](https://webkit.org/?p=13878), [MoEngage](https://moengage.com/docs/developer-guide/web-sdk/web-push/safari-web-push-for-i-os-and-i-pad-os)). Notifications show on the Lock Screen, Notification Center, Apple Watch, and respect Focus.
- **Badging API** works: set the Home Screen icon's unread count ([WebKit](https://webkit.org/?p=13878)).
- iOS 18.4+ also supports **Declarative Web Push**, which can show a notification without running the service worker ([WebKit](https://webkit.org/?p=16535)). Optional; standard push via the existing service worker is enough to start.
- Practical limits ([firt.dev iOS PWA notes](https://firt.dev/notes/pwa-ios/)): no silent/background pushes; every push must show a notification; no background location or sync. Android/desktop Chrome work with the same code.

### What Rove needs to build
1. **VAPID keys** (public in the app build, private as a Supabase secret).
2. **`push_subscriptions` table** `(id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_ok_at)`, owner-only RLS; one user can have several devices; delete on 404/410 from the push service.
3. **Service worker** `push` handler (show notification, set badge) and `notificationclick` handler (focus the app and open `#trip=<id>&tab=chat&msg=<id>`). Add to the existing app-shell worker; it still caches no data.
4. **Sender:** a Supabase Edge Function (`notify`) called by a database trigger/webhook on `trip_messages` insert (and on decisions, mentions, settlements). It looks up recipients' prefs (`trip_chat_prefs`), skips the sender and anyone with the chat open (a recent `last_read_at` / presence), and sends with the `web-push` library. Stays on the free stack.
5. **Permission ask, at the right moment:** not on first launch. Ask after a meaningful tap: the first time someone sends a message, votes on a decision, or opens Chat, with a Rove sheet explaining "Get told when someone mentions you or a plan changes" → "Turn on" (that tap triggers the iOS prompt). If they're in Safari, not installed, show the existing install hint instead.
6. **Settings:** Profile → Notifications (global on/off, test notification) and per-Trip mute (1.9).

### What to notify (and what not)
| Event | Default |
|---|---|
| Mention of you / @everyone | Push, even when muted (can be turned off) |
| Decision or poll you're asked on; reminder 2 h before its deadline if you haven't answered | Push |
| A plan change to an event you're on (time, place, cancelled); flight delay | Push |
| Someone asks you to settle up / a payment to you is recorded | Push |
| Ordinary messages | Push, **collapsed per Trip**: use the notification `tag` = Trip id so a burst replaces one notification ("Asha and 2 others: 7 new messages"), with a short cool-down per recipient |
| Reactions, system activity lines, typing | Never push; badge only |

- **Quiet hours** in the Trip's timezone (default 11pm–7am, mentions and plan changes still allowed). Travellers cross timezones; `tripTime.ts` already knows the Trip zone.
- **Preview privacy:** notification text shows sender and message preview by default; for a private booking card show only "Asha shared a booking with you". Option "Hide message previews".
- **Badge:** unread count across Trips, cleared as you read (`navigator.setAppBadge`).
- **Email fallback:** none for chat (too noisy). Maybe later a daily digest for people without push.
- **Test it on real phones:** iOS push behaviour differs by version; this is the riskiest piece. Plan device testing on iOS 17, 18 and 26 and one Android.

---

## 5. Suggested build order

### Phase 1: "Good enough to leave WhatsApp" (≈ 3–4 weeks) — built 2026-11-27 (migration 097), not deployed
- ✅ Push notifications with per-Trip mute and grouping (1.5, 1.9) — the single biggest reason people won't leave WhatsApp.
- ✅ Unread marker, badges (1.4). The existing "New messages ↓" pill is the jump to latest; it shows no count yet.
- ✅ Replies and reactions, with the long-press menu (1.1, 1.2, 1.8: Reply, React, Copy only; Edit and Unsend are Phase 2).
- ✅ Mentions incl. @everyone (1.3).
- ✅ Schema groundwork: `kind`, `ref_type`, `ref_id`, `reply_to`, `edited_at`, `deleted_at` on `trip_messages`, so Phase 2 doesn't need another reshape (all but `reply_to` are server-only and unused for now).

### Phase 2: "Chat that knows the trip" (≈ 3–4 weeks)
- Rich cards for expenses, events, flights, day plans, with the RLS privacy rule (2.1).
- Turn a message into a To-do / expense / event (2.5).
- Pinned bar and the Essentials sheet (2.7).
- Edit and unsend (1.7).
- Photos (1.6, without the album view yet).

### Phase 3: "Decide together" (≈ 3–4 weeks)
- Decision cards that create the event and expense (2.2) — the flagship.
- Polls, including date polls (2.3).
- Meet-up pin with "On my way / Here" (2.4, first half).
- Settle-up cards (2.9).
- Push for decisions, deadlines, plan changes.

### Phase 4: "Remember the trip" (later)
- Scanned documents in chat (2.6), trip activity lines (2.8), search with filters (1.10), shared album view.
- Then Tier 3 by user demand: voice notes first, then live location, catch-up summaries, sub-chats.

**Test each phase with a real group on a real trip** (as with the Rishikesh test) before the next; measure: messages sent in Rove vs. "let's discuss on WhatsApp", decision cards answered before deadline, push opt-in rate.

---

### Phase 1: what was built

**Schema (097).** `trip_messages` gains `reply_to` (same-Trip FK, set null if the original is deleted), `mentions uuid[]` and `mentions_everyone` (a trigger keeps only active Members of the Trip, sorted, and refuses `@everyone` from someone who used it in the last hour: `everyone_rate_limited`), plus the Phase 2 columns. New tables, all RLS-forced: `trip_message_reactions` (one row per message, member and emoji; seven allowed; insert and delete your own; Realtime), `trip_chat_reads` (your own row only; never moves backwards; everyone starts "read" at the moment they join), `push_subscriptions` (your own devices; `save_push_subscription` moves an endpoint to whoever signs in on that browser), `trip_notification_prefs` (`all` / `mentions` / `none`, `muted_until`). RPCs: `mark_chat_read`, `get_my_unread_counts` (invoker, capped at 100). Server only: `trip_private.chat_push_state` / `chat_push_log` and the service-role RPCs `chat_push_message_context`, `chat_push_claim_due`, `chat_push_record`.

**Push path.** A trigger on `trip_messages` insert calls the `send-chat-push` Edge Function through **pg_net** (queued in the sender's transaction, sent after commit, so closing the app never skips it), unless nobody else in the Trip has a device subscribed. A **pg_cron** job every 20 s calls it only when a collapsed summary is due. Both send the shared secret from **Vault** (`chat_push_url`, `chat_push_secret`); with either missing nothing is called. The function decides with `supabase/functions/send-chat-push/rules.ts` and sends standard Web Push with `npm:web-push` (checked working in Supabase's Deno runtime). Both pg_net and pg_cron exist on hosted Supabase and on the local CLI stack; the migration enables them. Rules: every other active Member with a device, as their Trip setting allows; mentions and @everyone always (unless Off), each as its own notification; ordinary messages share one tag per Trip and at most one push per 60 s per recipient, after which "N new messages · Asha: …" replaces it; quiet hours 23:00–07:00 Trip time drop ordinary messages; someone who read the chat in the last 20 s gets nothing now and a summary later only if still unread; reactions never push; 404/410 devices are deleted. Payload: Trip name, "Sender: text" (140 characters), `/#chat=<trip>`, and the unread total for the Home Screen badge.

**App.** Service worker: `public/sw-push.js`, pulled into the generated worker with `importScripts` (content-hashed, so changes go through the normal update prompt); it shows the notification, sets the badge, and on tap focuses the open app (which switches to that Chat) or opens `/#chat=<trip>`. The prompt card shows only in the installed app and only asks from the Turn on tap; iPhone Safari gets "add Rove to your Home Screen first". Settings → Notifications per Trip; Profile → "Notifications on this device"; signing out removes the device. The VAPID public key comes from `VITE_VAPID_PUBLIC_KEY` (or `VAPID_PUBLIC_KEY_FALLBACK` in `src/features/notifications/pushApi.ts`); without one, push stays off and Settings say so.

**Deviations from this plan.**
- Mentions are stored as readable `@Name` text plus resolved ids, not `@[member_id]` tokens: copy, push text and old clients stay readable; after someone renames, their old mentions show as plain text (no chip).
- `@everyone`: anyone, once an hour per person per Trip (not Owner-only or 3 a day). There is no separate "@everyone breaks mute" switch: Mute lets it through, Off silences it.
- No "+" for any emoji; the fixed seven are 👍 ❤️ 😂 😮 😢 🙏 ✅. No double-tap shortcut.
- The settings table is `trip_notification_prefs` (plan: `trip_chat_prefs`); `push_subscriptions` uses `profile_id` and `last_used_at`.
- Mute is "for 8 hours" only (no "until tomorrow"); no "Hide message previews" and no test notification; the Profile switch is per device, not per account.
- Notification links open the Trip's Chat (`#chat=<trip>`), not a specific message.
- Quiet hours drop ordinary messages rather than delivering them at 07:00; mentions sent while you are reading the chat wait like ordinary ones.
- Realtime cannot filter DELETE events, so un-reactions reach every subscriber as keys only (Trip, message, member, emoji ids); the app keeps only its Trip's.

**Production setup (owner).**
1. `npx supabase db push` (applies 097: enables pg_net and pg_cron, schedules `rove-chat-push-summaries` every 20 s and a daily cron-history cleanup).
2. `node scripts/generate-vapid.mjs <private folder>/rove-vapid.env` prints the public key and writes `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` to that file. Add two lines to the same file: `VAPID_SUBJECT=mailto:rove.noreply@gmail.com` and `CHAT_PUSH_SECRET=<openssl rand -hex 32>`.
3. `npx supabase secrets set --env-file <private folder>/rove-vapid.env`, then `npx supabase functions deploy send-chat-push --no-verify-jwt` (the database has no user JWT; the secret is the check).
4. SQL editor: `select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/send-chat-push', 'chat_push_url');` and `select vault.create_secret('<the same CHAT_PUSH_SECRET>', 'chat_push_secret');`
5. Cloudflare Pages: environment variable `VITE_VAPID_PUBLIC_KEY=<public key>`, then redeploy (or paste the key into `VAPID_PUBLIC_KEY_FALLBACK`).
6. Check on two phones with Rove installed: turn on notifications, send from the other phone; `select status_code, error_msg from net._http_response order by id desc limit 5;` shows 200s, and the function logs show `send-chat-push message sent=…`. Never set `CHAT_PUSH_STUB` on a hosted project.

## 6. Open questions for the owner
- ~~Who may use `@everyone`: everyone (rate-limited) or Owner only?~~ Decided 2026-11-27: everyone, once an hour per person per Trip.
- Should decision answers be visible to all (recommended) or only counts?
- Is a static map provider (and its key/cost) acceptable for meet-up cards, or link out to Maps only?
- ~~Do we want sub-chats for private bookings eventually, or is one Trip chat the rule?~~ Decided 2026-11-27: one chat per Trip. Also decided: no per-message "seen by" and no last seen.

---

## Sources

**Messenger features**
- [WhatsApp blog: better polls, @all and more (Aug 2026)](https://blog.whatsapp.com/your-group-chats-upgraded-introducing-better-polls-all-and-more)
- [MacRumors: WhatsApp adds @all mentions and poll upgrades](https://www.macrumors.com/2026/08/04/whatsapp-adds-all-mentions-and-poll-upgrades/)
- [Android Authority: WhatsApp group chat features](https://www.androidauthority.com/whatsapp-group-chat-features-3694631/)
- [WhatsApp blog: group chats, events, calls roundup](https://blog.whatsapp.com/new-feature-roundup-updates-to-group-chats-events-calls-channels-and-more)
- [Android Central: WhatsApp message summaries](https://www.androidcentral.com/apps-software/meta/whatsapp-unread-texts-message-summaries-meta-ai-rollout)
- [TechCrunch: WhatsApp message editing](https://techcrunch.com/?p=2546830)
- [Signal: edit message](https://support.signal.org/hc/articles/6255134251546-Edit-Message), [Signal: delete for everyone](https://support.signal.org/hc/en-us/articles/360050426432-Delete-for-everyone)
- [MacRumors: iOS 26 Messages polls and typing indicators](https://www.macrumors.com/2025/06/09/apple-announces-ios-26-messages-app-features/)
- [Telegram: topics in groups](https://telegram.org/blog/topics-in-groups-collectible-usernames/ko?setln=en), [Telegram API: forum topics](https://core.telegram.org/api/forum)
- [LINE Help: Notes](https://help.line.me/line/?contentId=20000246)
- [TechCrunch: Discord threads](https://techcrunch.com/2021/07/27/discord-threads)
- [Slack Engineering: Weaving threads](https://slack.engineering/weaving-threads/), [Medium: Slack's threading failure](https://medium.com/@brad.robertson/slack-threading-failure-threadfail-977859586d5a)
- [Digital Trends: WhatsApp location sharing](https://digitaltrends.com/mobile/whatsapp-location-sharing), [Lokmat Times: who has your live location](https://www.lokmattimes.com/technology/whatsapp-privacy-tips-how-to-check-who-has-access-to-your-live-location-a510/amp), [Marie Claire: useful or creepy](https://marieclaire.co.uk/news/whatsapp-update-545333)
- [MakeUseOf: searching WhatsApp media and links](https://www.makeuseof.com/whatsapp-search-chats-messages-media-links/), [TechIssuesToday: old media missing](https://techissuestoday.com/old-whatsapp-photos-videos-missing-from-media-section)
- [TechCrunch: 7 billion voice messages a day](https://techcrunch.com/2022/03/30/people-are-sending-7-billion-voice-messages-on-whatsapp-every-day), [ThePrint: Indian voice-note survey](https://theprint.in/feature/indian-social-media-users-voice-messaging-frnd-survey/3011813/)
- [The Federal: why WhatsApp Pay failed in India](https://thefederal.com/latest-news/whatsapp-pay-india-market-share-kunal-shah-upi-247884)

**Travel groups and trip apps** (several are trip-app blogs with a product to sell; read as pain-point evidence, not neutral data)
- [The Travel Planner: group trips without chat chaos](https://thetravelplanner.com.au/blog/how-to-organise-a-group-trip)
- [CrewsCanvas: why the group chat is the worst place to plan a trip](https://crewscanvas.com/blog/why-the-group-chat-is-the-worst-place-to-plan-a-trip)
- [Globe: why your group chat is failing your trip](https://areuglobe.com/blog/why-your-group-chat-is-the-worst-place-to-plan-a-trip)
- [MonkeyTravel: group travel mistakes](https://monkeytravel.app/blog/group-travel-mistakes-to-avoid)
- [tripsil: why group chats fail trip planning](https://tripsil.com/why-group-chats-fail-trip-planning/), [tripsil: best apps for group travel 2026](https://tripsil.com/5-best-apps-for-group-travel-in-2026-honest-review-no-sponsored-rankings/)
- [Juntos: friends won't respond about the trip](https://ourjuntos.app/blog/friends-wont-respond-about-trip)
- [Hunter Weitzman: The group chat finally won](https://hunterweitzman.substack.com/p/the-group-chat-finally-won)
- [Troupe on the App Store](https://apps.apple.com/us/app/troupe/id1610022190), [PopSci: group outing apps](https://www.popsci.com/diy/group-trip-planning-apps/)
- [Wanderlog review (Whistleout)](https://www.whistleout.com/CellPhones/Apps/wanderlog-group-trip-planning-app), [Wanderlog: what Reddit says](https://tripstone.app/blog/wanderlog-review)
- [TripIt: best apps for organising group trips](https://www.tripit.com/web/blog/travel-tips/best-group-travel-planning-app), [MetaFilter: staying organised as a travelling group](https://ask.metafilter.com/378879/Staying-organized-as-a-traveling-group-2024-edition)

**Psychology**
- [Simply Psychology: bystander effect](https://www.simplypsychology.org/bystander-effect.html), [The Decision Lab: diffusion of responsibility](https://thedecisionlab.com/reference-guide/psychology/diffusion-of-responsibility), [Atlantis Press: diffusion of responsibility review](https://www.atlantis-press.com/article/125974974.pdf), [BPS: bystander effect is more than diffusion](https://www.bps.org.uk/research-digest/bystander-effect-about-more-diffusion-responsibility)
- [Hoyle et al., CHI 2017 (read receipts)](https://www.cs.oberlin.edu/~rhoyle/papers/hoyle-chi17.pdf), [MedieKultur: read receipts and pressure](https://tidsskrift.dk/mef-journal/article/download/28781/25181), [Aalto: read receipts in long-distance relationships](https://aaltodoc.aalto.fi/items/175570ce-49d9-4d24-bfd9-46927f6f46ce)
- [Archives of Design Research: messenger notifications and stress](https://aodr.org/xml/04150/04150.pdf), [Pielot & Rello: 24 hours without notifications](https://arxiv.org/pdf/1612.02314), [WNY STEM: why people mute group chats](https://www.wnystem.org/people-quietly-leave-group-chats-or-mute-friends/)
- [Emoji reactions on Telegram (arXiv)](https://arxiv.org/html/2508.06349), [Reacji vs emoji in Messenger](https://linguistics.upd.edu.ph/wp-content/uploads/2024/07/13-Contrasting-the-Functions-of-the-Reacji-and-of-the-Standard-Emoji-in-Messenger-Conversations.pdf), [Emoji reactions in GitHub PRs (arXiv)](https://arxiv.org/pdf/2108.08094)
- [APA Monitor: too many choices](https://www.apa.org/monitor/jun04/toomany), [BPS: limits of the choice paradox](https://www.bps.org.uk/research-digest/less-always-more-testing-limits-choice-paradox)

**Web push on iOS**
- [WebKit: Web Push for web apps on iOS and iPadOS](https://webkit.org/?p=13878)
- [WebKit: Meet Declarative Web Push](https://webkit.org/?p=16535)
- [firt.dev: iOS PWA compatibility notes](https://firt.dev/notes/pwa-ios/)
- [MoEngage: Safari web push for iOS](https://moengage.com/docs/developer-guide/web-sdk/web-push/safari-web-push-for-i-os-and-i-pad-os)
