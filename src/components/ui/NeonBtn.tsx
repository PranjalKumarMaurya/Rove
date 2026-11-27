import { type CSSProperties, type ReactNode, type ButtonHTMLAttributes, forwardRef } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  color?: string
  children: ReactNode
  variant?: 'solid' | 'outline' | 'ghost'
  /** `md` (default) is the original size; `lg` is a 48px primary action with centred icon + label. */
  size?: 'md' | 'lg'
}

/** A one-third-opacity border colour; hex colours keep their original `#RRGGBB55` form. */
function translucent(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}55` : `color-mix(in srgb, ${color} 34%, transparent)`
}

export const NeonBtn = forwardRef<HTMLButtonElement, Props>(function NeonBtn({
  color = 'var(--accent)',
  children,
  variant = 'solid',
  size = 'md',
  className = '',
  style: externalStyle,
  ...rest
}, ref) {
  const base: CSSProperties = (() => {
    if (variant === 'solid')   return { background: color, border: `1px solid ${color}`, color: '#1A0A03' }
    if (variant === 'outline') return { background: 'transparent', border: `1px solid ${translucent(color)}`, color }
    return { background: 'rgba(245,241,235,0.04)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
  })()
  const sizing = size === 'lg'
    ? 'inline-flex min-h-12 items-center justify-center gap-2 px-5 t-callout'
    : 'px-4 py-2.5 t-callout'

  return (
    <button
      ref={ref}
      // m-press: transform-only press feedback (motion.css) instead of transition-all, which also eased layout.
      className={`${sizing} m-press font-ui hover:brightness-110 rounded-full disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 ${className}`}
      style={{
        fontWeight: size === 'lg' && variant === 'solid' ? 'var(--w-semibold)' : 'var(--w-medium)',
        letterSpacing: 0.2,
        ...base,
        ...externalStyle,
      }}
      {...rest}
    >
      {children}
    </button>
  )
})
