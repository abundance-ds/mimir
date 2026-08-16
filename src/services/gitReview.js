import { invoke } from '@tauri-apps/api/core'

const STATUSES = new Set(['new', 'modified', 'deleted', 'renamed', 'conflicted'])
const SCOPES = new Set(['all', 'unstaged', 'staged'])

export async function loadGitReviewChanges(workspacePath) {
  const path = requiredWorkspace(workspacePath)
  return normalizeGitReviewChanges(await invoke('git_changes', { path }))
}

export async function loadGitFileDiff(workspacePath, file, scope = 'all') {
  const path = requiredWorkspace(workspacePath)
  const normalizedFile = requiredFile(file)
  const normalizedScope = normalizeGitScope(scope)
  return normalizeGitFileDiff(await invoke('git_file_diff', {
    path,
    file: normalizedFile,
    scope: normalizedScope,
  }))
}

export async function stageGitFile({ workspacePath, file, scope, expectedSnapshot }) {
  return invoke('git_stage_file', {
    path: requiredWorkspace(workspacePath),
    file: requiredFile(file),
    scope: normalizeGitScope(scope),
    expectedSnapshot: requiredSnapshot(expectedSnapshot),
  })
}

export async function unstageGitFile({ workspacePath, file, scope, expectedSnapshot }) {
  return invoke('git_unstage_file', {
    path: requiredWorkspace(workspacePath),
    file: requiredFile(file),
    scope: normalizeGitScope(scope),
    expectedSnapshot: requiredSnapshot(expectedSnapshot),
  })
}

export function normalizeGitReviewChanges(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => ({
      path: normalizeRelative(entry.path),
      oldPath: normalizeRelative(entry.oldPath),
      status: String(entry.status || '').toLowerCase(),
      staged: Boolean(entry.staged),
      unstaged: Boolean(entry.unstaged),
      conflicted: Boolean(entry.conflicted),
    }))
    .filter(entry => (
      entry.path
      && STATUSES.has(entry.status)
      && (entry.staged || entry.unstaged || entry.conflicted)
    ))
    .sort((left, right) => (
      Number(right.conflicted) - Number(left.conflicted)
      || left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' })
    ))
}

export function normalizeGitFileDiff(value) {
  if (!value || typeof value !== 'object') throw new Error('Git returned an invalid review.')
  const path = normalizeRelative(value.path)
  const scope = normalizeGitScope(value.scope)
  const status = String(value.status || '').toLowerCase()
  const snapshot = String(value.snapshot || '')
  if (!path || !STATUSES.has(status) || !snapshot) {
    throw new Error('Git returned an incomplete review.')
  }
  return {
    path,
    oldPath: normalizeRelative(value.oldPath),
    status,
    scope,
    staged: Boolean(value.staged),
    unstaged: Boolean(value.unstaged),
    conflicted: Boolean(value.conflicted),
    original: String(value.original || ''),
    modified: String(value.modified || ''),
    patch: String(value.patch || ''),
    added: nonNegativeInteger(value.added),
    removed: nonNegativeInteger(value.removed),
    binary: Boolean(value.binary),
    unavailableReason: value.unavailableReason ? String(value.unavailableReason) : '',
    snapshot,
  }
}

export function normalizeGitScope(scope) {
  const value = String(scope || '').toLowerCase()
  if (!SCOPES.has(value)) throw new Error('Git scope must be all, unstaged, or staged.')
  return value
}

export function describeGitReviewError(cause) {
  const raw = cause instanceof Error ? cause.message : String(cause || 'Git review failed.')
  const message = raw.replace(/;\s*class=.*$/i, '').trim()
  const lower = message.toLowerCase()
  if (
    lower.includes('could not find a git repository')
    || lower.includes('could not find repository at')
  ) {
    return {
      kind: 'not-repository',
      message: 'This folder is not tracked with Git.',
    }
  }
  return {
    kind: 'error',
    message: message || 'Git changes could not be loaded.',
  }
}

function requiredWorkspace(workspacePath) {
  const value = String(workspacePath || '').trim()
  if (!value) throw new Error('Open a workspace to review Git changes.')
  return value
}

function requiredFile(file) {
  const value = normalizeRelative(file)
  if (!value) throw new Error('Choose a changed file to review.')
  return value
}

function requiredSnapshot(snapshot) {
  const value = String(snapshot || '')
  if (!value) throw new Error('Refresh this change before changing Git state.')
  return value
}

function normalizeRelative(path) {
  return String(path || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}
