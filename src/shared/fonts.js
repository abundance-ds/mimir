export const EDITOR_FONTS = [
  { key: 'sans',  label: 'Sans',  family: "'Inter', ui-sans-serif, system-ui, sans-serif" },
  { key: 'serif', label: 'Serif', family: "'Lora', Georgia, serif" },
  { key: 'mono',  label: 'Mono',  family: "'JetBrains Mono', ui-monospace, monospace" },
  { key: 'slab',  label: 'Slab',  family: "'Zilla Slab', Georgia, serif" },
]

const fontMap = Object.fromEntries(EDITOR_FONTS.map(f => [f.key, f.family]))

export function fontFamilyForKey(key) {
  return fontMap[key] || fontMap.mono
}
