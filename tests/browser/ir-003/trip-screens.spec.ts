import { expect, test, type Page, type Route } from '@playwright/test'
import { backToTrip, crewSection, openSettings, openTodos, openTrip, openTripTab, tripSettings, tripTodos, workspace } from '../support/trip-frame'

// UI wiring only, with synthetic responses: the Trip header's To-dos and Settings
// screens (pushed above the Trip), the Chat tab's place above the tab bar, the
// Settings → Invite link card, and opening a `#join=` link. Optional phone-screen
// shots: set TRIP_NAV_SHOTS to a folder.
const localBrowserHost = `127.0.0.1:${process.env.TRIP_WEB_PORT ?? '4173'}`
const accountId = 'a3100000-0000-4000-8000-000000000001'
const groupId = 'b3100000-0000-4000-8000-000000000001'
const ownMemberId = 'c3100000-0000-4000-8000-000000000001'
const friendMemberId = 'c3100000-0000-4000-8000-000000000002'
const proof = 'ab'.repeat(32)
const rotated = 'cd'.repeat(32)
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function shot(page: Page, name: string) {
  if (!process.env.TRIP_NAV_SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${process.env.TRIP_NAV_SHOTS}/${name}.png` })
}

const access = (role: 'owner' | 'member') => ({
  group_id: groupId, group_member_id: ownMemberId, role, trip_name: 'Bali bachelor', destination: 'Bali, Indonesia',
  start_date: '2026-12-04', end_date: '2026-12-10', timezone: 'Asia/Makassar', accounting_currency: 'INR', is_international: true,
})

/** A signed-in synthetic account; `trips` is what get_my_group_access returns (read on each call). */
async function signedIn(page: Page, trips: () => unknown[], calls: string[] = []) {
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
    if (url.pathname.startsWith('/rest/v1/rpc/')) calls.push(url.pathname.slice('/rest/v1/rpc/'.length))
    return route.abort('blockedbyclient')
  })
  await page.route('**/rest/v1/profiles*', (route) => route.fulfill(json([{ id: 'p', display_name: 'Olive' }])))
  await page.route('**/rest/v1/rpc/get_my_group_access', (route) => route.fulfill(json(trips())))
  await page.route('**/rest/v1/rpc/get_my_archived_groups', (route) => route.fulfill(json([])))
  await page.route('**/rest/v1/rpc/get_group_roster', (route) => route.fulfill(json([
    { participant_id: ownMemberId, group_id: groupId, display_name: 'Olive Owner', role: 'owner', status: 'active' },
    { participant_id: friendMemberId, group_id: groupId, display_name: 'Farah Friend', role: 'member', status: 'active' },
  ])))
  await page.route('**/rest/v1/rpc/list_group_invitations', (route) => route.fulfill(json({ live_count: 0, items: [] })))
  await page.route('**/rest/v1/group_configuration_display_currencies*', (route) => route.fulfill(json([{ currency_code: 'INR' }, { currency_code: 'IDR' }])))
  // Two open to-dos for the header badge (a HEAD count), and the list itself.
  await page.route('**/rest/v1/trip_todos*', (route: Route) => route.request().method() === 'HEAD'
    ? route.fulfill({ status: 200, body: '', headers: {
      'content-range': '0-1/2', 'content-type': 'application/json',
      'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range',
    } })
    : route.fulfill(json([
      { id: 't1', group_id: groupId, title: 'Book airport transfer', done: false, created_by: ownMemberId, completed_by: null, completed_at: null, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' },
      { id: 't2', group_id: groupId, title: 'Exchange cash', done: false, created_by: friendMemberId, completed_by: null, completed_at: null, created_at: '2026-11-21T10:00:00Z', updated_at: '2026-11-21T10:00:00Z' },
    ])))
}

test('To-dos and Settings are full screens above the Trip; back returns to the same tab', async ({ page }) => {
  await signedIn(page, () => [access('owner')])
  await page.route('**/rest/v1/rpc/get_trip_join_link', (route) => route.fulfill(json({ active: false })))
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openTripTab(page, 'Split')
  const header = workspace(page).locator('header')
  await expect(header.getByRole('button', { name: 'To-dos, 2 open' })).toBeVisible()
  await expect(header.locator('.round-btn__badge')).toHaveText('2')
  await shot(page, 'trip-header')

  // To-dos: a pushed screen with its own header; no tab bar.
  await header.getByRole('button', { name: 'To-dos, 2 open' }).click()
  await expect(tripTodos(page).getByRole('heading', { level: 1 })).toHaveText('To-dos')
  await expect(tripTodos(page).getByRole('list', { name: 'Open todos' })).toContainText('Book airport transfer')
  await expect(page.getByRole('tablist', { name: 'Trip sections' })).toHaveCount(0)
  await expect(workspace(page)).toHaveCount(0)
  await shot(page, 'todos')
  await tripTodos(page).getByRole('button', { name: 'Back to Bali bachelor' }).click()
  await expect(page.getByRole('tab', { name: 'Split', exact: true })).toHaveAttribute('aria-selected', 'true')

  // The system back gesture (history) steps back from a pushed screen.
  await openTodos(page)
  await page.goBack()
  await expect(workspace(page)).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Split', exact: true })).toHaveAttribute('aria-selected', 'true')

  // Settings: the four sections in order, People with the crew list.
  await openSettings(page)
  const settings = tripSettings(page)
  await expect(settings.getByRole('heading', { level: 1 })).toHaveText('Settings')
  await expect(settings.getByRole('heading', { level: 2 })).toHaveText(['Trip details', 'Notifications', 'People', 'Invite', 'Danger zone'])
  await expect(crewSection(page).getByRole('list', { name: 'Trip members' })).toContainText('Farah Friend')
  await expect(crewSection(page).getByRole('button', { name: 'Manage Farah Friend' })).toBeVisible()
  await expect(settings.getByTestId('danger-zone').getByRole('button', { name: 'Leave Trip' })).toBeVisible()
  await expect(settings.getByTestId('danger-zone').getByRole('button', { name: 'Archive Trip' })).toBeVisible()
  // On the 20px gutter, nothing wider than the screen.
  const layout = await page.evaluate(() => {
    const content = document.querySelector('.pushed-content')!.getBoundingClientRect()
    const firstCard = document.querySelector('.pushed-content .settings-card')!
    return {
      page: document.documentElement.scrollWidth, screen: window.innerWidth,
      gutter: getComputedStyle(document.querySelector('.pushed-content')!).paddingLeft,
      gap: getComputedStyle(document.querySelector('.pushed-content')!).rowGap,
      cardPadding: getComputedStyle(firstCard).paddingLeft,
      contentLeft: content.left,
    }
  })
  expect(layout.page).toBeLessThanOrEqual(layout.screen)
  expect(layout).toMatchObject({ gutter: '20px', gap: '24px', cardPadding: '16px' })
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'Split', exact: true })).toHaveAttribute('aria-selected', 'true')
  await backToTrip(page)
})

test('the Chat composer sits just above the tab bar', async ({ page }) => {
  await signedIn(page, () => [access('owner')])
  await page.route('**/rest/v1/trip_messages*', (route) => route.fulfill(json([
    { id: 'm1', group_id: groupId, sender_id: friendMemberId, client_id: 'c1', body: 'Landing at 6:15, see you at arrivals!', created_at: '2026-11-27T08:00:00Z' },
  ])))
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await expect(page.getByRole('tablist', { name: 'Trip sections' }).getByRole('tab')).toHaveText(['Trip', 'Split', 'Scan', 'Chat', 'FX'])
  await openTripTab(page, 'Chat')
  await expect(page.getByTestId('chat-tab')).toBeVisible()
  await page.getByTestId('chat-tab').evaluate((node) => Promise.all(node.parentElement!.getAnimations().map((animation) => animation.finished)))
  await expect.poll(() => page.evaluate(() => {
    const composer = document.querySelector('.chat__composer')!.getBoundingClientRect()
    const bar = document.querySelector('.tab-bar')!.getBoundingClientRect()
    return Math.round(bar.top - composer.bottom)
  })).toBe(8)
  // The page itself does not scroll; the field stays at least 16px.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true)
  expect(parseFloat(await page.getByRole('textbox', { name: 'Message' }).evaluate((node) => getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16)
  await shot(page, 'chat')
})

test('Settings → Invite: the Owner turns the link on, resets it and turns it off', async ({ page }) => {
  const changes: { enabled: boolean; rotate: boolean }[] = []
  await signedIn(page, () => [access('owner')])
  await page.route('**/rest/v1/rpc/get_trip_join_link', (route) => route.fulfill(json({ active: false })))
  await page.route('**/rest/v1/rpc/set_trip_join_link', (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean; rotate: boolean }
    changes.push({ enabled: body.enabled, rotate: body.rotate })
    if (!body.enabled) return route.fulfill(json({ outcome: 'disabled', active: false }))
    return route.fulfill(json(body.rotate ? { outcome: 'rotated', active: true, proof: rotated } : { outcome: 'enabled', active: true, proof }))
  })
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openSettings(page)
  const card = page.getByTestId('join-link-card')
  await expect(card).toContainText('Turn on to share one link anyone can use. Turn it off once everyone’s in.')
  await card.getByRole('switch', { name: 'Anyone with the link can join' }).click()
  await expect(card.getByTestId('join-link-url')).toHaveText(new RegExp(`#join=${proof}$`, 'u'))
  await expect(card.getByRole('button', { name: 'Copy' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Share' })).toBeVisible()
  // The link is one truncated line.
  expect(await card.getByTestId('join-link-url').evaluate((node) => getComputedStyle(node).textOverflow)).toBe('ellipsis')
  await expect(page.getByTestId('invite-section')).toContainText('Or invite one person by email')
  await expect(page.getByTestId('invite-member')).toBeVisible()
  await page.getByTestId('invite-section').evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await shot(page, 'settings-owner-link-on')

  await card.getByRole('button', { name: 'Reset link' }).click()
  const reset = page.getByTestId('reset-join-link-sheet')
  await expect(reset).toContainText('The current link stops working straight away.')
  await reset.getByRole('button', { name: 'Reset link' }).click()
  await reset.getByRole('button', { name: 'Done' }).click()
  await expect(card.getByTestId('join-link-url')).toHaveText(new RegExp(`#join=${rotated}$`, 'u'))

  await card.getByRole('switch', { name: 'Anyone with the link can join' }).click()
  await expect(card).toContainText('Turn on to share one link anyone can use.')
  expect(changes).toEqual([{ enabled: true, rotate: false }, { enabled: true, rotate: true }, { enabled: false, rotate: false }])
})

test('Settings → Invite: a Member sees the active link, or that it is off', async ({ page }) => {
  let active = true
  const calls: string[] = []
  await signedIn(page, () => [access('member')], calls)
  await page.route('**/rest/v1/rpc/get_trip_join_link', (route) => route.fulfill(json(active ? { active: true, proof } : { active: false })))
  await page.goto('/')
  await openTrip(page, 'Bali bachelor')
  await openSettings(page)
  const card = page.getByTestId('join-link-card')
  await expect(card.getByTestId('join-link-url')).toHaveText(new RegExp(`#join=${proof}$`, 'u'))
  await expect(card.getByRole('button', { name: 'Copy' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Share' })).toBeVisible()
  await expect(card.getByRole('switch')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Reset link' })).toHaveCount(0)
  await expect(page.getByTestId('invite-member')).toHaveCount(0)
  await expect(page.getByTestId('trip-details')).toContainText('Bali bachelor')
  active = false
  await backToTrip(page)
  await openSettings(page)
  await expect(card).toContainText('The Owner has turned off the invite link.')
  expect(calls).not.toContain('list_group_invitations')
})

test('a #join= link asks to confirm, joins, and opens the Trip', async ({ page }) => {
  let joined = false
  const joins: { proof: string; request_id: string }[] = []
  await signedIn(page, () => joined ? [access('member')] : [])
  await page.route('**/rest/v1/rpc/inspect_trip_join_link', (route) => route.fulfill(json({
    outcome: 'ready', trip_name: 'Bali bachelor', destination: 'Bali, Indonesia', start_date: '2026-12-04', end_date: '2026-12-10',
  })))
  await page.route('**/rest/v1/rpc/join_trip_with_link', (route) => {
    joins.push(route.request().postDataJSON())
    joined = true
    return route.fulfill(json({ outcome: 'joined', group_id: groupId }))
  })
  await page.goto(`/#join=${proof}`)
  const entry = page.getByTestId('join-entry')
  await expect(entry.getByRole('heading', { level: 1 })).toHaveText('Join Bali bachelor?')
  await expect(entry).toContainText('Bali, Indonesia ·')
  await shot(page, 'join-confirm')
  await entry.getByRole('button', { name: 'Join trip' }).click()
  await expect(workspace(page).getByRole('heading', { name: 'Bali bachelor', exact: true })).toBeVisible()
  expect(joins).toHaveLength(1)
  expect(joins[0].proof).toBe(proof)
  // The link is used up in this browser: the fragment and the pending copy are gone.
  expect(new URL(page.url()).hash).toBe('')
  expect(await page.evaluate(() => localStorage.getItem('trip:pending-join:v1'))).toBeNull()
})

test('a #join= link explains a closed link, a removal and an archived Trip; a member goes straight in', async ({ page }) => {
  let outcome = 'closed'
  await signedIn(page, () => [access('member')])
  await page.route('**/rest/v1/rpc/inspect_trip_join_link', (route) => route.fulfill(json(outcome === 'already_member'
    ? { outcome, trip_name: 'Bali bachelor', destination: 'Bali, Indonesia', start_date: '2026-12-04', end_date: '2026-12-10', group_id: groupId }
    : { outcome })))
  const entry = page.getByTestId('join-entry')
  const copy: Record<string, string> = {
    closed: 'This invite link is off. Ask the Trip Owner for a new one.',
    removed: 'You were removed from this Trip. Ask the Owner to invite you again.',
    archived: 'Nobody can join or change it while it’s archived.',
  }
  for (const [name, text] of Object.entries(copy)) {
    outcome = name
    await page.goto(`/#join=${proof}`)
    await expect(entry).toContainText(text)
    await expect(entry.getByRole('button', { name: 'Join trip' })).toHaveCount(0)
    await entry.getByRole('button', { name: 'Go to my Trips' }).click()
    await expect(page.getByTestId('trips-home')).toBeVisible()
  }
  outcome = 'already_member'
  await page.goto(`/#join=${proof}`)
  await expect(workspace(page).getByRole('heading', { name: 'Bali bachelor', exact: true })).toBeVisible()
})

test('a pasted #join= link in the invite dialog opens the join screen', async ({ page }) => {
  await signedIn(page, () => [access('owner')])
  await page.route('**/rest/v1/rpc/inspect_trip_join_link', (route) => route.fulfill(json({ outcome: 'closed' })))
  await page.goto('/')
  await page.getByRole('button', { name: 'Join with an invite link' }).click()
  await page.getByLabel('Have an invite link?').fill(`Come along: https://rove.example/#join=${proof}`)
  await page.getByRole('button', { name: 'Open invite' }).click()
  await expect(page.getByTestId('join-entry')).toContainText('This invite link is off.')
})
