// Hardcoded blocklist of sensitive paths — always reject.
// Home-relative entries start with /. (matched against any path segment prefix).
// Absolute entries are checked as full path prefixes.
const SENSITIVE_PATHS = [
  '/.ssh', '/.gnupg', '/.aws', '/.config/gcloud',
  '/etc', '/private/etc', '/var/run',
  '/Library/Keychains', '/.kube', '/.docker',
  '/.npmrc', '/.pypirc',
]

// Block any path containing these segments
const SENSITIVE_SEGMENTS = ['credentials', '.env', 'secrets']

// Session-scoped approved directories: sessionId → Set<dirPath>
const sessionPathAllows = new Map()

export function addSessionPathAllow(sessionId, dirPath) {
  if (!sessionId || !dirPath) return
  if (!sessionPathAllows.has(sessionId)) sessionPathAllows.set(sessionId, new Set())
  sessionPathAllows.get(sessionId).add(dirPath)
}

export function clearSessionPathAllows(sessionId) {
  if (sessionId) {
    sessionPathAllows.delete(sessionId)
  } else {
    sessionPathAllows.clear()
  }
}

export function revokeSessionPathAllow(sessionId, dirPath) {
  if (!sessionId || !dirPath) return
  const dirs = sessionPathAllows.get(sessionId)
  if (dirs) dirs.delete(dirPath)
}

export function getSessionPathAllows(sessionId) {
  if (!sessionId) return []
  const dirs = sessionPathAllows.get(sessionId)
  return dirs ? [...dirs] : []
}

/**
 * Classify a resolved absolute path for permission gating.
 * Returns { action: 'allow'|'ask'|'reject', reason: string }
 */
export function classifyPath(absolutePath, projectPath, sessionId) {
  if (!absolutePath) return { action: 'reject', reason: 'No path provided' }

  // 1. Check sensitive blocklist
  for (const entry of SENSITIVE_PATHS) {
    if (entry.startsWith('/.')) {
      // Home-relative pattern: check if path contains the segment
      if (absolutePath.includes(entry + '/') || absolutePath.endsWith(entry)) {
        return { action: 'reject', reason: `Sensitive path: ${entry}` }
      }
    } else {
      // Absolute prefix: check if path starts with it
      if (absolutePath === entry || absolutePath.startsWith(entry + '/')) {
        return { action: 'reject', reason: `Sensitive path: ${entry}` }
      }
    }
  }

  // 2. Check for sensitive path segments
  const segments = absolutePath.split('/')
  for (const seg of segments) {
    const lower = seg.toLowerCase()
    for (const sensitive of SENSITIVE_SEGMENTS) {
      if (lower === sensitive) {
        return { action: 'reject', reason: `Path contains sensitive segment: ${sensitive}` }
      }
    }
  }

  // 3. Check if within project path
  if (projectPath && (absolutePath === projectPath || absolutePath.startsWith(projectPath + '/'))) {
    return { action: 'allow', reason: 'Within project folder' }
  }

  // 4. Check session-approved directories
  if (sessionId && sessionPathAllows.has(sessionId)) {
    for (const dir of sessionPathAllows.get(sessionId)) {
      if (absolutePath === dir || absolutePath.startsWith(dir + '/')) {
        return { action: 'allow', reason: `Session-approved directory: ${dir}` }
      }
    }
  }

  // 5. Default: ask
  return { action: 'ask', reason: 'Outside project folder' }
}

/**
 * Structured error for AI tools when path access is denied.
 */
export function pathDeniedError(path, projectPath, reason) {
  return {
    error: `Access denied: ${path} — ${reason}`,
    detail: projectPath
      ? `File is outside the project folder ${projectPath}.`
      : 'No project folder linked.',
    suggestion: 'Copy the needed file into the project folder, or ask the user to grant access.',
  }
}

/**
 * Check path access for a tool. Returns null if allowed,
 * or an error object if denied/requires approval.
 *
 * When the user approves with alwaysAllow, the parent directory
 * is added to the session allow list for subsequent calls.
 */
export async function checkPathAccess(absolutePath, toolName, context) {
  const mode = context.approvalMode || 'normal'
  if (mode === 'bypass') return null

  const result = classifyPath(absolutePath, context.projectPath, context.sessionId)

  if (result.action === 'allow') return null
  if (result.action === 'reject') return pathDeniedError(absolutePath, context.projectPath, result.reason)

  // 'ask' — use the approval handler
  if (context.onApprovalRequest) {
    const approval = await context.onApprovalRequest(toolName, { path: absolutePath }, {
      category: 'path-access',
      risk: 'medium',
      pathOutsideProject: true,
      detail: `Access to ${absolutePath} (outside project folder)`,
    })
    if (approval?.approved) {
      if (approval?.alwaysAllow) {
        const lastSlash = absolutePath.lastIndexOf('/')
        const dir = lastSlash > 0 ? absolutePath.substring(0, lastSlash) : absolutePath
        addSessionPathAllow(context.sessionId, dir)
      }
      return null
    }
    return pathDeniedError(absolutePath, context.projectPath, 'User denied access')
  }

  return pathDeniedError(absolutePath, context.projectPath, 'Outside project folder and no approval handler')
}
