// Validate the canonical RED Gherkin contract under features/meetings.
//
// This checker is intentionally dependency-free. It validates the repository's
// constrained feature-file shape; it is not a general Gherkin interpreter.
//
// Usage:
//   node scripts/check-meeting-specs.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_EVIDENCE_TAGS = new Set([
  'domain',
  'native',
  'renderer',
  'desktop',
  'hardware',
  'contract',
  'security',
  'legal',
  'recovery',
  'performance',
  'accessibility',
  'packaging',
  'release',
  'supply-chain',
])

export function checkMeetingSpecs({
  root = process.cwd(),
  manifestPath = path.join(root, 'features', 'meetings', 'evidence.json'),
} = {}) {
  const failures = []
  const manifest = readJson(manifestPath, failures)
  if (!manifest) return result(failures, 0, 0)

  const manifestRelative = relative(root, manifestPath)
  if (manifest.schemaVersion !== 1) {
    failures.push(`${manifestRelative}: schemaVersion must be 1`)
  }
  if (manifest.phase !== 'red') {
    failures.push(`${manifestRelative}: phase must remain 'red' for the specification foundation`)
  }

  const idPattern = compilePattern(manifest.idPattern, manifestRelative, failures)
  const requiredTags = stringSet(
    manifest.requiredScenarioTags,
    `${manifestRelative}: requiredScenarioTags`,
    failures,
  )
  const evidenceTags = stringSet(
    manifest.evidenceTags,
    `${manifestRelative}: evidenceTags`,
    failures,
  )
  if (evidenceTags.size === 0) {
    for (const tag of DEFAULT_EVIDENCE_TAGS) evidenceTags.add(tag)
  }

  if (!Array.isArray(manifest.suites) || manifest.suites.length === 0) {
    failures.push(`${manifestRelative}: suites must be a non-empty array`)
    return result(failures, 0, 0)
  }

  const featureDir = path.dirname(manifestPath)
  const actualFeatures = fs.existsSync(featureDir)
    ? fs.readdirSync(featureDir)
      .filter((name) => name.endsWith('.feature'))
      .map((name) => relative(root, path.join(featureDir, name)))
      .sort()
    : []
  const manifestFeatures = []
  const globalIds = new Map()
  let scenarioCount = 0

  for (const [suiteIndex, suite] of manifest.suites.entries()) {
    const label = `${manifestRelative}: suites[${suiteIndex}]`
    if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
      failures.push(`${label} must be an object`)
      continue
    }

    const feature = normalizeRelativePath(suite.feature)
    if (!feature) {
      failures.push(`${label}.feature must be a repository-relative .feature path`)
      continue
    }
    manifestFeatures.push(feature)

    if (typeof suite.owner !== 'string' || !suite.owner.trim()) {
      failures.push(`${label}.owner must name one evidence owner`)
    }
    if (
      !Array.isArray(suite.plannedEvidence)
      || suite.plannedEvidence.length === 0
      || suite.plannedEvidence.some((entry) => typeof entry !== 'string' || !entry.trim())
    ) {
      failures.push(`${label}.plannedEvidence must contain non-empty RED evidence descriptions`)
    }

    const expectedIds = expandIdRange(suite.idRange, label, idPattern, failures)
    const absoluteFeature = path.join(root, feature)
    if (!fs.existsSync(absoluteFeature)) {
      failures.push(`${feature}: manifest feature does not exist`)
      continue
    }

    const parsed = parseFeature(absoluteFeature, root, failures)
    scenarioCount += parsed.scenarios.length
    if (parsed.featureCount !== 1) {
      failures.push(`${feature}: expected exactly one Feature declaration, found ${parsed.featureCount}`)
    }
    if (parsed.scenarios.length === 0) {
      failures.push(`${feature}: must contain at least one Scenario`)
    }

    const actualIds = []
    for (const scenario of parsed.scenarios) {
      const location = `${feature}:${scenario.line}`
      const matchingIds = scenario.tags.filter((tag) => idPattern?.test(tag))
      if (matchingIds.length !== 1) {
        failures.push(`${location}: scenario must have exactly one stable MTG ID tag`)
      } else {
        const id = matchingIds[0]
        actualIds.push(id)
        if (globalIds.has(id)) {
          failures.push(`${location}: duplicate ${id}; first declared at ${globalIds.get(id)}`)
        } else {
          globalIds.set(id, location)
        }
      }

      for (const tag of requiredTags) {
        if (!scenario.tags.includes(tag)) {
          failures.push(`${location}: missing required @${tag} tag`)
        }
      }
      if (!scenario.tags.some((tag) => evidenceTags.has(tag))) {
        failures.push(`${location}: must carry at least one manifest evidence tag`)
      }
      for (const keyword of ['Given', 'When', 'Then']) {
        if (!scenario.stepKeywords.has(keyword)) {
          failures.push(`${location}: scenario must contain a ${keyword} step`)
        }
      }
    }

    compareLists(
      expectedIds,
      actualIds,
      `${feature}: scenario IDs must exactly match manifest idRange`,
      failures,
    )
  }

  for (const [feature, count] of counts(manifestFeatures)) {
    if (count > 1) failures.push(`${manifestRelative}: feature '${feature}' is listed ${count} times`)
  }
  compareLists(
    actualFeatures,
    [...new Set(manifestFeatures)].sort(),
    `${manifestRelative}: every meeting .feature file must be manifested exactly once`,
    failures,
  )

  validatePerformanceBudgets(manifest.performanceBudgets, manifestRelative, failures)

  return result(failures, manifestFeatures.length, scenarioCount)
}

