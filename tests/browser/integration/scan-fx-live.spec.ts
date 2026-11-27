import zlib from 'node:zlib'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createTrip, signUp } from '../support/trip-frame'

// Real local stack (Auth, PostgREST, Storage, Edge runtime with the stub
// extractor); only the public FX rates endpoint is mocked.
test.skip(process.env.TRIP_SCAN_FX_LIVE !== '1', 'requires the disposable scan-fx-live stack (npm run test:scan:live)')

const apiUrl = process.env.VITE_SUPABASE_URL ?? ''
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const inrRates = { result: 'success', base_code: 'INR', time_last_update_unix: 1793145600, rates: { INR: 1, IDR: 190, USD: 0.012, EUR: 0.011 } }

async function mockRates(context: BrowserContext, mode: { online: boolean }) {
  await context.route('https://open.er-api.com/**', (route) => mode.online
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(inrRates) })
    : route.abort('internetdisconnected'))
}

// International Trips (INR, also IDR) so the FX tab is shown.
async function signUpWithTrip(page: Page, name: string, email: string, trip: { name: string; destination: string }) {
  await page.goto('/')
  await signUp(page, name, email)
  await createTrip(page, { ...trip, international: true, currency: 'INR', alsoShow: ['IDR'] })
}

/** The signed-in user's access token, read from the app's own session storage. */
const accessToken = (page: Page) => page.evaluate(() => {
  const key = Object.keys(localStorage).find((name) => name.endsWith('-auth-token'))
  return key ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token ?? '' : ''
})

