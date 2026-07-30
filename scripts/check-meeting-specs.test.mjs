import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkMeetingSpecs } from './check-meeting-specs.mjs'

test('accepts an automated implementation scenario traced to a real test selector', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', validFeature('MTG-001', 'automated'))
  writeRustTest(fixture, 'tests/behavior.rs', 'traced_behavior')
  writeManifest(fixture, {
    automatedEvidence: [evidence('MTG-001')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, true, checked.failures.join('\n'))
  assert.equal(checked.scenarioCount, 1)
})

test('accepts a manual scenario only as unclaimed structured evidence', (t) => {
  const fixture = createFixture(t)
  writeFeature(
    fixture,
    'example.feature',
    validFeature('MTG-001', 'manual', '@hardware'),
  )
  writeManifest(fixture, {
    automatedEvidence: [],
    manualEvidence: {
      'MTG-001': {
        procedure: 'Exercise the signed fixture on release-reference hardware.',
        requiredArtifacts: ['build identity', 'measurement report'],
        records: [],
      },
    },
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, true, checked.failures.join('\n'))
})

test('rejects missing and stale automated selectors', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', validFeature('MTG-001', 'automated'))
  writeRustTest(fixture, 'tests/behavior.rs', 'real_behavior')
  writeManifest(fixture, {
    automatedEvidence: [evidence('MTG-001', 'missing_behavior')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /selector 'missing_behavior' is stale/)
})

test('rejects ignored Rust tests and skipped JavaScript tests as evidence', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', validFeature('MTG-001', 'automated'))
  const file = path.join(fixture, 'tests', 'behavior.rs')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#[test]\n#[ignore]\nfn traced_behavior() {}\n')
  writeManifest(fixture, {
    automatedEvidence: [evidence('MTG-001')],
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /ignored and cannot count as passed evidence/)
})

test('rejects placeholder evidence and a bare manual pass claim', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', validFeature('MTG-001', 'manual'))
  writeManifest(fixture, {
    automatedEvidence: [],
    manualEvidence: {
      'MTG-001': {
        procedure: 'TODO run it later',
        requiredArtifacts: ['report'],
        records: [],
        status: 'passed',
      },
    },
  })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /placeholder or pending language/)
  assert.match(checked.failures.join('\n'), /cannot claim pass status/)
})

test('rejects RED tags, ambiguous execution tags, and automated hardware claims', (t) => {
  const fixture = createFixture(t)
  writeFeature(fixture, 'example.feature', `
Feature: Example

  @MTG-001 @red @automated @manual @hardware @native
  Scenario: Invalid phase tags
    Given an initial state
    When an action occurs
    Then the outcome is durable
`)
  writeManifest(fixture, { automatedEvidence: [] })

  const checked = checkMeetingSpecs({ root: fixture })

  assert.equal(checked.ok, false)
  assert.match(checked.failures.join('\n'), /obsolete @red/)
  assert.match(checked.failures.join('\n'), /exactly one @automated or @manual/)
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

function writeRustTest(root, name, selector) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#[test]\nfn ${selector}() {}\n`)
}

function writeManifest(root, overrides = {}) {
  const manifest = {
    schemaVersion: 2,
    phase: 'implementation',
    idPattern: '^MTG-[0-9]{3}$',
    evidenceTags: ['domain', 'native', 'hardware'],
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
    suites: [{
      feature: 'features/meetings/example.feature',
      idRange: ['MTG-001', 'MTG-001'],
      owner: 'meeting-test-owner',
      verificationScope: ['executable behavior'],
    }],
    automatedEvidence: [],
    manualEvidence: {},
    ...overrides,
  }
  fs.writeFileSync(
    path.join(root, 'features', 'meetings', 'evidence.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

function evidence(id, selector = 'traced_behavior') {
  return {
    kind: 'rust-test',
    path: 'tests/behavior.rs',
    selector,
    scenarios: [id],
  }
}

function validFeature(id, mode, extraTag = '') {
  return `
Feature: Example

  @${id} @${mode} @native ${extraTag}
  Scenario: Traced behavior
    Given an initial state
    When an action occurs
    Then the outcome is durable
`
}
