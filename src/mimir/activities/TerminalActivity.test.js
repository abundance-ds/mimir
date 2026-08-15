import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const xterm = vi.hoisted(() => ({
  terminals: [],
  fits: [],
  serializers: [],
  webglAddons: [],
  failWebgl: false,
  deferWrites: false,
  pendingWriteCallbacks: [],
  proposedSize: null,
}))
const api = vi.hoisted(() => ({
  callback: null,
  unlisten: vi.fn(),
  attach: vi.fn(),
  checkpoint: vi.fn(),
  release: vi.fn(),
  listen: vi.fn(),
  proposeTitle: vi.fn(),
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
      this.write = vi.fn((_value, callback) => {
        if (!callback) return
        if (xterm.deferWrites) xterm.pendingWriteCallbacks.push(callback)
        else callback()
      })
      this.resize = vi.fn((cols, rows) => {
        this.cols = cols
        this.rows = rows
      })
      this.focus = vi.fn()
      this.reset = vi.fn()
      this.dispose = vi.fn()
      this.dataDisposable = { dispose: vi.fn() }
      this.onData = vi.fn((callback) => {
        this.dataCallback = callback
        return this.dataDisposable
      })
      this.unicode = { activeVersion: '6' }
      this.buffer = {
        active: {
          length: 1,
          getLine: () => ({ translateToString: () => 'visible screen' }),
        },
      }
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
      this.proposeDimensions = vi.fn(() => {
        const terminal = xterm.terminals.at(-1)
        return xterm.proposedSize || { cols: terminal.cols, rows: terminal.rows }
      })
      xterm.fits.push(this)
    }
  },
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class MockSerializeAddon {
    constructor() {
      this.serialize = vi.fn(() => 'serialized terminal')
      xterm.serializers.push(this)
    }
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    constructor() {
      if (xterm.failWebgl) throw new Error('WebGL2 unavailable')
      this.dispose = vi.fn()
      this.contextLossDisposable = { dispose: vi.fn() }
      this.onContextLoss = vi.fn((callback) => {
        this.contextLossCallback = callback
        return this.contextLossDisposable
      })
      xterm.webglAddons.push(this)
    }
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class MockUnicode11Addon {},
}))

vi.mock('../../services/activities.js', () => ({
  attachTerminalActivity: api.attach,
  checkpointTerminalActivity: api.checkpoint,
  listenToActivityEvents: api.listen,
  proposeActivityTitle: api.proposeTitle,
  releaseTerminalActivity: api.release,
  resizeActivity: api.resize,
  stopActivity: api.stop,
  writeActivity: api.write,
}))

import TerminalActivity from './TerminalActivity.vue'

const agent = {
  id: 'agent:one',
  kind: 'agent',
  title: 'Codex',
  titleSource: 'launcher',
  workspacePath: '/workspace',
  status: 'working',
  host: { type: 'pty', resumeStrategy: 'codex' },
  launch: { cwd: '/workspace' },
  session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
}

let resizeObservers
let rafCallbacks
let nextRafId