/** A smooth RGB gradient PNG of the given size (compresses small but is too big in pixels). */
function gradientPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8); header.writeUInt8(2, 9) // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = x % 256; raw[row + 2 + x * 3] = y % 256; raw[row + 3 + x * 3] = 160
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('Scan stores documents privately, drafts an Event for review, and FX converts with cached rates', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const strangerContext = await browser.newContext()
  const rates = { online: true }
  await mockRates(ownerContext, rates)
  await mockRates(strangerContext, rates)
  try {
    const owner = await ownerContext.newPage()
    await signUpWithTrip(owner, 'Scan Owner', 'scan-owner@example.test', { name: 'Bali crew', destination: 'Seminyak, Bali' })
    await owner.getByRole('tab', { name: 'Scan' }).click()
    const scan = owner.getByTestId('scan-tab')
    await expect(scan).toContainText('No documents yet')
    const fileInput = owner.getByLabel('Ticket, booking, or bill file')

    // Local checks reject unsupported and oversize files before any upload.
    await fileInput.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(scan.getByRole('alert')).toContainText('Choose a PDF, JPEG, PNG, WebP, or HEIC file.')
    await fileInput.setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) })
    await expect(scan.getByRole('alert')).toContainText('Choose a PDF under 10 MB')
    await expect(owner.getByRole('button', { name: 'Upload and read' })).toBeDisabled()

    // Upload -> parse (stub) -> editable draft -> add to itinerary.
    await fileInput.setInputFiles({ name: 'boarding-pass.png', mimeType: 'image/png', buffer: png })
    await expect(owner.getByTestId('scan-selected-file')).toContainText('boarding-pass.png')
    await owner.getByRole('button', { name: 'Upload and read' }).click()
    const review = owner.getByTestId('scan-review')
    // The first read waits for the local Edge runtime to warm up.
    await expect(review).toBeVisible({ timeout: 30_000 })
    await expect(review.getByLabel('Title')).toHaveValue('IndiGo 6E-123 · DEL → GOI')
    await expect(review.getByTestId('scan-kind')).toContainText('Read as a booking')
    await expect(review.getByRole('button', { name: 'Change to bill' })).toBeVisible()
    await expect(review.getByLabel('Starts')).toHaveValue('2026-11-01T06:15')
    await expect(review.getByLabel('Start timezone')).toHaveValue('Asia/Kolkata')
    await expect(review.getByLabel('Flight number')).toHaveValue('6E-123')
    await expect(review.getByLabel('Departure airport')).toHaveValue('DEL')
    await expect(review.getByLabel('Booking reference')).toHaveValue('STUB42')
    await review.getByLabel('Title').fill('Flight to Goa')
    // The booking shows a paid price, so its cost goes to Split next, in the same flow.
    await expect(review.getByTestId('scan-cost')).toContainText('12,480')
    await expect(review.getByTestId('scan-cost')).toContainText('paid')
    await expect(review.getByLabel('Also add the cost to Split')).toBeChecked()
    await review.getByRole('button', { name: 'Add to itinerary and split' }).click()
    const costForm = owner.getByTestId('expense-form')
    await expect(costForm).toContainText('Split this booking')
    await expect(costForm.getByTestId('scan-cost-notice')).toContainText('Flight to Goa is in the itinerary.')
    await expect(costForm.getByLabel('Description')).toHaveValue('Flight to Goa')
    await expect(costForm.getByLabel('Total amount')).toHaveValue('12480')
    await expect(costForm.getByLabel('Category')).toHaveValue('transport')
    await costForm.getByRole('button', { name: 'Save expense' }).click()
    await expect(scan).toContainText('In the itinerary and in Split: Flight to Goa')
    const passRow = owner.getByTestId('scan-document').filter({ hasText: 'boarding-pass.png' })
    await expect(passRow).toContainText('In itinerary · In Split: Flight to Goa')
    await expect(passRow.getByRole('button', { name: 'Split cost of boarding-pass.png' })).toHaveCount(0)
    await expect(passRow).toContainText('Scan Owner')
    await expect(passRow.getByRole('button', { name: 'Review boarding-pass.png' })).toHaveCount(0)

    // A big phone photo is shrunk on the device (to a JPEG, 2000 px long side) and still read.
    await fileInput.setInputFiles({ name: 'large-ticket-photo.png', mimeType: 'image/png', buffer: gradientPng(3000, 2000) })
    await owner.getByRole('button', { name: 'Upload and read' }).click()
    await expect(review.getByLabel('Title')).toHaveValue('IndiGo 6E-123 · DEL → GOI')
    await review.getByRole('button', { name: 'Not now' }).click()
    const bigRow = owner.getByTestId('scan-document').filter({ hasText: 'large-ticket-photo.jpg' })
    await expect(bigRow).toContainText('JPG')
    await bigRow.getByRole('button', { name: 'Delete large-ticket-photo.jpg' }).click()
    await bigRow.getByRole('button', { name: 'Delete document' }).click()
    await expect(scan).toContainText('Deleted large-ticket-photo.jpg')

    // A bill opens Split's form, filled in from the bill. "Not now" keeps it as a draft to split later.
    await fileInput.setInputFiles({ name: 'dinner-bill.png', mimeType: 'image/png', buffer: png })
    await owner.getByRole('button', { name: 'Upload and read' }).click()
    const billForm = owner.getByTestId('expense-form')
    await expect(billForm).toContainText('Split this bill')
    await expect(billForm.getByTestId('scan-bill-notice')).toContainText('dinner-bill.png')
    // What the reader decided, with a clear way to change it.
    await expect(billForm.getByTestId('scan-kind')).toContainText('Read as a bill')
    await expect(billForm.getByTestId('scan-kind').getByRole('button', { name: 'Change to booking' })).toBeVisible()
    await expect(billForm.getByLabel('Description')).toHaveValue('Curlies by the Sea: food and drinks')
    await expect(billForm.getByLabel('Total amount')).toHaveValue('7770.00')
    await expect(billForm.getByLabel('When')).toHaveValue(/T\d\d:\d\d$/u)
    await billForm.getByRole('button', { name: 'Cancel' }).click()
    const billRow = owner.getByTestId('scan-document').filter({ hasText: 'dinner-bill.png' })
    await expect(billRow).toContainText('Bill ready to split')
    // The next morning: open it from the list and split it.
    await billRow.getByRole('button', { name: 'Split dinner-bill.png' }).click()
    await expect(billForm.getByLabel('Description')).toHaveValue('Curlies by the Sea: food and drinks')
    await billForm.getByRole('button', { name: 'Save expense' }).click()
    await expect(scan).toContainText('Added to Split: Curlies by the Sea: food and drinks')
    await expect(billRow).toContainText('In Split: Curlies by the Sea: food and drinks')
    await expect(billRow.getByRole('button', { name: 'Split dinner-bill.png' })).toHaveCount(0)
    await owner.getByRole('tab', { name: 'Split' }).click()
    await expect(owner.getByTestId('expense-card').filter({ hasText: 'Curlies by the Sea' })).toBeVisible()
    // Labels say where each came from; expenses I'm on carry the quiet highlight.
    const flightCard = owner.getByTestId('expense-card').filter({ hasText: 'Flight to Goa' })
    await expect(flightCard.getByTestId('expense-source')).toHaveText('From booking: Flight to Goa · In itinerary')
    await expect(flightCard).toHaveAttribute('data-mine', 'true')
    await expect(owner.getByTestId('expense-card').filter({ hasText: 'Curlies by the Sea' }).getByTestId('expense-source')).toHaveText('From a scanned bill')
    await owner.getByRole('button', { name: /^Only mine/u }).click()
    await expect(owner.getByTestId('expense-card')).toHaveCount(2)
    await owner.getByRole('button', { name: 'All', exact: true }).click()
    // Adding the same cost again by hand is flagged before saving.
    await owner.getByRole('button', { name: 'Add expense' }).click()
    const manual = owner.getByTestId('expense-form')
    await manual.getByLabel('Total amount').fill('12480')
    await expect(manual.getByTestId('similar-expense')).toContainText('already added')
    await expect(manual.getByTestId('similar-expense')).toContainText('Flight to Goa')
    await manual.getByRole('button', { name: 'Cancel' }).click()
    await manual.getByRole('button', { name: 'Discard' }).click()
    await owner.getByRole('tab', { name: 'Scan' }).click()

    // A parse failure still allows manual entry.
    await fileInput.setInputFiles({ name: 'unreadable-voucher.pdf', mimeType: 'application/pdf', buffer: pdf })
    await owner.getByRole('button', { name: 'Upload and read' }).click()
    await expect(review).toContainText('We could not read this document. Enter the details yourself.')
    await expect(review.getByLabel('Title')).toHaveValue('')
    await review.getByRole('button', { name: 'Add to itinerary' }).click()
    await expect(review.getByRole('alert').first()).toContainText('Fix the highlighted fields')
    await review.getByLabel('Type').selectOption('hotel')
    await review.getByLabel('Title').fill('Hotel check-in')
    await review.getByLabel('Starts').fill('2026-11-01T14:00')
    await review.getByRole('button', { name: 'Add to itinerary' }).click()
    await expect(scan).toContainText('Added to the itinerary: Hotel check-in')

    // View opens a short-lived signed URL for the private object.
    const popupPromise = owner.waitForEvent('popup')
    await passRow.getByRole('button', { name: 'View boarding-pass.png' }).click()
    const popup = await popupPromise
    await popup.waitForURL(/\/storage\/v1\/object\/sign\/trip-documents\//u)
    const signedUrl = popup.url()
    const objectPath = decodeURIComponent(new URL(signedUrl).pathname.split('/object/sign/trip-documents/')[1])
    const viewed = await ownerContext.request.get(signedUrl)
    expect(viewed.status()).toBe(200)
    expect(viewed.headers()['content-type']).toContain('image/png')
    await popup.close()
    // The object is not public.
    expect((await ownerContext.request.get(`${apiUrl}/storage/v1/object/public/trip-documents/${objectPath}`)).ok()).toBe(false)

    // Someone in another Trip sees nothing and cannot fetch the object directly.
    const stranger = await strangerContext.newPage()
    await signUpWithTrip(stranger, 'Other Person', 'scan-other@example.test', { name: 'Jaipur', destination: 'Jaipur' })
    await stranger.getByRole('tab', { name: 'Scan' }).click()
    await expect(stranger.getByTestId('scan-tab')).toContainText('No documents yet')
    const strangerToken = await accessToken(stranger)
    expect(strangerToken).not.toBe('')
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? ''
    const headers = { apikey: anonKey, Authorization: `Bearer ${strangerToken}` }
    const download = await strangerContext.request.get(`${apiUrl}/storage/v1/object/authenticated/trip-documents/${objectPath}`, { headers })
    expect(download.ok()).toBe(false)
    const listed = await strangerContext.request.get(`${apiUrl}/rest/v1/trip_documents?select=id`, { headers })
    expect(await listed.json()).toEqual([])
    await stranger.getByRole('tab', { name: 'FX' }).click()
    await expect(stranger.getByTestId('fx-tab')).toBeVisible()
    await expect(stranger.getByTestId('fx-bali-guide')).toHaveCount(0)

    // Delete needs confirmation; the itinerary entry made from it stays.
    await passRow.getByRole('button', { name: 'Delete boarding-pass.png' }).click()
    await passRow.getByRole('button', { name: 'Keep' }).click()
    await expect(passRow).toBeVisible()
    await passRow.getByRole('button', { name: 'Delete boarding-pass.png' }).click()
    await passRow.getByRole('button', { name: 'Delete document' }).click()
    await expect(scan).toContainText('Deleted boarding-pass.png')
    // Left: the hotel voucher and the split bill.
    await expect(owner.getByTestId('scan-document')).toHaveCount(2)
    await expect(owner.getByTestId('scan-document').filter({ hasText: 'unreadable-voucher.pdf' })).toContainText('In itinerary: Hotel check-in')
    expect((await ownerContext.request.get(signedUrl)).ok()).toBe(false)

    // Several files at once: nothing pops up; they're read in the background and "Review next" walks through them.
    await fileInput.setInputFiles([
      { name: 'taxi-receipt.png', mimeType: 'image/png', buffer: png },
      { name: 'ferry-ticket.png', mimeType: 'image/png', buffer: png },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    ])
    await expect(owner.getByTestId('scan-selected-files')).toContainText('taxi-receipt.png')
    await expect(owner.getByTestId('scan-batch-note')).toContainText('2 files ready.')
    await expect(owner.getByTestId('scan-batch-note')).toContainText('Left out: notes.txt')
    await owner.getByRole('button', { name: 'Upload 2 files' }).click()
    await expect(scan).toContainText('2 added to Trip documents', { timeout: 30_000 })
    await expect(review).toHaveCount(0)
    await expect(owner.getByTestId('expense-form')).toHaveCount(0)
    await expect(owner.getByTestId('scan-document').filter({ hasText: 'taxi-receipt.png' })).toContainText('Bill ready to split')
    await expect(owner.getByTestId('scan-document').filter({ hasText: 'ferry-ticket.png' })).toContainText('Booking ready to review')
    const next = owner.getByTestId('scan-review-next')
    await expect(next).toContainText('2 waiting')
    await next.click()
    await expect(owner.getByTestId('scan-walk')).toContainText('REVIEWING 1 OF 2')
    await expect(owner.getByTestId('expense-form')).toContainText('Split this bill')
    await owner.getByTestId('expense-form').getByRole('button', { name: 'Save expense' }).click()
    // Saving moves straight on to the next one.
    await expect(owner.getByTestId('scan-walk')).toContainText('REVIEWING 2 OF 2')
    await expect(review.getByLabel('Title')).toHaveValue('IndiGo 6E-123 · DEL → GOI')
    await review.getByRole('button', { name: 'Skip' }).click()
    await expect(scan).toContainText('All caught up')
    await expect(owner.getByTestId('scan-walk')).toHaveCount(0)
    await expect(owner.getByTestId('scan-document').filter({ hasText: 'taxi-receipt.png' })).toContainText('In Split')
    await expect(next).toContainText('1 waiting')

    // FX: accounting currency against IDR (a Bali Trip), mocked live rates, two-way input.
    await owner.getByRole('tab', { name: 'FX' }).click()
    const fx = owner.getByTestId('fx-tab')
    await expect(owner.getByTestId('fx-status')).toContainText('Live rates')
    await expect(owner.getByLabel('Other currency')).toHaveValue('IDR')
    await expect(owner.getByTestId('fx-rate')).toContainText('1 INR = 190 IDR')
    await expect(owner.getByLabel('Amount in IDR')).toHaveValue('19000')
    await owner.getByLabel('Amount in INR').fill('1,000')
    await expect(owner.getByLabel('Amount in IDR')).toHaveValue('190000')
    await owner.getByLabel('Amount in IDR').fill('380000')
    await expect(owner.getByLabel('Amount in INR')).toHaveValue('2000')
    await fx.getByRole('button', { name: /^Convert .*500/u }).first().click()
    await expect(owner.getByLabel('Amount in INR')).not.toHaveValue('2000')
    await expect(owner.getByTestId('fx-bali-guide')).toContainText('Bintang large')
    await owner.getByLabel('Other currency').selectOption('USD')
    await expect(owner.getByTestId('fx-rate')).toContainText('1 INR = 0.012 USD')

    // Offline: refresh fails but the last good rates keep working, also after a reload.
    rates.online = false
    await owner.getByRole('button', { name: 'Refresh rates' }).click()
    await expect(owner.getByTestId('fx-status')).toContainText('Offline. Showing saved rates')
    await owner.reload()
    await owner.getByRole('tab', { name: 'FX' }).click()
    await expect(owner.getByTestId('fx-status')).toContainText('Saved rates')
    await expect(owner.getByLabel('Other currency')).toHaveValue('USD')
    await owner.getByLabel('Amount in INR').fill('500')
    await expect(owner.getByLabel('Amount in USD')).toHaveValue('6')
  } finally {
    await ownerContext.close()
    await strangerContext.close()
  }
})
