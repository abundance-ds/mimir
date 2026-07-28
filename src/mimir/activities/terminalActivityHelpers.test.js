import { describe, expect, it, vi } from 'vitest'
import {
  eventActivityId,
  isEndedStatus,
  orderedReplayChunks,
  prepareTerminalFonts,
  readTerminalTheme,
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

  it('loads upright and italic regular and semibold faces before xterm measures', async () => {
    const load = vi.fn().mockResolvedValue([])
    await prepareTerminalFonts(13, { load })

    expect(load.mock.calls).toEqual([
      ['400 13px "IBM Plex Mono"', 'MW'],
      ['italic 400 13px "IBM Plex Mono"', 'MW'],
      ['600 13px "IBM Plex Mono"', 'MW'],
      ['italic 600 13px "IBM Plex Mono"', 'MW'],
    ])
  })

  it('uses strong default ink and keeps ANSI black dark on dark themes', () => {
    const root = document.createElement('div')
    root.style.setProperty('--color-surface', '#1e1f2e')
    root.style.setProperty('--color-chrome', '#151622')
    root.style.setProperty('--color-ink', '#f0eef8')
    root.style.setProperty('--color-ink-2', '#b8b4c8')
    root.style.setProperty('--color-ink-3', '#7e7a92')
    document.body.append(root)

    const theme = readTerminalTheme(root)
    expect(theme.foreground).toBe('#f0eef8')
    expect(theme.black).toBe('#151622')
    expect(theme.white).toBe('#b8b4c8')
    expect(theme.brightWhite).toBe('#f0eef8')
    expect(theme.scrollbarSliderBackground).toBe('#7e7a9266')
    expect(theme.scrollbarSliderHoverBackground).toBe('#b8b4c899')
    root.remove()
  })
})
