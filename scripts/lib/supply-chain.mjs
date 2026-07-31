import { createHash } from 'node:crypto'

const SPDX_TOKEN = /\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/g

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function parseCargoLock(source) {
  return source
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map(block => {
      const field = name => block.match(new RegExp(`^${name} = "([^"]*)"`, 'm'))?.[1] ?? ''
      return {
        ecosystem: 'cargo',
        name: field('name'),
        version: field('version'),
        source: field('source'),
        checksum: field('checksum'),
      }
    })
    .filter(component => component.name && component.version)
}

export function parseBunLock(source) {
  const packagesOffset = source.indexOf('  "packages": {')
  if (packagesOffset === -1) throw new Error('bun.lock has no packages table')
  const packagesSource = source.slice(packagesOffset)
  const entries = []
  const pattern = /^ {4}("(?:[^"\\]|\\.)+"): \[("(?:[^"\\]|\\.)+"),.*,\s*("(?:[^"\\]|\\.)*")\],?$/gm
  for (const match of packagesSource.matchAll(pattern)) {
    const lockKey = JSON.parse(match[1])
    const spec = JSON.parse(match[2])
    const integrity = JSON.parse(match[3])
    const separator = spec.lastIndexOf('@')
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`unsupported bun.lock package identity: ${spec}`)
    }
    entries.push({
      ecosystem: 'npm',
      lockKey,
      name: spec.slice(0, separator),
      version: spec.slice(separator + 1),
      integrity,
    })
  }
  if (!entries.length) throw new Error('bun.lock packages table is empty or unsupported')
  const declaredEntries = packagesSource.match(/^ {4}"(?:[^"\\]|\\.)+": \[/gm)?.length ?? 0
  if (entries.length !== declaredEntries) {
    throw new Error(
      `bun.lock package format is unsupported (${entries.length}/${declaredEntries} entries parsed)`,
    )
  }
  return entries
}

export function componentId(component) {
  return `${component.ecosystem}:${component.name}@${component.version}`
}

export function canonicalLicense(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return ''
  return expression
    .trim()
    .replace(/\s*\/\s*/g, ' OR ')
    .replace(/\s+/g, ' ')
}

export function evaluateLicense(expression, policy) {
  const normalized = canonicalLicense(expression)
  if (!normalized) return { allowed: false, unknown: ['NOASSERTION'], denied: [] }
  const tokens = normalized.match(SPDX_TOKEN) ?? []
  let offset = 0
  const unknown = new Set()
  const denied = new Set()

  const leaf = token => {
    if (policy.allowedLicenses.includes(token)) return true
    if (policy.deniedLicensePrefixes.some(prefix => token.startsWith(prefix))) {
      denied.add(token)
    } else {
      unknown.add(token)
    }
    return false
  }
  const exception = token => {
    if (policy.allowedExceptions.includes(token)) return true
    unknown.add(token)
    return false
  }
  const primary = () => {
    if (tokens[offset] === '(') {
      offset += 1
      const value = or()
      if (tokens[offset] !== ')') throw new Error(`invalid license expression: ${expression}`)
      offset += 1
      return value
    }
    const token = tokens[offset]
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token)) {
      throw new Error(`invalid license expression: ${expression}`)
    }
    offset += 1
    let value = leaf(token)
    if (tokens[offset] === 'WITH') {
      offset += 1
      const exceptionToken = tokens[offset]
      if (!exceptionToken) throw new Error(`invalid license exception: ${expression}`)
      offset += 1
      value = value && exception(exceptionToken)
    }
    return value
  }
  const and = () => {
    let value = primary()
    while (tokens[offset] === 'AND') {
      offset += 1
      value = primary() && value
    }
    return value
  }
  const or = () => {
    let value = and()
    while (tokens[offset] === 'OR') {
      offset += 1
      value = and() || value
    }
    return value
  }
  const allowed = or()
  if (offset !== tokens.length) throw new Error(`invalid license expression: ${expression}`)
  return { allowed, unknown: [...unknown].sort(), denied: [...denied].sort() }
}

