import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { ref, reactive, nextTick } from 'vue'

vi.mock('../../apps/runner.js', () => ({
  createAppHandle: vi.fn(() => ({
    start: vi.fn(),
    cancel: vi.fn(),
    promise: null,
  })),
}))

vi.mock('../../stores/panel/apps.js', () => {
  let _app = null
  return {
    useAppStore: () => ({
      getApp: () => _app,
      _setApp: (a) => { _app = a },
    }),
  }
})

vi.mock('../../stores/panel/sessions.js', () => ({
  useSessionStore: () => ({}),
}))

vi.mock('../../stores/panel/projects.js', () => ({
  useProjectStore: () => ({ projects: [] }),
}))

vi.mock('../../stores/panel/helpers.js', () => ({
  plainProject: (p) => p,
}))

vi.mock('../../stores/panel/persistence.js', () => ({
  schedulePersist: vi.fn(),
}))

import AppView from './AppView.vue'
import { useAppStore } from '../../stores/panel/apps.js'
import { createAppHandle } from '../../apps/runner.js'

describe('AppView', () => {
  describe('password field stripping', () => {
    it('strips password fields from session.appInputs but passes full inputs to runner', async () => {
      const app = {
        id: 'test-app',
        name: 'Test',
        ui: 'standard',
        setup: {
          fields: [
            { id: 'token', type: 'password', label: 'Token' },
            { id: 'name', type: 'text', label: 'Name' },
          ],
        },
      }
      useAppStore()._setApp(app)

      const session = reactive({
        id: 'sess-1',
        appId: 'test-app',
        appStatus: 'setup',
        appInputs: null,
        appEvents: [],
        updatedAt: '',
        appStartedAt: null,
        projectId: 'general',
      })

      const wrapper = shallowMount(AppView, {
        props: { session },
      })

      const setup = wrapper.findComponent({ name: 'AppSetup' })
      setup.vm.$emit('start', { token: 'secret-123', name: 'My App' })
      await nextTick()

      expect(session.appInputs).toEqual({ name: 'My App' })
      expect(session.appInputs.token).toBeUndefined()

      expect(createAppHandle).toHaveBeenCalledWith(
        app,
        expect.any(Object),
        expect.objectContaining({
          inputs: { token: 'secret-123', name: 'My App' },
        }),
      )
    })
  })
})
