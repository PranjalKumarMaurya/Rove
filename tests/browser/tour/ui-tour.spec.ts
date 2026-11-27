import { mkdirSync } from 'node:fs'
import { backToTrip, createTrip, goToTrips, openProfile, openSettings, openTodos, openTrip, openTripTab, setTripSettings } from '../support/trip-frame'
import { expect, test, type Page } from '@playwright/test'

// Visual tour: screenshots every main screen with realistic data for UI review.
// Run with `npm run test:ui:tour`; images land in TRIP_TOUR_DIR (default artifacts/ui-tour).
test.skip(process.env.TRIP_UI_TOUR !== '1', 'requires the disposable stack from run-ui-tour.mjs')
test.setTimeout(240_000)

const outDir = process.env.TRIP_TOUR_DIR ?? 'artifacts/ui-tour'
const problems: string[] = []
let index = 0

async function shot(page: Page, name: string) {
  index += 1
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${outDir}/${String(index).padStart(2, '0')}-${name}.png`, fullPage: true })
}

/** Optional phone-screen shots (the viewport only, 390×844): set TRIP_NAV_SHOTS to a folder. */
async function navShot(page: Page, name: string) {
  if (!process.env.TRIP_NAV_SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${process.env.TRIP_NAV_SHOTS}/${name}.png` })
}

