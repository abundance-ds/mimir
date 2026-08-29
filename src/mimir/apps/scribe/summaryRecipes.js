export const SUMMARY_TEMPLATE_OPTIONS = Object.freeze([
  { value: 'standard', label: 'Standard · balanced' },
  { value: 'brief', label: 'Brief · executive' },
  { value: 'decisions-actions', label: 'Decisions + actions' },
])

export const SUMMARY_PROMPTS = Object.freeze({
  standard: 'Use the BLUF approach. Return a concise Markdown document. Use these sections in order: # BLUF, # Key points, and # Follow-up. Under # BLUF, write one short paragraph of one or two sentences that states the outcome or direction. Under # Key points, write short flat bullets for only the essential decisions, facts, constraints, or risks. Under # Follow-up, combine actions, open questions, and blockers in one flat list; start each bullet with a useful bold cue such as **Action — Paul:**, **Open:**, or **Blocker:**. Omit # Follow-up when nothing useful belongs there. Prefer more short bullets over fewer long bullets. Keep each bullet to one sentence and at most 25 words. Do not repeat information across sections. Document height is not a target; achieve concision by selecting useful information, not by flattening structure. Read the user notes with judgment: use useful facts, questions, decisions, actions, or context; ignore noise or memory aids that add nothing.',
  brief: 'Use the BLUF approach. Return a short Markdown document with # BLUF and # Key points, plus # Follow-up only when needed. BLUF is one sentence. Key points contain 2 to 4 short flat bullets. Follow-up combines only critical actions, open questions, or blockers; label each with **Action — Name:**, **Open:**, or **Blocker:**. Keep each bullet to one sentence and at most 20 words. Prefer more short bullets over fewer long bullets. Do not repeat information. Read the user notes with judgment.',
  'decisions-actions': 'Use the BLUF approach. Return a concise Markdown document with # BLUF and # Decisions and follow-up. BLUF is one short paragraph. Combine decisions, actions, open questions, and blockers in one flat list; label each bullet with **Decision:**, **Action — Name:**, **Open:**, or **Blocker:**. Keep each bullet to one sentence and at most 25 words. Prefer more short bullets over fewer long bullets. Preserve owners and dates only when stated. Do not repeat information. Read the user notes with judgment.',
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
