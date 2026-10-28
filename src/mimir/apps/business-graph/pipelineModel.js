import { parseCsvRecords, toCsv } from '../../../shared/csv.js'

// Pipeline rows are projections of company nodes, sales notes, and the Team
// connections file. Nothing here writes; the store owns graph writes.

export const PIPELINE_STAGES = Object.freeze(['Target', 'Contacted', 'In conversation', 'Proposal', 'Client', 'Dormant'])
export const TRIGGER_RATINGS = Object.freeze(['Strong', 'Medium', 'Watch'])
export const PLAY_VERDICTS = Object.freeze(['Working', 'Too early', 'Untested', 'Not working yet', 'Not a sales route'])
export const TRIGGER_TAG = 'sales-trigger'
export const PLAY_TAG = 'sales-play'
export const NOT_SET = '__not_set__'
export const ROLE_ORDER = Object.freeze(['Economic buyer', 'Champion', 'Expert user', 'Gatekeeper', 'Other'])
export const NETWORK_TYPES = Object.freeze(['Public, HTA, or academia', 'Consultancy', 'Pharma', 'Other'])
export const CONNECTION_BUCKETS = Object.freeze([
  { value: '0', label: 'None' },
  { value: '1', label: '1' },
  { value: '2-4', label: '2 to 4' },
  { value: '5+', label: '5 or more' },
])
export const NETWORK_PAGE_SIZE = 200

export const PIPELINE_COLUMNS = Object.freeze({
  companies: [
    { id: 'company', label: 'Company', locked: true },
    { id: 'headquarters', label: 'Headquarters' },
    { id: 'stage', label: 'Stage' },
    { id: 'trigger', label: 'Trigger' },
    { id: 'play', label: 'Play' },
    { id: 'connections', label: 'Connections' },
    { id: 'nextStep', label: 'Next step' },
  ],
  triggers: [
    { id: 'trigger', label: 'Trigger', locked: true },
    { id: 'category', label: 'Category' },
    { id: 'for', label: 'For' },
    { id: 'summary', label: 'What happens' },
    { id: 'spot', label: 'Where we find it' },
    { id: 'who', label: 'Who we contact' },
    { id: 'rating', label: 'Rating' },
  ],
  plays: [
    { id: 'play', label: 'Play', locked: true },
    { id: 'for', label: 'For' },
    { id: 'verdict', label: 'Result so far' },
    { id: 'learned', label: 'What we learned' },
  ],
  network: [
    { id: 'company', label: 'Company', locked: true },
    { id: 'connections', label: 'Connections' },
    { id: 'messaged', label: 'Messaged' },
    { id: 'roles', label: 'Likely roles' },
    { id: 'inPipeline', label: 'In pipeline' },
  ],
})

/** Keep only known, unlocked column ids; the name column can never hide. */
export function sanitizeHiddenColumns(view, hidden) {
  const allowed = new Set((PIPELINE_COLUMNS[view] || []).filter(column => !column.locked).map(column => column.id))
  return [...new Set((Array.isArray(hidden) ? hidden : []).filter(id => allowed.has(id)))]
}

const LEGAL_WORDS = new Set(['inc', 'ltd', 'llc', 'gmbh', 'plc', 'ag', 'limited', 'corporation', 'corp', 'co', 'sa', 'bv', 'the', 'group'])

export function normalizeCompanyName(name) {
  return String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(word => word && !LEGAL_WORDS.has(word))
    .join(' ')
}

export function text(value) {
  return typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim())
}

