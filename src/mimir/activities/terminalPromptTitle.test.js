import { describe, expect, it } from 'vitest'
import {
  createTerminalPromptTitleTracker,
  deriveProvisionalActivityTitle,
} from './terminalPromptTitle.js'

describe('terminal prompt titles', () => {
  it.each([
    [
      'README.md docs/_MAP.md\n\nwir haben schon wieder auto titel erstellung verloren.',
      'Auto titel erstellung verloren',
    ],
    [
      '2026-08-14 10:20:30 ERROR worker failed\nat runtime.js:42\nWhat is going on with the startup panic?',
      'What is going on with the startup panic',
    ],
    [
      'Please restore reliable Activity titles across every supported provider today.',
      'Restore reliable Activity titles across every supported',
    ],
    [
      'check KG for "vandage" and "ai native heor"',
      'Check KG for "vandage" and "ai native heor"',
    ],
  ])('derives a bounded task label from %j', (prompt, expected) => {
    expect(deriveProvisionalActivityTitle(prompt)).toBe(expected)
  })

  it('removes secrets, URLs, path-only context, and fenced code', () => {
    const prompt = [
      'src/private/config.ts README.md',
      '```',
      'const token = "sk-secretsecretsecretsecret"',
      '```',
      'Fix authentication at https://example.test/?token=secret',
    ].join('\n')
    expect(deriveProvisionalActivityTitle(prompt)).toBe('Fix authentication')
    expect(deriveProvisionalActivityTitle(
      'Fix authentication with password=hunter2 and api_key="private-value"',
    )).toBe('Fix authentication')
  })

  it('reconstructs editing and bracketed paste before Enter', () => {
    const tracker = createTerminalPromptTitleTracker()
    tracker.feed('Fix activitx')
    tracker.feed('\u007f')
    tracker.feed('y titles')
    expect(tracker.feed('\r')).toBe('Fix activity titles')

    tracker.feed('\u001b[200~README.md docs/_MAP.md\nRestore title fallback\u001b[201~')
    expect(tracker.feed('\r')).toBe('Restore title fallback')
  })

  it('ignores slash commands and preserves Shift+Enter line breaks', () => {
    const tracker = createTerminalPromptTitleTracker()
    tracker.feed('/model gpt-5.6')
    expect(tracker.feed('\r')).toBe('')
    tracker.feed('Investigate the title')
    tracker.feed('\n')
    tracker.feed('fallback regression')
    expect(tracker.feed('\r')).toBe('Investigate the title')
  })

  it('waits past setup confirmations for a substantive prompt', () => {
    const tracker = createTerminalPromptTitleTracker()
    tracker.feed('yes')
    expect(tracker.feed('\r')).toBe('')
    tracker.feed('Fix the Activity title regression')
    expect(tracker.feed('\r')).toBe('Fix the Activity title regression')
  })

  it('handles common line-editing controls without exposing callbacks', () => {
    const tracker = createTerminalPromptTitleTracker()
    tracker.feed('wrong words')
    tracker.feed('\u0015')
    tracker.feed('Review title source')
    tracker.feed('\u0017')
    tracker.feed(' priority')
    expect(tracker.feed('\r')).toBe('Review title priority')
  })

  it('tracks cursor edits and fails closed after history navigation', () => {
    const tracker = createTerminalPromptTitleTracker()
    tracker.feed('Fix title sorce')
    tracker.feed('\u001b[D\u001b[D\u001b[D')
    tracker.feed('u')
    expect(tracker.feed('\r')).toBe('Fix title source')

    tracker.feed('Unrelated draft')
    tracker.feed('\u001b[A')
    expect(tracker.feed('\r')).toBe('')
  })

  it('discards terminal color replies even when their terminator is split', () => {
    const response = [
      '\u001b]10;rgb:f8f8/f8f8/f2f2\u001b\\',
      '\u001b]11;rgb:2727/2828/2222\u0007',
    ].join('')
    for (let split = 1; split < response.length; split += 1) {
      const tracker = createTerminalPromptTitleTracker()
      tracker.feed(response.slice(0, split))
      tracker.feed(response.slice(split))
      tracker.feed('tiny test')
      expect(tracker.feed('\r')).toBe('Tiny test')
    }
  })

  it.each([
    ['DCS', '\u001bP1$r0m\u001b\\'],
    ['APC', '\u001b_hidden metadata\u001b\\'],
    ['PM', '\u001b^private message\u001b\\'],
    ['SOS', '\u001bXstart of string\u001b\\'],
  ])('discards split %s control strings', (_name, response) => {
    for (let split = 1; split < response.length; split += 1) {
      const tracker = createTerminalPromptTitleTracker()
      tracker.feed(response.slice(0, split))
      tracker.feed(response.slice(split))
      tracker.feed('tiny test')
      expect(tracker.feed('\r')).toBe('Tiny test')
    }
  })

  it.each([
    ['CSI', '\u001b[D'],
    ['SS3', '\u001bOD'],
    ['C1 CSI', '\u009bD'],
    ['C1 SS3', '\u008fD'],
  ])('retains split %s sequences until their final byte', (_name, sequence) => {
    for (let split = 1; split < sequence.length; split += 1) {
      const tracker = createTerminalPromptTitleTracker()
      tracker.feed('Fix title source')
      tracker.feed(sequence.slice(0, split))
      tracker.feed(sequence.slice(split))
      expect(tracker.feed('\r')).toBe('Fix title source')
    }
  })

  it('recognizes bracketed paste markers split at every byte boundary', () => {
    const wrapped = '\u001b[200~tiny test\u001b[201~'
    for (let split = 1; split < wrapped.length; split += 1) {
      const tracker = createTerminalPromptTitleTracker()
      tracker.feed(wrapped.slice(0, split))
      tracker.feed(wrapped.slice(split))
      expect(tracker.feed('\r')).toBe('Tiny test')
    }
  })

  it('fails closed on an oversized unterminated control sequence', () => {
    const tracker = createTerminalPromptTitleTracker()
    tracker.feed('Fix title source')
    tracker.feed(`\u001b[${'1'.repeat(300)}`)
    tracker.feed('D')
    expect(tracker.feed('\r')).toBe('')
  })
})
