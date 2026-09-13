import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import boundaries from '../../src-tauri/tests/fixtures/graph_source_boundaries.json'
import { graphSourceBodyStart } from './graphDocuments.js'

describe('Graph source completion boundary', () => {
  it.each(boundaries)('uses the native fence semantics for $name', ({ content, completionFrom }) => {
    const state = EditorState.create({ doc: content })
    // CodeMirror normalizes CRLF. The helper returns positions in this actual
    // document, while the native source contract counts the exact input text.
    const expected = content.slice(0, completionFrom).replace(/\r\n?/g, '\n').length
    expect(graphSourceBodyStart(state)).toBe(expected)
  })
})
