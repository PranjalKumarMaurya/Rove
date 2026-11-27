import { expect, type Page } from '@playwright/test'

// Shared steps for the app frame (sign-up, Trips home, Create Trip, opening and
// switching Trips, Profile), so specs do not each depend on how those controls
// are laid out. After sign-in the app always opens the Trips home.

export const TEST_PASSWORD = 'LongerPass123!'

/** From the sign-in screen: create an account. Does not wait for what comes next. */
export async function signUp(page: Page, name: string, email: string, password = TEST_PASSWORD) {
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Display name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

export const tripsHome = (page: Page) => page.getByTestId('trips-home')
export const workspace = (page: Page) => page.getByTestId('group-workspace')

/** Back to the Trips home from wherever the page is (a Trip, its To-dos or Settings, Profile or Create Trip). */
export async function goToTrips(page: Page) {
  // "Back to Trips" in a Trip, "Back to <Trip>" on its To-dos and Settings, "Back" on Profile, "Trips" on Create Trip.
  const back = page.getByRole('button', { name: /^(Back to .+|Back|Trips)$/ })
  // Wait until the app has settled on a screen (it may still be restoring the session).
  await expect(tripsHome(page).or(back).first()).toBeVisible()
  // A screen pushed above a Trip, or Profile opened from a Trip, is two steps from home.
  for (let step = 0; step < 3 && !(await tripsHome(page).isVisible()); step += 1) {
    await back.first().click()
    await expect(tripsHome(page).or(back).first()).toBeVisible()
  }
  await expect(tripsHome(page)).toBeVisible()
}

export const tripSettings = (page: Page) => page.getByTestId('trip-settings')
export const tripTodos = (page: Page) => page.getByTestId('trip-todos')
/** Settings → People (the crew list and its actions; what was the Crew tab). */
export const crewSection = (page: Page) => page.getByTestId('crew-section')

/** From a Trip's To-dos or Settings back to the Trip (no-op when already on it). */
export async function backToTrip(page: Page) {
  const pushed = tripSettings(page).or(tripTodos(page))
  await expect(workspace(page).or(pushed).first()).toBeVisible()
  if (await pushed.count()) await pushed.first().getByRole('button', { name: /^Back to / }).first().click()
  await expect(workspace(page)).toBeVisible()
}

/** Select one of the Trip's bottom tabs (Trip, Split, Scan, Chat, FX), leaving To-dos or Settings first. */
export async function openTripTab(page: Page, name: string) {
  await backToTrip(page)
  await page.getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
}

/** Open the Trip's Settings screen (details, People, Invite, Danger zone) from its header. */
export async function openSettings(page: Page) {
  if (await tripSettings(page).count()) return
  await backToTrip(page)
  await workspace(page).getByRole('button', { name: 'Trip settings' }).click()
  await expect(tripSettings(page)).toBeVisible()
}

/** Open the Trip's To-dos screen from its header. */
export async function openTodos(page: Page) {
  if (await tripTodos(page).count()) return
  await backToTrip(page)
  await workspace(page).getByRole('button', { name: /^To-dos/ }).click()
  await expect(tripTodos(page)).toBeVisible()
}

/**
 * Pick the Trip timezone and currencies on Create Trip or Trip settings. Giving a
 * `currency` or `alsoShow` (or `international: true`) turns on "International trip?",
 * which is where currency choices live; domestic Trips use the home currency.
 */
export async function setTripSettings(page: Page, { timezone, currency, alsoShow = [], international }: {
  timezone?: string
  currency?: string
  alsoShow?: string[]
  international?: boolean
}) {
  if (timezone) await page.getByLabel('Timezone').selectOption(timezone)
  const wantInternational = international ?? Boolean(currency || alsoShow.length)
  const toggle = page.getByRole('switch', { name: 'International trip?' })
  if ((await toggle.getAttribute('aria-checked') === 'true') !== wantInternational) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(wantInternational))
  if (!wantInternational) return
  if (currency) await page.getByLabel('Trip currency').selectOption(currency)
  if (!alsoShow.length) return
  await page.getByRole('button', { name: 'More options' }).click()
  for (const code of alsoShow) await page.getByLabel('Also show amounts in').selectOption(code)
}

export interface NewTrip {
  name: string
  destination?: string
  startDate?: string
  endDate?: string
  timezone?: string
  international?: boolean
  currency?: string
  alsoShow?: string[]
}

/** Fill and submit the Create Trip form, then open the new Trip. */
export async function fillAndCreateTrip(page: Page, trip: NewTrip) {
  await expect(page.getByTestId('bootstrap-onboarding')).toBeVisible()
  await page.getByLabel('Trip name').fill(trip.name)
  await page.getByLabel('Destination').fill(trip.destination ?? 'Goa')
  await page.getByLabel('Start date').fill(trip.startDate ?? '2026-11-01')
  await page.getByLabel('End date').fill(trip.endDate ?? '2026-11-05')
  await setTripSettings(page, { timezone: trip.timezone ?? 'Asia/Kolkata', currency: trip.currency, alsoShow: trip.alsoShow, international: trip.international })
  await page.getByRole('button', { name: 'Create Trip', exact: true }).click()
  await expect(page.getByTestId('bootstrap-success-state-a')).toContainText(trip.name)
  await page.getByRole('button', { name: 'Open Trip' }).click()
  await expect(workspace(page).getByRole('heading', { name: trip.name, exact: true })).toBeVisible()
}

/** Trips home -> ＋ -> Create Trip -> Open Trip. Works from inside another Trip too. */
export async function createTrip(page: Page, trip: NewTrip) {
  await createAnotherTrip(page)
  await fillAndCreateTrip(page, trip)
}

/** Open the Create Trip screen from the Trips home ＋ button. */
export async function createAnotherTrip(page: Page) {
  await goToTrips(page)
  await tripsHome(page).getByRole('button', { name: 'Create Trip', exact: true }).click()
  await expect(page.getByTestId('bootstrap-onboarding')).toBeVisible()
}

/** Open a Trip by name from the Trips home. */
export async function openTrip(page: Page, tripName: string) {
  await goToTrips(page)
  await tripsHome(page).getByRole('button', { name: tripName, exact: true }).click()
  await expect(workspace(page).getByRole('heading', { name: tripName, exact: true })).toBeVisible()
}

export const switchTrip = openTrip

export async function expectTripCount(page: Page, count: number) {
  await goToTrips(page)
  await expect(tripsHome(page).getByTestId('trip-card')).toHaveCount(count)
}

/** Re-read the Trip list: back to the Trips home (which refreshes) and into the same Trip again. */
export async function refreshTrips(page: Page) {
  await backToTrip(page)
  const name = (await workspace(page).getByRole('heading', { level: 1 }).innerText()).trim()
  await goToTrips(page)
  await openTrip(page, name)
}

export async function openProfile(page: Page) {
  // Profile is on the home screen only; leave a Trip first.
  if (await page.getByTestId('group-workspace').count()) await goToTrips(page)
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByTestId('profile-screen')).toBeVisible()
}
