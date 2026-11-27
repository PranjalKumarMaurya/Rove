import { expect, test, type Page, type Route } from '@playwright/test'
import { openTrip, openTripTab, tripsHome, workspace } from '../support/trip-frame'

// Layout checker for docs/DESIGN-SYSTEM.md, against synthetic responses (the
// ir-003 mock setup), so it runs in CI without a backend. On every screen the
// mocks reach, at 390×844 and 320×640:
//  1. no horizontal overflow;
//  2. every visible button and link is at least --tap (44px) high, unless it is
//     an inline text link (`data-layout-exempt="inline"`, or a text-only button
//     inside running text) or a native control drawn by the browser;
//  3. sibling `data-layout="section"` elements are --space-6 (24px) apart, and
//     every `data-layout="card"` has --space-4 (16px) padding on all sides (±1);
//  4. scrolled to the end, the last content clears the bottom bar by --space-6
//     and nothing visible sits under the bar's rectangle.
// Optional before/after screenshots at 390×844: set LAYOUT_SHOTS to a folder and
// LAYOUT_SHOTS_PREFIX (default "shot") to a file-name prefix.
const localBrowserHost = `127.0.0.1:${process.env.TRIP_WEB_PORT ?? '4173'}`
const accountId = 'a3100000-0000-4000-8000-000000000001'
const groupId = 'b3100000-0000-4000-8000-000000000001'
const ownMemberId = 'c3100000-0000-4000-8000-000000000001'
const friendMemberId = 'c3100000-0000-4000-8000-000000000002'
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

const access = {
  group_id: groupId, group_member_id: ownMemberId, role: 'owner', trip_name: 'Bali bachelor', destination: 'Bali, Indonesia',
  start_date: '2026-12-04', end_date: '2026-12-10', timezone: 'Asia/Makassar', accounting_currency: 'INR', is_international: true,
}

const event = (id: string, type: string, title: string, startsAt: string, extra: Record<string, unknown> = {}) => ({
  id, group_id: groupId, event_type: type, title, starts_at: startsAt, ends_at: null, location: null, location_to: null, map_url: null,
  notes: null, dep_code: null, arr_code: null, flight_no: null, airline: null, terminal: null, booking_ref: null,
  created_by: ownMemberId, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', ...extra,
})

const expense = (id: string, description: string, amount: string, spentAt: string, payer: string) => {
  const half = (Number(amount) / 2).toFixed(2)
  return {
    id, description, category: 'food', original_amount: amount, original_currency: 'INR', accounting_amount: amount, accounting_currency: 'INR',
    fx_rate: null, fx_source: null, fx_captured_at: null, split_method: 'equal', created_by: payer, version: 1,
    created_at: spentAt, updated_at: spentAt, spent_at: spentAt,
    payers: [{ member_id: payer, amount }],
    shares: [{ member_id: ownMemberId, amount: half }, { member_id: friendMemberId, amount: half }],
  }
}

