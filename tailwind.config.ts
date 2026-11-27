import type { Config } from 'tailwindcss'

const SPACE = {
  0: '0px',
  px: '1px',
  1: 'var(--space-1)',
  2: 'var(--space-2)',
  3: 'var(--space-3)',
  4: 'var(--space-4)',
  5: 'var(--space-5)',
  6: 'var(--space-6)',
  8: 'var(--space-8)',
  10: 'var(--space-10)',
}

const SIZES = {
  tap: 'var(--tap)',
  field: 'var(--field-h)',
  button: 'var(--button-h)',
  'button-lg': 'var(--button-h-lg)',
  'button-sm': 'var(--button-h-sm)',
  'icon-sm': 'var(--icon-sm)',
  'icon-md': 'var(--icon-md)',
  'icon-lg': 'var(--icon-lg)',
  'avatar-sm': 'var(--avatar-sm)',
  'avatar-md': 'var(--avatar-md)',
  'avatar-lg': 'var(--avatar-lg)',
}

export default {
  // `relative` resolves these globs from this config file, so styles work whatever directory Vite starts in.
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    // Type comes from the roles in src/styles/type.css (.t-body, .t-footnote …), not Tailwind's
    // text-sm/text-xs sizes; these aliases follow the same tokens if a utility is ever needed.
    fontSize: {
      caption: ['var(--type-caption)', 'var(--lh-caption)'],
      footnote: ['var(--type-footnote)', 'var(--lh-footnote)'],
      callout: ['var(--type-callout)', 'var(--lh-callout)'],
      body: ['var(--type-body)', 'var(--lh-body)'],
      headline: ['var(--type-headline)', 'var(--lh-headline)'],
    },
    // 400 / 500 / 600 only, each raised by Bold text (--weight-boost).
    fontWeight: {
      normal: 'var(--w-regular)',
      medium: 'var(--w-medium)',
      semibold: 'var(--w-semibold)',
      bold: 'var(--w-semibold)',
    },
    // Spacing (docs/DESIGN-SYSTEM.md §1): padding, margin and gap take only the token
    // steps, and the number is the token (p-4 = --space-4 = 16px). Off-grid steps
    // (p-1.5, gap-7, mt-0.5, p-[13px]…) are not generated, so they cannot creep back in.
    padding: SPACE,
    margin: { auto: 'auto', ...SPACE },
    gap: SPACE,
    space: SPACE,
    scrollPadding: SPACE,
    scrollMargin: SPACE,
    // Radii (§3): the token names; there is no Tailwind default radius.
    borderRadius: {
      none: '0px',
      sm: 'var(--radius-sm)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-xl)',
      full: 'var(--radius-pill)',
    },
    extend: {
      // Sizes (§2): min-h-tap, h-field, min-h-button, w-icon-md, size-avatar-sm …
      spacing: SIZES,
      fontFamily: {
        display: ['var(--font-display)'],
        ui: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
} satisfies Config
