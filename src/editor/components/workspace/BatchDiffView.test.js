import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDiffStore } from '../../../stores/diff.js'
import BatchDiffView from './BatchDiffView.vue'

describe('BatchDiffView resolution', () => {
  beforeEach(() => setActivePinia(createPinia()))

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