/** A signed-in synthetic owner of one Trip with an itinerary, expenses, a document and a message. */
async function signedIn(page: Page) {
  const payload = Buffer.from(JSON.stringify({ sub: accountId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  await page.addInitScript((session) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
    localStorage.setItem('sb-127.0.0.1-auth-token', JSON.stringify(session))
  }, {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`, refresh_token: 'synthetic-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: accountId, aud: 'authenticated', role: 'authenticated', email: 'olive@example.test', app_metadata: {}, user_metadata: {} },
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.host === localBrowserHost) return route.continue()
    return route.abort('blockedbyclient')
  })
  await page.route('https://open.er-api.com/**', (route) => route.fulfill(json({
    result: 'success', base_code: 'INR', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { INR: 1, IDR: 190.5, USD: 0.012, EUR: 0.011 },
  })))
  await page.route('**/rest/v1/profiles*', (route) => route.fulfill(json([{ id: 'p', display_name: 'Olive' }])))
  await page.route('**/rest/v1/rpc/get_my_group_access', (route) => route.fulfill(json([access])))
  await page.route('**/rest/v1/rpc/get_my_archived_groups', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/rpc/get_my_trip_member_counts', (route) => route.fulfill(json([{ group_id: groupId, member_count: 2 }])))
  await page.route('**/rest/v1/rpc/get_group_roster', (route) => route.fulfill(json([
    { participant_id: ownMemberId, group_id: groupId, display_name: 'Olive Owner', role: 'owner', status: 'active' },
    { participant_id: friendMemberId, group_id: groupId, display_name: 'Farah Friend', role: 'member', status: 'active' },
  ])))
  await page.route('**/rest/v1/rpc/get_trip_member_profiles', (route) => route.fulfill(json([
    { group_member_id: ownMemberId, display_name: 'Olive Owner', avatar_emoji: null, avatar_path: null, upi_id: null, phone: null, emergency_contact: null, dietary_notes: null },
    { group_member_id: friendMemberId, display_name: 'Farah Friend', avatar_emoji: null, avatar_path: null, upi_id: 'farah@upi', phone: null, emergency_contact: null, dietary_notes: null },
  ])))
  await page.route('**/rest/v1/rpc/list_group_invitations', (route) => route.fulfill(json({ live_count: 0, items: [] })))
  await page.route('**/rest/v1/rpc/get_trip_join_link', (route) => route.fulfill(json({ active: false })))
  await page.route('**/rest/v1/rpc/get_my_ai_usage', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/group_configuration_display_currencies*', (route) => route.fulfill(json([{ currency_code: 'INR' }, { currency_code: 'IDR' }])))
  await page.route('**/rest/v1/trip_todos*', (route: Route) => route.request().method() === 'HEAD'
    ? route.fulfill({ status: 200, body: '', headers: {
      'content-range': '0-1/2', 'content-type': 'application/json',
      'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range',
    } })
    : route.fulfill(json([
      { id: 't1', group_id: groupId, title: 'Book airport transfer', done: false, created_by: ownMemberId, completed_by: null, completed_at: null, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' },
      { id: 't2', group_id: groupId, title: 'Exchange cash', done: false, created_by: friendMemberId, completed_by: null, completed_at: null, created_at: '2026-11-21T10:00:00Z', updated_at: '2026-11-21T10:00:00Z' },
      { id: 't3', group_id: groupId, title: 'Pack sunscreen', done: true, created_by: friendMemberId, completed_by: friendMemberId, completed_at: '2026-11-22T10:00:00Z', created_at: '2026-11-21T10:00:00Z', updated_at: '2026-11-22T10:00:00Z' },
    ])))
  await page.route('**/rest/v1/trip_events*', (route) => route.fulfill(json([
    event('e1', 'flight', 'Delhi to Bali', '2026-12-04T02:30:00Z', { dep_code: 'DEL', arr_code: 'DPS', flight_no: 'SQ 403', airline: 'Singapore Airlines', terminal: 'T3', booking_ref: 'X7K2QP' }),
    event('e2', 'stay', 'Villa check-in', '2026-12-04T08:00:00Z', { location: 'Seminyak, Bali' }),
    event('e3', 'activity', 'Sunset at Uluwatu temple and the Kecak fire dance', '2026-12-05T09:30:00Z', { location: 'Uluwatu', notes: 'Bring sarongs.' }),
    event('e4', 'food', 'Dinner at La Lucciola', '2026-12-05T12:00:00Z'),
  ])))
  await page.route('**/rest/v1/trip_event_audience*', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/rpc/get_split_ledger', (route) => route.fulfill(json({
    accounting_currency: 'INR',
    expenses: [
      expense('x1', 'Villa deposit', '24000.00', '2026-11-20T10:00:00Z', ownMemberId),
      expense('x2', 'Airport taxi', '1800.00', '2026-12-04T09:00:00Z', friendMemberId),
      expense('x3', 'Beach club lunch with a very long description that should truncate', '5400.00', '2026-12-04T13:00:00Z', ownMemberId),
    ],
    settlements: [{ id: 's1', from_member: friendMemberId, to_member: ownMemberId, amount: '2000.00', currency: 'INR', note: null, recorded_by: friendMemberId, created_at: '2026-11-25T10:00:00Z' }],
  })))
  await page.route('**/rest/v1/trip_documents*', (route) => route.fulfill(json([{
    id: 'd1', storage_path: `${groupId}/d1.pdf`, file_name: 'SQ403-e-ticket.pdf', mime_type: 'application/pdf', size_bytes: 182_000,
    uploaded_by: ownMemberId, event_id: 'e1', expense_id: null, parse_status: 'parsed', extracted: null, created_at: '2026-11-21T10:00:00Z',
    event: { title: 'Delhi to Bali' }, expense: null,
  }])))
  await page.route('**/rest/v1/trip_parse_usage*', (route) => route.fulfill({ status: 200, body: '', headers: {
    'content-range': '*/0', 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range',
  } }))
  // Chat: a reply, a mention of me, reactions, and an unread divider above the last two.
  const m = (n: number) => `d3100000-0000-4000-8000-00000000000${n}`
  await page.route('**/rest/v1/trip_messages*', (route) => route.fulfill(json([
    { id: m(4), group_id: groupId, sender_id: friendMemberId, client_id: 'c4', body: '@Olive Owner bring the passports please', created_at: '2026-11-27T08:09:00Z', reply_to: null, mentions: [ownMemberId], mentions_everyone: false },
    { id: m(3), group_id: groupId, sender_id: friendMemberId, client_id: 'c3', body: 'Great, see you there', created_at: '2026-11-27T08:07:00Z', reply_to: m(2), mentions: [], mentions_everyone: false },
    { id: m(2), group_id: groupId, sender_id: ownMemberId, client_id: 'c2', body: 'Perfect, I will wait by the money exchange.', created_at: '2026-11-27T08:05:00Z', reply_to: null, mentions: [], mentions_everyone: false },
    { id: m(1), group_id: groupId, sender_id: friendMemberId, client_id: 'c1', body: 'Landing at 6:15, see you at arrivals!', created_at: '2026-11-27T08:00:00Z', reply_to: null, mentions: [], mentions_everyone: false },
  ])))
  await page.route('**/rest/v1/trip_message_reactions*', (route) => route.fulfill(json([
    { message_id: m(1), member_id: ownMemberId, emoji: '❤️' }, { message_id: m(2), member_id: friendMemberId, emoji: '👍' },
    { message_id: m(2), member_id: friendMemberId, emoji: '✅' },
  ])))
  await page.route('**/rest/v1/trip_chat_reads*', (route) => route.fulfill(json([{ last_read_at: '2026-11-27T08:06:00Z' }])))
  await page.route('**/rest/v1/rpc/get_my_unread_counts', (route) => route.fulfill(json([{ group_id: groupId, unread: 2 }])))
}

/** Wait for entrance animations to settle so boxes are measured at rest. */
async function settle(page: Page) {
  await page.waitForTimeout(150)
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))))
  await page.waitForTimeout(100)
}

type Screen = {
  name: string
  open: (page: Page) => Promise<void>
  /** The dialog's root: only it is audited (the screen under its backdrop is not). */
  dialog?: string
  /** Chat docks its composer --space-2 above the tab bar (DESIGN-SYSTEM.md §5); only "nothing under the bar" applies. */
  dockedToBar?: boolean
}

const inTrip = (tab: string) => async (page: Page) => {
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openTripTab(page, tab)
}

const SCREENS: Screen[] = [
  { name: 'home', open: async (page) => { await page.goto('/'); await expect(tripsHome(page)).toBeVisible() } },
  { name: 'invite-dialog', dialog: '.invite-dialog__card', open: async (page) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Join with an invite link' }).click()
    await expect(page.getByLabel('Have an invite link?')).toBeVisible()
  } },
  { name: 'profile', open: async (page) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await expect(page.getByTestId('profile-screen')).toBeVisible()
  } },
  { name: 'profile-sheet', dialog: 'dialog.sheet[open]', open: async (page) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await page.getByRole('button', { name: 'Change email' }).click()
    await expect(page.locator('dialog.sheet[open]')).toBeVisible()
  } },
  { name: 'create-trip', open: async (page) => {
    await page.goto('/')
    await tripsHome(page).getByRole('button', { name: 'Create Trip', exact: true }).click()
    await expect(page.getByTestId('bootstrap-onboarding')).toBeVisible()
  } },
  { name: 'join', open: async (page) => {
    await page.route('**/rest/v1/rpc/inspect_trip_join_link', (route) => route.fulfill(json({
      outcome: 'ready', trip_name: 'Goa weekend', destination: 'Goa, India', start_date: '2027-01-08', end_date: '2027-01-10',
    })))
    await page.goto(`/#join=${'ab'.repeat(32)}`)
    await expect(page.getByTestId('join-entry')).toBeVisible()
  } },
  { name: 'trip', open: async (page) => { await inTrip('Trip')(page); await expect(page.getByTestId('itinerary')).toBeVisible() } },
  { name: 'event-dialog', dialog: '[role="dialog"]', open: async (page) => {
    await inTrip('Trip')(page)
    await page.getByRole('button', { name: 'Add event' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
  } },
  { name: 'todos', open: async (page) => {
    await inTrip('Trip')(page)
    await workspace(page).getByRole('button', { name: /^To-dos/ }).click()
    await expect(page.getByTestId('trip-todos')).toBeVisible()
  } },
  { name: 'settings', open: async (page) => {
    await inTrip('Trip')(page)
    await workspace(page).getByRole('button', { name: 'Trip settings' }).click()
    await expect(page.getByTestId('trip-settings')).toBeVisible()
  } },
  { name: 'manage-member', dialog: 'dialog[open]', open: async (page) => {
    await inTrip('Trip')(page)
    await workspace(page).getByRole('button', { name: 'Trip settings' }).click()
    await page.getByRole('button', { name: 'Manage Farah Friend' }).click()
    await expect(page.locator('dialog[open]')).toBeVisible()
  } },
  { name: 'split', open: async (page) => { await inTrip('Split')(page); await expect(page.getByTestId('split-balance')).toBeVisible() } },
  { name: 'expense-form', dialog: '[role="dialog"]', open: async (page) => {
    await inTrip('Split')(page)
    await page.getByRole('button', { name: 'Add expense' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
  } },
  { name: 'settle-up', dialog: '[role="dialog"]', open: async (page) => {
    await inTrip('Split')(page)
    await page.getByRole('button', { name: 'Settle up' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
  } },
  { name: 'scan', open: async (page) => { await inTrip('Scan')(page); await expect(page.getByTestId('scan-document')).toBeVisible() } },
  { name: 'chat', dockedToBar: true, open: async (page) => { await inTrip('Chat')(page); await expect(page.getByTestId('chat-tab')).toContainText('Landing at 6:15') } },
  { name: 'fx', open: async (page) => { await inTrip('FX')(page); await expect(page.getByTestId('fx-rate')).toBeVisible() } },
]

/** What the page reports against the rules; empty when it follows them. */
type Checked = { targets: number; sectionGaps: number; cards: number; rows: number; barChecked: boolean }

async function audit(page: Page, screen: Screen): Promise<{ problems: string[]; checked: Checked }> {
  return page.evaluate(async ({ dialog, dockedToBar }) => {
    const problems: string[] = []
    const checked = { targets: 0, sectionGaps: 0, cards: 0, rows: 0, barChecked: false }
    const px = (value: string) => Number.parseFloat(value) || 0
    const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 1
    const label = (el: Element) => {
      const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/gu, ' ').slice(0, 40)
      const id = el.getAttribute('data-testid')
      return `<${el.tagName.toLowerCase()}${id ? ` ${id}` : ''}> "${text}"`
    }
    const shown = (el: Element) => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 1 || rect.height <= 1) return false
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
        if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
      }
      return true
    }
    const root: Element = dialog ? document.querySelector(dialog)! : document.body
    const all = <T extends Element>(selector: string) => [...root.querySelectorAll<T>(selector)].filter(shown)
    const viewport = window.innerWidth

    // 1. No horizontal overflow: the page, and nothing cut at the right edge outside a scroller.
    if (document.documentElement.scrollWidth > viewport) problems.push(`page is ${document.documentElement.scrollWidth}px wide at ${viewport}px`)
    const clipped = (el: Element) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(node).overflowX)) return true
      }
      return false
    }
    for (const el of all('*')) {
      const rect = el.getBoundingClientRect()
      if ((rect.right > viewport + 1 || rect.left < -1) && !clipped(el)) problems.push(`overflows the screen: ${label(el)} (${Math.round(rect.left)}–${Math.round(rect.right)})`)
    }

    // 2. Tap targets: at least --tap (44px) tall. Exceptions: inline text links (display: inline,
    // or data-layout-exempt="inline"), and controls marked data-layout-exempt="in-field" whose
    // hit area is extended to --tap by a pseudo-element.
    for (const el of all<HTMLElement>('button, a[href], summary, [role="button"], [role="tab"], [role="switch"]')) {
      if (el.closest('[data-layout-exempt]')) continue
      if (getComputedStyle(el).display === 'inline') continue
      const height = el.getBoundingClientRect().height
      checked.targets += 1
      if (height < 44 - 0.5) problems.push(`tap target ${Math.round(height * 10) / 10}px high: ${label(el)}`)
    }

    // 3a. Sibling sections are --space-6 (24px) apart. A closed Collapse between two sections
    // has no height and folds the gap it sits in, so it is skipped.
    const isSection = (el: Element): boolean => el.matches('[data-layout~="section"]')
      || (el.children.length === 1 && isSection(el.children[0]))
    for (const marked of all('[data-layout~="section"]')) {
      // A section wrapped alone (in a Collapse or a Swap) is compared at its outermost wrapper.
      let el: Element = marked
      while (el.parentElement && el.parentElement.childElementCount === 1 && !el.parentElement.matches('[data-layout]')) el = el.parentElement
      let previous = el.previousElementSibling
      while (previous && !shown(previous)) previous = previous.previousElementSibling
      if (!previous || !isSection(previous)) continue
      const gap = el.getBoundingClientRect().top - previous.getBoundingClientRect().bottom
      checked.sectionGaps += 1
      if (!near(gap, 24)) problems.push(`sections ${Math.round(gap)}px apart (want 24): ${label(previous)} → ${label(el)}`)
    }
    // 3b. Top-level sections sit on the 20px gutter (or the dialog's).
    const frame = dialog ? root.getBoundingClientRect() : { left: 0, right: viewport }
    for (const el of all('[data-layout~="section"]')) {
      if (el.parentElement?.closest('[data-layout~="section"], [data-layout~="card"]')) continue
      const rect = el.getBoundingClientRect()
      if (!near(rect.left - frame.left, 20) || !near(frame.right - rect.right, 20)) problems.push(`section off the gutter (${Math.round(rect.left - frame.left)}/${Math.round(frame.right - rect.right)}px): ${label(el)}`)
    }
    // 3c. Cards: --space-4 (16px) padding on every side; dense rows --space-3 / --space-4.
    const padding = (el: Element) => {
      const style = getComputedStyle(el)
      return [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)]
    }
    for (const el of all('[data-layout~="card"]')) {
      const [top, right, bottom, left] = padding(el)
      checked.cards += 1
      if (![top, right, bottom, left].every((value) => near(value, 16))) problems.push(`card padding ${top}/${right}/${bottom}/${left} (want 16): ${label(el)}`)
    }
    for (const el of all('[data-layout~="row"]')) {
      const [top, right, bottom, left] = padding(el)
      checked.rows += 1
      if (!near(top, 12) || !near(bottom, 12) || !near(left, 16) || !near(right, 16)) problems.push(`row padding ${top}/${right}/${bottom}/${left} (want 12/16): ${label(el)}`)
    }

    // 4. At the end of the scroll nothing sits under the bottom bar (or the raised ＋), and the
    // last content ends --space-6 (24px) above it.
    const bar = dialog ? null : document.querySelector('.tab-bar, .home-nav')
    if (bar && shown(bar)) {
      checked.barChecked = true
      window.scrollTo(0, document.documentElement.scrollHeight)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const barRects = [bar.getBoundingClientRect(), ...[...bar.querySelectorAll('.home-nav__fab')].map((fab) => fab.getBoundingClientRect())]
      const fixed = (el: Element) => {
        for (let node: Element | null = el; node; node = node.parentElement) if (getComputedStyle(node).position === 'fixed') return true
        return false
      }
      // What paints: text and controls, and any box with a border or a background (a card's edge).
      const paints = (el: Element) => {
        if (el.childElementCount === 0 || el.matches('button, a, input, select, textarea, img, svg')) return true
        if ([...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return true
        const style = getComputedStyle(el)
        return px(style.borderBottomWidth) > 0 && !/rgba\([^)]*,\s*0\)|transparent/u.test(style.borderBottomColor)
          || !/rgba\([^)]*,\s*0\)|transparent/u.test(style.backgroundColor)
      }
      const leaves = [...document.body.querySelectorAll('#root *')].filter((el) => !bar.contains(el) && shown(el) && !fixed(el) && paints(el))
      let lowest: Element | null = null
      for (const el of leaves) {
        const rect = el.getBoundingClientRect()
        if (barRects.some((zone) => rect.bottom > zone.top + 0.5 && rect.top < zone.bottom && rect.right > zone.left && rect.left < zone.right)) {
          problems.push(`under the bottom bar: ${label(el)}`)
        }
        if (!lowest || rect.bottom > lowest.getBoundingClientRect().bottom) lowest = el
      }
      const top = Math.min(...barRects.map((zone) => zone.top))
      if (lowest && !dockedToBar) {
        // Exactly --space-6 when the page scrolls; a page shorter than the screen just keeps clear.
        const gap = top - lowest.getBoundingClientRect().bottom
        const scrolls = document.documentElement.scrollHeight > window.innerHeight + 1
        if (scrolls ? !near(gap, 24) : gap < 23) problems.push(`last content ${Math.round(gap)}px above the bottom bar (want 24): ${label(lowest)}`)
      }
      window.scrollTo(0, 0)
    }
    return { problems, checked }
  }, { dialog: screen.dialog ?? null, dockedToBar: Boolean(screen.dockedToBar) })
}

