import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import LauncherGroup from './LauncherGroup.vue'

const agents = [
  { id: 'codex', title: 'Codex', installed: true, binaryPath: '/bin/codex', version: '0.145.0' },
  { id: 'claude', title: 'Claude', installed: false, binaryPath: null },
]

function makeRow(overrides = {}) {
  return reactive({
    key: 'k-codex',
    id: 'codex',
    title: 'Codex',
    kind: 'agent',
    agentId: 'codex',
    enabled: true,
    binary: '',
    flagsText: '--full-auto',
    cwdMode: 'workspace',
    cwdPath: '',
    envText: '',
    ...overrides,
  })
}

function render(props = {}) {
  return mount(LauncherGroup, {
    props: { title: 'Agents', agents, rows: [], ...props },
  })
}

describe('LauncherGroup', () => {
  it('renders one row per preset with detected command, version, and readiness', () => {
    const wrapper = render({
      rows: [
        makeRow(),
        makeRow({ key: 'k-claude', id: 'claude', agentId: 'claude', title: 'Claude', flagsText: '' }),
        makeRow({ key: 'k-term', id: 'terminal', agentId: '', kind: 'terminal', title: 'Terminal', flagsText: '' }),
      ],
    })

    const rows = wrapper.findAll('[data-launcher-preset]')
    expect(rows).toHaveLength(3)
    expect(wrapper.text()).toContain('3') // row count in the header

    expect(rows[0].text()).toContain('Codex')
    expect(rows[0].text()).toContain('/bin/codex')
    expect(rows[0].text()).toContain('0.145.0')
    expect(rows[0].text()).toContain('--full-auto')
    expect(rows[0].text()).toContain('Ready')

    expect(rows[1].text()).toContain('Not installed')
    expect(rows[1].text()).toContain('Not found')

    expect(rows[2].text()).toContain('Default login shell')
    expect(rows[2].text()).toContain('Ready')
  })

  it('reflects enabled state on the switch and emits toggleEnabled with the row key', async () => {
    const wrapper = render({
      rows: [
        makeRow(),
        makeRow({ key: 'k-term', id: 'terminal', agentId: '', kind: 'terminal', title: 'Terminal', enabled: false }),
      ],
    })

    const codexSwitch = wrapper.get('[data-launcher-enabled="codex"]')
    expect(codexSwitch.attributes('aria-checked')).toBe('true')
    expect(codexSwitch.classes()).toContain('launcher-switch-on')
    await codexSwitch.trigger('click')
    expect(wrapper.emitted('toggleEnabled')).toEqual([['k-codex', false]])

    const termSwitch = wrapper.get('[data-launcher-enabled="terminal"]')
    expect(termSwitch.attributes('aria-checked')).toBe('false')
    expect(termSwitch.classes()).not.toContain('launcher-switch-on')
    await termSwitch.trigger('click')
    expect(wrapper.emitted('toggleEnabled')[1]).toEqual(['k-term', true])
  })

  it('locks the switch for a missing CLI until a command override rescues it', () => {
    const missing = makeRow({ key: 'k-claude', id: 'claude', agentId: 'claude', title: 'Claude' })
    const wrapper = render({ rows: [missing] })

    const lockedSwitch = wrapper.get('[data-launcher-enabled="claude"]')
    expect(lockedSwitch.attributes('disabled')).toBeDefined()
    // Enabled in config, but an uninstalled CLI still presents as off.
    expect(lockedSwitch.attributes('aria-checked')).toBe('false')
    expect(lockedSwitch.attributes('title')).toBe('Install the CLI or set a command override first')

    const overridden = makeRow({
      key: 'k-claude', id: 'claude', agentId: 'claude', title: 'Claude', binary: '/opt/claude-dev',
    })
    const rescued = render({ rows: [overridden] })
    expect(rescued.text()).toContain('/opt/claude-dev')
    expect(rescued.text()).toContain('Ready')
    expect(rescued.get('[data-launcher-enabled="claude"]').attributes('disabled')).toBeUndefined()
    expect(rescued.get('[data-launcher-enabled="claude"]').attributes('aria-checked')).toBe('true')
  })

  it('emits toggleOpen from both the title and Customise, mirroring openId in the UI', async () => {
    const closed = render({ rows: [makeRow()] })
    expect(closed.find('[data-launcher-args]').exists()).toBe(false)
    expect(closed.get('[data-launcher-customize="codex"]').text()).toBe('Customise')

    await closed.get('[data-launcher-customize="codex"]').trigger('click')
    await closed.get('[aria-controls="launcher-details-k-codex"]').trigger('click')
    expect(closed.emitted('toggleOpen')).toEqual([['k-codex'], ['k-codex']])

    const open = render({ rows: [makeRow()], openId: 'k-codex' })
    expect(open.get('[aria-controls="launcher-details-k-codex"]').attributes('aria-expanded')).toBe('true')
    expect(open.get('[data-launcher-customize="codex"]').text()).toBe('Close')
    expect(open.get('[data-launcher-args]').attributes('placeholder')).toBe('--model gpt-5 --full-auto')
  })

  it('edits flags and working directory directly on the row model', async () => {
    const row = makeRow()
    const wrapper = render({ rows: [row], openId: 'k-codex' })

    await wrapper.get('[data-launcher-args]').setValue('--model gpt-5 --sandbox')
    expect(row.flagsText).toBe('--model gpt-5 --sandbox')

    const segments = wrapper.get('.launcher-segments').findAll('button')
    expect(segments.map((b) => b.text())).toEqual(['Project', 'Home', 'Custom'])
    expect(segments[0].attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('input[placeholder="/absolute/path"]').exists()).toBe(false)

    await segments[2].trigger('click')
    expect(row.cwdMode).toBe('custom')
    expect(segments[2].attributes('aria-pressed')).toBe('true')

    await wrapper.get('input[placeholder="/absolute/path"]').setValue('/tmp/projects')
    expect(row.cwdPath).toBe('/tmp/projects')
  })

  it('discloses advanced details and edits identity, binary, and environment in place', async () => {
    const row = makeRow()
    const wrapper = render({ rows: [row], openId: 'k-codex' })

    await wrapper.get('[data-launcher-advanced="codex"]').trigger('click')
    expect(wrapper.emitted('toggleAdvanced')).toEqual([['k-codex']])
    expect(wrapper.find('[data-launcher-id]').exists()).toBe(false)

    const advanced = render({ rows: [row], openId: 'k-codex', advancedId: 'k-codex' })
    expect(advanced.get('[data-launcher-advanced="codex"]').attributes('aria-expanded')).toBe('true')

    const nameField = advanced
      .findAll('label.launcher-field')
      .find((label) => label.find('span').text() === 'Name')
    await nameField.get('input').setValue('Codex Dev')
    expect(row.title).toBe('Codex Dev')

    await advanced.get('[data-launcher-id]').setValue('codex-dev')
    expect(row.id).toBe('codex-dev')

    const binary = advanced.get('[data-launcher-binary]')
    expect(binary.attributes('placeholder')).toBe('Use the detected command')
    await binary.setValue('/usr/local/bin/codex')
    expect(row.binary).toBe('/usr/local/bin/codex')

    await advanced.get('[data-launcher-env]').setValue('MIM_MODE=fast\nDEBUG=1')
    expect(row.envText).toBe('MIM_MODE=fast\nDEBUG=1')
  })

  it('emits remove with the row key from the advanced panel', async () => {
    const wrapper = render({ rows: [makeRow()], openId: 'k-codex', advancedId: 'k-codex' })

    const remove = wrapper.findAll('button').find((b) => b.text() === 'Remove preset')
    await remove.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['k-codex']])
  })
})
