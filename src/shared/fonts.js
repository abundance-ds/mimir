export const SYSTEM_SANS_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
export const SYSTEM_MONO_FONT_STACK = 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export const EDITOR_FONTS = [
  { key: 'sans', label: 'Sans', family: SYSTEM_SANS_FONT_STACK },
  { key: 'mono', label: 'Mono', family: SYSTEM_MONO_FONT_STACK },
]

const fontMap = Object.fromEntries(EDITOR_FONTS.map(f => [f.key, f.family]))

export function fontFamilyForKey(key) {
  // Serif was removed from the product. Preserve a readable migration path
  // for an older saved preference without rendering a serif fallback.
  if (key === 'serif') return fontMap.sans
  return fontMap[key] || fontMap.mono
}
