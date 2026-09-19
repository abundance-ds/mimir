import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { acceptChunk, rejectChunk, getChunks } from '@codemirror/merge'
import { invoke } from '@tauri-apps/api/core'
import { useDiffStore } from '../../../stores/diff.js'
import { useFileStore } from '../../../stores/files.js'
import { useDiffReview } from '../../composables/useDiffReview.js'
import BatchDiffView from './BatchDiffView.vue'

enableAutoUnmount(afterEach)
afterEach(() => vi.useRealTimers())

describe('BatchDiffView resolution', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invoke.mockReset().mockResolvedValue(undefined)
  })

  async function reviewFile(original, modified) {
    const files = useFileStore()
    const diff = useDiffStore()
    await files.openFile('/work/a.md', original)
    const review = useDiffReview({
      fileManager: files, diffStore: diff, currentFile: computed(() => files.currentFile),
      reviewTabActive: ref(true), inlineAIState: ref(null), restoreConfirmMeta: ref(null),
      diffViewRef: ref(null), batchDiffViewRef: ref(null), scheduleContentSync() {}, flushEditorContent() {},
    })
    diff.activateBatch({ fileList: [{ path: '/work/a.md', original, modified, proposalId: 'p1' }] })
    let completion
    const wrapper = mount(BatchDiffView, { props: { onAllResolved: () => { completion = review.onBatchAllResolved() } } })
    const view = EditorView.findFromDOM(wrapper.element.querySelector('.cm-editor'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const finish = async () => { await vi.runAllTimersAsync(); await completion; await flushPromises() }
    return { files, diff, view, review, wrapper, finish }
  }

  it.each(['\n', '\r\n'])('rejects the last batch chunk without applying or saving it (%j)', async ending => {
    const original = `old${ending}same${ending}`
    const h = await reviewFile(original, `new${ending}same${ending}`)
    expect(rejectChunk(h.view, 0)).toBe(true)
    await h.finish()
    expect(h.files.currentFile).toMatchObject({ content: original, dirty: false })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', { result: expect.objectContaining({ id: 'p1', status: 'rejected' }) })
    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
  })

  it.each(['accept', 'reject'])('applies only accepted chunks when the final action is %s', async last => {
    const middle = Array.from({ length: 12 }, (_, i) => `shared ${i}`).join('\r\n')
    const original = `old A\r\n${middle}\r\nold B`
    const proposed = `new A\r\n${middle}\r\nnew B`
    const expected = last === 'accept' ? `old A\r\n${middle}\r\nnew B` : `new A\r\n${middle}\r\nold B`
    const h = await reviewFile(original, proposed)
    expect(getChunks(h.view.state).chunks).toHaveLength(2)
    const first = last === 'accept' ? rejectChunk : acceptChunk
    const final = last === 'accept' ? acceptChunk : rejectChunk
    expect(first(h.view, 0)).toBe(true)
    expect(final(h.view, getChunks(h.view.state).chunks[0].fromB)).toBe(true)
    await h.finish()
    expect(h.files.currentFile).toMatchObject({ content: expected, dirty: true })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', { result: expect.objectContaining({ status: 'applied' }) })
  })

  it('keeps a rejected chunk when Accept All resolves the remaining changes', async () => {
    const middle = Array.from({ length: 12 }, (_, i) => `shared ${i}`).join('\n')
    const h = await reviewFile(`old A\n${middle}\nold B`, `new A\n${middle}\nnew B`)
    rejectChunk(h.view, 0)
    await h.review.onDiffAcceptAll()
    expect(h.files.currentFile.content).toBe(`old A\n${middle}\nnew B`)
  })

  it('cancels a scheduled resolution if Undo restores a pending chunk', async () => {
    const h = await reviewFile('old', 'new')
    rejectChunk(h.view, 0)
    const { undo } = await import('@codemirror/commands')
    undo(h.view)
    await h.finish()
    expect(h.diff.files[0]).toMatchObject({ status: 'pending', modified: 'new' })
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', expect.anything())
  })

  it('emits all-resolved exactly once when the final file is decided', async () => {
    const diff = useDiffStore()
    diff.activateBatch({
      fileList: [
        { path: '/work/a.md', original: 'a', modified: 'A' },
        { path: '/work/b.md', original: 'b', modified: 'B' },
      ],
    })
    const wrapper = mount(BatchDiffView, {
      global: {
        stubs: {
          BatchFileDiff: {
            props: ['file'],
            emits: ['accept', 'reject', 'reset'],
            template: '<button class="decide" @click="$emit(\'accept\', file.path)">{{ file.path }}</button>',
          },
        },
      },
    })

    await wrapper.findAll('.decide')[0].trigger('click')
    expect(wrapper.emitted('all-resolved')).toBeUndefined()

    await wrapper.findAll('.decide')[1].trigger('click')
    await nextTick()
    expect(wrapper.emitted('all-resolved')).toHaveLength(1)
  })
})
