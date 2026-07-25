import { describe, expect, it } from 'vitest'
import {
  eventActivityId,
  isEndedStatus,
  orderedReplayChunks,
  terminalBytes,
  terminalStatusLabel,
} from './terminalActivity.js'

describe('terminal activity byte and lifecycle helpers', () => {
  it('encodes strings as UTF-8 and preserves raw byte views', () => {
    expect(Array.from(terminalBytes('🙂'))).toEqual([240, 159, 153, 130])
    const raw = Uint8Array.of(0xff, 0x00)
    expect(terminalBytes(raw)).toBe(raw)
  })

  it('normalizes lifecycle labels and event field names', () => {
    expect(isEndedStatus('interrupted')).toBe(true)
    expect(isEndedStatus('idle')).toBe(false)
    expect(terminalStatusLabel('needs-input')).toBe('Input')
    expect(eventActivityId({ activityId: 'new' })).toBe('new')
    expect(eventActivityId({ activity_id: 'legacy' })).toBe('legacy')
  })

  it('orders replay by backend sequence without mutating the snapshot', () => {
    const snapshot = {
      scrollback: {
        chunks: [
          { sequence: 2, bytes: [2] },
          { sequence: 1, bytes: [1] },
        ],
      },
    }
    expect(orderedReplayChunks(snapshot).map((chunk) => chunk.sequence)).toEqual([1, 2])
    expect(snapshot.scrollback.chunks[0].sequence).toBe(2)
  })
})
