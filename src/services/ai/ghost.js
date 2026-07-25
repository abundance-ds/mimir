import { generateAiText } from './client'
import { escapePromptXml } from './context'
import { mapAiError } from './errors.js'
import { useSettingsStore } from '../../stores/settings.js'

// G5: Academic citation trigger phrases
const CITATION_TRIGGERS = [
  'as shown by',
  'according to',
  'demonstrated in',
  'demonstrated by',
  'as described by',
  'as reported by',
  'as noted by',
  'following the approach of',
  'building on',
  'consistent with',
  'in line with',
  'as proposed by',
  'as suggested by',
  'as argued by',
  'as found by',
  'as observed by',
  'previous work',
  'prior work',
  'earlier studies',
  'recent work',
  'has been shown',
  'have shown that',
  'was demonstrated',
  'were reported',
  'et al.',
]

function detectCitationContext(text) {
  if (!text) return false
  // Check the last ~120 chars of the prefix for trigger phrases
  const tail = text.slice(-120).toLowerCase()
  return CITATION_TRIGGERS.some(trigger => tail.includes(trigger))
}

export async function requestGhostSuggestions({ before, after, documentId, fallback = [] }) {
  const citationHint = detectCitationContext(before)
    ? '\n- The user appears to be citing. Suggest a citation in [@key] format if appropriate, e.g. " [@authorYear]" or " [@key]".'
    : ''

  const system = `You are the inline completion engine for mim terminal editor.

Return JSON only:
{
  "suggestions": ["...", "...", "..."]
}

Rules:
- Predict text at <cursor/> that fits naturally between <prefix> and <suffix>.
- Match the writer's style and register.
- Include leading whitespace or newlines when needed.
- Return 3 to 5 suggestions.
- Each suggestion should be 1 word to 3 sentences.
- Do not repeat text that already appears in <suffix>.
- Do not invent facts; use placeholders such as [citation], [value], or [source] when needed.${citationHint}`

  const user = `<prefix>${escapePromptXml(before)}</prefix>
<cursor/>
<suffix>${escapePromptXml(after)}</suffix>`

  try {
    const settings = useSettingsStore()
    const ghostModel = settings.aiGhostModel
    const result = await generateAiText({
      feature: 'ghost',
      modelId: ghostModel || undefined,
      documentId,
      system,
      messages: [{ role: 'user', content: user }],
      responseFormat: 'json',
      maxOutputTokens: 700,
      temperature: 0.35,
    })
    const suggestions = result.json?.suggestions
    const clean = cleanSuggestions(suggestions)
    if (clean.length) {
      return {
        suggestions: clean,
        result,
      }
    }
    return { suggestions: fallback, result }
  } catch (error) {
    const mapped = mapAiError(error)
    if (mapped.kind === 'auth') {
      return { suggestions: [], error: mapped.message }
    }
    return { suggestions: fallback, error }
  }
}

function cleanSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return []
  const seen = new Set()
  const clean = []
  for (const item of suggestions) {
    if (typeof item !== 'string') continue
    const normalized = item.replace(/\r\n/g, '\n')
    if (!normalized.trim()) continue
    const key = normalized.trim()
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(normalized)
  }
  return clean.slice(0, 5)
}
