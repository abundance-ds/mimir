import { describe, expect, it } from 'vitest'
import { defaultGraphWriteScope } from './businessGraphScopes.js'

const scopes = [
  { id: 'private:local', kind: 'private' },
  { id: 'project:alpha', kind: 'project' },
  { id: 'team:main', kind: 'team' },
]

describe('business graph scope policy', () => {
  it.each(['company', 'person', 'project', 'issue', 'note', 'decision', 'evidence'])(
    'defaults %s to the shared Team scope',
    kind => {
      expect(defaultGraphWriteScope(scopes, kind)).toBe('team:main')
    },
  )

  it('uses the current Workspace scope when the workspace selects it', () => {
    expect(defaultGraphWriteScope(scopes, 'issue', 'workspace')).toBe('project:alpha')
  })

  it('keeps Journal private under either workspace preference', () => {
    expect(defaultGraphWriteScope(scopes, 'journal')).toBe('private:local')
    expect(defaultGraphWriteScope(scopes, 'journal', 'workspace')).toBe('private:local')
  })

  it('falls back to the remaining shared scope before Private', () => {
    expect(defaultGraphWriteScope(
      scopes.filter(scope => scope.kind !== 'team'),
      'issue',
    )).toBe('project:alpha')
    expect(defaultGraphWriteScope(
      scopes.filter(scope => scope.kind !== 'project'),
      'company',
      'workspace',
    )).toBe('team:main')
  })
})
