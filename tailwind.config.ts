import type { Config } from 'tailwindcss'

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
    extend: {
      fontFamily: {
        display: ['var(--font-display)'],
        ui: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
} satisfies Config
