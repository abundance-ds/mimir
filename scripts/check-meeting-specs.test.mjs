import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkMeetingSpecs } from './check-meeting-specs.mjs'

test('accepts a fully traced RED meeting feature', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', `
@meetings
Feature: Example

  @MTG-001 @red @domain
  Scenario: Traced behavior
    Given an initial state
    When an action occurs
    Then the outcome is durable
`)
  writeManifest(fixture, {
    suites: [suite('example.feature', 'MTG-001', 'MTG-001')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, true, checked.failures.join('\n'))
  assert.equal(checked.featureCount, 1)
  assert.equal(checked.scenarioCount, 1)
})

test('rejects duplicate IDs, missing RED tags, and missing evidence tags', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', `
Feature: Example

  @MTG-001
  Scenario: First behavior
    Given an initial state
    When an action occurs
    Then an outcome exists

  @MTG-001 @red
  Scenario: Duplicate behavior
    Given another state
    When another action occurs
    Then another outcome exists
`)
  writeManifest(fixture, {
    suites: [suite('example.feature', 'MTG-001', 'MTG-002')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /missing required @red tag/)
  assert.match(checked.failures.join('\n'), /must carry at least one manifest evidence tag/)
  assert.match(checked.failures.join('\n'), /duplicate MTG-001/)
  assert.match(checked.failures.join('\n'), /scenario IDs must exactly match manifest idRange/)
})

test('rejects an unmanifested meeting feature', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', validFeature('MTG-001'))
  writeFeature(fixture, 'untracked.feature', validFeature('MTG-002'))
  writeManifest(fixture, {
    suites: [suite('example.feature', 'MTG-001', 'MTG-001')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(
    checked.failures.join('\n'),
    /every meeting \.feature file must be manifested exactly once/,
  )
})

test('rejects scenarios without complete Given When Then structure', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', `
Feature: Example

  @MTG-001 @red @native
  Scenario: Missing outcome
    Given an initial state
    When an action occurs
`)
  writeManifest(fixture, {
    suites: [suite('example.feature', 'MTG-001', 'MTG-001')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /must contain a Then step/)
})

test('rejects malformed or absent evidence ownership', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', validFeature('MTG-001'))
  const invalidSuite = suite('example.feature', 'MTG-001', 'MTG-001')
  invalidSuite.owner = ''
  invalidSuite.plannedEvidence = []
  writeManifest(fixture, { suites: [invalidSuite] })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /owner must name one evidence owner/)
  assert.match(checked.failures.join('\n'), /plannedEvidence must contain/)
})

function createFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mimir-meeting-specs-'))
  fs.mkdirSync(path.join(fixture, 'features', 'meetings'), { recursive: true })
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  return fixture
}

function writeFeature(root, name, source) {
  fs.writeFileSync(path.join(root, 'features', 'meetings', name), source.trimStart())
}

function writeManifest(root, overrides) {
  const manifest = {
    schemaVersion: 1,
    phase: 'red',
    idPattern: '^MTG-[0-9]{3}$',
    requiredScenarioTags: ['red'],
    evidenceTags: ['domain', 'native'],
    performanceBudgets: {
      audioCallbackP99MaximumFrameFraction: 0.25,
      channelDriftMaximumMillisecondsOverFourHours: 20,
      forcedTerminationUncertainAudioMaximumSeconds: 2,
      levelProjectionMaximumHertz: 10,
      provisionalTranscriptProjectionMaximumHertz: 5,
      providerStallSeconds: 30,
      captureSoakHours: 4,
      detectionSoakHours: 24,
      lifecycleCycles: 100,
      largeTranscriptWords: 100000,
      accuracyPolicy: 'Versioned release baseline.',
    },
    suites: [],
    ...overrides,
  }
  fs.writeFileSync(
    path.join(root, 'features', 'meetings', 'evidence.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

function suite(name, firstId, lastId) {
  return {
    feature: `features/meetings/${name}`,
    idRange: [firstId, lastId],
    owner: 'meeting-test-owner',
    plannedEvidence: ['native executable scenario'],
  }
}

function validFeature(id) {
  return `
Feature: Example

  @${id} @red @domain
  Scenario: Traced behavior
    Given an initial state
    When an action occurs
    Then the outcome is durable
`
}