export function assertAllowedLicense(component, policy) {
  const id = component.id ?? componentId(component)
  if (policy.firstParty.includes(id)) return 'NOASSERTION'
  const override = policy.overrides[id]
  const declared = canonicalLicense(override?.license ?? component.license)
  const result = evaluateLicense(declared, policy)
  if (!result.allowed || result.unknown.length) {
    const reasons = [
      result.denied.length ? `denied: ${result.denied.join(', ')}` : '',
      result.unknown.length ? `unknown: ${result.unknown.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`${id} has no permitted license choice (${declared || 'missing'}; ${reasons})`)
  }
  return declared
}

export function assertLicensePolicy(policy, knownComponentIds = null) {
  for (const key of [
    'allowedLicenses',
    'allowedExceptions',
    'deniedLicensePrefixes',
    'firstParty',
    'vendorComponents',
  ]) {
    if (!Array.isArray(policy[key])) throw new Error(`license policy ${key} must be an array`)
  }
  if (!policy.overrides || typeof policy.overrides !== 'object' || Array.isArray(policy.overrides)) {
    throw new Error('license policy overrides must be an object')
  }
  for (const key of ['allowedLicenses', 'allowedExceptions', 'deniedLicensePrefixes']) {
    const values = policy[key]
    if (
      values.some(value => typeof value !== 'string' || !value.trim())
      || new Set(values).size !== values.length
    ) {
      throw new Error(`license policy ${key} must contain unique non-empty strings`)
    }
  }
  for (const id of policy.firstParty) {
    if (!/^(cargo|npm):[^*]+@[^*@]+$/.test(id)) {
      throw new Error(`first-party license identity must be exact and versioned: ${id}`)
    }
    if (knownComponentIds && !knownComponentIds.has(id)) {
      throw new Error(`stale first-party license identity: ${id}`)
    }
  }
  for (const [id, override] of Object.entries(policy.overrides)) {
    if (!/^(cargo|npm):[^*]+@[^*@]+$/.test(id)) {
      throw new Error(`license override must be exact and versioned: ${id}`)
    }
    if (knownComponentIds && !knownComponentIds.has(id)) {
      throw new Error(`stale license override: ${id}`)
    }
    if (
      typeof override.reason !== 'string'
      || override.reason.trim().length < 20
      || typeof override.evidence !== 'string'
      || !override.evidence.startsWith('https://')
    ) {
      throw new Error(`license override ${id} needs a substantive reason and public HTTPS evidence`)
    }
    const result = evaluateLicense(override.license, policy)
    if (!result.allowed || result.unknown.length) {
      throw new Error(`license override ${id} does not conclude to a reviewed permitted license`)
    }
  }
  const vendorIds = new Set()
  for (const component of policy.vendorComponents) {
    if (
      !component.id
      || vendorIds.has(component.id)
      || typeof component.downloadLocation !== 'string'
      || !component.downloadLocation.startsWith('https://')
    ) {
      throw new Error('vendor/model policy entries need unique ids and immutable HTTPS locations')
    }
    vendorIds.add(component.id)
    assertAllowedLicense(component, policy)
  }
}

export function lockedIdentities(cargoLock, bunLock) {
  const cargo = new Set(parseCargoLock(cargoLock).map(componentId))
  const npm = new Set(parseBunLock(bunLock).map(componentId))
  return { cargo, npm }
}

export function assertCompleteInventory(document, cargoLock, bunLock, policy) {
  if (document.spdxVersion !== 'SPDX-2.3') throw new Error('SBOM must use SPDX 2.3')
  const expected = lockedIdentities(cargoLock, bunLock)
  const actual = { cargo: new Set(), npm: new Set() }
  const seen = new Set()
  for (const component of document.packages ?? []) {
    const id = component.annotations?.find(annotation => (
      annotation.annotationType === 'OTHER'
      && annotation.comment.startsWith('mimir-component-id:')
    ))?.comment.slice('mimir-component-id:'.length)
    if (!id) continue
    if (seen.has(id)) throw new Error(`duplicate SBOM component identity: ${id}`)
    seen.add(id)
    const ecosystem = id.split(':', 1)[0]
    if (actual[ecosystem]) actual[ecosystem].add(id)
    assertAllowedLicense({
      id,
      license: component.licenseDeclared === 'NOASSERTION' ? '' : component.licenseDeclared,
    }, policy)
  }
  for (const ecosystem of ['cargo', 'npm']) {
    const missing = [...expected[ecosystem]].filter(id => !actual[ecosystem].has(id))
    const stale = [...actual[ecosystem]].filter(id => !expected[ecosystem].has(id))
    if (missing.length || stale.length) {
      throw new Error(
        `${ecosystem} SBOM drift; missing [${missing.join(', ')}], stale [${stale.join(', ')}]`,
      )
    }
  }
}

export function renderLicenseInventory(document) {
  const packages = [...document.packages].sort((left, right) => {
    const leftId = componentAnnotation(left)
    const rightId = componentAnnotation(right)
    return leftId.localeCompare(rightId)
  })
  const counts = new Map()
  for (const component of packages) {
    const ecosystem = componentAnnotation(component).split(':', 1)[0]
    counts.set(ecosystem, (counts.get(ecosystem) ?? 0) + 1)
  }
  const rows = packages.map(component => {
    const id = componentAnnotation(component)
    const location = component.downloadLocation === 'NOASSERTION'
      ? 'first-party'
      : component.downloadLocation
    const checksum = component.checksums?.[0]?.checksumValue ?? ''
    return `| ${escapeCell(id)} | ${escapeCell(component.licenseDeclared)} | ${escapeCell(location)} | ${checksum} |`
  })
  return [
    '# Mimir locked third-party license inventory',
    '',
    'Generated from `src-tauri/Cargo.lock`, `bun.lock`, and the reviewed',
    '`src-tauri/vendor/license-policy.json`. Do not edit this file manually.',
    'Regenerate it together with `SBOM.spdx.json` using',
    '`bun run supply-chain:generate`.',
    '',
    `Inventory: ${counts.get('cargo') ?? 0} Cargo packages, ${counts.get('npm') ?? 0} npm packages, and ${(counts.get('vendor') ?? 0) + (counts.get('model') ?? 0)} reviewed embedded/downloadable assets.`,
    '',
    'A license expression is accepted only when the policy contains a permitted',
    'choice. Unknown identifiers and expressions with no permitted choice fail the',
    'release gate. Special copyright and full-text notices for adapted code and',
    'model assets remain in `THIRD_PARTY_NOTICES.md`.',
    '',
    '| Component | Declared/concluded license | Registry or source | Locked checksum |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

export function componentAnnotation(component) {
  return component.annotations?.find(annotation => (
    annotation.annotationType === 'OTHER'
    && annotation.comment.startsWith('mimir-component-id:')
  ))?.comment.slice('mimir-component-id:'.length) ?? ''
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}