function parseFeature(file, root, failures) {
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/)
  const scenarios = []
  let featureCount = 0
  let pendingTags = []
  let current = null

  const finishScenario = () => {
    if (!current) return
    if (!current.name.trim()) {
      failures.push(`${relative(root, file)}:${current.line}: Scenario must have a name`)
    }
    scenarios.push(current)
    current = null
  }

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    const trimmed = lines[index].trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (trimmed.startsWith('@')) {
      pendingTags.push(...trimmed.split(/\s+/).map((tag) => tag.replace(/^@/, '')))
      continue
    }

    if (/^Feature\s*:/.test(trimmed)) {
      finishScenario()
      featureCount += 1
      pendingTags = []
      continue
    }

    const scenarioMatch = trimmed.match(/^Scenario(?: Outline)?\s*:\s*(.*)$/)
    if (scenarioMatch) {
      finishScenario()
      current = {
        line: lineNumber,
        name: scenarioMatch[1],
        tags: [...new Set(pendingTags)],
        stepKeywords: new Set(),
      }
      pendingTags = []
      continue
    }

    const stepMatch = trimmed.match(/^(Given|When|Then|And|But)\b/)
    if (stepMatch && current) {
      current.stepKeywords.add(stepMatch[1])
    }
  }

  finishScenario()
  return { featureCount, scenarios }
}

function expandIdRange(value, label, idPattern, failures) {
  if (!Array.isArray(value) || value.length !== 2) {
    failures.push(`${label}.idRange must be [firstId, lastId]`)
    return []
  }
  const [first, last] = value
  if (
    typeof first !== 'string'
    || typeof last !== 'string'
    || !idPattern?.test(first)
    || !idPattern?.test(last)
  ) {
    failures.push(`${label}.idRange must contain IDs matching the manifest idPattern`)
    return []
  }

  const firstMatch = first.match(/^(.*?)(\d+)$/)
  const lastMatch = last.match(/^(.*?)(\d+)$/)
  if (
    !firstMatch
    || !lastMatch
    || firstMatch[1] !== lastMatch[1]
    || firstMatch[2].length !== lastMatch[2].length
  ) {
    failures.push(`${label}.idRange endpoints must share a prefix and numeric width`)
    return []
  }

  const start = Number(firstMatch[2])
  const end = Number(lastMatch[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    failures.push(`${label}.idRange must be ascending`)
    return []
  }

  const ids = []
  for (let number = start; number <= end; number++) {
    ids.push(`${firstMatch[1]}${String(number).padStart(firstMatch[2].length, '0')}`)
  }
  return ids
}

function validatePerformanceBudgets(value, manifestRelative, failures) {
  const label = `${manifestRelative}: performanceBudgets`
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failures.push(`${label} must be an object`)
    return
  }

  const positiveNumbers = [
    'audioCallbackP99MaximumFrameFraction',
    'channelDriftMaximumMillisecondsOverFourHours',
    'forcedTerminationUncertainAudioMaximumSeconds',
    'levelProjectionMaximumHertz',
    'provisionalTranscriptProjectionMaximumHertz',
    'providerStallSeconds',
    'captureSoakHours',
    'detectionSoakHours',
    'lifecycleCycles',
    'largeTranscriptWords',
  ]
  for (const key of positiveNumbers) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) {
      failures.push(`${label}.${key} must be a positive finite number`)
    }
  }
  if (typeof value.accuracyPolicy !== 'string' || !value.accuracyPolicy.trim()) {
    failures.push(`${label}.accuracyPolicy must describe the release regression policy`)
  }
}

function readJson(file, failures) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`${file}: could not read evidence manifest: ${error.message}`)
    return null
  }
}

function compilePattern(value, label, failures) {
  if (typeof value !== 'string' || !value) {
    failures.push(`${label}: idPattern must be a non-empty regular expression`)
    return null
  }
  try {
    return new RegExp(value)
  } catch (error) {
    failures.push(`${label}: invalid idPattern: ${error.message}`)
    return null
  }
}

function stringSet(value, label, failures) {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    failures.push(`${label} must be an array of non-empty strings`)
    return new Set()
  }
  return new Set(value)
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value.endsWith('.feature') || path.isAbsolute(value)) {
    return null
  }
  const normalized = value.split('/').join(path.sep)
  if (normalized.split(path.sep).includes('..')) return null
  return normalized.split(path.sep).join('/')
}

function compareLists(expected, actual, label, failures) {
  if (expected.length === actual.length && expected.every((value, index) => value === actual[index])) {
    return
  }
  failures.push(`${label}; expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`)
}

function counts(values) {
  const result = new Map()
  for (const value of values) result.set(value, (result.get(value) || 0) + 1)
  return result
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function result(failures, featureCount, scenarioCount) {
  return {
    ok: failures.length === 0,
    failures,
    featureCount,
    scenarioCount,
  }
}

const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (directInvocation) {
  const checked = checkMeetingSpecs()
  if (!checked.ok) {
    console.error(`Meeting specification check failed (${checked.failures.length}):`)
    for (const failure of checked.failures) console.error(`- ${failure}`)
    process.exitCode = 1
  } else {
    console.log(
      `Meeting specification check passed: ${checked.featureCount} features, `
      + `${checked.scenarioCount} RED scenarios.`,
    )
  }
}