/** What each screen must have had measured (a guard against a rule silently checking nothing). */
const EXPECTED: Record<string, Partial<Record<keyof Checked, number | boolean>>> = {
  home: { sectionGaps: 1, barChecked: true },
  profile: { sectionGaps: 5, cards: 4, barChecked: true },
  trip: { sectionGaps: 2, cards: 3, barChecked: true },
  todos: { sectionGaps: 2, cards: 1, rows: 2 },
  settings: { sectionGaps: 3, cards: 4 },
  split: { sectionGaps: 4, cards: 1, rows: 3, barChecked: true },
  'expense-form': { cards: 2 },
  'settle-up': { cards: 1 },
  scan: { sectionGaps: 1, cards: 2, rows: 1, barChecked: true },
  chat: { barChecked: true },
  fx: { sectionGaps: 3, cards: 2, barChecked: true },
}

for (const [width, height] of [[390, 844], [320, 640]] as const) {
  test.describe(`layout at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } })
    for (const screen of SCREENS) {
      test(screen.name, async ({ page }) => {
        await signedIn(page)
        await screen.open(page)
        await settle(page)
        const { problems, checked } = await audit(page, screen)
        expect(problems).toEqual([])
        // The rules really ran: every screen has tap targets, and each one with marked
        // sections, cards or rows had them measured.
        expect(checked.targets).toBeGreaterThan(0)
        for (const [rule, want] of Object.entries(EXPECTED[screen.name] ?? {})) {
          if (typeof want === 'boolean') expect(checked[rule as keyof Checked], rule).toBe(want)
          else expect(Number(checked[rule as keyof Checked]), rule).toBeGreaterThanOrEqual(want)
        }
      })
    }
  })
}

test.describe('screenshots', () => {
  test.skip(!process.env.LAYOUT_SHOTS, 'set LAYOUT_SHOTS to a folder to save screenshots')
  for (const screen of SCREENS) {
    test(screen.name, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await signedIn(page)
      await screen.open(page)
      await settle(page)
      await page.screenshot({ path: `${process.env.LAYOUT_SHOTS}/${process.env.LAYOUT_SHOTS_PREFIX ?? 'shot'}-${screen.name}.png` })
    })
  }
})
