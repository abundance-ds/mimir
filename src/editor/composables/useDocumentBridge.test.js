import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentBridge } from './useDocumentBridge.js'

describe('useDocumentBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes only the latest scheduled document after the debounce', () => {
    const bridge = useDocumentBridge({ delay: 50 })

    bridge.schedule('old content', '/work/old.md')
    vi.advanceTimersByTime(25)
    bridge.schedule('current content', '/work/current.md')
    vi.advanceTimersByTime(49)
    expect(localStorage.getItem('mimir:doc')).toBeNull()

    vi.advanceTimersByTime(1)
    expect(localStorage.getItem('mimir:doc')).toBe('current content')
    expect(localStorage.getItem('mimir:doc:path')).toBe('/work/current.md')
  })

  it('flushes immediately and cancels pending content', () => {
    const bridge = useDocumentBridge({ delay: 50 })

    bridge.schedule('scheduled content', '/work/scheduled.md')
    bridge.flush('saved content', '/work/saved.md')
    vi.advanceTimersByTime(50)

    expect(localStorage.getItem('mimir:doc')).toBe('saved content')
    expect(localStorage.getItem('mimir:doc:path')).toBe('/work/saved.md')
  })

  it('cancels pending publication when disposed', () => {
    const bridge = useDocumentBridge({ delay: 50 })

    bridge.schedule('discarded content', '/work/discarded.md')
    bridge.dispose()
    vi.advanceTimersByTime(50)

    expect(localStorage.getItem('mimir:doc')).toBeNull()
  })
})
