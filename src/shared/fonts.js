export const SYSTEM_SANS_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
export const SYSTEM_MONO_FONT_STACK = 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace'
export const COMMIT_MONO_FONT_STACK = '"Commit Mono", ' + SYSTEM_MONO_FONT_STACK

export const EDITOR_LINE_HEIGHT_RATIO = 1.35
export const EDITOR_LIGHT_FONT_WEIGHT = 450
export const EDITOR_DARK_FONT_WEIGHT = 400

export const EDITOR_FONTS = [
  { key: 'mono', label: 'Commit Mono', family: COMMIT_MONO_FONT_STACK },
  { key: 'system-mono', label: 'System Mono', family: SYSTEM_MONO_FONT_STACK },
  { key: 'sans', label: 'Sans', family: SYSTEM_SANS_FONT_STACK },
]

const fontMap = Object.fromEntries(EDITOR_FONTS.map(f => [f.key, f.family]))

function normalizedFontKey(key) {
  if (key === 'serif') return 'sans'
  return fontMap[key] ? key : 'mono'
}

export function fontFamilyForKey(key) {
  // Serif was removed from the product. Preserve a readable migration path
  // for an older saved preference without rendering a serif fallback.
  return fontMap[normalizedFontKey(key)]
}

export function editorTypographyVars({ fontSize, zoom = 1, fontKey, dark = false }) {
  const scaledFontSize = fontSize * zoom
  const usesCommitMono = normalizedFontKey(fontKey) === 'mono'
  return {
    '--editor-size': scaledFontSize + 'px',
    '--editor-line-height': (scaledFontSize * EDITOR_LINE_HEIGHT_RATIO) + 'px',
    '--editor-font-weight': String(
      usesCommitMono && !dark ? EDITOR_LIGHT_FONT_WEIGHT : EDITOR_DARK_FONT_WEIGHT,
    ),
    '--font-mono': fontFamilyForKey(fontKey),
  }
}
