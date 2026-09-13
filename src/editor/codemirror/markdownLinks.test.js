import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it, vi } from 'vitest'
import {
  linkDestinationForClick,
  linkDestinationAt,
  markdownLinkDestination,
  resolveMarkdownFileTarget,
} from './markdownLinks.js'

function stateFor(doc) {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
}

describe('Markdown link destinations', () => {
  it('keeps safe web URLs separate from local file targets', () => {
    expect(markdownLinkDestination('https://example.com/docs')).toEqual({
      kind: 'url',
      target: 'https://example.com/docs',
    })
    expect(markdownLinkDestination('layout-2.html')).toEqual({
      kind: 'file',
      target: 'layout-2.html',
    })
    expect(markdownLinkDestination('javascript:alert(1)')).toBeNull()
    expect(markdownLinkDestination('#components')).toBeNull()
  })

  it('routes graph URLs separately and never treats unsupported custom URLs as files', () => {
    expect(markdownLinkDestination('mimir://graph/jon')).toEqual({ kind: 'graph', target: 'jon' })
    for (const target of ['mimir://other/jon', 'mimir://graph/jon#heading', 'mimir://graph/jon?x=1', 'MIMIR://graph/jon']) {
      expect(markdownLinkDestination(target)).toBeNull()
    }
    const reference = '[Jon][person]\n\n[person]: mimir://graph/jon'
    expect(linkDestinationAt(stateFor(reference), 2)).toEqual({ kind: 'graph', target: 'jon' })
    const image = '![Jon](mimir://graph/jon)'
    expect(linkDestinationAt(stateFor(image), image.indexOf('mimir') + 2)).toBeNull()
  })

  it('recognizes a click only on the requested rendered-link class', () => {
    const doc = '[Layout](layout-2.html)'
    const state = stateFor(doc)
    const view = {
      state,
      posAtCoords: vi.fn(() => doc.indexOf('Layout') + 2),
    }
    const event = {
      button: 0,
      shiftKey: false,
      altKey: false,
      clientX: 10,
      clientY: 10,
      target: { closest: selector => (selector === '.cm-lp-link' ? {} : null) },
    }

    expect(linkDestinationForClick(event, view, '.cm-lp-link')).toEqual({
      kind: 'file',
      target: 'layout-2.html',
    })
    expect(linkDestinationForClick(event, view, '.cm-graph-link')).toBeNull()
  })
})

describe('resolveMarkdownFileTarget', () => {
  it('resolves a relative target from the Markdown file', () => {
    expect(resolveMarkdownFileTarget('../layout-2.html', {
      sourcePath: '/work/docs/README.md',
    })).toBe('/work/layout-2.html')
  })

  it('uses the workspace for an untitled Markdown draft', () => {
    expect(resolveMarkdownFileTarget('layout-library.html', {
      fallbackDirectory: '/work/project',
    })).toBe('/work/project/layout-library.html')
  })

  it('keeps absolute paths and removes a local heading fragment', () => {
    expect(resolveMarkdownFileTarget('/work/README.md#components', {
      sourcePath: '/other/note.md',
    })).toBe('/work/README.md')
    expect(resolveMarkdownFileTarget('C:\\work\\README.md', {
      sourcePath: 'C:\\other\\note.md',
    })).toBe('C:/work/README.md')
  })

  it('does not guess a base for a relative target', () => {
    expect(resolveMarkdownFileTarget('layout-2.html')).toBe('')
    expect(resolveMarkdownFileTarget('#components', {
      sourcePath: '/work/README.md',
    })).toBe('')
  })
})
