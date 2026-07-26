import { describe, expect, it } from 'vitest'
import { formatLauncherFlags, parseLauncherFlags } from './launcherFlags.js'

describe('launcher flag editing', () => {
  it('turns a familiar CLI command line into exact argv entries', () => {
    expect(parseLauncherFlags('--model "gpt 5" --label=hello\\ world \'\''))
      .toEqual(['--model', 'gpt 5', '--label=hello world', ''])
  })

  it('formats arbitrary argv without losing empty, padded, or quoted values', () => {
    const args = ['--model', 'gpt 5', '  padded  ', '', `it's-safe`]
    expect(parseLauncherFlags(formatLauncherFlags(args))).toEqual(args)
  })

  it('reports unfinished input instead of silently saving the wrong argv', () => {
    expect(() => parseLauncherFlags('--model "gpt 5')).toThrow('unclosed double quote')
    expect(() => parseLauncherFlags('--label hello\\')).toThrow('unfinished escape')
  })
})
