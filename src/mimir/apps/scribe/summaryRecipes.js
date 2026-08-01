export const SUMMARY_TEMPLATE_OPTIONS = Object.freeze([
  { value: 'standard', label: 'Standard · balanced' },
  { value: 'brief', label: 'Brief · executive' },
  { value: 'decisions-actions', label: 'Decisions + actions' },
  { value: 'detailed', label: 'Detailed · chronological' },
])

export const SUMMARY_PROMPTS = Object.freeze({
  standard: 'Write a balanced meeting summary with context, decisions, action items, and open questions. Use short Markdown sections only when they improve scanning.',
  brief: 'Write a compact executive summary. Keep only the outcome, key decisions, named action items, and unresolved blockers.',
  'decisions-actions': 'Prioritize decisions and action items. Use explicit Decisions, Actions, and Open questions sections; preserve owners and dates only when the transcript states them.',
  detailed: 'Write a detailed chronological summary that preserves important reasoning, decisions, action items, risks, disagreements, and open questions without inventing facts.',
})

export function summaryPromptFor(template = 'standard') {
  return SUMMARY_PROMPTS[template] || SUMMARY_PROMPTS.standard
}

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
