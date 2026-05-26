/**
 * Recover from poisoned tool-call messages in a Chat instance.
 *
 * Converts any tool part that would crash the pipeline to a text summary.
 * A tool part is safe only when: terminal state + object input + toolCallId.
 *
 * @param {import('@ai-sdk/vue').Chat} chat
 * @param {Error|string} [error]
 * @returns {boolean} true if recovery was attempted
 */
export function recoverPoisonedMessages(chat, error) {
  try {
    let recovered = false
    const msgs = chat.state.messagesRef.value
    const errMsg = error?.message || String(error || 'Unknown error')

    for (const msg of msgs) {
      if (msg.role !== 'assistant' || !msg.parts) continue
      for (let j = 0; j < msg.parts.length; j++) {
        const p = msg.parts[j]
        if (!p?.type?.startsWith('tool-') && p?.type !== 'dynamic-tool') continue

        const terminal = p.state === 'output-available' || p.state === 'output-error'
        const validInput = typeof p.input === 'object' && p.input !== null && !Array.isArray(p.input)

        if (!terminal || !validInput || !p.toolCallId) {
          msg.parts[j] = {
            type: 'text',
            text: `[Tool call: ${p.toolName || 'unknown'} — ${p.errorText || errMsg}]`,
          }
          recovered = true
        }
      }
    }

    return recovered
  } catch (cleanupErr) {
    console.warn('[recovery] Failed to recover from broken tool call:', cleanupErr)
    return false
  }
}
