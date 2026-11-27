import { expect, test, type Page } from '@playwright/test'
import { openTrip, openTripTab, tripsHome, workspace } from '../support/trip-frame'

// Chat Phase 1 against synthetic responses (no backend): the unread divider and
// counts, replies (menu and swipe), reactions (tapback bar, cluster, who reacted),
// @mentions (picker, resolved ids, chips) and the notification prompt card.
// Phone-width screenshots: set CHAT_SHOTS to a folder.
const localBrowserHost = `127.0.0.1:${process.env.TRIP_WEB_PORT ?? '4173'}`
const accountId = 'a3100000-0000-4000-8000-000000000001'
const groupId = 'b3100000-0000-4000-8000-000000000001'
const me = 'c3100000-0000-4000-8000-000000000001'
const farah = 'c3100000-0000-4000-8000-000000000002'
const raj = 'c3100000-0000-4000-8000-000000000003'
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const uuid = (n: number) => `d3100000-0000-4000-8000-${String(n).padStart(12, '0')}`

const message = (n: number, sender: string, body: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n), group_id: groupId, sender_id: sender, client_id: `c${n}`, body, created_at: ago(minutesAgo),
  reply_to: null, mentions: [], mentions_everyone: false, ...extra,
})

// Read up to message 3; 4–6 are new.
const history = [
  message(1, farah, 'Landing at 6:15, see you at arrivals!', 50),
  message(2, me, 'Perfect, I’ll wait by the money exchange.', 48),
  message(3, raj, 'Villa check-in is at 2. I booked the early slot', 46),
  message(4, farah, 'Bags are out. Where are you two?', 12, { reply_to: uuid(2) }),
  message(5, raj, '@Olive Owner can you grab SIM cards on the way?', 10, { mentions: [me] }),
  message(6, farah, 'Found a cab, ₹1,800 to Seminyak. Splitting it in Split', 8),
]
const reactions = [
  { message_id: uuid(3), member_id: farah, emoji: '❤️' },
  { message_id: uuid(3), member_id: me, emoji: '❤️' },
  { message_id: uuid(3), member_id: farah, emoji: '🙏' },
  { message_id: uuid(6), member_id: raj, emoji: '✅' },
]

interface Calls { inserts: Record<string, unknown>[]; reactionInserts: Record<string, unknown>[]; reactionDeletes: string[]; reads: unknown[] }

