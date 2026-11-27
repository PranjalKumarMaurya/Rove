import { useCallback, useState } from 'react'

/**
 * The person's text size and Bold text choice (Profile › Text size). Stored on this
 * device only and applied to <html> as two CSS variables that every type token in
 * src/styles/type.css multiplies by (--text-scale) or adds to (--weight-boost).
 */

/** The five slider steps; index 2 is the default. */
export const TEXT_SCALE_STEPS = [0.9, 0.95, 1, 1.12, 1.25] as const
export const DEFAULT_TEXT_STEP = 2
/** Added to every weight when Bold text is on (400 → 500, 500 → 600, 600 → 700). */
export const BOLD_WEIGHT_BOOST = 100

export type TextSizeSettings = { step: number; bold: boolean }

const STORAGE_KEY = 'rove.textSize'
export const DEFAULT_TEXT_SIZE: TextSizeSettings = { step: DEFAULT_TEXT_STEP, bold: false }

const clampStep = (value: unknown): number => {
  const step = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_TEXT_STEP
  return Math.min(TEXT_SCALE_STEPS.length - 1, Math.max(0, step))
}

/** Parses a stored value; anything unreadable falls back to the defaults. */
export function parseTextSize(raw: string | null | undefined): TextSizeSettings {
  if (!raw) return DEFAULT_TEXT_SIZE
  try {
    const value = JSON.parse(raw) as Partial<TextSizeSettings> | null
    if (!value || typeof value !== 'object') return DEFAULT_TEXT_SIZE
    return { step: clampStep(value.step), bold: value.bold === true }
  } catch {
    return DEFAULT_TEXT_SIZE
  }
}

export function readTextSize(): TextSizeSettings {
  try {
    return parseTextSize(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    // Private mode or blocked storage: the defaults still work.
    return DEFAULT_TEXT_SIZE
  }
}

function saveTextSize(settings: TextSizeSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Not saved on this device; the choice still applies until the app closes.
  }
}

/** Sets the variables on <html>; the whole app follows at once. */
export function applyTextSize(settings: TextSizeSettings, root: HTMLElement = document.documentElement) {
  const scale = TEXT_SCALE_STEPS[clampStep(settings.step)]
  if (scale === 1) root.style.removeProperty('--text-scale')
  else root.style.setProperty('--text-scale', String(scale))
  if (settings.bold) root.style.setProperty('--weight-boost', String(BOLD_WEIGHT_BOOST))
  else root.style.removeProperty('--weight-boost')
  root.dataset.textStep = String(clampStep(settings.step))
  if (settings.bold) root.dataset.boldText = 'true'
  else delete root.dataset.boldText
}

/** Profile's control: the current choice, and a setter that applies and saves it. */
export function useTextSize() {
  const [settings, setSettings] = useState<TextSizeSettings>(readTextSize)
  const update = useCallback((changes: Partial<TextSizeSettings>) => {
    setSettings((current) => {
      const next = { step: clampStep(changes.step ?? current.step), bold: changes.bold ?? current.bold }
      applyTextSize(next)
      saveTextSize(next)
      return next
    })
  }, [])
  return { settings, update }
}
