import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { seedAppFromResource } from './seeder'

vi.mock('../dataDir', () => ({
  getDataDir: vi.fn(() => Promise.resolve('/mock/data')),
}))

describe('seedAppFromResource', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'path_exists') return false
      if (cmd === 'create_dir') return null
      if (cmd === 'write_text_file') return null
      return null
    })
  })

  it('writes manifest and files on fresh install', async () => {
    await seedAppFromResource({
      id: 'test-app',
      manifest: '{"name":"Test"}',
      files: [
        { path: 'index.html', content: '<h1>Hi</h1>' },
        { path: 'app.js', content: 'console.log("ok")' },
      ],
    })

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(3)
    expect(writeCalls[0][1].path).toContain('manifest.json')
    expect(writeCalls[1][1].path).toContain('index.html')
    expect(writeCalls[2][1].path).toContain('app.js')
  })

  it('creates app directory under data dir', async () => {
    await seedAppFromResource({
      id: 'my-app',
      manifest: '{}',
      files: [],
    })

    const dirCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'create_dir')
    expect(dirCalls).toHaveLength(2)
    expect(dirCalls[0][1].path).toBe('/mock/data/apps')
    expect(dirCalls[1][1].path).toBe('/mock/data/apps/my-app')
  })

  it('skips if app exists and bundled has no version', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'path_exists') return true
      return null
    })

    await seedAppFromResource({
      id: 'existing-app',
      manifest: '{"name":"Test"}',
      files: [],
    })

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(0)
  })

  it('overwrites if bundled version is newer than installed', async () => {
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === 'path_exists') return true
      if (cmd === 'read_text_file') return { content: '{"version":"1.0.0"}' }
      if (cmd === 'create_dir') return null
      if (cmd === 'write_text_file') return null
      return null
    })

    await seedAppFromResource({
      id: 'my-app',
      manifest: '{"version":"2.0.0","name":"Test"}',
      files: [{ path: 'index.js', content: 'new code' }],
    })

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(2) // manifest + index.js
  })

  it('skips if installed version matches bundled', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'path_exists') return true
      if (cmd === 'read_text_file') return { content: '{"version":"2.0.0"}' }
      return null
    })

    await seedAppFromResource({
      id: 'my-app',
      manifest: '{"version":"2.0.0"}',
      files: [],
    })

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(0)
  })

  it('skips if installed version is higher than bundled', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'path_exists') return true
      if (cmd === 'read_text_file') return { content: '{"version":"3.0.0"}' }
      return null
    })

    await seedAppFromResource({
      id: 'my-app',
      manifest: '{"version":"2.0.0"}',
      files: [],
    })

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(0)
  })

  it('overwrites if installed has no version but bundled does', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'path_exists') return true
      if (cmd === 'read_text_file') return { content: '{"name":"Old"}' }
      if (cmd === 'create_dir') return null
      if (cmd === 'write_text_file') return null
      return null
    })

    await seedAppFromResource({
      id: 'my-app',
      manifest: '{"version":"1.0.0","name":"New"}',
      files: [],
    })

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(1) // manifest
  })

  it('creates subdirectories for nested file paths', async () => {
    await seedAppFromResource({
      id: 'my-app',
      manifest: '{"name":"Test"}',
      files: [{ path: 'agents/reviewer.js', content: 'code' }],
    })

    const dirCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'create_dir')
    expect(dirCalls.some(c => c[1].path.includes('agents'))).toBe(true)
  })
})
