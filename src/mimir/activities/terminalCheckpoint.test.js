import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

function createTerminal(cols, rows) {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 100,
    allowProposedApi: true,
  })
  const serializer = new SerializeAddon()
  terminal.loadAddon(new Unicode11Addon())
  terminal.loadAddon(serializer)
  terminal.unicode.activeVersion = '11'
  return { terminal, serializer }
}

function write(terminal, value) {
  return new Promise((resolve) => terminal.write(value, resolve))
}

function bufferState(terminal) {
  const read = (buffer) => ({
    type: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    lines: Array.from({ length: buffer.length }, (_, index) => (
      buffer.getLine(index)?.translateToString(false) || ''
    )),
  })
  return {
    active: terminal.buffer.active.type,
    normal: read(terminal.buffer.normal),
    alternate: read(terminal.buffer.alternate),
  }
}

describe('terminal checkpoint compatibility', () => {
  it('round-trips Unicode, color, cursor, OSC 8, scrollback, and alternate-buffer state', async () => {
    const source = createTerminal(20, 5)
    await write(source.terminal, [
      'first\r\nsecond\r\nthird\r\nfourth\r\nfifth\r\n',
      '🙂 e\u0301 \u001b[31mred\u001b[0m ',
      '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
      '\u001b[2;4Hcursor',
      '\u001b[?1049halt\r\nwide 界\u001b[2;3H',
    ].join(''))
    const checkpoint = source.serializer.serialize({ scrollback: 100 })

    const restored = createTerminal(20, 5)
    await write(restored.terminal, checkpoint)

    expect(bufferState(restored.terminal)).toEqual(bufferState(source.terminal))
    source.terminal.dispose()
    restored.terminal.dispose()
  })

  it('restores at checkpoint geometry before applying later resize and output events', async () => {
    const source = createTerminal(30, 6)
    await write(source.terminal, 'before\r\n🙂 wide\r\n')
    const checkpoint = source.serializer.serialize({ scrollback: 100 })

    source.terminal.resize(18, 4)
    await write(source.terminal, '\u001b[4;1Hafter resize')

    const restored = createTerminal(30, 6)
    await write(restored.terminal, checkpoint)
    restored.terminal.resize(18, 4)
    await write(restored.terminal, '\u001b[4;1Hafter resize')

    expect(bufferState(restored.terminal)).toEqual(bufferState(source.terminal))
    source.terminal.dispose()
    restored.terminal.dispose()
  })
})
