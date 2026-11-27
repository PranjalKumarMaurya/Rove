import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

// Every padding, margin and gap comes from the spacing tokens (docs/DESIGN-SYSTEM.md §1).
// This reads the source: Tailwind spacing classes may use only the token steps, inline
// styles may not set spacing in px, and CSS spacing goes through var(--space-*) (or a
// documented exception marked `/* layout: why */` on the same line).

const root = new URL('../../', import.meta.url).pathname
// Legacy v1 components that nothing imports any more (AGENTS.md): not part of the app.
const LEGACY = new Set(['Avatar.tsx', 'NeonBorder.tsx', 'NeonText.tsx', 'Scanlines.tsx', 'UserChips.tsx', 'VIPBadge.tsx'])

function files(dir, extensions) {
  const out = []
  for (const name of readdirSync(join(root, dir))) {
    const path = join(root, dir, name)
    if (statSync(path).isDirectory()) out.push(...files(relative(root, path), extensions))
    else if (extensions.some((extension) => name.endsWith(extension)) && !LEGACY.has(name)) out.push(path)
  }
  return out
}

const sources = [...files('src/features', ['.tsx', '.ts']), ...files('src/components/ui', ['.tsx', '.ts'])]
const styles = [join(root, 'src/styles/global.css'), join(root, 'src/styles/motion.css'), ...files('src/features', ['.css']), ...files('src/components/ui', ['.css'])]

const SPACE_STEPS = new Set(['0', 'px', '1', '2', '3', '4', '5', '6', '8', '10'])
const SPACING_CLASS = /(?<![\w-])-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|scroll-p[xytblr]?|scroll-m[xytblr]?)-(\[[^\]]*\]|\d+(?:\.\d+)?)(?![\w.-])/gu

const where = (path, text, index) => `${relative(root, path)}:${text.slice(0, index).split('\n').length}`

test('Tailwind spacing classes use only the token steps', () => {
  const found = []
  for (const path of sources) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(SPACING_CLASS)) {
      if (!SPACE_STEPS.has(match[1])) found.push(`${where(path, text, match.index)} ${match[0]}`)
    }
  }
  assert.deepEqual(found, [], 'off-grid spacing classes (use p-1…p-10 = --space-1…--space-10)')
})

test('inline styles do not set spacing or radii in px', () => {
  const found = []
  const inline = /\b(padding|margin|gap|rowGap|columnGap|borderRadius)(Top|Bottom|Left|Right|Inline|Block|InlineStart|InlineEnd)?\s*:\s*('[^']*'|"[^"]*"|`[^`]*`|-?\d+(?:\.\d+)?)/gu
  for (const path of sources) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(inline)) {
      const value = match[3]
      if (/var\(--/u.test(value) || /^['"`]?(0|auto|0px)['"`]?$/u.test(value) || value === "'50%'") continue
      found.push(`${where(path, text, match.index)} ${match[0]}`)
    }
  }
  assert.deepEqual(found, [], 'inline spacing/radius literals (use the tokens or a class)')
})

test('CSS padding, margin and gap go through the spacing tokens', () => {
  const found = []
  const declaration = /(?<![\w-])(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?\s*:\s*([^;}\n]+);?([^\n]*)$/gmu
  for (const path of styles) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(declaration)) {
      const [, , , value, rest] = match
      if (/\/\*\s*layout:/u.test(rest)) continue
      // 0, 1px hairlines, auto, and anything built from var(--…) only.
      const literals = value.replace(/var\([^)]*\)/gu, '').match(/-?\d*\.?\d+px/gu) ?? []
      if (literals.every((literal) => ['0px', '1px', '-1px'].includes(literal))) continue
      found.push(`${where(path, text, match.index)} ${match[0].trim()}`)
    }
  }
  assert.deepEqual(found, [], 'raw px spacing in CSS (use var(--space-*) or mark `/* layout: why */`)')
})

test('Tailwind maps spacing and radii to the tokens', () => {
  const config = readFileSync(join(root, 'tailwind.config.ts'), 'utf8')
  for (const step of ['1', '2', '3', '4', '5', '6', '8', '10']) assert.match(config, new RegExp(`${step}: 'var\\(--space-${step}\\)'`, 'u'))
  for (const radius of ['sm', 'md', 'lg', 'xl']) assert.match(config, new RegExp(`${radius}: 'var\\(--radius-${radius}\\)'`, 'u'))
  const css = readFileSync(join(root, 'src/styles/global.css'), 'utf8')
  for (const token of ['--space-1', '--space-10', '--tap', '--field-h', '--button-h', '--bar-clear', '--screen-end', '--radius-lg']) {
    assert.match(css, new RegExp(`${token}:`, 'u'), `${token} is defined`)
  }
})
