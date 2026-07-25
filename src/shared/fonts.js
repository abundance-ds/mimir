export const EDITOR_FONTS = [
  { key: 'sans',  label: 'Sans',  family: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif" },
  { key: 'serif', label: 'Serif', family: "'IBM Plex Serif', Georgia, serif" },
  { key: 'mono',  label: 'Mono',  family: "'IBM Plex Mono', ui-monospace, monospace" },
]

const fontMap = Object.fromEntries(EDITOR_FONTS.map(f => [f.key, f.family]))

export function fontFamilyForKey(key) {
  return fontMap[key] || fontMap.mono
}
