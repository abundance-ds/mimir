import { generateAiText } from './client'
import { escapePromptXml } from './context'

export async function requestSelectionRewrite({ text, instruction, contextBefore = '', contextAfter = '', documentId }) {
  const system = `You rewrite selected Markdown text inside mim terminal editor.

Return JSON only:
{
  "replacement": "...",
  "rationale": "..."
}

Rules:
- Rewrite only the selected text.
- Preserve Markdown structure unless the instruction asks to change it.
- Do not add unverifiable facts.
- Keep the replacement ready for direct insertion.
- Keep rationale to one concise sentence.`

  const user = `<instruction>${escapePromptXml(instruction) || 'improve this passage'}</instruction>
<context-before>${escapePromptXml(contextBefore)}</context-before>
<selection>${escapePromptXml(text)}</selection>
<context-after>${escapePromptXml(contextAfter)}</context-after>`

  const result = await generateAiText({
    feature: 'rewrite',
    documentId,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
    maxOutputTokens: 1400,
    temperature: 0.25,
  })

  const replacement = result.json?.replacement
  if (typeof replacement !== 'string' || replacement.trim().length === 0) {
    throw new Error('AI rewrite response did not include a replacement')
  }

  return {
    replacement,
    rationale: typeof result.json?.rationale === 'string' ? result.json.rationale : '',
    result,
  }
}

export async function requestInlineQuestion({ text, question, contextBefore = '', contextAfter = '', documentId }) {
  const system = `You answer questions about selected text in mim terminal editor.

Return JSON only:
{
  "answer": "...",
  "suggestedEdit": null
}

Rules:
- Answer the question concisely (2-4 sentences unless more detail is needed).
- If the question implies a text change, include suggestedEdit: { "oldText": "...", "newText": "..." } where oldText is a substring of the selection.
- Otherwise set suggestedEdit to null.
- Keep the answer helpful and accessible for non-technical researchers.`

  const user = `<question>${escapePromptXml(question)}</question>
<context-before>${escapePromptXml(contextBefore)}</context-before>
<selection>${escapePromptXml(text)}</selection>
<context-after>${escapePromptXml(contextAfter)}</context-after>`

  const result = await generateAiText({
    feature: 'inline-question',
    documentId,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
    maxOutputTokens: 800,
    temperature: 0.3,
  })

  const answer = result.json?.answer
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error('AI did not return an answer')
  }

  return {
    answer,
    suggestedEdit: result.json?.suggestedEdit || null,
    result,
  }
}
