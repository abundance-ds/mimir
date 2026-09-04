import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesDirectory = dirname(fileURLToPath(import.meta.url))
const themesSource = readFileSync(join(stylesDirectory, 'themes.css'), 'utf8')
const appSource = readFileSync(join(stylesDirectory, 'app.css'), 'utf8')

const themeTokens = Object.fromEntries(
  [...themesSource.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)]
    .map(([, name, block]) => [name, colorTokens(block)]),
)

function colorTokens(block) {
  return Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6})/gi)]
      .map(([, name, value]) => [name, value]),
  )
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(channel => (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    ))
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2])
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const light = Math.max(firstLuminance, secondLuminance)
  const dark = Math.min(firstLuminance, secondLuminance)
  return (light + 0.05) / (dark + 0.05)
}

const SYNTAX_TOKENS = ['editor-heading', 'syntax-keyword', 'syntax-property', 'syntax-string', 'syntax-number', 'syntax-tag']

const syntaxTokensByTheme = Object.fromEntries(
  [...themesSource.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)]
    .map(([, name, block]) => [name, Object.fromEntries(
      [...block.matchAll(/--(editor-heading|syntax-[a-z]+):\s*(#[\da-f]{6})/gi)]
        .map(([, token, value]) => [token, value]),
    )]),
)

describe('theme text contrast', () => {
  it('keeps editor syntax colours legible on the editor paper', () => {
    for (const [theme, tokens] of Object.entries(themeTokens)) {
      for (const token of SYNTAX_TOKENS) {
        const value = syntaxTokensByTheme[theme]?.[token]
        expect(value, `${theme} defines ${token}`).toMatch(/^#[\da-f]{6}$/i)
        expect(
          contrastRatio(value, tokens.surface),
          `${theme} ${token} against surface`,
        ).toBeGreaterThanOrEqual(5)
      }
    }
  })


  it('keeps quiet metadata readable against every theme surface', () => {
    expect(Object.keys(themeTokens)).toEqual([
      'parchment',
      'studio',
      'glacier',
      'slate',
      'monokai',
      'dracula',
      'zenith',
      'synthwave',
    ])

    for (const [theme, tokens] of Object.entries(themeTokens)) {
      for (const surface of ['chrome', 'chrome-mid', 'chrome-high', 'surface']) {
        expect(
          contrastRatio(tokens['ink-3'], tokens[surface]),
          `${theme} ink-3 against ${surface}`,
        ).toBeGreaterThanOrEqual(5)
        expect(
          contrastRatio(tokens['ink-4'], tokens[surface]),
          `${theme} ink-4 against ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the default Tailwind text hierarchy aligned with Parchment', () => {
    const defaultBlock = appSource.match(/@theme\s*\{([^}]*)\}/)?.[1] || ''
    const defaults = colorTokens(defaultBlock)
    expect(defaults['ink-3']).toBe(themeTokens.parchment['ink-3'])
    expect(defaults['ink-4']).toBe(themeTokens.parchment['ink-4'])
  })
})
