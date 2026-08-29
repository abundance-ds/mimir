import { describe, expect, it } from 'vitest'
import { readableTranscriptEntries } from './transcriptPresentation.js'

describe('readableTranscriptEntries', () => {
  it('groups adjacent final fragments from one speaker into bounded utterances', () => {
    const entries = readableTranscriptEntries([
      { id: 's1', text: 'The contract is', startMs: 0, endMs: 2_000, channel: 'system', speaker: 'Others', final: true, revision: 1 },
      { id: 's2', text: 'ready for review.', startMs: 2_000, endMs: 4_000, channel: 'system', speaker: 'Others', final: true, revision: 1 },
      { id: 's3', text: 'Good.', startMs: 4_000, endMs: 5_000, channel: 'microphone', speaker: 'You', final: true, revision: 1 },
    ])

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      text: 'The contract is ready for review.',
      startMs: 0,
      endMs: 4_000,
      sourceSegmentIds: ['s1', 's2'],
    })
    expect(entries[1].text).toBe('Good.')
  })

  it('keeps partials, channel changes, capture gaps, and long turns separate', () => {
    const entries = readableTranscriptEntries([
      { id: 's1', text: 'First', startMs: 0, endMs: 1_000, channel: 'microphone', speaker: 'You', final: true, revision: 1 },
      { id: 's2', text: 'draft', startMs: 1_000, endMs: 2_000, channel: 'microphone', speaker: 'You', final: false, revision: 2 },
      { id: 's3', text: 'After gap', startMs: 4_000, endMs: 5_000, channel: 'microphone', speaker: 'You', final: true, revision: 1 },
      { id: 's4', text: 'Much later', startMs: 40_000, endMs: 41_000, channel: 'microphone', speaker: 'You', final: true, revision: 1 },
    ], [
      { channel: 'microphone', startMs: 2_000, endMs: 3_500, reason: 'device-restart' },
    ])

    expect(entries.map(entry => entry.kind)).toEqual([
      'segment',
      'segment',
      'gap',
      'segment',
      'segment',
    ])
  })
})