beforeEach(() => {
  vi.clearAllMocks()
  xterm.terminals.length = 0
  xterm.fits.length = 0
  xterm.serializers.length = 0
  xterm.webglAddons.length = 0
  xterm.failWebgl = false
  xterm.deferWrites = false
  xterm.pendingWriteCallbacks.length = 0
  xterm.proposedSize = null
  api.callback = null
  api.listen.mockImplementation(async (callback) => {
    api.callback = callback
    return api.unlisten
  })
  api.attach.mockResolvedValue(snapshot())
  api.proposeTitle.mockResolvedValue({
    ...agent,
    title: 'Restore Activity titles',
    titleSource: 'provisional',
  })
  api.checkpoint.mockResolvedValue({ revision: 1, throughSequence: 2 })
  api.release.mockResolvedValue(true)
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
    runId: 'run-1',
    ownerId: 'owner',
    leaseGeneration: 1,
    checkpoint: null,
    revision: 0,
    baseSequence: 0,
    firstSequence: 1,
    lastSequence: 2,
    truncated: false,
    cols: 100,
    rows: 30,
    events: [
      { type: 'output', sequence: 1, bytes: [0xf0, 0x9f] },
      { type: 'output', sequence: 2, bytes: [0x99, 0x82] },
    ],
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
  it('queues workbench entry focus until xterm is ready', async () => {
    const wrapper = render()

    expect(wrapper.vm.focusEntry()).toBe(false)
    await initialize(wrapper)

    expect(xterm.terminals[0].focus).toHaveBeenCalled()
    expect(wrapper.vm.focusEntry()).toBe(true)
  })

  it('subscribes before restore and replays raw bytes without decoding', async () => {
    const order = []
    api.listen.mockImplementationOnce(async (callback) => {
      order.push('listen')
      api.callback = callback
      return api.unlisten
    })
    api.attach.mockImplementationOnce(async () => {
      order.push('attach')
      return snapshot()
    })
    const wrapper = await initialize()

    expect(order).toEqual(['listen', 'attach'])
    const terminal = xterm.terminals[0]
    expect(writtenBytes(terminal)).toEqual([[0xf0, 0x9f], [0x99, 0x82]])
    expect(terminal.open.mock.invocationCallOrder[0])
      .toBeLessThan(terminal.write.mock.invocationCallOrder[0])
    expect(wrapper.emitted('ready')[0][0]).toMatchObject({ activityId: 'agent:one' })
    expect(xterm.terminals[0].loadAddon).toHaveBeenCalledTimes(5)
    expect(xterm.terminals[0].unicode.activeVersion).toBe('11')
    expect(xterm.terminals[0].options).toMatchObject({
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.15,
      minimumContrastRatio: 3,
    })
    // The Unicode 11 addon throws at load time without the proposed API flag.
    expect(xterm.terminals[0].options.allowProposedApi).toBe(true)
    expect(wrapper.get('[data-terminal-surface]').attributes('data-renderer')).toBe('webgl')
  })

  it('falls back to the DOM renderer after WebGL context loss', async () => {
    const wrapper = await initialize()
    const addon = xterm.webglAddons[0]

    addon.contextLossCallback()
    await nextTick()

    expect(addon.contextLossDisposable.dispose).toHaveBeenCalledOnce()
    expect(addon.dispose).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-terminal-surface]').attributes('data-renderer')).toBe('dom')
  })

  it('keeps the DOM renderer when WebGL cannot initialize', async () => {
    xterm.failWebgl = true

    const wrapper = await initialize()

    expect(xterm.terminals[0].loadAddon).toHaveBeenCalledTimes(4)
    expect(xterm.webglAddons).toHaveLength(0)
    expect(wrapper.get('[data-terminal-surface]').attributes('data-renderer')).toBe('dom')
    expect(wrapper.find('[data-terminal-error]').exists()).toBe(false)
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

  it('explains an automatic resume failure without asking for another Resume click', async () => {
    const interrupted = {
      ...agent,
      status: 'interrupted',
      error: 'Automatic resume failed: provider session unavailable',
    }
    api.attach.mockResolvedValueOnce(snapshot({
      record: interrupted,
      live: false,
    }))

    const wrapper = await initialize(render({ activity: interrupted }))

    expect(wrapper.get('[data-terminal-error]').text()).toContain('provider session unavailable')
    expect(wrapper.find('[data-terminal-restart]').exists()).toBe(false)
    expect(wrapper.find('[data-terminal-interrupt]').exists()).toBe(false)
    expect(wrapper.find('[data-terminal-stop]').exists()).toBe(false)
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
    let resolveAttachment
    api.attach.mockReturnValueOnce(new Promise((resolve) => {
      resolveAttachment = resolve
    }))
    const wrapper = render()
    await flushPromises()
    api.callback({ type: 'output', activityId: 'other', sequence: 3, bytes: [99] })
    api.callback({ type: 'output', activityId: 'agent:one', sequence: 3, bytes: [3] })
    resolveAttachment(snapshot())
    await initialize(wrapper)

    expect(writtenBytes(xterm.terminals[0])).toEqual([
      [0xf0, 0x9f],
      [0x99, 0x82],
      [3],
    ])
    api.callback({ type: 'output', activityId: 'agent:one', sequence: 2, bytes: [2] })
    expect(xterm.terminals[0].write).toHaveBeenCalledTimes(3)
  })

  it('advances checkpoint progress only after xterm finishes each asynchronous write', async () => {
    xterm.deferWrites = true
    api.attach.mockResolvedValueOnce(snapshot({
      events: [{ type: 'output', sequence: 1, bytes: [1] }],
      lastSequence: 1,
    }))
    const wrapper = render()
    await flushPromises()

    api.callback({ type: 'output', activityId: 'agent:one', sequence: 2, bytes: [2] })
    api.callback({
      type: 'exit',
      activityId: 'agent:one',
      exit: { reason: 'completed', code: 0 },
      record: { ...agent, status: 'done' },
    })
    expect(api.checkpoint).not.toHaveBeenCalled()

    xterm.pendingWriteCallbacks.shift()()
    await flushPromises()
    expect(api.checkpoint).not.toHaveBeenCalled()
    expect(xterm.pendingWriteCallbacks).toHaveLength(1)

    xterm.pendingWriteCallbacks.shift()()
    await flushPromises()
    expect(api.checkpoint).toHaveBeenCalledWith(expect.objectContaining({
      throughSequence: 2,
      baseRevision: 0,
    }))
    wrapper.unmount()
    await flushPromises()
  })

  it('restores a checkpoint at its original size before ordered resize and output events', async () => {
    api.attach.mockResolvedValueOnce(snapshot({
      checkpoint: {
        revision: 4,
        throughSequence: 5,
        cols: 80,
        rows: 24,
        formatVersion: 1,
        engineVersion: '6.0.0',
        unicodeVersion: '11',
        data: '\u001b[2Jrestored',
      },
      revision: 4,
      baseSequence: 5,
      firstSequence: 6,
      lastSequence: 7,
      events: [
        { type: 'resize', sequence: 6, cols: 132, rows: 42 },
        { type: 'output', sequence: 7, bytes: [65] },
      ],
    }))

    await initialize()
    const terminal = xterm.terminals[0]
    expect(terminal.resize.mock.calls[0]).toEqual([80, 24])
    expect(terminal.resize.mock.calls[1]).toEqual([132, 42])
    expect(terminal.write.mock.calls[0][0]).toBe('\u001b[2Jrestored')
    expect(Array.from(terminal.write.mock.calls[1][0])).toEqual([65])
  })

  it('reports agent attention without obscuring the terminal and renders authoritative exit state', async () => {
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

    expect(wrapper.find('[data-terminal-attention]').exists()).toBe(false)
    expect(wrapper.emitted('status')).toBeUndefined()

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

  it('blocks input during restoration and reports the first later user interaction', async () => {
    const wrapper = await initialize(render({ restoring: true }))
    const terminal = xterm.terminals[0]

    terminal.dataCallback('blocked')
    await flushPromises()
    expect(api.write).not.toHaveBeenCalled()
    expect(wrapper.vm.focusEntry()).toBe(false)

    await wrapper.setProps({ restoring: false })
    terminal.dataCallback('ready')
    terminal.dataCallback('\r')
    await flushPromises()

    expect(api.write).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('activity-input')).toEqual([[
      { activityId: 'agent:one' },
    ]])
  })

  it.each(['codex', 'claude', 'pi', 'gemini'])(
    'proposes a first-prompt title through the shared terminal path for %s',
    async (launcherId) => {
      await initialize(render({
        activity: {
          ...agent,
          title: launcherId,
          source: { launcherId },
        },
      }))
      const terminal = xterm.terminals[0]

      terminal.dataCallback('Please restore Activity titles across providers')
      terminal.dataCallback('\r')
      await flushPromises()

      expect(api.proposeTitle).toHaveBeenCalledWith(
        'agent:one',
        'Restore Activity titles across providers',
      )
    },
  )

  it('never proposes over a manual title', async () => {
    await initialize(render({
      activity: { ...agent, title: 'Pinned title', titleSource: 'manual' },
    }))
    const terminal = xterm.terminals[0]

    terminal.dataCallback('Investigate the title regression')
    terminal.dataCallback('\r')
    await flushPromises()

    expect(api.proposeTitle).not.toHaveBeenCalled()
  })

  it('keeps terminal color replies out of the proposed title', async () => {
    await initialize()
    const terminal = xterm.terminals[0]

    terminal.dataCallback('\u001b]10;rgb:f8f8/f8f8/f2f2\u001b\\')
    terminal.dataCallback('\u001b]11;rgb:2727/2828/2222\u001b\\')
    terminal.dataCallback('tiny test')
    terminal.dataCallback('\r')
    await flushPromises()

    expect(api.proposeTitle).toHaveBeenCalledWith('agent:one', 'Tiny test')
    expect(api.write.mock.calls.map(([, bytes]) => new TextDecoder().decode(bytes))).toEqual([
      '\u001b]10;rgb:f8f8/f8f8/f2f2\u001b\\',
      '\u001b]11;rgb:2727/2828/2222\u001b\\',
      'tiny test',
      '\r',
    ])
  })

  it('keeps title fallback failures silent and leaves terminal input intact', async () => {
    api.proposeTitle.mockRejectedValueOnce(new Error('title persistence unavailable'))
    const wrapper = await initialize()
    const terminal = xterm.terminals[0]

    terminal.dataCallback('Investigate title persistence')
    terminal.dataCallback('\r')
    await flushPromises()

    expect(api.write).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-terminal-error]').exists()).toBe(false)
    expect(wrapper.emitted('surface-error')).toBeUndefined()
  })

  it('reports a local terminal API failure to the Activity owner', async () => {
    api.write.mockRejectedValueOnce(new Error('terminal transport unavailable'))
    const wrapper = await initialize()

    await expect(wrapper.vm.pasteText('retry')).resolves.toBe(false)

    expect(wrapper.get('[data-terminal-error]').text()).toBe('terminal transport unavailable')
    expect(wrapper.emitted('surface-error')).toEqual([[
      {
        activityId: 'agent:one',
        error: 'terminal transport unavailable',
      },
    ]])
  })

  it('snaps the surface onto the device pixel grid so WebGL glyphs stay crisp', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 640,
      height: 480,
      top: 50.6,
      left: 100.3,
      right: 740.3,
      bottom: 530.6,
      x: 100.3,
      y: 50.6,
      toJSON() {},
    })
    const wrapper = await initialize()

    // 100.3 CSS px = 200.6 device px → nearest whole device pixel is 100.5;
    // 50.6 CSS px = 101.2 device px → nearest is 50.5.
    expect(wrapper.get('[data-terminal-surface]').element.style.transform)
      .toBe('translate(0.2px, -0.1px)')
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

    xterm.proposedSize = { cols: 132, rows: 42 }
    resizeObservers[0].callback()
    flushRaf()
    await flushPromises()
    expect(api.resize).toHaveBeenLastCalledWith('agent:one', 132, 42)
    expect(terminal.resize).not.toHaveBeenCalledWith(132, 42)

    api.callback({
      type: 'resize',
      activityId: 'agent:one',
      sequence: 3,
      cols: 132,
      rows: 42,
    })
    await flushPromises()
    expect(terminal.resize).toHaveBeenLastCalledWith(132, 42)

    await wrapper.setProps({
      activity: { ...agent, status: 'idle' },
      active: true,
      fontSize: 14,
    })
    flushRaf()
    await flushPromises()
    expect(xterm.terminals).toHaveLength(1)
    expect(api.attach).toHaveBeenCalledTimes(1)
    expect(terminal.options.fontSize).toBe(14)
    expect(terminal.focus).toHaveBeenCalled()
  })

  it('keeps one hidden xterm model current while suspending layout observers', async () => {
    const wrapper = await initialize()
    const terminal = xterm.terminals[0]
    const firstObserver = resizeObservers[0]

    await wrapper.setProps({ active: false })
    expect(api.unlisten).not.toHaveBeenCalled()
    expect(firstObserver.disconnect).toHaveBeenCalledTimes(1)

    api.callback({ type: 'output', activityId: 'agent:one', sequence: 3, bytes: [65] })
    await flushPromises()
    await wrapper.setProps({ active: true })
    await flushPromises()

    expect(api.listen).toHaveBeenCalledTimes(1)
    expect(api.attach).toHaveBeenCalledTimes(1)
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
    expect(wrapper.find('[data-terminal-restart]').exists()).toBe(false)

    api.attach.mockResolvedValueOnce(snapshot({
      record: { ...agent, status: 'idle', session: { runId: 'run-2' } },
      runId: 'run-2',
      events: [{ type: 'output', sequence: 1, bytes: [66] }],
      lastSequence: 1,
    }))
    await wrapper.setProps({
      activity: { ...agent, status: 'idle', session: { runId: 'run-2' } },
    })
    await flushPromises()

    expect(terminal.reset).toHaveBeenCalledTimes(1)
    expect(xterm.terminals).toHaveLength(1)
    expect(api.attach).toHaveBeenLastCalledWith('agent:one', expect.any(String))
    expect(writtenBytes(terminal).at(-1)).toEqual([66])
    expect(wrapper.find('[data-terminal-restart]').exists()).toBe(false)
    expect(wrapper.find('[data-terminal-stop]').exists()).toBe(true)
  })

  it('does not reset or attach twice when initial attachment already acquired the resumed run', async () => {
    let resolveAttachment
    api.attach.mockReturnValueOnce(new Promise((resolve) => {
      resolveAttachment = resolve
    }))
    const first = { ...agent, session: { runId: 'run-1' } }
    const wrapper = render({ activity: first })
    await flushPromises()

    await wrapper.setProps({
      activity: { ...agent, status: 'idle', session: { runId: 'run-2' } },
    })
    resolveAttachment(snapshot({
      record: { ...agent, status: 'idle', session: { runId: 'run-2' } },
      runId: 'run-2',
      events: [{ type: 'output', sequence: 1, bytes: [66] }],
      lastSequence: 1,
    }))
    await initialize(wrapper)

    expect(api.attach).toHaveBeenCalledTimes(1)
    expect(xterm.terminals[0].reset).not.toHaveBeenCalled()
    expect(writtenBytes(xterm.terminals[0]).at(-1)).toEqual([66])
  })

  it('keeps the event owner stable across rapid active changes', async () => {
    const wrapper = await initialize(render({ active: true }))
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })
    await flushPromises()

    expect(api.listen).toHaveBeenCalledTimes(1)
    expect(api.attach).toHaveBeenCalledTimes(1)
    expect(api.unlisten).not.toHaveBeenCalled()

    api.callback({ type: 'output', activityId: 'agent:one', sequence: 3, bytes: [65] })
    await flushPromises()
    expect(writtenBytes(xterm.terminals[0]).at(-1)).toEqual([65])
  })

  it('detaches cleanly without stopping the supervised process', async () => {
    const wrapper = await initialize()
    const terminal = xterm.terminals[0]
    const addon = xterm.webglAddons[0]
    const observer = resizeObservers[0]
    wrapper.unmount()
    await flushPromises()

    expect(api.unlisten).toHaveBeenCalledTimes(1)
    expect(terminal.dataDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(addon.contextLossDisposable.dispose).toHaveBeenCalledTimes(1)
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(api.checkpoint).toHaveBeenCalled()
    expect(api.release).toHaveBeenCalledWith('agent:one', expect.any(String), 1)
    expect(api.stop).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
  })
})
