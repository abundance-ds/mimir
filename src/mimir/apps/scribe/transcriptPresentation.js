const MAX_UTTERANCE_GAP_MS = 1_500
const MAX_UTTERANCE_DURATION_MS = 30_000

export function readableTranscriptEntries(segments = [], gaps = []) {
  const entries = [
    ...segments.map(segment => ({
      ...segment,
      kind: 'segment',
      key: `segment:${segment.id}:${segment.revision}`,
      sourceSegmentIds: [segment.id],
    })),
    ...gaps.map((gap, index) => ({
      ...gap,
      kind: 'gap',
      key: `gap:${gap.channel}:${gap.startMs}:${gap.endMs}:${index}`,
    })),
  ].sort((left, right) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs
    if (left.kind !== right.kind) return left.kind === 'gap' ? -1 : 1
    return left.key.localeCompare(right.key)
  })

  const readable = []
  for (const entry of entries) {
    const previous = readable.at(-1)
    if (!canMergeSegments(previous, entry)) {
      readable.push(entry)
      continue
    }
    previous.endMs = Math.max(previous.endMs, entry.endMs)
    previous.text = `${previous.text.trim()} ${entry.text.trim()}`.trim()
    previous.revision = Math.max(previous.revision || 0, entry.revision || 0)
    previous.sourceSegmentIds.push(...entry.sourceSegmentIds)
    previous.key = `utterance:${previous.sourceSegmentIds[0]}:${entry.id}:${previous.revision}`
  }
  return readable
}

function canMergeSegments(previous, next) {
  if (previous?.kind !== 'segment' || next.kind !== 'segment') return false
  if (!previous.final || !next.final) return false
  if (previous.channel !== next.channel) return false
  if ((previous.speaker || '') !== (next.speaker || '')) return false
  if (next.startMs < previous.startMs) return false
  if (next.startMs - previous.endMs > MAX_UTTERANCE_GAP_MS) return false
  return Math.max(previous.endMs, next.endMs) - previous.startMs <= MAX_UTTERANCE_DURATION_MS
}
