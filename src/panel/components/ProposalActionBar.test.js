import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { IconChevronDown } from '@tabler/icons-vue'
import ProposalActionBar from './ProposalActionBar.vue'

function makeProposal(id, status = 'pending', path = 'file.md') {
  return { id, status, path, targetText: 'old\ntext', replacement: 'new\ntext\nmore' }
}

describe('ProposalActionBar', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountBar(proposals) {
    return mount(ProposalActionBar, { props: { proposals } })
  }

  it('shows correct pending file count (plural)', () => {
    const w = mountBar([
      makeProposal('1', 'pending', 'a.md'),
      makeProposal('2', 'pending', 'b.md'),
    ])
    expect(w.text()).toContain('2 files pending review')
  })

  it('shows singular pending file count', () => {
    const w = mountBar([makeProposal('1', 'pending', 'a.md')])
    expect(w.text()).toContain('1 file pending review')
  })

  it('emits review on Review click', async () => {
    const w = mountBar([makeProposal('1')])
    const btn = w.findAll('button').find(b => b.text() === 'Review')
    await btn.trigger('click')
    expect(w.emitted('review')).toHaveLength(1)
  })

  it('emits accept-all on Accept All click', async () => {
    const w = mountBar([makeProposal('1')])
    const btn = w.findAll('button').find(b => b.text() === 'Accept All')
    await btn.trigger('click')
    expect(w.emitted('accept-all')).toHaveLength(1)
  })

  it('emits reject-all on Reject All click', async () => {
    const w = mountBar([makeProposal('1')])
    const btn = w.findAll('button').find(b => b.text() === 'Reject All')
    await btn.trigger('click')
    expect(w.emitted('reject-all')).toHaveLength(1)
  })

  it('emits open-file with proposal on icon button click', async () => {
    const proposals = [makeProposal('p1', 'pending', 'test.md')]
    const w = mountBar(proposals)
    // Expand the file list by clicking the drawer bar
    await w.find('.drawer-bar').trigger('click')
    const openBtn = w.find('button[title="Open in Editor"]')
    await openBtn.trigger('click')
    expect(w.emitted('open-file')).toHaveLength(1)
    expect(w.emitted('open-file')[0][0].id).toBe('p1')
  })

  it('filters out resolved proposals (only shows pending)', () => {
    const w = mountBar([
      makeProposal('1', 'pending', 'a.md'),
      makeProposal('2', 'accepted', 'b.md'),
      makeProposal('3', 'rejected', 'c.md'),
    ])
    expect(w.text()).toContain('1 file pending review')
  })

  it('renders nothing when no pending proposals', () => {
    const w = mountBar([
      makeProposal('1', 'accepted', 'a.md'),
      makeProposal('2', 'rejected', 'b.md'),
    ])
    expect(w.find('div').exists()).toBe(false)
  })

  it('emits accept-file per proposal when clicking file accept', async () => {
    const w = mountBar([makeProposal('p1', 'pending', 'a.md')])
    await w.find('.drawer-bar').trigger('click')
    const btn = w.find('button[title="Accept"]')
    await btn.trigger('click')
    expect(w.emitted('accept-file')).toHaveLength(1)
    expect(w.emitted('accept-file')[0][0].id).toBe('p1')
  })

  it('emits reject-file per proposal when clicking file reject', async () => {
    const w = mountBar([makeProposal('p1', 'pending', 'a.md')])
    await w.find('.drawer-bar').trigger('click')
    const btn = w.find('button[title="Reject"]')
    await btn.trigger('click')
    expect(w.emitted('reject-file')).toHaveLength(1)
    expect(w.emitted('reject-file')[0][0].id).toBe('p1')
  })

  it('shows +N/-N delta per file', async () => {
    // 'a\nb' -> 2 lines, 'c\nd\ne\nf' -> 4 lines, no common -> +4 -2
    const w = mountBar([
      { id: '1', status: 'pending', path: 'x.md', targetText: 'a\nb', replacement: 'c\nd\ne\nf' },
    ])
    await w.find('.drawer-bar').trigger('click')
    expect(w.text()).toContain('+4')
    expect(w.text()).toContain('-2')
  })
})
