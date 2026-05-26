import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyPath,
  addSessionPathAllow,
  clearSessionPathAllows,
  pathDeniedError,
  checkPathAccess,
} from './pathPermission'

describe('classifyPath', () => {
  const projectPath = '/Users/test/projects/myproject'

  beforeEach(() => {
    clearSessionPathAllows()
  })

  it('returns allow for path inside project', () => {
    const result = classifyPath('/Users/test/projects/myproject/src/main.js', projectPath, 'sess-1')
    expect(result.action).toBe('allow')
    expect(result.reason).toContain('Within project')
  })

  it('returns allow for the project root itself', () => {
    const result = classifyPath(projectPath, projectPath, 'sess-1')
    expect(result.action).toBe('allow')
  })

  it('returns reject for ~/.ssh/id_rsa', () => {
    const result = classifyPath('/Users/test/.ssh/id_rsa', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
    expect(result.reason).toContain('.ssh')
  })

  it('returns reject for ~/.ssh (exact match)', () => {
    const result = classifyPath('/Users/test/.ssh', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for /etc/passwd', () => {
    const result = classifyPath('/etc/passwd', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
    expect(result.reason).toContain('/etc')
  })

  it('returns reject for /private/etc/hosts', () => {
    const result = classifyPath('/private/etc/hosts', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for ~/.aws/credentials', () => {
    const result = classifyPath('/Users/test/.aws/credentials', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for path containing .env segment', () => {
    const result = classifyPath('/Users/test/otherproject/.env', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
    expect(result.reason).toContain('.env')
  })

  it('returns reject for path containing credentials segment', () => {
    const result = classifyPath('/Users/test/app/credentials/key.json', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
    expect(result.reason).toContain('credentials')
  })

  it('returns reject for path containing secrets segment', () => {
    const result = classifyPath('/Users/test/deploy/secrets/token', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
    expect(result.reason).toContain('secrets')
  })

  it('returns ask for path outside project, not sensitive', () => {
    const result = classifyPath('/Users/test/documents/notes.txt', projectPath, 'sess-1')
    expect(result.action).toBe('ask')
    expect(result.reason).toContain('Outside project')
  })

  it('returns allow for session-approved directory', () => {
    addSessionPathAllow('sess-1', '/Users/test/documents')
    const result = classifyPath('/Users/test/documents/notes.txt', projectPath, 'sess-1')
    expect(result.action).toBe('allow')
    expect(result.reason).toContain('Session-approved')
  })

  it('does not allow session approval from different session', () => {
    addSessionPathAllow('sess-1', '/Users/test/documents')
    const result = classifyPath('/Users/test/documents/notes.txt', projectPath, 'sess-2')
    expect(result.action).toBe('ask')
  })

  it('returns reject for no path', () => {
    const result = classifyPath(null, projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns ask when no project path is set', () => {
    const result = classifyPath('/Users/test/documents/notes.txt', null, 'sess-1')
    expect(result.action).toBe('ask')
  })

  it('returns reject for ~/.gnupg path', () => {
    const result = classifyPath('/home/user/.gnupg/pubring.gpg', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for ~/.kube/config', () => {
    const result = classifyPath('/Users/test/.kube/config', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for ~/.docker path', () => {
    const result = classifyPath('/Users/test/.docker/config.json', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for ~/.npmrc', () => {
    const result = classifyPath('/Users/test/.npmrc', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })

  it('returns reject for /Library/Keychains', () => {
    const result = classifyPath('/Library/Keychains/System.keychain', projectPath, 'sess-1')
    expect(result.action).toBe('reject')
  })
})

describe('addSessionPathAllow + classifyPath interaction', () => {
  beforeEach(() => {
    clearSessionPathAllows()
  })

  it('allows access after adding parent directory', () => {
    const projectPath = '/Users/test/project'
    addSessionPathAllow('sess-1', '/Users/test/data')
    expect(classifyPath('/Users/test/data/file.csv', projectPath, 'sess-1').action).toBe('allow')
  })

  it('allows access to the approved directory itself', () => {
    const projectPath = '/Users/test/project'
    addSessionPathAllow('sess-1', '/Users/test/data')
    expect(classifyPath('/Users/test/data', projectPath, 'sess-1').action).toBe('allow')
  })

  it('does not allow sibling directories', () => {
    const projectPath = '/Users/test/project'
    addSessionPathAllow('sess-1', '/Users/test/data')
    expect(classifyPath('/Users/test/other/file.csv', projectPath, 'sess-1').action).toBe('ask')
  })

  it('supports multiple approved directories', () => {
    const projectPath = '/Users/test/project'
    addSessionPathAllow('sess-1', '/Users/test/data')
    addSessionPathAllow('sess-1', '/Users/test/uploads')
    expect(classifyPath('/Users/test/data/a.txt', projectPath, 'sess-1').action).toBe('allow')
    expect(classifyPath('/Users/test/uploads/b.txt', projectPath, 'sess-1').action).toBe('allow')
  })
})

describe('clearSessionPathAllows', () => {
  beforeEach(() => {
    clearSessionPathAllows()
  })

  it('clears approvals for a specific session', () => {
    const projectPath = '/Users/test/project'
    addSessionPathAllow('sess-1', '/Users/test/data')
    addSessionPathAllow('sess-2', '/Users/test/other')
    clearSessionPathAllows('sess-1')
    expect(classifyPath('/Users/test/data/a.txt', projectPath, 'sess-1').action).toBe('ask')
    expect(classifyPath('/Users/test/other/a.txt', projectPath, 'sess-2').action).toBe('allow')
  })

  it('clears all approvals when called without sessionId', () => {
    const projectPath = '/Users/test/project'
    addSessionPathAllow('sess-1', '/Users/test/data')
    addSessionPathAllow('sess-2', '/Users/test/other')
    clearSessionPathAllows()
    expect(classifyPath('/Users/test/data/a.txt', projectPath, 'sess-1').action).toBe('ask')
    expect(classifyPath('/Users/test/other/a.txt', projectPath, 'sess-2').action).toBe('ask')
  })
})

describe('pathDeniedError', () => {
  it('returns structured error with all fields', () => {
    const err = pathDeniedError('/etc/passwd', '/Users/test/project', 'Sensitive path')
    expect(err.error).toContain('/etc/passwd')
    expect(err.error).toContain('Sensitive path')
    expect(err.detail).toContain('/Users/test/project')
    expect(err.suggestion).toBeTruthy()
  })

  it('returns appropriate detail when no project path', () => {
    const err = pathDeniedError('/some/path', null, 'some reason')
    expect(err.detail).toContain('No project folder linked')
  })
})

describe('checkPathAccess', () => {
  beforeEach(() => {
    clearSessionPathAllows()
  })

  it('returns null (allowed) in bypass mode', async () => {
    const result = await checkPathAccess('/etc/passwd', 'test_tool', { approvalMode: 'bypass' })
    expect(result).toBeNull()
  })

  it('returns null for path inside project in normal mode', async () => {
    const result = await checkPathAccess(
      '/Users/test/project/file.txt',
      'test_tool',
      { approvalMode: 'normal', projectPath: '/Users/test/project', sessionId: 'sess-1' },
    )
    expect(result).toBeNull()
  })

  it('returns error for sensitive path in normal mode', async () => {
    const result = await checkPathAccess(
      '/Users/test/.ssh/id_rsa',
      'test_tool',
      { approvalMode: 'normal', projectPath: '/Users/test/project', sessionId: 'sess-1' },
    )
    expect(result).not.toBeNull()
    expect(result.error).toContain('Access denied')
  })

  it('calls onApprovalRequest for outside-project path', async () => {
    let called = false
    const handler = (name, args, meta) => {
      called = true
      expect(name).toBe('test_tool')
      expect(args.path).toBe('/Users/test/other/file.txt')
      expect(meta.category).toBe('path-access')
      return { approved: true, alwaysAllow: false }
    }
    const result = await checkPathAccess(
      '/Users/test/other/file.txt',
      'test_tool',
      {
        approvalMode: 'normal',
        projectPath: '/Users/test/project',
        sessionId: 'sess-1',
        onApprovalRequest: handler,
      },
    )
    expect(called).toBe(true)
    expect(result).toBeNull()
  })

  it('adds session path allow when alwaysAllow is true', async () => {
    const handler = () => ({ approved: true, alwaysAllow: true })
    await checkPathAccess(
      '/Users/test/other/file.txt',
      'test_tool',
      {
        approvalMode: 'normal',
        projectPath: '/Users/test/project',
        sessionId: 'sess-1',
        onApprovalRequest: handler,
      },
    )
    // Second call should be auto-allowed via session allow
    const result = await checkPathAccess(
      '/Users/test/other/another.txt',
      'test_tool',
      {
        approvalMode: 'normal',
        projectPath: '/Users/test/project',
        sessionId: 'sess-1',
      },
    )
    expect(result).toBeNull()
  })

  it('returns error when user rejects approval', async () => {
    const handler = () => ({ approved: false, alwaysAllow: false })
    const result = await checkPathAccess(
      '/Users/test/other/file.txt',
      'test_tool',
      {
        approvalMode: 'normal',
        projectPath: '/Users/test/project',
        sessionId: 'sess-1',
        onApprovalRequest: handler,
      },
    )
    expect(result).not.toBeNull()
    expect(result.error).toContain('User denied')
  })

  it('returns error when no approval handler and path is outside project', async () => {
    const result = await checkPathAccess(
      '/Users/test/other/file.txt',
      'test_tool',
      { approvalMode: 'normal', projectPath: '/Users/test/project', sessionId: 'sess-1' },
    )
    expect(result).not.toBeNull()
    expect(result.error).toContain('Access denied')
  })

  it('defaults to normal mode when approvalMode is not set', async () => {
    const result = await checkPathAccess(
      '/Users/test/.ssh/id_rsa',
      'test_tool',
      { projectPath: '/Users/test/project', sessionId: 'sess-1' },
    )
    expect(result).not.toBeNull()
    expect(result.error).toContain('Access denied')
  })
})
