import { describe, expect, it } from 'vitest'
import {
  buildInspectorSave,
  hydrateInspectorDraft,
} from './graphInspectorPersistence.js'

describe('graph inspector file properties', () => {
  it('round-trips Team resource paths with optional labels', () => {
    const node = {
      id: 'proposal-template',
      kind: 'resource',
      title: 'Proposal template',
      summary: '',
      body: '',
      tags: [],
      relations: [],
      properties: {
        files: [
          { path: 'resources/proposal.html', label: 'HTML template' },
          'resources/brand.svg',
        ],
      },
      provenance: { scopeId: 'team:main', sourceRevision: 'rev-1' },
    }
    const draft = {}
    hydrateInspectorDraft(draft, node)

    expect(draft.files).toBe(
      'resources/proposal.html | HTML template\nresources/brand.svg',
    )

    const saved = buildInspectorSave({ node, nodes: [node], draft, tags: [] })
    expect(saved.payload.setProperties.files).toEqual([
      { path: 'resources/proposal.html', label: 'HTML template' },
      { path: 'resources/brand.svg' },
    ])
  })
})
