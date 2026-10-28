import { describe, expect, it } from 'vitest'
import { parseCsv } from '../../../shared/csv.js'
import {
  NOT_SET,
  buildCompanyRows,
  buildNetworkRows,
  buildPlayRows,
  buildTriggerRows,
  companyCsv,
  companyFilterOptions,
  connectionBucket,
  connectionsForCompany,
  filterCompanyRows,
  filterNetworkRows,
  filterPlayRows,
  filterTriggerRows,
  groupConnections,
  guessCompanyType,
  guessRole,
  normalizeCompanyName,
  parseConnections,
  rolesSummary,
  sanitizeHiddenColumns,
} from './pipelineModel.js'

const CSV = [
  'Notes:',
  '"Fictional export."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On,Messaged,Previous communication (summary)',
  'Ada,Example,https://example.com/in/ada,ada@example.com,"Northwind Health Economics, Ltd.",Head of Market Access,01 Mar 2025,Yes,Talked about a model.',
  'Ben,Sample,javascript:alert(1),ben@example.com,Northwind HE,Health Economist,02 Mar 2025,No,No matching messages found',
  'Cara,Placeholder,,,The Contoso Therapeutics Group,Associate Director HEOR,03 Mar 2025,,',
  ',,,,,,,,',
  'Dan,Demo,,,Wingtip Analytics Inc,Procurement Lead,04 Mar 2025,no,',
].join('\n')

const company = (id, title, properties = {}) => ({
  id, kind: 'company', title, properties, provenance: { sourceRevision: `${id}-r1` },
})
const note = (id, title, properties = {}, summary = '') => ({ id, kind: 'note', title, summary, properties })

describe('company name normalisation and matching', () => {
  it('drops case, punctuation, legal suffixes, and filler words', () => {
    expect(normalizeCompanyName('Northwind Health Economics, Ltd.')).toBe('northwind health economics')
    expect(normalizeCompanyName('The Contoso Therapeutics Group')).toBe('contoso therapeutics')
    expect(normalizeCompanyName('  Fabrikam   GmbH ')).toBe('fabrikam')
    expect(normalizeCompanyName('Tailspin Corp. (UK) Limited')).toBe('tailspin uk')
    expect(normalizeCompanyName('Café Société SA')).toBe('cafe societe')
  })

  it('matches a company by title or by any connection alias', () => {
    const groups = groupConnections(parseConnections(CSV))
    const northwind = company('n', 'Northwind Health Economics', { connectionAliases: ['Northwind HE'] })
    expect(connectionsForCompany(northwind, groups).map(person => person.name)).toEqual(['Ada Example', 'Ben Sample'])
    expect(connectionsForCompany(company('n2', 'Northwind Health Economics'), groups)).toHaveLength(1)
    expect(connectionsForCompany(company('c', 'Contoso Therapeutics'), groups)).toHaveLength(1)
    expect(connectionsForCompany(company('x', 'Other Firm'), groups)).toEqual([])
  })
})

describe('connections file', () => {
  it('skips empty rows, drops email addresses and unsafe links, and hides empty summaries', () => {
    const people = parseConnections(CSV)
    expect(people.map(person => person.name)).toEqual(['Ada Example', 'Ben Sample', 'Cara Placeholder', 'Dan Demo'])
    expect(JSON.stringify(people)).not.toContain('@example.com')
    expect(people[0]).toMatchObject({ messaged: true, previous: 'Talked about a model.', url: 'https://example.com/in/ada', role: 'Economic buyer' })
    expect(people[1]).toMatchObject({ messaged: false, previous: '', url: '' })
    expect(people[3].messaged).toBe(false)
  })

  it('groups by normalised name and keeps the most common spelling', () => {
    const groups = groupConnections(parseConnections([
      'First Name,Last Name,Company,Position',
      'A,One,Wingtip Analytics,Analyst',
      'B,Two,"Wingtip Analytics, Inc.",Analyst',
      'C,Three,Wingtip Analytics,Manager',
    ].join('\n')))
    expect([...groups.keys()]).toEqual(['wingtip analytics'])
    expect(groups.get('wingtip analytics').name).toBe('Wingtip Analytics')
    expect(groups.get('wingtip analytics').people).toHaveLength(3)
  })
})

