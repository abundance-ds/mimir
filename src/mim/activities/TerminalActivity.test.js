import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const xterm = vi.hoisted(() => ({ terminals: [], fits: [] }))
const api = vi.hoisted(() => ({
  callback: null,
  unlisten: vi.fn(),
  snapshot: vi.fn(),
  listen: vi.fn(),
  resize: vi.fn(),
  stop: vi.fn(),
  write: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    constructor(options) {
      this.options = { ...options }
      this.cols = 100
      this.rows = 30
      this.loadAddon = vi.fn()
      this.open = vi.fn()
      this.write = vi.fn()
      this.focus = vi.fn()
      this.reset = vi.fn()
      this.dispose = vi.fn()
      this.dataDisposable = { dispose: vi.fn() }
      this.onData = vi.fn((callback) => {
        this.dataCallback = callback
        return this.dataDisposable
      })
      this.unicode = { activeVersion: '6' }
      this.attachCustomKeyEventHandler = vi.fn((handler) => {
        this.customKeyHandler = handler
      })
      xterm.terminals.push(this)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    constructor() {
      this.fit = vi.fn()
      xterm.fits.push(this)
    }
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class MockUnicode11Addon {},
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    constructor() {
      this.onContextLoss = vi.fn()
      this.dispose = vi.fn()
    }
  },
}))

vi.mock('../../services/activities.js', () => ({
  activitySnapshot: api.snapshot,
  listenToActivityEvents: api.listen,
  resizeActivity: api.resize,
  stopActivity: api.stop,
  writeActivity: api.write,
}))

import TerminalActivity from './TerminalActivity.vue'

const agent = {
  id: 'agent:one',
  kind: 'agent',
  title: 'Codex',
  workspacePath: '/workspace',
  status: 'working',
  host: { type: 'pty', resumeStrategy: 'codex' },
  launch: { cwd: '/workspace' },
}

let resizeObservers
let rafCallbacks
let nextRafId

beforeEach(() => {
  vi.clearAllMocks()
  xterm.terminals.length = 0
  xterm.fits.length = 0
  api.callback = null
  api.listen.mockImplementation(async (callback) => {
    api.callback = callback
    return api.unlisten
  })
  api.snapshot.mockResolvedValue(snapshot())
  api.resize.mockResolvedValue()
  api.stop.mockResolvedValue()
  api.write.mockResolvedValue()

  resizeObservers = []
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.observe = vi.fn()
      this.disconnect = vi.fn()
      resizeObservers.push(this)
    }
  })

  rafCallbacks = new Map()
  nextRafId = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
    const id = ++nextRafId
    rafCallbacks.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id) => rafCallbacks.delete(id)))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 640,
    height: 480,
    top: 0,
    left: 0,
    right: 640,
    bottom: 480,
    x: 0,
    y: 0,
    toJSON() {},
  })
})

function snapshot(overrides = {}) {
  return {
    record: { ...agent },
    scrollback: {
      chunks: [
        { sequence: 1, bytes: [0xf0, 0x9f] },
        { sequence: 2, bytes: [0x99, 0x82] },
      ],
      lastSequence: 2,
      retainedBytes: 4,
      byteCap: 2_097_152,
      truncated: false,
    },
    live: true,
    ...overrides,
  }
}

function render(props = {}, { stubTeleport = true } = {}) {
  const stubs = {
    IconPlayerPause: true,
    IconPlayerStop: true,
    IconRefresh: true,
  }
  if (stubTeleport) stubs.Teleport = true

  return mount(TerminalActivity, {
    props: { activity: agent, active: true, ...props },
    global: {
      stubs,
    },
  })
}

async function initialize(wrapper = render()) {
  await flushPromises()
  flushRaf()
  await flushPromises()
  await nextTick()
  return wrapper
}

function flushRaf() {
  const callbacks = [...rafCallbacks.values()]
  rafCallbacks.clear()
  for (const callback of callbacks) callback(performance.now())
}

function writtenBytes(terminal) {
  return terminal.write.mock.calls.map(([bytes]) => Array.from(bytes))
}

