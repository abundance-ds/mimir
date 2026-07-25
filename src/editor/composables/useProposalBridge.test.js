import { describe, expect, it } from 'vitest'
import { computeCompoundDiff, computeDiffFromReview } from './useProposalBridge.js'

describe('proposal diff construction', () => {
  it('matches visible editor text across fixed pseudo-XML comment annotations', () => {
    const content = 'A <comment id="c1" author="user" text="Review">careful</comment> sentence.'
    const diff = computeDiffFromReview({
      targetText: 'A careful sentence.',
      replacement: 'A precise sentence.',
    }, content)

    expect(diff).toEqual({
      original: content,
      modified: 'A precise sentence.',
    })
  })

  it('rejects overlapping compound reviews instead of producing a corrupt merge', () => {
    expect(computeCompoundDiff([
      { targetText: 'alpha beta', replacement: 'one' },
      { targetText: 'beta gamma', replacement: 'two' },
    ], 'alpha beta gamma')).toBeNull()
  })
})