describe('role and type guesses', () => {
  it('guesses a buying role from the job title', () => {
    expect(guessRole('VP, Market Access')).toBe('Economic buyer')
    expect(guessRole('Managing Director')).toBe('Economic buyer')
    expect(guessRole('Associate Director, HEOR')).toBe('Champion')
    expect(guessRole('Senior Manager')).toBe('Champion')
    expect(guessRole('Principal Health Economist')).toBe('Champion')
    expect(guessRole('Research Fellow')).toBe('Expert user')
    expect(guessRole('Biostatistician')).toBe('Other')
    expect(guessRole('Statistician')).toBe('Expert user')
    expect(guessRole('Procurement Manager')).toBe('Gatekeeper')
    expect(guessRole('')).toBe('Other')
    expect(guessRole('Office coordinator')).toBe('Other')
  })

  it('guesses a company type from the name', () => {
    expect(guessCompanyType('University of Exampleton')).toBe('Public, HTA, or academia')
    expect(guessCompanyType('National Health Agency')).toBe('Public, HTA, or academia')
    expect(guessCompanyType('Wingtip Analytics')).toBe('Consultancy')
    expect(guessCompanyType('Northwind Health Economics')).toBe('Consultancy')
    expect(guessCompanyType('Contoso Therapeutics')).toBe('Pharma')
    expect(guessCompanyType('Litware Pharma')).toBe('Pharma')
    expect(guessCompanyType('Fabrikam Capital')).toBe('Other')
  })

  it('summarises roles and buckets counts', () => {
    expect(rolesSummary([{ role: 'Champion' }, { role: 'Economic buyer' }, { role: 'Champion' }, { role: 'Other' }]))
      .toBe('1 economic buyer, 2 champion')
    expect([0, 1, 2, 4, 5, 40].map(connectionBucket)).toEqual(['0', '1', '2-4', '2-4', '5+', '5+'])
  })
})

