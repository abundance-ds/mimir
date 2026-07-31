export const SUMMARY_TEMPLATE_OPTIONS = Object.freeze([
  { value: 'standard', label: 'Standard · balanced' },
  { value: 'brief', label: 'Brief · executive' },
  { value: 'decisions-actions', label: 'Decisions + actions' },
  { value: 'detailed', label: 'Detailed · chronological' },
])

export function summaryAgentOptions(presets = [], selected = '') {
  const options = [
    { value: '', label: 'Automatic · first available' },
    ...presets
      .filter(preset => preset?.kind === 'agent' && preset.enabled !== false && preset.available !== false)
      .map(preset => ({ value: String(preset.id), label: String(preset.title || preset.id) })),
  ]
  const current = String(selected || '')
  if (current && !options.some(option => option.value === current)) {
    options.push({ value: current, label: `${current} · unavailable` })
  }
  return options
}