async function signedIn(page: Page, { unread = 3 } = {}): Promise<Calls> {
  const calls: Calls = { inserts: [], reactionInserts: [], reactionDeletes: [], reads: [] }
  const payload = Buffer.from(JSON.stringify({ sub: accountId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  await page.addInitScript((session) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
    localStorage.setItem('sb-127.0.0.1-auth-token', JSON.stringify(session))
  }, {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`, refresh_token: 'synthetic-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: accountId, aud: 'authenticated', role: 'authenticated', email: 'olive@example.test', app_metadata: {}, user_metadata: {} },
  })
  await page.route('**/*', (route) => new URL(route.request().url()).host === localBrowserHost ? route.continue() : route.abort('blockedbyclient'))
  await page.route('**/rest/v1/profiles*', (route) => route.fulfill(json([{ id: 'p', display_name: 'Olive' }])))
  await page.route('**/rest/v1/rpc/get_my_group_access', (route) => route.fulfill(json([{
    group_id: groupId, group_member_id: me, role: 'owner', trip_name: 'Bali bachelor', destination: 'Bali, Indonesia',
    start_date: '2026-12-04', end_date: '2026-12-10', timezone: 'Asia/Makassar', accounting_currency: 'INR', is_international: false,
  }])))
  await page.route('**/rest/v1/rpc/get_my_archived_groups', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/rpc/get_my_trip_member_counts', (route) => route.fulfill(json([{ group_id: groupId, member_count: 3 }])))
  await page.route('**/rest/v1/rpc/get_my_unread_counts', (route) => route.fulfill(json(unread ? [{ group_id: groupId, unread }] : [])))
  await page.route('**/rest/v1/rpc/get_group_roster', (route) => route.fulfill(json([
    { participant_id: me, group_id: groupId, display_name: 'Olive Owner', role: 'owner', status: 'active' },
    { participant_id: farah, group_id: groupId, display_name: 'Farah Friend', role: 'member', status: 'active' },
    { participant_id: raj, group_id: groupId, display_name: 'Raj', role: 'member', status: 'active' },
  ])))
  await page.route('**/rest/v1/rpc/get_trip_member_profiles', (route) => route.fulfill(json([
    { group_member_id: farah, display_name: 'Farah Friend', avatar_emoji: '🌺', avatar_path: null },
    { group_member_id: raj, display_name: 'Raj', avatar_emoji: '🏄', avatar_path: null },
  ])))
  await page.route('**/rest/v1/trip_todos*', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/trip_events*', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/trip_messages*', (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      calls.inserts.push(body)
      return route.fulfill(json({ id: uuid(100 + calls.inserts.length), created_at: new Date().toISOString(), ...body }, 201))
    }
    // The newest page, newest first (the app asks for 51 to know whether there is more).
    return route.fulfill(json([...history].reverse()))
  })
  await page.route('**/rest/v1/trip_message_reactions*', (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      calls.reactionInserts.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ status: 201, body: '' })
    }
    if (request.method() === 'DELETE') {
      calls.reactionDeletes.push(decodeURIComponent(new URL(request.url()).search))
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill(json(reactions))
  })
  await page.route('**/rest/v1/trip_chat_reads*', (route) => route.fulfill(json([{ last_read_at: history[2].created_at }])))
  await page.route('**/rest/v1/rpc/mark_chat_read', (route) => {
    calls.reads.push(route.request().postDataJSON())
    return route.fulfill(json(new Date().toISOString()))
  })
  return calls
}

async function shot(page: Page, name: string) {
  if (!process.env.CHAT_SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${process.env.CHAT_SHOTS}/${name}.png` })
}

const chat = (page: Page) => page.getByTestId('chat-tab')
const bubble = (page: Page, text: string) => chat(page).getByTestId('chat-bubble').filter({ hasText: text })

test('unread: a count on the Trips home card and the Chat tab; the chat opens at the divider and marks read at the bottom', async ({ page }) => {
  const calls = await signedIn(page)
  await page.goto('/')
  await expect(tripsHome(page).getByTestId('trip-card-unread')).toHaveText('3')
  await expect(tripsHome(page).getByRole('button', { name: 'Bali bachelor', exact: true })).toHaveAccessibleDescription(/3 unread messages/u)
  await openTrip(page, 'Bali bachelor')
  // The count is CSS content: the tab is still named "Chat", and describes the count.
  await expect(workspace(page).getByTestId('chat-tab-icon')).toHaveAttribute('data-count', '3')
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAccessibleDescription('3 unread messages')
  await openTripTab(page, 'Chat')
  await expect(workspace(page).getByTestId('chat-tab-icon')).not.toHaveAttribute('data-count', /./u)

  const divider = chat(page).getByTestId('chat-unread-divider')
  await expect(divider).toHaveText('Unread messages')
  // Above the first message from others after the read point (Farah's 4th), nothing else.
  const order = await chat(page).locator('[data-unread-divider], [data-testid="chat-bubble"]').evaluateAll((nodes) =>
    nodes.map((node) => node.hasAttribute('data-unread-divider') ? 'divider' : (node.textContent ?? '').slice(0, 12)))
  expect(order.indexOf('divider')).toBe(3)
  // At the bottom (all six fit on the screen) the chat is marked read up to the newest message.
  await expect.poll(() => calls.reads.length).toBeGreaterThan(0)
  expect(calls.reads[calls.reads.length - 1]).toEqual({ p_group_id: groupId, p_read_at: history[5].created_at })
})

test('reactions: a cluster with counts; tap for who reacted; long press for the tapback bar; toggle my own', async ({ page }) => {
  const calls = await signedIn(page)
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openTripTab(page, 'Chat')
  const villa = bubble(page, 'Villa check-in')
  const cluster = villa.getByTestId('chat-reactions')
  await expect(cluster).toHaveAccessibleName('Reactions: 2 Heart, 1 Thanks. Show who reacted')
  await shot(page, 'chat-reply-reactions-mention')
  await cluster.click()
  const sheet = page.getByTestId('chat-reactions-sheet')
  await expect(sheet).toContainText('You, Farah Friend')
  await sheet.getByRole('button', { name: 'Remove mine' }).click()
  await expect.poll(() => calls.reactionDeletes.length).toBe(1)
  expect(calls.reactionDeletes[0]).toContain(`message_id=eq.${uuid(3)}`)
  expect(calls.reactionDeletes[0]).toContain('emoji=eq.❤️')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(cluster).toHaveAccessibleName('Reactions: 1 Heart, 1 Thanks. Show who reacted')

  // Long press opens the menu: the tapback bar above a copy of the bubble, Reply and Copy below.
  const box = await bubble(page, 'Bags are out').boundingBox()
  if (!box) throw new Error('no bubble')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(600)
  await page.mouse.up()
  const menu = page.getByTestId('chat-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('group', { name: 'React' }).getByRole('button')).toHaveCount(7)
  await expect(menu.getByRole('menuitem')).toHaveText(['Reply', 'Copy'])
  await shot(page, 'chat-menu-tapbacks')
  await menu.getByRole('button', { name: 'React with Done' }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(() => calls.reactionInserts).toEqual([{ group_id: groupId, message_id: uuid(4), member_id: me, emoji: '✅' }])
  await expect(bubble(page, 'Bags are out').getByTestId('chat-reactions')).toHaveAccessibleName('Reactions: 1 Done. Show who reacted')

  // The menu's twin for keyboards and screen readers.
  await bubble(page, 'Found a cab').locator('..').getByRole('button', { name: 'Message actions' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('chat-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('chat-menu')).toHaveCount(0)
})

test('replies: from the menu or a swipe; the composer quotes it; the sent bubble quotes and jumps to the original', async ({ page }) => {
  const calls = await signedIn(page)
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openTripTab(page, 'Chat')
  // An existing reply shows the quoted sender and text.
  const quote = bubble(page, 'Bags are out').getByTestId('chat-quote')
  await expect(quote).toHaveAccessibleName(/^Reply to You: Perfect, I’ll wait by the money exchange\./u)

  // Right click (the desktop long press) → Reply.
  await bubble(page, 'Villa check-in').click({ button: 'right' })
  await page.getByTestId('chat-menu').getByRole('menuitem', { name: 'Reply' }).click()
  const replying = chat(page).getByTestId('chat-replying')
  await expect(replying).toContainText('Replying to Raj')
  await expect(replying).toContainText('Villa check-in is at 2')
  await replying.getByRole('button', { name: 'Cancel reply' }).click()
  await expect(replying).toHaveCount(0)

  // A swipe to the right on a touch screen.
  const target = bubble(page, 'Found a cab')
  const box = await target.boundingBox()
  if (!box) throw new Error('no bubble')
  const at = (dx: number) => ({ pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: box.x + 40 + dx, clientY: box.y + box.height / 2, button: 0, bubbles: true })
  await target.dispatchEvent('pointerdown', at(0))
  for (const dx of [10, 30, 60, 100, 130]) await target.dispatchEvent('pointermove', at(dx))
  await target.dispatchEvent('pointerup', at(130))
  await expect(replying).toContainText('Replying to Farah Friend')
  await shot(page, 'chat-composer-replying')

  await chat(page).getByRole('textbox', { name: 'Message' }).fill('On it, see you at the cab')
  await chat(page).getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => calls.inserts.length).toBe(1)
  expect(calls.inserts[0]).toMatchObject({ body: 'On it, see you at the cab', reply_to: uuid(6), mentions: [], mentions_everyone: false })
  await expect(replying).toHaveCount(0)
  const sent = bubble(page, 'On it, see you at the cab')
  await expect(sent.getByTestId('chat-quote')).toContainText('Farah Friend')
  await sent.getByTestId('chat-quote').click()
  await expect(bubble(page, 'Found a cab').first()).toHaveClass(/chat-bubble--flash/u)
})

test('mentions: @ opens a member picker (plus everyone); the message carries resolved ids; chips and an accent edge render', async ({ page }) => {
  const calls = await signedIn(page)
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openTripTab(page, 'Chat')
  // Raj's message mentions me: a chip and the accent edge.
  const mention = bubble(page, 'grab SIM cards')
  await expect(mention).toHaveClass(/chat-bubble--to-me/u)
  await expect(mention.locator('.chat-mention--me')).toHaveText('@Olive Owner')

  const field = chat(page).getByRole('textbox', { name: 'Message' })
  await field.click()
  await field.pressSequentially('Thanks @')
  const picker = chat(page).getByTestId('mention-picker')
  await expect(picker.getByRole('option')).toHaveText([/Farah Friend$/u, /Raj$/u, /everyone/u])
  await field.pressSequentially('fa')
  await expect(picker.getByRole('option')).toHaveText([/Farah Friend$/u])
  await shot(page, 'chat-mention-picker')
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue('Thanks @Farah Friend ')
  await field.pressSequentially('and @ev')
  await expect(picker.getByRole('option')).toHaveText([/everyone/u])
  await picker.getByRole('option').click()
  await expect(field).toHaveValue('Thanks @Farah Friend and @everyone ')
  await field.pressSequentially('lunch at 1?')
  await chat(page).getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => calls.inserts.length).toBe(1)
  expect(calls.inserts[0]).toMatchObject({ body: 'Thanks @Farah Friend and @everyone lunch at 1?', mentions: [farah], mentions_everyone: true, reply_to: null })
  const sent = bubble(page, 'lunch at 1?')
  await expect(sent.locator('.chat-mention')).toHaveText(['@Farah Friend', '@everyone'])
})

test('notifications: a friendly prompt in the installed app; iPhone Safari is told to add Rove to the Home Screen', async ({ page }) => {
  await page.addInitScript(() => {
    // The installed app, before anyone has answered the permission prompt.
    const real = window.matchMedia.bind(window)
    window.matchMedia = (query: string) => query.includes('display-mode: standalone')
      ? { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as MediaQueryList
      : real(query)
    Object.defineProperty(Notification, 'permission', { get: () => 'default' })
  })
  await signedIn(page, { unread: 0 })
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openTripTab(page, 'Chat')
  const prompt = chat(page).getByTestId('notify-prompt')
  await expect(prompt).toContainText('Get notified when the crew messages')
  await expect(prompt.getByRole('button', { name: 'Turn on' })).toBeVisible()
  await shot(page, 'chat-notification-prompt')
  // The composer still docks just above the tab bar.
  const gap = await page.evaluate(() => document.querySelector('.tab-bar')!.getBoundingClientRect().top - document.querySelector('.chat__composer')!.getBoundingClientRect().bottom)
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThanOrEqual(16)
  await prompt.getByRole('button', { name: 'Not now' }).click()
  await expect(prompt).toHaveCount(0)
  await page.reload()
  await openTripTab(page, 'Chat')
  await expect(chat(page)).toContainText('Found a cab')
  await expect(chat(page).getByTestId('notify-prompt')).toHaveCount(0)
})

test.describe('in iPhone Safari (not installed)', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1' })
  test('the prompt explains Add to Home Screen, and Settings say the same', async ({ page }) => {
    await signedIn(page, { unread: 0 })
    await page.goto('/')
    await openTrip(page, 'Bali bachelor')
    await openTripTab(page, 'Chat')
    const prompt = chat(page).getByTestId('notify-prompt')
    await expect(prompt).toHaveAttribute('data-kind', 'install')
    await expect(prompt).toContainText('Add Rove to your Home Screen first')
    await expect(prompt.getByRole('button', { name: 'Turn on' })).toHaveCount(0)
    await shot(page, 'chat-notification-install-hint')
    await workspace(page).getByRole('button', { name: 'Trip settings' }).click()
    const section = page.getByTestId('trip-notifications')
    await expect(section.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(section.getByTestId('notify-device-note')).toContainText('Add to Home Screen')
  })
})

test('Trip settings: All / Mentions only / Off, and Mute for 8 hours, saved as my own row', async ({ page }) => {
  await signedIn(page, { unread: 0 })
  const saved: unknown[] = []
  await page.route('**/rest/v1/trip_notification_prefs*', (route) => {
    if (route.request().method() === 'POST') {
      saved.push(route.request().postDataJSON())
      return route.fulfill({ status: 201, body: '' })
    }
    return route.fulfill(json([]))
  })
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await workspace(page).getByRole('button', { name: 'Trip settings' }).click()
  const section = page.getByTestId('trip-notifications')
  await section.getByRole('button', { name: 'Mentions only' }).click()
  await expect(section.getByRole('button', { name: 'Mentions only' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => saved.length).toBe(1)
  expect(saved[0]).toMatchObject({ group_id: groupId, member_id: me, level: 'mentions', muted_until: null })
  await section.getByRole('button', { name: 'Mute for 8 hours' }).click()
  await expect(section.getByTestId('notify-mute-state')).toContainText('Muted until')
  await expect.poll(() => saved.length).toBe(2)
  const muted = saved[1] as { muted_until: string }
  expect(Date.parse(muted.muted_until) - Date.now()).toBeGreaterThan(7.9 * 3600_000)
  await section.getByRole('button', { name: 'Unmute' }).click()
  await expect.poll(() => (saved[2] as { muted_until: unknown } | undefined)?.muted_until).toBeNull()
})
