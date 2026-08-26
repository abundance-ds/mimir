import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  linkDestinationAt,
  linkDestinationForClick,
  linkTargetAt,
} from './markdownLinkOpen.js'

function stateFor(doc) {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  })
}

function targetInside(doc, needle) {
  const state = stateFor(doc)
  const index = doc.indexOf(needle)
  expect(index).toBeGreaterThanOrEqual(0)
  return linkTargetAt(state, index + Math.floor(needle.length / 2))
}

function destinationInside(doc, needle) {
  const state = stateFor(doc)
  const index = doc.indexOf(needle)
  expect(index).toBeGreaterThanOrEqual(0)
  return linkDestinationAt(state, index + Math.floor(needle.length / 2))
}

describe('linkTargetAt', () => {
  it('resolves the destination from a click on the label or the target', () => {
    const doc = 'See [the evidence map](outputs/evidence-map.md) for details.'
    expect(targetInside(doc, 'the evidence map')).toBe('outputs/evidence-map.md')
    expect(targetInside(doc, 'outputs/evidence-map.md')).toBe('outputs/evidence-map.md')
  })

  it('resolves image sources', () => {
    expect(targetInside('![chart](assets/chart.png)', 'chart]')).toBe('assets/chart.png')
  })

  it('strips angle brackets and decodes percent-escapes', () => {
    expect(targetInside('[deck](<outputs/final deck.pdf>)', 'final deck')).toBe('outputs/final deck.pdf')
    expect(targetInside('[map](outputs/evidence%20map.xlsx)', 'evidence%20map')).toBe('outputs/evidence map.xlsx')
  })

  it('returns null for external URLs, anchors, and plain text', () => {
    expect(targetInside('[site](https://example.com/x)', 'https://example.com')).toBeNull()
    expect(targetInside('[mail](mailto:a@b.c)', 'mailto')).toBeNull()
    expect(targetInside('Autolink <https://example.com> here', 'https://example.com')).toBeNull()
    expect(targetInside('[jump](#section)', '#section')).toBeNull()
    expect(targetInside('plain text only', 'text')).toBeNull()
    expect(targetInside('[empty]()', 'empty')).toBeNull()
  })

  it('keeps Windows-absolute paths as file targets', () => {
    expect(targetInside('[report](C:\\reports\\q4.pdf)', 'C:\\reports')).toBe('C:\\reports\\q4.pdf')
  })

  it('resolves safe web URLs without treating them as files', () => {
    expect(destinationInside('https://example.com/docs', 'example.com')).toEqual({
      kind: 'url',
      target: 'https://example.com/docs',
    })
    expect(destinationInside('[site](http://example.com)', 'site')).toEqual({
      kind: 'url',
      target: 'http://example.com/',
    })
    expect(destinationInside('<https://example.com/help>', 'example.com')).toEqual({
      kind: 'url',
      target: 'https://example.com/help',
    })
    expect(destinationInside('[unsafe](javascript:alert(1))', 'unsafe')).toBeNull()
  })

  it('opens only a direct click on highlighted link text', () => {
    const doc = 'Read https://example.com/docs then edit here.'
    const state = stateFor(doc)
    const view = {
      state,
      posAtCoords: () => doc.indexOf('example.com') + 2,
    }
    const event = {
      button: 0,
      shiftKey: false,
      altKey: false,
      clientX: 10,
      clientY: 10,
      target: { closest: selector => (selector === '.cm-graph-link' ? {} : null) },
    }

    expect(linkDestinationForClick(event, view)).toEqual({
      kind: 'url',
      target: 'https://example.com/docs',
    })
    expect(linkDestinationForClick({
      ...event,
      target: { closest: () => null },
    }, view)).toBeNull()
    expect(linkDestinationForClick({ ...event, shiftKey: true }, view)).toBeNull()
  })
})
