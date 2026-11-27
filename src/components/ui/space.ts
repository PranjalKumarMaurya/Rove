/**
 * The spacing steps (docs/DESIGN-SYSTEM.md §1) for the few places that set spacing
 * from script (a Collapse folding its parent's gap, a list's --fold-gap). The number
 * is the token: 4 is --space-4 (16px), as in the Tailwind classes (gap-4).
 */
export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10

export const space = (step: Space): string => (step === 0 ? '0px' : `var(--space-${step})`)