/** Accept a YAML list or a string separated by new lines or semicolons. */
export function listValue(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  return text(value).split(/\r?\n|;/).map(item => item.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
}

const ROLE_RULES = [
  ['Gatekeeper', /\b(procurement|sourcing|purchasing|vendor|supplier)\b/],
  ['Economic buyer', /\b(head|vp|vice president|chief|partner|founder|co-founder|ceo|coo|cso|cfo|cmo|president|general manager|managing director|executive director|senior director|global director|director)\b/],
  ['Champion', /\b(lead|principal|senior manager|manager|associate director)\b/],
  ['Expert user', /\b(analyst|associate|scientist|statistician|economist|consultant|researcher|modeller|modeler|fellow|specialist)\b/],
]

/** Guess a buying role from a job title. This is a heuristic, not a fact. */
export function guessRole(position) {
  const value = String(position ?? '').toLowerCase()
  if (!value.trim()) return 'Other'
  // Associate director is a champion, not a director.
  if (/\bassociate director\b/.test(value)) return 'Champion'
  return ROLE_RULES.find(([, pattern]) => pattern.test(value))?.[0] || 'Other'
}

const TYPE_RULES = [
  ['Public, HTA, or academia', /(universit|college|institute|hospital|\bnhs\b|agency|ministry|society|school|council|government|national)/],
  ['Consultancy', /(consult|analytics|health economics|\bheor\b|access|outcomes|iqvia|evidera|parexel|cytel|icon\b|syneos|real world)/],
  ['Pharma', /(pharma|therapeutics|biotec|bioscience|biologics|vaccine|novartis|roche|pfizer|sanofi|bayer|merck|astrazeneca|glaxosmithkline|gsk|novo nordisk|takeda|abbvie|lilly|bristol|johnson|boehringer|amgen|gilead)/],
]

export function guessCompanyType(name) {
  const value = String(name ?? '').toLowerCase()
  return TYPE_RULES.find(([, pattern]) => pattern.test(value))?.[0] || 'Other'
}

/** Graph companyType value for a guessed Network type, or '' for Other. */
export function companyTypeFromGuess(type) {
  return { 'Public, HTA, or academia': 'Public body or academia', Consultancy: 'Consultancy', Pharma: 'Pharma' }[type] || ''
}

function truthy(value) {
  return /^(yes|y|true|1|x)$/i.test(text(value))
}

/** Parse a LinkedIn connections export. Email addresses are dropped here. */
export function parseConnections(csvText) {
  const records = parseCsvRecords(csvText, {
    findHeader: row => row.some(cell => cell.trim() === 'First Name'),
  })
  const connections = []
  for (const record of records) {
    const firstName = text(record['First Name'])
    const lastName = text(record['Last Name'])
    const company = text(record.Company)
    if (!firstName && !lastName && !company) continue
    const previousKey = Object.keys(record).find(key => /^previous communication/i.test(key))
    const previous = previousKey ? text(record[previousKey]) : ''
    const position = text(record.Position)
    connections.push({
      name: [firstName, lastName].filter(Boolean).join(' ') || 'Unnamed connection',
      position,
      company,
      key: normalizeCompanyName(company),
      connectedOn: text(record['Connected On']),
      url: /^https?:\/\//i.test(text(record.URL)) ? text(record.URL) : '',
      messaged: truthy(record.Messaged),
      previous: /^no matching/i.test(previous) ? '' : previous,
      role: guessRole(position),
    })
  }
  return connections
}

/** Group connections by normalised company name. */
export function groupConnections(connections) {
  const groups = new Map()
  for (const person of connections) {
    if (!person.key) continue
    let group = groups.get(person.key)
    if (!group) {
      group = { key: person.key, spellings: new Map(), people: [] }
      groups.set(person.key, group)
    }
    group.spellings.set(person.company, (group.spellings.get(person.company) || 0) + 1)
    group.people.push(person)
  }
  for (const group of groups.values()) {
    group.name = [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    group.messaged = group.people.filter(person => person.messaged).length
  }
  return groups
}

export function companyKeys(node) {
  return [...new Set([node?.title, ...listValue(node?.properties?.connectionAliases)]
    .map(normalizeCompanyName).filter(Boolean))]
}

export function connectionsForCompany(node, groups) {
  const people = []
  for (const key of companyKeys(node)) people.push(...(groups.get(key)?.people || []))
  return people
}

export function connectionBucket(count) {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  return count <= 4 ? '2-4' : '5+'
}

export function groupByRole(people) {
  return ROLE_ORDER.map(role => ({ role, people: people.filter(person => person.role === role) }))
    .filter(group => group.people.length)
}

export function rolesSummary(people) {
  return groupByRole(people).filter(group => group.role !== 'Other')
    .map(group => `${group.people.length} ${group.role.toLowerCase()}`).join(', ')
}

function noteIndex(notes) {
  const byId = new Map(notes.map(note => [note.id, note]))
  const byTitle = new Map(notes.map(note => [text(note.title).toLowerCase(), note]))
  return reference => {
    const value = text(reference)
    if (!value) return null
    return byId.get(value) || byTitle.get(value.toLowerCase()) || { id: value, title: value, missing: true }
  }
}

function properties(node) {
  return node?.properties || {}
}

function nodeRevision(node) {
  return node?.provenance?.sourceRevision || node?.sourceRevision || ''
}

export function buildCompanyRows({ companies = [], triggers = [], plays = [], groups = new Map() }) {
  const trigger = noteIndex(triggers), play = noteIndex(plays)
  return companies.map(node => {
    const values = properties(node)
    const stage = text(values.pipelineStage)
    const triggerNote = trigger(values.pipelineTrigger)
    const playNote = play(values.pipelinePlay)
    const people = connectionsForCompany(node, groups)
    return {
      id: node.id,
      node,
      revision: nodeRevision(node),
      title: text(node.title) || 'Untitled company',
      type: text(values.companyType),
      city: text(values.hqCity),
      country: text(values.hqCountry),
      portfolio: text(values.portfolio),
      stage,
      stageIndex: stage ? (PIPELINE_STAGES.includes(stage) ? PIPELINE_STAGES.indexOf(stage) : PIPELINE_STAGES.length) : PIPELINE_STAGES.length + 1,
      triggerId: triggerNote?.id || '',
      triggerTitle: triggerNote?.title || '',
      triggerSummary: triggerNote?.missing ? '' : text(triggerNote?.summary),
      triggerNote: text(values.pipelineTriggerNote),
      playId: playNote?.id || '',
      playTitle: playNote?.title || '',
      nextStep: text(values.pipelineNextStep),
      people,
      connectionCount: people.length,
      messagedCount: people.filter(person => person.messaged).length,
    }
  }).sort(compareCompanyRows)
}

export function compareCompanyRows(left, right) {
  return left.stageIndex - right.stageIndex || left.title.localeCompare(right.title)
}

export function headquarters(row) {
  return [row.city, row.country].filter(Boolean).join(', ')
}

function matchesQuery(haystack, query) {
  const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const value = haystack.toLowerCase()
  return terms.every(term => value.includes(term))
}

function matchesSet(selected, value) {
  return !selected?.length || selected.includes(value || NOT_SET)
}

export const COMPANY_FILTERS = Object.freeze(['type', 'country', 'stage', 'trigger', 'play', 'connections'])

export function companyFilterValue(row, filter) {
  return {
    type: row.type,
    country: row.country,
    stage: row.stage,
    trigger: row.triggerId,
    play: row.playId,
    connections: connectionBucket(row.connectionCount),
  }[filter]
}

export function filterCompanyRows(rows, { query = '', filters = {}, includeUnstaged = false } = {}) {
  return rows.filter(row => {
    // An explicit Stage filter replaces the default staged-only view.
    if (!filters.stage?.length && !includeUnstaged && !row.stage) return false
    if (!COMPANY_FILTERS.every(filter => matchesSet(filters[filter], companyFilterValue(row, filter)))) return false
    return matchesQuery([row.title, row.type, row.city, row.country, ...row.people.map(person => person.name)].join(' '), query)
  })
}

function valueOptions(values, labels = new Map(), order = null) {
  const counts = new Map()
  for (const value of values) counts.set(value || NOT_SET, (counts.get(value || NOT_SET) || 0) + 1)
  const options = [...counts.keys()].filter(value => value !== NOT_SET).map(value => ({
    value, label: labels.get(value) || value, hint: `${counts.get(value)}`,
  }))
  options.sort((a, b) => order
    ? (order.indexOf(a.value) + 1 || 99) - (order.indexOf(b.value) + 1 || 99) || a.label.localeCompare(b.label)
    : a.label.localeCompare(b.label))
  return [...options, { value: NOT_SET, label: 'Not set', hint: `${counts.get(NOT_SET) || 0}` }]
}

export function companyFilterOptions(rows) {
  return {
    type: valueOptions(rows.map(row => row.type)),
    country: valueOptions(rows.map(row => row.country)),
    stage: valueOptions([...PIPELINE_STAGES, ...rows.map(row => row.stage)].filter(Boolean).concat(rows.filter(row => !row.stage).map(() => '')), new Map(), PIPELINE_STAGES)
      .map(option => ({ ...option, hint: `${rows.filter(row => (row.stage || NOT_SET) === option.value).length}` })),
    trigger: valueOptions(rows.map(row => row.triggerId), new Map(rows.map(row => [row.triggerId, row.triggerTitle]))),
    play: valueOptions(rows.map(row => row.playId), new Map(rows.map(row => [row.playId, row.playTitle]))),
    connections: CONNECTION_BUCKETS.map(bucket => ({ ...bucket, hint: `${rows.filter(row => connectionBucket(row.connectionCount) === bucket.value).length}` })),
  }
}

export function companyCsv(rows) {
  return toCsv([
    ['Company', 'Type', 'City', 'Country', 'Stage', 'Trigger', 'Play', 'Next step', 'Connections', 'Messaged'],
    ...rows.map(row => [row.title, row.type, row.city, row.country, row.stage, row.triggerTitle,
      row.playTitle, row.nextStep, row.connectionCount, row.messagedCount]),
  ])
}

export function buildTriggerRows(triggers = [], plays = []) {
  return triggers.map(node => {
    const values = properties(node)
    return {
      id: node.id,
      node,
      title: text(node.title) || 'Untitled trigger',
      category: text(values.triggerCategory),
      for: text(values.triggerFor),
      summary: text(node.summary),
      spot: text(values.triggerSpot),
      who: text(values.triggerWho),
      rating: text(values.triggerRating),
      opener: text(values.triggerOpener),
      why: text(values.triggerWhy),
      plays: plays.filter(play => listValue(properties(play).playTriggers)
        .some(reference => reference === node.id || reference.toLowerCase() === text(node.title).toLowerCase()))
        .map(play => ({ id: play.id, title: text(play.title) || 'Untitled play' })),
    }
  }).sort((a, b) => (TRIGGER_RATINGS.indexOf(a.rating) + 1 || 9) - (TRIGGER_RATINGS.indexOf(b.rating) + 1 || 9)
    || a.title.localeCompare(b.title))
}

export const TRIGGER_FILTERS = Object.freeze(['category', 'for', 'rating'])

export function filterTriggerRows(rows, { query = '', filters = {} } = {}) {
  return rows.filter(row => TRIGGER_FILTERS.every(filter => matchesSet(filters[filter], row[filter]))
    && matchesQuery([row.title, row.category, row.for, row.summary, row.spot, row.who].join(' '), query))
}

export function triggerFilterOptions(rows) {
  return {
    category: valueOptions(rows.map(row => row.category)),
    for: valueOptions(rows.map(row => row.for)),
    rating: valueOptions(rows.map(row => row.rating), new Map(), TRIGGER_RATINGS),
  }
}

export function buildPlayRows(plays = [], triggers = []) {
  const trigger = noteIndex(triggers)
  return plays.map(node => {
    const values = properties(node)
    return {
      id: node.id,
      node,
      title: text(node.title) || 'Untitled play',
      for: text(values.playFor),
      verdict: text(values.playVerdict),
      learned: text(values.playLearned),
      steps: listValue(values.playSteps),
      triggers: listValue(values.playTriggers).map(trigger).filter(Boolean),
    }
  }).sort((a, b) => (PLAY_VERDICTS.indexOf(a.verdict) + 1 || 9) - (PLAY_VERDICTS.indexOf(b.verdict) + 1 || 9)
    || a.title.localeCompare(b.title))
}

export const PLAY_FILTERS = Object.freeze(['for', 'verdict'])

export function filterPlayRows(rows, { query = '', filters = {} } = {}) {
  return rows.filter(row => PLAY_FILTERS.every(filter => matchesSet(filters[filter], row[filter]))
    && matchesQuery([row.title, row.for, row.verdict, row.learned].join(' '), query))
}

export function playFilterOptions(rows) {
  return {
    for: valueOptions(rows.map(row => row.for)),
    verdict: valueOptions(rows.map(row => row.verdict), new Map(), PLAY_VERDICTS),
  }
}

/** One row per connection company; graph companies match by name or alias. */
export function buildNetworkRows(groups, companies = []) {
  const companyByKey = new Map()
  for (const node of companies) {
    for (const key of companyKeys(node)) {
      const current = companyByKey.get(key)
      if (!current || (!text(properties(current).pipelineStage) && text(properties(node).pipelineStage))) companyByKey.set(key, node)
    }
  }
  return [...groups.values()].map(group => {
    const company = companyByKey.get(group.key) || null
    return {
      id: group.key,
      key: group.key,
      title: group.name,
      type: guessCompanyType(group.name),
      people: group.people,
      connectionCount: group.people.length,
      messagedCount: group.messaged,
      roles: rolesSummary(group.people),
      company,
      inPipeline: Boolean(company && text(properties(company).pipelineStage)),
    }
  }).sort((a, b) => b.connectionCount - a.connectionCount || a.title.localeCompare(b.title))
}

export const NETWORK_FILTERS = Object.freeze(['type', 'connections', 'messaged', 'inPipeline'])

export function networkFilterValue(row, filter) {
  return {
    type: row.type,
    connections: connectionBucket(row.connectionCount),
    messaged: row.messagedCount ? 'yes' : 'no',
    inPipeline: row.inPipeline ? 'yes' : 'no',
  }[filter]
}

export function filterNetworkRows(rows, { query = '', filters = {} } = {}) {
  return rows.filter(row => NETWORK_FILTERS.every(filter => matchesSet(filters[filter], networkFilterValue(row, filter)))
    && matchesQuery([row.title, ...row.people.map(person => person.name)].join(' '), query))
}

export function networkFilterOptions(rows) {
  const count = (filter, value) => `${rows.filter(row => networkFilterValue(row, filter) === value).length}`
  const yesNo = filter => [
    { value: 'yes', label: 'Yes', hint: count(filter, 'yes') },
    { value: 'no', label: 'No', hint: count(filter, 'no') },
  ]
  return {
    type: NETWORK_TYPES.map(value => ({ value, label: value, hint: count('type', value) })),
    connections: CONNECTION_BUCKETS.filter(bucket => bucket.value !== '0').map(bucket => ({ ...bucket, hint: count('connections', bucket.value) })),
    messaged: yesNo('messaged'),
    inPipeline: yesNo('inPipeline'),
  }
}
