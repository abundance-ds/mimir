const GIT_MARKS = Object.freeze({
  new: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  excluded: '·',
})

const GIT_LABELS = Object.freeze({
  new: 'Added in Git',
  modified: 'Modified in Git',
  deleted: 'Deleted in Git',
  renamed: 'Renamed in Git',
  excluded: 'Not included in automatic sync',
})

const GIT_SORT_RANK = Object.freeze({
  deleted: 1,
  renamed: 2,
  new: 3,
  modified: 4,
  conflicted: 5,
})

const KIND_BY_EXTENSION = Object.freeze({
  bash: 'Shell script',
  bmp: 'Image',
  c: 'C source',
  cc: 'C++ source',
  cpp: 'C++ source',
  css: 'Stylesheet',
  csv: 'CSV',
  env: 'Environment',
  gif: 'Image',
  go: 'Go source',
  h: 'C header',
  hpp: 'C++ header',
  html: 'HTML',
  java: 'Java source',
  jpeg: 'Image',
  jpg: 'Image',
  js: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSON',
  jsx: 'JavaScript JSX',
  lock: 'Lock file',
  md: 'Markdown',
  mdown: 'Markdown',
  mkd: 'Markdown',
  markdown: 'Markdown',
  pdf: 'PDF',
  png: 'Image',
  py: 'Python source',
  rs: 'Rust source',
  sass: 'Sass',
  scss: 'Sass',
  sh: 'Shell script',
  sql: 'SQL',
  svg: 'SVG image',
  toml: 'TOML',
  ts: 'TypeScript',
  tsv: 'TSV',
  tsx: 'TypeScript JSX',
  txt: 'Text',
  vue: 'Vue component',
  webp: 'Image',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Shell script',
})

const FILE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function formatFileSize(bytes) {
  const count = Number(bytes)
  if (!Number.isFinite(count) || count < 0) return '—'
  if (count < 1024) return `${count} B`
  if (count < 1024 ** 2) return `${trimUnit(count / 1024)} KB`
  if (count < 1024 ** 3) return `${trimUnit(count / 1024 ** 2)} MB`
  return `${trimUnit(count / 1024 ** 3)} GB`
}

export function formatModifiedTime(timestamp) {
  const date = validDate(timestamp)
  if (!date) return '—'
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ')
}

export function modifiedDateTime(timestamp) {
  return validDate(timestamp)?.toISOString() || ''
}

export function fileKind(entry) {
  if (entry?.isDirectory) return 'Folder'
  const name = String(entry?.name || entry?.relativePath || '')
  const base = name.split(/[\\/]/).at(-1) || ''
  const extension = base.includes('.') ? base.split('.').at(-1).toLowerCase() : ''
  if (KIND_BY_EXTENSION[extension]) return KIND_BY_EXTENSION[extension]
  if (entry?.openBehavior === 'pdf') return 'PDF'
  if (entry?.textReadable !== false) return extension ? `${extension.toUpperCase()} file` : 'Text'
  return extension ? `${extension.toUpperCase()} file` : 'File'
}

export function compareFileEntries(left, right, { by = 'name', direction = 'asc' } = {}) {
  const leftDirectory = Boolean(left?.isDirectory)
  const rightDirectory = Boolean(right?.isDirectory)
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1

  let comparison = 0
  if (by === 'kind') {
    comparison = compareText(fileKind(left), fileKind(right))
  } else if (by === 'modified') {
    comparison = compareNumbers(left?.mtime, right?.mtime, direction)
  } else if (by === 'size') {
    comparison = compareNumbers(left?.size, right?.size, direction, { allowZero: true })
  } else {
    comparison = compareText(left?.name, right?.name)
  }

  if (comparison && !['modified', 'size'].includes(by)) {
    comparison *= direction === 'desc' ? -1 : 1
  }
  return comparison || compareText(left?.name, right?.name)
}

export function compareFileRows(left, right, { by = 'name', direction = 'asc' } = {}) {
  const leftEntry = left?.entry || left
  const rightEntry = right?.entry || right
  const leftDirectory = Boolean(leftEntry?.isDirectory)
  const rightDirectory = Boolean(rightEntry?.isDirectory)
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1

  if (by === 'git') {
    const comparison = compareSortValues(gitSortRank(left), gitSortRank(right), direction)
    return comparison || compareText(leftEntry?.name, rightEntry?.name)
  }
  if (by === 'favorite') {
    const comparison = compareSortValues(Number(Boolean(left?.favorite)), Number(Boolean(right?.favorite)), direction)
    return comparison || compareText(leftEntry?.name, rightEntry?.name)
  }
  return compareFileEntries(leftEntry, rightEntry, { by, direction })
}

export function gitMark(status) {
  return GIT_MARKS[status] || ''
}

export function gitLabel(status) {
  return GIT_LABELS[status] || ''
}

function trimUnit(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1)
}

function validDate(timestamp) {
  const value = Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function compareText(left, right) {
  return FILE_COLLATOR.compare(String(left || ''), String(right || ''))
}

function compareNumbers(left, right, direction, { allowZero = false } = {}) {
  const leftValue = Number(left)
  const rightValue = Number(right)
  const leftValid = Number.isFinite(leftValue) && (allowZero ? leftValue >= 0 : leftValue > 0)
  const rightValid = Number.isFinite(rightValue) && (allowZero ? rightValue >= 0 : rightValue > 0)
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  if (!leftValid) return 0
  return (leftValue - rightValue) * (direction === 'desc' ? -1 : 1)
}

function gitSortRank(row) {
  if (Number(row?.gitCount) > 0) return 6
  return GIT_SORT_RANK[row?.gitStatus] || 0
}

function compareSortValues(left, right, direction) {
  return (left - right) * (direction === 'desc' ? -1 : 1)
}
