export function defaultGraphWriteScope(scopes, kind, preferredScope = 'team') {
  const normalizedKind = String(kind || '').trim().toLowerCase()
  const preferred = preferredScope === 'workspace' ? 'project' : 'team'
  const order = normalizedKind === 'journal'
    ? ['private', preferred, preferred === 'team' ? 'project' : 'team']
    : [preferred, preferred === 'team' ? 'project' : 'team', 'private']
  for (const scopeKind of order) {
    const scope = (scopes || []).find(candidate => candidate.kind === scopeKind)
    if (scope) return scope.id
  }
  return scopes?.[0]?.id || ''
}
