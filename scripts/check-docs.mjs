import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const docsDir = path.join(root, 'docs')
const markdownFiles = [
  path.join(root, 'README.md'),
  ...markdownUnder(docsDir),
]
const failures = []

for (const file of markdownFiles) {
  const source = fs.readFileSync(file, 'utf8')
  checkLinks(file, source)
  checkRepositoryPaths(file, source)
}

checkDocumentationRouting()
checkVersionConsistency()

if (failures.length) {
  console.error(`Documentation check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Documentation check passed (${markdownFiles.length} Markdown files).`)
}

function checkLinks(file, source) {
  for (const match of source.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '')
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
      continue
    }
    const [encodedPath, anchor = ''] = rawTarget.split('#', 2)
    const targetPath = path.resolve(path.dirname(file), decodeURIComponent(encodedPath))
    if (!fs.existsSync(targetPath)) {
      fail(file, `broken link '${rawTarget}'`)
      continue
    }
    if (anchor && targetPath.endsWith('.md')) {
      const targetSource = fs.readFileSync(targetPath, 'utf8')
      const anchors = markdownAnchors(targetSource)
      if (!anchors.has(decodeURIComponent(anchor).toLowerCase())) {
        fail(file, `missing anchor '${rawTarget}'`)
      }
    }
  }
}

function markdownAnchors(source) {
  const counts = new Map()
  const anchors = new Set()
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1]
      .trim()
      .toLowerCase()
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    const count = counts.get(base) || 0
    counts.set(base, count + 1)
    anchors.add(count ? `${base}-${count}` : base)
  }
  return anchors
}

function checkRepositoryPaths(file, source) {
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    let candidate = match[1].trim()
    if (!isRepositoryPath(candidate)) continue
    candidate = candidate
      .split('::', 1)[0]
      .replace(/[.,;:]$/, '')
    if (
      candidate.includes('*')
      || candidate.includes(',')
      || candidate.includes(' ')
      || candidate.includes('<')
      || candidate.includes('>')
    ) {
      continue
    }
    if (!fs.existsSync(path.resolve(root, candidate))) {
      fail(file, `missing repository path '${candidate}'`)
    }
  }
}

function isRepositoryPath(value) {
  return /^(?:src\/|src-tauri\/|scripts\/|bin\/|public\/|\.github\/|package\.json$|vite\.config\.js$|vitest\.config\.js$|README\.md$)/.test(value)
}

function checkDocumentationRouting() {
  const indexPath = path.join(docsDir, 'README.md')
  const referenceDir = path.join(docsDir, 'reference')
  const referenceIndexPath = path.join(referenceDir, 'README.md')
  const mapPath = path.join(referenceDir, '_MAP.md')
  if (!fs.existsSync(indexPath)) {
    failures.push('docs/README.md: missing active documentation entry point')
    return
  }
  if (!fs.existsSync(referenceIndexPath) || !fs.existsSync(mapPath)) {
    failures.push('docs/reference/: missing README.md or _MAP.md')
    return
  }
  const indexSource = fs.readFileSync(indexPath, 'utf8')
  if (!indexSource.includes('(reference/README.md)')) {
    fail(indexPath, 'does not route the reference archive')
  }
  const referenceIndexSource = fs.readFileSync(referenceIndexPath, 'utf8')
  if (!referenceIndexSource.includes('(_MAP.md)')) {
    fail(referenceIndexPath, 'does not route the archived codebase map')
  }
  const mapSource = fs.readFileSync(mapPath, 'utf8')
  for (const file of markdownFiles) {
    if (
      !file.startsWith(`${referenceDir}${path.sep}`)
      || file === mapPath
      || file === referenceIndexPath
    ) continue
    const target = path.relative(referenceDir, file).split(path.sep).join('/')
    if (!mapSource.includes(`(${target})`) && !mapSource.includes(`](${target}#`)) {
      fail(mapPath, `does not route '${target}'`)
    }
  }
}

function markdownUnder(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...markdownUnder(target))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target)
  }
  return files.sort()
}

function checkVersionConsistency() {
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).version
  const tauriVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
  ).version
  const cargoSource = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')
  const cargoVersion = cargoSource.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
  const versions = { package: packageVersion, tauri: tauriVersion, cargo: cargoVersion }
  if (new Set(Object.values(versions)).size !== 1) {
    failures.push(`version mismatch: ${JSON.stringify(versions)}`)
  }
}

function fail(file, message) {
  failures.push(`${path.relative(root, file)}: ${message}`)
}
