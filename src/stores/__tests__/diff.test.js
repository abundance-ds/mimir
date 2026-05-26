import { describe, it, expect, beforeEach } from 'vitest'
import { useDiffStore } from '../diff.js'

function makeFileList(...files) {
  return files.map(f => ({
    path: f.path || '/test/' + f.id + '.js',
    original: f.original || '',
    modified: f.modified || '',
    proposalId: f.proposalId || null,
  }))
}

describe('diff store – resetFile', () => {
  let store

  beforeEach(() => {
    store = useDiffStore()
    store.activateBatch({
      fileList: makeFileList(
        { id: 'a', path: '/src/a.js' },
        { id: 'b', path: '/src/b.js' },
        { id: 'c', path: '/src/c.js' },
      ),
    })
  })

  it('accept a file then reset → status is pending', () => {
    store.acceptFile('/src/a.js')
    expect(store.files[0].status).toBe('accepted')
    store.resetFile('/src/a.js')
    expect(store.files[0].status).toBe('pending')
  })

  it('reject a file then reset → status is pending', () => {
    store.rejectFile('/src/b.js')
    expect(store.files[1].status).toBe('rejected')
    store.resetFile('/src/b.js')
    expect(store.files[1].status).toBe('pending')
  })

  it('after resetting the last resolved file, allResolved becomes false', () => {
    store.acceptAllFiles()
    expect(store.allResolved).toBe(true)
    store.resetFile('/src/c.js')
    expect(store.allResolved).toBe(false)
  })

  it('reset on a non-existent path is a no-op', () => {
    store.acceptFile('/src/a.js')
    store.resetFile('/src/nonexistent.js')
    expect(store.files[0].status).toBe('accepted')
    expect(store.files[1].status).toBe('pending')
    expect(store.files[2].status).toBe('pending')
  })
})
