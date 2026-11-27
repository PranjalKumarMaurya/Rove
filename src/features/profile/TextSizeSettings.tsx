import { type CSSProperties, useId } from 'react'
import { Switch } from '../../components/ui/Switch'
import { DEFAULT_TEXT_STEP, TEXT_SCALE_STEPS, useTextSize } from '../../lib/textSize'

const STEP_NAMES = ['Smallest', 'Smaller', 'Default', 'Larger', 'Largest'] as const

/**
 * Profile › Text size: a five-step slider and a Bold text switch. Both apply to the
 * whole app at once (variables on <html>) and are kept on this device. Only the
 * preview eases between sizes; the rest of the app changes in one step, so nothing
 * re-lays out frame by frame.
 */
export function TextSizeSettings() {
  const { settings, update } = useTextSize()
  const sliderId = useId()
  const hintId = useId()
  const last = TEXT_SCALE_STEPS.length - 1
  const fill = `${(settings.step / last) * 100}%`

  return (
    <section aria-labelledby="profile-text-size" className="section" data-testid="profile-text-size" data-layout="section">
      <h2 id="profile-text-size" className="t-eyebrow">Text size</h2>
      <div className="surface card" data-layout="card">
        {/* The preview: what a day header and an expense row look like at this size. */}
        <div className="text-size-preview" aria-hidden="true" data-testid="text-size-preview">
          <p className="t-headline t-num" style={{ color: 'var(--text-primary)' }}>Day 2 · Mon 16 Nov</p>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <span className="t-callout min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>Dinner at Ganga View</span>
            <span className="t-headline t-num shrink-0 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>₹1,350</span>
          </div>
          <p className="t-footnote mt-1" style={{ color: 'var(--text-tertiary)' }}>Paid by you · 4 people</p>
        </div>

        <label htmlFor={sliderId} className="sr-only">Text size</label>
        <div className="mt-4 flex items-center gap-3">
          {/* Fixed sizes: the ends of the slider show the range, so they don't scale. */}
          <span aria-hidden="true" className="text-size-aa" style={{ fontSize: 13 }}>Aa</span>
          <div className="text-size-range-wrap">
            <input id={sliderId} type="range" className="text-size-range" min={0} max={last} step={1}
              value={settings.step} aria-describedby={hintId}
              aria-valuetext={`${STEP_NAMES[settings.step]}${settings.step === DEFAULT_TEXT_STEP ? '' : ` (${Math.round(TEXT_SCALE_STEPS[settings.step] * 100)}%)`}`}
              style={{ '--range-fill': fill } as CSSProperties}
              onChange={(event) => update({ step: Number(event.target.value) })} />
            <span className="text-size-ticks" aria-hidden="true">
              {TEXT_SCALE_STEPS.map((scale, index) => (
                <span key={scale} className={`text-size-tick${index <= settings.step ? ' is-on' : ''}${index === DEFAULT_TEXT_STEP ? ' is-default' : ''}`} />
              ))}
            </span>
          </div>
          <span aria-hidden="true" className="text-size-aa" style={{ fontSize: 21 }}>Aa</span>
        </div>
        <p id={hintId} className="t-footnote mt-2" style={{ color: 'var(--text-tertiary)' }}>
          {STEP_NAMES[settings.step]} · applies across the app on this device.
        </p>
      </div>
      <Switch label="Bold text" hint="Thicker letters everywhere in the app." checked={settings.bold}
        testId="bold-text-switch" onChange={(bold) => update({ bold })} />
    </section>
  )
}
