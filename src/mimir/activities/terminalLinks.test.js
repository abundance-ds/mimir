import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  createTerminalLinkProvider,
  findTerminalFileReferences,
  resolveTerminalFileReference,
} from './terminalLinks.js'

describe('terminalLinks', () => {
  it('finds relative and absolute file references with source locations', () => {
    expect(findTerminalFileReferences(
      'Read src/mimir/App.vue:42:8 and /work/docs/README.md#L9C2.',
    )).toMatchObject([
      {
        path: 'src/mimir/App.vue',
        line: 42,
        column: 8,
      },
      {
        path: '/work/docs/README.md',
        line: 9,
        column: 2,
      },
    ])
  })

  it.each([
    [
      '"src/mimir/activities/TerminalActivity.vue:239"',
      'src/mimir/activities/TerminalActivity.vue',
      239,
      null,
    ],
    [
      'See src/mimir/activities/TerminalActivity.vue:239, then fix it.',
      'src/mimir/activities/TerminalActivity.vue',
      239,
      null,
    ],
    [
      '/Users/me/project/src/TerminalActivity.vue:239:12',
      '/Users/me/project/src/TerminalActivity.vue',
      239,
      12,
    ],
    [
      './src/mimir/activities/TerminalActivity.vue',
      './src/mimir/activities/TerminalActivity.vue',
      null,
      null,
    ],
    [
      '/Users/me/project/TerminalActivityWithAVeryLongName.vue:',
      '/Users/me/project/TerminalActivityWithAVeryLongName.vue',
      null,
      null,
    ],
  ])('handles a CLI file-reference corpus case: %s', (input, path, line, column) => {
    expect(findTerminalFileReferences(input)).toMatchObject([{ path, line, column }])
  })

  it('finds a file target inside a Markdown link without linking the label', () => {
    expect(findTerminalFileReferences('[App](/work/src/App.vue:12)')).toMatchObject([
      {
        text: '/work/src/App.vue:12',
        path: '/work/src/App.vue',
        line: 12,
      },
    ])
  })

  it('does not treat web URLs, versions, or ordinary prose as files', () => {
    expect(findTerminalFileReferences(
      'Use https://example.com/docs with vue@3.5.24 and ordinary words.',
    )).toEqual([])
  })

  it('resolves relative, parent, home, and file URL paths', () => {
    expect(resolveTerminalFileReference({ path: 'src/App.vue' }, '/work/project'))
      .toBe('/work/project/src/App.vue')
    expect(resolveTerminalFileReference({ path: '../README.md' }, '/work/project/src'))
      .toBe('/work/project/README.md')
    expect(resolveTerminalFileReference({ path: '~/notes.md' }, '/work', '/Users/me'))
      .toBe('/Users/me/notes.md')
    expect(resolveTerminalFileReference({ path: 'file:///work/My%20File.md' }, '/unused'))
      .toBe('/work/My File.md')
  })

  it('links a file reference across xterm visual wraps', async () => {
    const terminal = mockTerminal([
      { text: 'src/mimir/activity/A', isWrapped: false },
      { text: 'pp.vue:7', isWrapped: true },
    ], 20)
    const onOpenFile = vi.fn()
    const provider = createTerminalLinkProvider(terminal, {
      baseDirectory: '/work',
      onOpenFile,
    })

    const links = await provide(provider, 2)
    expect(links).toHaveLength(1)
    expect(links[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 8, y: 2 },
    })

    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/work/src/mimir/activity/App.vue',
      line: 7,
    }))
  })

  it('provides a clickable range from the real xterm buffer', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 })
    await writeTerminal(terminal, 'src/mimir/activities/TerminalActivity.vue:239\r\n')
    const onOpenFile = vi.fn()
    const provider = createTerminalLinkProvider(terminal, {
      baseDirectory: '/work',
      onOpenFile,
    })

    const links = await provide(provider, 1)
    expect(links).toHaveLength(1)
    expect(links[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 45, y: 1 },
    })

    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/work/src/mimir/activities/TerminalActivity.vue',
      line: 239,
    }))
  })

  it('recovers an indented file reference split after a slash', async () => {
    const terminal = mockTerminal([
      { text: 'See src/mimir/activities/' },
      { text: '  TerminalActivity.vue:239' },
    ])
    const onOpenFile = vi.fn()
    const provider = createTerminalLinkProvider(terminal, {
      baseDirectory: '/work',
      onOpenFile,
    })

    const links = await provide(provider, 2)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe('src/mimir/activities/TerminalActivity.vue:239')

    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/work/src/mimir/activities/TerminalActivity.vue',
      line: 239,
    }))
  })

  it('recovers a file reference split across three physical lines', async () => {
    const terminal = mockTerminal([
      { text: 'See src/mimir/' },
      { text: '  activities/' },
      { text: '  TerminalActivity.vue:239' },
    ])
    const onOpenFile = vi.fn()
    const provider = createTerminalLinkProvider(terminal, {
      baseDirectory: '/work',
      onOpenFile,
    })

    const links = await provide(provider, 3)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe('src/mimir/activities/TerminalActivity.vue:239')

    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/work/src/mimir/activities/TerminalActivity.vue',
      line: 239,
    }))
  })

  it('recovers an indented web URL split after a slash', async () => {
    const terminal = mockTerminal([
      { text: 'Open https://example.com/a/' },
      { text: '  long/page' },
    ])
    const onOpenUrl = vi.fn()
    const provider = createTerminalLinkProvider(terminal, { onOpenUrl })

    const links = await provide(provider, 2)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe('https://example.com/a/long/page')

    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/a/long/page')
  })

  it('does not join an unindented line after a path fragment', async () => {
    const terminal = mockTerminal([
      { text: 'Generated docs/' },
      { text: 'README.md is ready' },
    ])
    const provider = createTerminalLinkProvider(terminal, {
      baseDirectory: '/work',
    })

    const links = await provide(provider, 2)
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe('README.md')
  })
})

function provide(provider, line) {
  return new Promise(resolve => provider.provideLinks(line, resolve))
}

function writeTerminal(terminal, value) {
  return new Promise(resolve => terminal.write(value, resolve))
}

function mockTerminal(lines, columns = 120) {
  const bufferLines = lines.map(line => mockBufferLine(line.text, columns, line.isWrapped))
  return {
    cols: columns,
    buffer: {
      active: {
        getLine(index) {
          return bufferLines[index]
        },
        getNullCell() {
          return mockCell()
        },
      },
    },
  }
}

function mockBufferLine(text, columns, isWrapped = false) {
  return {
    isWrapped,
    length: columns,
    translateToString() {
      return text
    },
    getCell(index, cell) {
      cell.chars = index < text.length ? text[index] : ''
      cell.width = 1
      return cell
    },
  }
}

function mockCell() {
  return {
    chars: '',
    width: 1,
    getChars() {
      return this.chars
    },
    getWidth() {
      return this.width
    },
  }
}