describe('TerminalActivity', () => {
  it('subscribes before snapshot and replays raw bytes without decoding', async () => {
    const order = []
    api.listen.mockImplementationOnce(async (callback) => {
      order.push('listen')
      api.callback = callback
      return api.unlisten
    })
    api.snapshot.mockImplementationOnce(async () => {
      order.push('snapshot')
      return snapshot()
    })
    const wrapper = await initialize()

    expect(order).toEqual(['listen', 'snapshot'])
    expect(writtenBytes(xterm.terminals[0])).toEqual([[0xf0, 0x9f], [0x99, 0x82]])
    expect(wrapper.emitted('ready')[0][0]).toMatchObject({ activityId: 'agent:one' })
    expect(xterm.terminals[0].loadAddon).toHaveBeenCalledTimes(4)
    expect(xterm.terminals[0].unicode.activeVersion).toBe('11')
    // The Unicode 11 addon throws at load time without the proposed API flag.
    expect(xterm.terminals[0].options.allowProposedApi).toBe(true)
  })

  it('keeps process controls and leaves identity chrome to the shared pane header', async () => {
    const wrapper = await initialize()

    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Agent session')
    expect(wrapper.text()).not.toContain('/workspace')
    expect(wrapper.get('[data-terminal-controls]').attributes('aria-label')).toBe('Codex process controls')
    expect(wrapper.find('[data-terminal-paste]').exists()).toBe(false)
    expect(wrapper.get('[data-terminal-interrupt]').exists()).toBe(true)
    expect(wrapper.get('[data-terminal-stop]').exists()).toBe(true)
  })

  it('places active process controls in the shared Activity header target', async () => {
    const target = document.createElement('div')
    target.dataset.paneActions = 'activity'
    document.body.append(target)
    const wrapper = await initialize(render({}, { stubTeleport: false }))

    expect(target.querySelector('[data-terminal-controls]')).not.toBeNull()
    expect(target.querySelector('[data-terminal-stop]')).not.toBeNull()

    await wrapper.setProps({ active: false })
    expect(target.querySelector('[data-terminal-controls]')).toBeNull()

    wrapper.unmount()
    target.remove()
  })

  it('queues hydration output, filters by id, and removes replay duplicates', async () => {
    let resolveSnapshot
    api.snapshot.mockReturnValueOnce(new Promise((resolve) => {
      resolveSnapshot = resolve
    }))
    const wrapper = render()
    await flushPromises()
    api.callback({ type: 'output', activityId: 'other', sequence: 3, bytes: [99] })
    api.callback({ type: 'output', activityId: 'agent:one', sequence: 3, bytes: [3] })
    resolveSnapshot(snapshot())
    await initialize(wrapper)

    expect(writtenBytes(xterm.terminals[0])).toEqual([
      [0xf0, 0x9f],
      [0x99, 0x82],
      [3],
    ])
    api.callback({ type: 'output', activityId: 'agent:one', sequence: 2, bytes: [2] })
    expect(xterm.terminals[0].write).toHaveBeenCalledTimes(3)
  })

  it('renders agent attention and authoritative exit state', async () => {
    const wrapper = await initialize()
    api.callback({
      type: 'status',
      activityId: 'agent:one',
      status: 'done',
    })
    await nextTick()
    expect(wrapper.get('[data-terminal-interrupt]').exists()).toBe(true)
    expect(wrapper.find('[data-terminal-restart]').exists()).toBe(false)

    api.callback({
      type: 'status',
      activityId: 'agent:one',
      status: 'needs-input',
      needsInputIsBlocking: true,
    })
    await nextTick()

    expect(wrapper.get('[data-terminal-attention]').exists()).toBe(true)
    expect(wrapper.emitted('status').at(-1)[0]).toMatchObject({
      status: 'needs-input',
      needsInputIsBlocking: true,
    })

    api.callback({
      type: 'exit',
      activityId: 'agent:one',
      exit: { reason: 'completed', code: 0 },
      record: { ...agent, status: 'done' },
    })
    await nextTick()
    const resume = wrapper.get('[data-terminal-restart]')
    expect(resume.exists()).toBe(true)
    expect(resume.attributes('data-resume-emphasis')).toBe('accent')
    expect(resume.classes()).toContain('bg-accent-soft')
    expect(resume.classes()).toContain('text-accent')
    expect(wrapper.emitted('exit')).toHaveLength(1)
    expect(wrapper.emitted('restart-ready')[0][0]).toMatchObject({
      activityId: 'agent:one',
    })
  })

  it('sends exact UTF-8 input in arrival order', async () => {
    let releaseFirst
    api.write
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = resolve
      }))
      .mockResolvedValueOnce()
    await initialize()
    const terminal = xterm.terminals[0]

    terminal.dataCallback('🙂')
    terminal.dataCallback('é')
    await flushPromises()
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(Array.from(api.write.mock.calls[0][1])).toEqual([240, 159, 153, 130])

    releaseFirst()
    await flushPromises()
    expect(api.write).toHaveBeenCalledTimes(2)
    expect(Array.from(api.write.mock.calls[1][1])).toEqual([195, 169])
  })

  it('turns Shift+Enter into a line feed instead of a submit', async () => {
    await initialize()
    const terminal = xterm.terminals[0]
    const key = (overrides = {}) => ({
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      ...overrides,
    })

    expect(terminal.customKeyHandler(key())).toBe(false)
    await flushPromises()
    expect(api.write).toHaveBeenCalledTimes(1)
    expect(Array.from(api.write.mock.calls[0][1])).toEqual([10])

    // keyup for the same combo stays blocked but must not send twice.
    expect(terminal.customKeyHandler(key({ type: 'keyup' }))).toBe(false)
    await flushPromises()
    expect(api.write).toHaveBeenCalledTimes(1)

    // Plain Enter and modified combos keep xterm's default handling.
    expect(terminal.customKeyHandler(key({ shiftKey: false }))).toBe(true)
    expect(terminal.customKeyHandler(key({ metaKey: true }))).toBe(true)
    expect(terminal.customKeyHandler(key({ isComposing: true }))).toBe(true)
    await flushPromises()
    expect(api.write).toHaveBeenCalledTimes(1)
  })

  it('keeps interrupt, stop, and restart as explicit actions', async () => {
    const wrapper = await initialize()
    await wrapper.vm.pasteText('pasted')
    await flushPromises()
    expect(Array.from(api.write.mock.calls[0][1])).toEqual([112, 97, 115, 116, 101, 100])

    await wrapper.get('[data-terminal-interrupt]').trigger('click')
    await flushPromises()
    expect(Array.from(api.write.mock.calls[1][1])).toEqual([3])
    expect(wrapper.emitted('interrupt')[0][0]).toEqual({ activityId: 'agent:one' })

    await wrapper.get('[data-terminal-stop]').trigger('click')
    expect(api.stop).toHaveBeenCalledWith('agent:one')
    expect(wrapper.emitted('stop')[0][0]).toEqual({ activityId: 'agent:one' })

    api.callback({
      type: 'exit',
      activityId: 'agent:one',
      exit: { reason: 'stopped' },
      record: { ...agent, status: 'stopped' },
    })
    await nextTick()
    await wrapper.get('[data-terminal-restart]').trigger('click')
    expect(wrapper.emitted('restart')[0][0]).toMatchObject({ activityId: 'agent:one' })
  })

  it('resizes and updates props without rebuilding the xterm instance', async () => {
    const wrapper = await initialize()
    const terminal = xterm.terminals[0]
    expect(api.resize).toHaveBeenCalledWith('agent:one', 100, 30)

    terminal.cols = 132
    terminal.rows = 42
    resizeObservers[0].callback()
    flushRaf()
    await flushPromises()
    expect(api.resize).toHaveBeenLastCalledWith('agent:one', 132, 42)

    await wrapper.setProps({
      activity: { ...agent, status: 'idle' },
      active: true,
      fontSize: 14,
    })
    flushRaf()
    await flushPromises()
    expect(xterm.terminals).toHaveLength(1)
    expect(api.snapshot).toHaveBeenCalledTimes(1)
    expect(terminal.options.fontSize).toBe(14)
    expect(terminal.focus).toHaveBeenCalled()
  })

  it('suspends hidden listeners and observers, then catches up from native scrollback', async () => {
    const wrapper = await initialize()
    const terminal = xterm.terminals[0]
    const firstObserver = resizeObservers[0]

    await wrapper.setProps({ active: false })
    expect(api.unlisten).toHaveBeenCalledTimes(1)
    expect(firstObserver.disconnect).toHaveBeenCalledTimes(1)

    api.snapshot.mockResolvedValueOnce(snapshot({
      scrollback: {
        chunks: [{ sequence: 3, bytes: [65] }],
        lastSequence: 3,
      },
    }))
    await wrapper.setProps({ active: true })
    await flushPromises()

    expect(api.listen).toHaveBeenCalledTimes(2)
    expect(api.snapshot).toHaveBeenLastCalledWith('agent:one', 2)
    expect(writtenBytes(terminal).at(-1)).toEqual([65])
    expect(xterm.terminals).toHaveLength(1)
  })

  it('restarts replay in place when a resumed session reuses the Activity identity', async () => {
    const first = { ...agent, session: { runId: 'run-1' } }
    const wrapper = await initialize(render({ activity: first }))
    const terminal = xterm.terminals[0]

    api.callback({
      type: 'exit',
      activityId: 'agent:one',
      exit: { reason: 'interrupted' },
      record: { ...first, status: 'interrupted', session: { runId: 'run-1', exit: { reason: 'interrupted' } } },
    })
    await nextTick()
    expect(wrapper.find('[data-terminal-restart]').exists()).toBe(true)

    api.snapshot.mockResolvedValueOnce(snapshot({
      record: { ...agent, status: 'idle', session: { runId: 'run-2' } },
      scrollback: {
        chunks: [{ sequence: 1, bytes: [66] }],
        lastSequence: 1,
      },
    }))
    await wrapper.setProps({
      activity: { ...agent, status: 'idle', session: { runId: 'run-2' } },
    })
    await flushPromises()

    expect(terminal.reset).toHaveBeenCalledTimes(1)
    expect(xterm.terminals).toHaveLength(1)
    expect(api.snapshot).toHaveBeenLastCalledWith('agent:one', null)
    expect(writtenBytes(terminal).at(-1)).toEqual([66])
    expect(wrapper.find('[data-terminal-restart]').exists()).toBe(false)
    expect(wrapper.find('[data-terminal-stop]').exists()).toBe(true)
  })

  it('cannot strand a rapid active-inactive-active surface without a listener', async () => {
    let releaseFirst
    const firstStop = vi.fn()
    const secondStop = vi.fn()
    api.listen
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve(firstStop)
      }))
      .mockImplementationOnce(async (callback) => {
        api.callback = callback
        return secondStop
      })

    const wrapper = render({ active: true })
    await flushPromises()
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })
    await flushPromises()

    expect(api.listen).toHaveBeenCalledTimes(2)
    expect(api.snapshot).toHaveBeenCalledTimes(1)

    releaseFirst()
    await flushPromises()
    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(secondStop).not.toHaveBeenCalled()
    expect(api.snapshot).toHaveBeenCalledTimes(1)

    api.callback({ type: 'output', activityId: 'agent:one', sequence: 3, bytes: [65] })
    expect(writtenBytes(xterm.terminals[0]).at(-1)).toEqual([65])
  })

  it('detaches cleanly without stopping the supervised process', async () => {
    const wrapper = await initialize()
    const terminal = xterm.terminals[0]
    const observer = resizeObservers[0]
    wrapper.unmount()

    expect(api.unlisten).toHaveBeenCalledTimes(1)
    expect(terminal.dataDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(api.stop).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
  })
})