describe('pipeline rows', () => {
  const triggers = [note('t-hire', 'New lead hired', { triggerRating: 'Strong', triggerFor: 'Both', triggerCategory: 'People' }, 'A new lead starts.')]
  const plays = [note('p-intro', 'Warm introduction', { playVerdict: 'Working', playFor: 'Both', playTriggers: ['t-hire'], playSteps: 'Find a contact\nAsk for an introduction' })]
  const companies = [
    company('northwind', 'Northwind Health Economics', {
      pipelineStage: 'Proposal', pipelineTrigger: 't-hire', pipelinePlay: 'Warm introduction',
      companyType: 'HEOR consultancy', hqCity: 'London', hqCountry: 'United Kingdom', pipelineNextStep: '=Send case study',
      connectionAliases: 'Northwind HE',
    }),
    company('contoso', 'Contoso Therapeutics', { pipelineStage: 'Target', companyType: 'Pharma', hqCountry: 'Switzerland' }),
    company('alpha', 'Alpha Bio', { pipelineStage: 'Target' }),
    company('tailspin', 'Tailspin Outcomes', { companyType: 'HEOR consultancy' }),
  ]
  const groups = groupConnections(parseConnections(CSV))
  const rows = buildCompanyRows({ companies, triggers, plays, groups })

  it('resolves notes by id or title and sorts by stage order, then title', () => {
    expect(rows.map(row => row.id)).toEqual(['alpha', 'contoso', 'northwind', 'tailspin'])
    expect(rows[2]).toMatchObject({ triggerTitle: 'New lead hired', playId: 'p-intro', connectionCount: 2, messagedCount: 1, revision: 'northwind-r1' })
  })

  it('shows staged companies by default and names a way to include the rest', () => {
    expect(filterCompanyRows(rows).map(row => row.id)).toEqual(['alpha', 'contoso', 'northwind'])
    expect(filterCompanyRows(rows, { includeUnstaged: true })).toHaveLength(4)
    expect(filterCompanyRows(rows, { filters: { stage: [NOT_SET] } }).map(row => row.id)).toEqual(['tailspin'])
  })

  it('applies column filters, Not set values, buckets, and search over connection names', () => {
    expect(filterCompanyRows(rows, { filters: { type: [NOT_SET] } }).map(row => row.id)).toEqual(['alpha'])
    expect(filterCompanyRows(rows, { filters: { country: ['Switzerland', 'United Kingdom'] } }).map(row => row.id)).toEqual(['contoso', 'northwind'])
    expect(filterCompanyRows(rows, { filters: { connections: ['2-4'] } }).map(row => row.id)).toEqual(['northwind'])
    expect(filterCompanyRows(rows, { filters: { trigger: ['t-hire'], play: ['p-intro'] } }).map(row => row.id)).toEqual(['northwind'])
    expect(filterCompanyRows(rows, { query: 'ben sample' }).map(row => row.id)).toEqual(['northwind'])
    expect(filterCompanyRows(rows, { query: 'london consultancy' }).map(row => row.id)).toEqual(['northwind'])
    const options = companyFilterOptions(rows)
    expect(options.stage.map(option => option.value)).toEqual(['Target', 'Contacted', 'In conversation', 'Proposal', 'Client', 'Dormant', NOT_SET])
    expect(options.trigger.find(option => option.value === 't-hire').label).toBe('New lead hired')
    expect(options.type.at(-1)).toMatchObject({ value: NOT_SET, label: 'Not set', hint: '1' })
  })

  it('exports shown rows with fixed columns and safe cells', () => {
    const csv = companyCsv(filterCompanyRows(rows, { filters: { stage: ['Proposal'] } }))
    expect(parseCsv(csv)).toEqual([
      ['Company', 'Type', 'City', 'Country', 'Stage', 'Trigger', 'Play', 'Next step', 'Connections', 'Messaged'],
      ['Northwind Health Economics', 'HEOR consultancy', 'London', 'United Kingdom', 'Proposal', 'New lead hired', 'Warm introduction', "'=Send case study", '2', '1'],
    ])
  })

  it('builds trigger and play rows with their links', () => {
    const triggerRows = buildTriggerRows(triggers, plays)
    expect(triggerRows[0].plays).toEqual([{ id: 'p-intro', title: 'Warm introduction' }])
    expect(filterTriggerRows(triggerRows, { filters: { rating: ['Watch'] } })).toEqual([])
    const playRows = buildPlayRows(plays, triggers)
    expect(playRows[0].steps).toEqual(['Find a contact', 'Ask for an introduction'])
    expect(playRows[0].triggers.map(trigger => trigger.title)).toEqual(['New lead hired'])
    expect(filterPlayRows(playRows, { filters: { verdict: ['Working'] } })).toHaveLength(1)
  })

  it('builds network rows, including companies not in the graph', () => {
    const network = buildNetworkRows(groups, companies)
    const byKey = Object.fromEntries(network.map(row => [row.key, row]))
    expect(byKey['northwind health economics'].inPipeline).toBe(true)
    expect(byKey['northwind he'].company.id).toBe('northwind')
    expect(byKey['contoso therapeutics'].inPipeline).toBe(true)
    expect(byKey['wingtip analytics']).toMatchObject({ inPipeline: false, company: null, type: 'Consultancy', roles: '1 gatekeeper' })
    expect(filterNetworkRows(network, { filters: { inPipeline: ['no'] } }).map(row => row.key)).toEqual(['wingtip analytics'])
    expect(filterNetworkRows(network, { filters: { messaged: ['yes'] } }).map(row => row.key)).toEqual(['northwind health economics'])
    expect(filterNetworkRows(network, { query: 'cara' }).map(row => row.key)).toEqual(['contoso therapeutics'])
  })

  it('never hides the name column', () => {
    expect(sanitizeHiddenColumns('companies', ['company', 'stage', 'stage', 'unknown'])).toEqual(['stage'])
    expect(sanitizeHiddenColumns('network', 'roles')).toEqual([])
  })
})
