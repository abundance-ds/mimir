import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { createTerminalResizeAnchor } from './terminalResizeAnchor.js'

let frames
let nextFrame
let terminals
let anchors

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  terminals = []
  anchors = []
  vi.stubGlobal('requestAnimationFrame', callback => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
})

afterEach(() => {
  for (const anchor of anchors) anchor.dispose()
  for (const terminal of terminals) terminal.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function flushFrame() {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback()
}

function write(terminal, value) {
  return new Promise(resolve => terminal.write(value, resolve))
}

function transcript(count = 200) {
  return Array.from({ length: count }, (_, index) => (
    `line ${String(index).padStart(3, '0')} ${'sample '.repeat(index % 10 + 3)}\r\n`
  )).join('')
}

function topText(terminal) {
  const buffer = terminal.buffer.active
  return buffer.getLine(buffer.viewportY).translateToString(true)
}

async function setup({ cols = 80, rows = 24, scrollback = 10000, text = transcript() } = {}) {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  const anchor = createTerminalResizeAnchor(terminal)
  terminals.push(terminal)
  anchors.push(anchor)
  await write(terminal, text)
  return { terminal, anchor }
}

describe('terminal resize reading position (real xterm)', () => {
  it('keeps the same logical line through width and height changes', async () => {
    const { terminal, anchor } = await setup()
    terminal.scrollToLine(109)
    const expected = topText(terminal)
    expect(expected).toContain('line 091')
    anchor.begin()

    for (const [cols, rows] of [[50, 24], [110, 24], [110, 40], [65, 18]]) {
      anchor.begin()
      terminal.resize(cols, rows)
      anchor.applied(true)
      flushFrame()
      expect(topText(terminal)).toBe(expected)
      expect(terminal.markers).toHaveLength(1)
    }
  })

  it('anchors the start of a wrapped line so wider columns do not delete its marker', async () => {
    const { terminal, anchor } = await setup({
      cols: 40,
      text: Array.from({ length: 100 }, (_, i) => `${i}: ${'界🙂e\u0301 '.repeat(20)}\r\n`).join(''),
    })
    const buffer = terminal.buffer.active
    let line = Math.floor(buffer.baseY / 2)
    while (buffer.getLine(line).isWrapped) line -= 1
    terminal.scrollToLine(line + 2)
    anchor.begin()
    terminal.resize(100, 24)
    anchor.applied(true)
    flushFrame()
    expect(terminal.markers[0].isDisposed).toBe(false)
    expect(buffer.viewportY).toBe(terminal.markers[0].line)
    expect(topText(terminal)).toMatch(/^\d+: 界🙂é /)
  })

  it('keeps the bottom through a delayed redraw in multiple writes', async () => {
    const { terminal, anchor } = await setup()
    anchor.begin()
    terminal.resize(50, 30)
    anchor.applied(true)
    flushFrame()
    await write(terminal, '\x1b[3J\x1b[H\x1b[2J')
    anchor.applied()
    flushFrame()
    for (let index = 0; index < 3; index += 1) {
      await write(terminal, transcript(50))
      anchor.applied()
      flushFrame()
      expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
    }
    expect(terminal.markers).toHaveLength(0)
  })

  it('keeps the original percentage when a redraw clears history during repeated resize', async () => {
    const { terminal, anchor } = await setup()
    terminal.scrollToLine(109)
    const fraction = terminal.buffer.active.viewportY / terminal.buffer.active.baseY
    anchor.begin()
    terminal.resize(50, 24)
    anchor.applied(true)
    flushFrame()
    await write(terminal, '\x1b[3J\x1b[H\x1b[2J')
    anchor.applied()
    flushFrame()
    expect(terminal.markers).toHaveLength(0)

    anchor.begin()
    terminal.resize(60, 24)
    anchor.applied(true)
    for (let index = 0; index < 3; index += 1) {
      await write(terminal, transcript(70))
      anchor.applied()
      flushFrame()
      const buffer = terminal.buffer.active
      expect(buffer.viewportY).toBe(Math.round(fraction * buffer.baseY))
    }
  })

  it('leaves the user position alone after cancellation, including pending frames', async () => {
    const { terminal, anchor } = await setup()
    terminal.scrollToLine(80)
    anchor.begin()
    terminal.resize(50, 24)
    anchor.applied(true)
    anchor.cancel()
    terminal.scrollToLine(25)
    await write(terminal, transcript(10))
    anchor.applied()
    flushFrame()
    expect(terminal.buffer.active.viewportY).toBe(25)
    expect(terminal.markers).toHaveLength(0)
  })

  it('does not anchor alternate screens and cancels when the buffer changes', async () => {
    const { terminal, anchor } = await setup()
    terminal.scrollToLine(80)
    anchor.begin()
    await write(terminal, '\x1b[?1049h')
    anchor.begin()
    terminal.resize(50, 24)
    anchor.applied(true)
    flushFrame()
    expect(terminal.buffer.active.type).toBe('alternate')
    await write(terminal, '\x1b[?1049l')
    terminal.scrollToLine(25)
    anchor.applied()
    flushFrame()
    expect(terminal.buffer.active.viewportY).toBe(25)
    expect(terminal.markers).toHaveLength(0)
  })

  it('coalesces output into one frame and expires even while output continues', async () => {
    const { terminal, anchor } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    terminal.scrollToLine(80)
    const scroll = vi.spyOn(terminal, 'scrollToLine')
    anchor.begin()
    anchor.applied(true)
    for (let index = 0; index < 100; index += 1) anchor.applied()
    expect(frames.size).toBe(1)
    flushFrame()
    expect(scroll).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(900)
    anchor.applied()
    vi.advanceTimersByTime(100)
    expect(frames.size).toBe(0)
    expect(terminal.markers).toHaveLength(0)
    anchor.applied()
    flushFrame()
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('uses bounded work for a very long wrapped line and survives scrollback trimming', async () => {
    const { terminal, anchor } = await setup({ scrollback: 200, text: 'word '.repeat(4000) })
    terminal.scrollToLine(100)
    const getLine = vi.spyOn(terminal.buffer.active, 'getLine')
    anchor.begin()
    expect(getLine.mock.calls.length).toBeLessThanOrEqual(65)
    expect(terminal.markers).toHaveLength(0)
    terminal.resize(40, 24)
    await write(terminal, transcript(100))
    anchor.applied(true)
    flushFrame()
    expect(terminal.buffer.active.viewportY).toBe(100)
  })
})