async function step(name: string, action: () => Promise<void>) {
  try {
    await action()
  } catch (error) {
    problems.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

function inDays(days: number, time: string) {
  const day = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  return `${day}T${time}`
}

test('tour every screen', async ({ browser }) => {
  mkdirSync(outDir, { recursive: true })
  if (process.env.TRIP_NAV_SHOTS) mkdirSync(process.env.TRIP_NAV_SHOTS, { recursive: true })
  const ownerContext = await browser.newContext({ timezoneId: 'Asia/Kolkata' })
  const friendContext = await browser.newContext({ timezoneId: 'Asia/Kolkata' })
  for (const context of [ownerContext, friendContext]) {
    await context.route('https://open.er-api.com/**', (route) => route.fulfill({
      json: { result: 'success', base_code: 'INR', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { INR: 1, IDR: 188.68, USD: 0.012, EUR: 0.011 } },
    }))
  }
  const owner = await ownerContext.newPage()

  await step('auth', async () => {
    await owner.goto('/')
    await expect(owner.getByRole('button', { name: 'Create an account' })).toBeVisible()
    await shot(owner, 'sign-in')
    await owner.getByRole('button', { name: 'Forgot password?' }).click()
    await shot(owner, 'forgot-password')
    await owner.goto('/')
    await owner.getByRole('button', { name: 'Create an account' }).click()
    await shot(owner, 'create-account')
    await owner.getByLabel('Display name').fill('Partha')
    await owner.getByLabel('Email').fill('partha@example.test')
    await owner.getByLabel('Password').fill('LongerPass123!')
    await owner.getByRole('button', { name: 'Create account' }).click()
  })

  await step('trips-home-empty', async () => {
    await expect(owner.getByTestId('trips-empty')).toBeVisible()
    await shot(owner, 'trips-home-empty')
  })

  await step('profile', async () => {
    await openProfile(owner)
    await owner.getByLabel('Home currency').selectOption('INR')
    await owner.getByLabel('UPI ID').fill('partha@okaxis')
    await owner.getByLabel('Dietary needs or allergies').fill('No shellfish')
    await owner.getByRole('button', { name: 'Save details' }).click()
    await owner.getByRole('button', { name: 'Use 😎 as your avatar' }).click()
    await shot(owner, 'profile')
    await owner.getByRole('button', { name: 'Delete account' }).click()
    await owner.getByLabel('Type DELETE to confirm').waitFor()
    await shot(owner, 'profile-delete-account')
    await owner.getByRole('button', { name: 'Keep my account' }).click()
    await owner.getByRole('button', { name: 'Privacy policy' }).click()
    await shot(owner, 'privacy-policy')
    await owner.getByRole('button', { name: 'Back to Profile' }).click()
    await goToTrips(owner)
  })

  await step('onboarding', async () => {
    await owner.getByRole('button', { name: 'Create Trip', exact: true }).click()
    await expect(owner.getByTestId('bootstrap-onboarding')).toBeVisible()
    await shot(owner, 'onboarding-empty-domestic')
    await owner.getByLabel('Trip name').fill('Bali bachelor')
    await owner.getByLabel('Destination').fill('Bali, Indonesia')
    await owner.getByLabel('Start date').fill(inDays(5, '00:00').slice(0, 10))
    await owner.getByLabel('End date').fill(inDays(11, '00:00').slice(0, 10))
    await setTripSettings(owner, { timezone: 'Asia/Makassar', currency: 'INR', alsoShow: ['IDR'] })
    await shot(owner, 'onboarding-filled-international')
    await owner.getByRole('button', { name: 'Create Trip' }).click()
    await expect(owner.getByRole('button', { name: 'Open Trip' })).toBeVisible()
    await shot(owner, 'trip-created')
    await owner.getByRole('button', { name: 'Open Trip' }).click()
    await expect(owner.getByTestId('group-workspace')).toBeVisible()
  })

  await step('trip-tab', async () => {
    await shot(owner, 'trip-empty')
    await owner.getByRole('button', { name: 'Add event' }).click()
    const dialog = owner.getByRole('dialog', { name: 'Add event' })
    await shot(owner, 'trip-add-event-dialog')
    await dialog.getByLabel('Type').selectOption('flight')
    await dialog.getByLabel('Title', { exact: true }).fill('IndiGo to Bali')
    await dialog.getByLabel('Starts', { exact: true }).fill(inDays(5, '06:15'))
    await dialog.getByRole('button', { name: 'Add event' }).click()
    await expect(dialog).toHaveCount(0)
    await owner.getByRole('button', { name: 'Add event' }).click()
    await dialog.getByLabel('Type').selectOption('hotel')
    await dialog.getByLabel('Title', { exact: true }).fill('W Bali – Seminyak')
    await dialog.getByLabel('Starts', { exact: true }).fill(inDays(5, '15:00'))
    await dialog.getByRole('button', { name: 'Add event' }).click()
    await expect(dialog).toHaveCount(0)
    await shot(owner, 'trip-with-events')
  })

  await step('todos-tab', async () => {
    await openTodos(owner)
    await shot(owner, 'todos-empty')
    for (const title of ['Book airport transfer', 'Buy sunscreen', 'Exchange cash']) {
      await owner.getByLabel('New todo').fill(title)
      await owner.keyboard.press('Enter')
      await expect(owner.getByTestId('todo-row').filter({ hasText: title })).toBeVisible()
    }
    // Ticking folds the row out of the open list and into Completed.
    await owner.getByTestId('todo-row').filter({ hasText: 'Book airport transfer' }).getByRole('checkbox').click()
    await expect(owner.getByRole('list', { name: 'Completed todos' }).getByRole('checkbox')).toBeChecked()
    await shot(owner, 'todos-with-items')
    await navShot(owner, 'todos')
    // Back on the Trip, the header counts the open to-dos.
    await backToTrip(owner)
    await expect(owner.getByRole('button', { name: 'To-dos, 2 open' })).toBeVisible()
    await navShot(owner, 'trip-header')
  })

  await step('split-tab', async () => {
    await openTripTab(owner, 'Split')
    await shot(owner, 'split-empty')
    await owner.getByRole('button', { name: 'Add expense' }).click()
    const form = owner.getByRole('dialog', { name: 'Add expense' })
    await form.getByLabel('Description').fill('Beach club dinner')
    await form.getByLabel('Total amount').fill('4500')
    await shot(owner, 'split-add-expense-dialog')
    await form.getByRole('button', { name: 'Save expense' }).click()
    await expect(form).toHaveCount(0)
    await shot(owner, 'split-with-expense')
  })

  await step('scan-tab', async () => {
    await openTripTab(owner, 'Scan')
    await shot(owner, 'scan')
  })

  await step('fx-tab', async () => {
    await openTripTab(owner, 'FX')
    await shot(owner, 'fx')
  })

  let link = ''
  let joinUrl = ''
  await step('settings', async () => {
    await openSettings(owner)
    await expect(owner.getByLabel('Trip name')).toBeVisible()
    await shot(owner, 'settings-owner')
    await navShot(owner, 'settings-owner-top')
    const joinCard = owner.getByTestId('join-link-card')
    await joinCard.getByRole('switch', { name: 'Anyone with the link can join' }).click()
    await expect(joinCard.getByTestId('join-link-url')).toBeVisible()
    joinUrl = (await joinCard.getByTestId('join-link-url').innerText()).trim()
    await owner.getByTestId('invite-section').evaluate((node) => node.scrollIntoView({ block: 'start' }))
    await navShot(owner, 'settings-owner-invite-link-on')
    await owner.getByLabel('Friend’s email').fill('astitva@example.test')
    await owner.getByRole('button', { name: 'Create link' }).click()
    link = await owner.getByLabel('Invitation link').inputValue()
    await shot(owner, 'settings-invite-links')
    await owner.getByTestId('danger-zone').evaluate((node) => node.scrollIntoView({ block: 'end' }))
    await navShot(owner, 'settings-owner-danger-zone')
  })

  await step('frame', async () => {
    // A domestic Trip: no FX tab, no currency in Split.
    await createTrip(owner, { name: 'Goa long weekend', destination: 'Goa', startDate: inDays(-1, '00:00').slice(0, 10), endDate: inDays(2, '00:00').slice(0, 10) })
    await shot(owner, 'domestic-trip')
    await openTripTab(owner, 'Split')
    await owner.getByRole('button', { name: 'Add expense' }).click()
    await shot(owner, 'domestic-split-add-expense')
    await owner.getByRole('dialog', { name: 'Add expense' }).getByRole('button', { name: 'Cancel' }).click()
    await goToTrips(owner)
    await shot(owner, 'trips-home')
    await openTrip(owner, 'Bali bachelor')
    await openSettings(owner)
  })

  const friend = await friendContext.newPage()
  await step('friend-join', async () => {
    await friend.goto(link)
    await expect(friend.getByTestId('invitation-entry')).toBeVisible()
    await shot(friend, 'invite-entry-signed-out')
    await friend.getByRole('button', { name: 'Continue', exact: true }).click()
    await shot(friend, 'invite-auth')
    await friend.getByRole('button', { name: 'Create an account' }).click()
    await friend.getByLabel('Display name').fill('Astitva')
    await friend.getByLabel('Email').fill('astitva@example.test')
    await friend.getByLabel('Password').fill('LongerPass123!')
    await friend.getByRole('button', { name: 'Create account' }).click()
    await expect(friend.getByRole('button', { name: 'Confirm and join' })).toBeVisible()
    await shot(friend, 'invite-confirm-join')
    await friend.getByRole('button', { name: 'Confirm and join' }).click()
    await expect(friend.getByTestId('invitation-entry')).toContainText('You joined Bali bachelor.')
    await shot(friend, 'invite-joined')
    await friend.getByRole('button', { name: 'Open Trip' }).click()
    await expect(friend.getByTestId('group-workspace')).toBeVisible()
    await shot(friend, 'friend-trip')
    await openSettings(friend)
    await expect(friend.getByTestId('trip-details')).toBeVisible()
    await shot(friend, 'friend-settings')
    await openTripTab(friend, 'Split')
    await shot(friend, 'friend-split')
  })

  // A third person joins with the Trip's open invite link.
  const guestContext = await browser.newContext({ timezoneId: 'Asia/Kolkata' })
  const guest = await guestContext.newPage()
  await step('join-link', async () => {
    await guest.goto(joinUrl)
    await expect(guest.getByTestId('join-entry')).toContainText('Join Bali bachelor?')
    await shot(guest, 'join-entry-signed-out')
    await guest.getByRole('button', { name: 'Continue', exact: true }).click()
    await guest.getByRole('button', { name: 'Create an account' }).click()
    await guest.getByLabel('Display name').fill('Neha')
    await guest.getByLabel('Email').fill('neha@example.test')
    await guest.getByLabel('Password').fill('LongerPass123!')
    await guest.getByRole('button', { name: 'Create account' }).click()
    await expect(guest.getByRole('button', { name: 'Join trip' })).toBeVisible()
    await shot(guest, 'join-confirm')
    await navShot(guest, 'join-confirm')
    await guest.getByRole('button', { name: 'Join trip' }).click()
    await expect(guest.getByTestId('group-workspace')).toContainText('Bali bachelor')
  })

  await step('chat', async () => {
    await openTripTab(friend, 'Chat')
    await friend.getByRole('textbox', { name: 'Message' }).fill('Landing at 6:15, see you at arrivals!')
    await friend.getByRole('button', { name: 'Send' }).click()
    await openTripTab(owner, 'Chat')
    await expect(owner.getByRole('log', { name: 'Messages' })).toContainText('Landing at 6:15', { timeout: 15_000 })
    await owner.getByRole('textbox', { name: 'Message' }).fill('Villa is booked. Pool on day one 🎉')
    await owner.getByRole('button', { name: 'Send' }).click()
    await expect(owner.getByRole('log', { name: 'Messages' })).toContainText('Villa is booked')
    // The composer sits just above the tab bar.
    const gap = await owner.evaluate(() => {
      const composer = document.querySelector('.chat__composer')!.getBoundingClientRect()
      const bar = document.querySelector('.tab-bar')!.getBoundingClientRect()
      return bar.top - composer.bottom
    })
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(gap).toBeLessThanOrEqual(16)
    await shot(owner, 'chat')
    await navShot(owner, 'chat')
  })

  await step('owner-after-join', async () => {
    await openSettings(owner)
    await owner.getByRole('button', { name: 'Refresh crew' }).click().catch(() => undefined)
    await expect(owner.getByRole('list', { name: 'Trip members' })).toContainText('Neha')
    await shot(owner, 'settings-people-with-friends')
  })

  await ownerContext.close()
  await friendContext.close()
  await guestContext.close()
  console.log(JSON.stringify({ screenshots: index, problems }))
})
