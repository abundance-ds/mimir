import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUSINESS_GRAPH_DYNAMIC_CONTROL_PREFIXES,
  BUSINESS_GRAPH_SURFACES,
  BUSINESS_GRAPH_UI_INVENTORY,
} from './businessGraphUiInventory.js'

const graphDirectory = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(graphDirectory, '..', 'BusinessGraphApp.vue'), 'utf8')
const componentSource = BUSINESS_GRAPH_SURFACES
  .filter(file => file !== 'BusinessGraphApp.vue')
  .map(file => readFileSync(join(graphDirectory, file), 'utf8'))
  .join('\n')
const source = `${appSource}\n${componentSource}`
const workBoardSource = readFileSync(join(graphDirectory, 'WorkBoard.vue'), 'utf8')
const portfolioSource = readFileSync(join(graphDirectory, 'PortfolioView.vue'), 'utf8')

describe('Business Graph UI contract', () => {
  it('keeps every inventoried control represented in source', () => {
    for (const [surface, controls] of Object.entries(BUSINESS_GRAPH_UI_INVENTORY)) {
      for (const control of controls) {
        expect(
          source,
          `${surface} is missing data-graph-control="${control}"`,
        ).toContain(`data-graph-control="${control}"`)
      }
    }
  })

  it('keeps every dynamic interaction family identifiable', () => {
    for (const prefix of BUSINESS_GRAPH_DYNAMIC_CONTROL_PREFIXES) {
      expect(source, `missing dynamic control prefix ${prefix}`).toContain(prefix)
    }
  })

  it('rejects legacy dense-control regressions', () => {
    expect(source).not.toMatch(/<(?:select|datalist)\b/i)
    expect(source).not.toMatch(/type="(?:date|datetime-local)"/i)
    expect(source).not.toContain('Field atlas')
    expect(source).not.toMatch(/text-\[(?:6|7|8)px\]/)
    expect(source).not.toMatch(/font-size:\s*(?:6|7|8)px/)
    expect(source).not.toMatch(/rows="[234]"/)
    expect(source).not.toContain('property-input')
    expect(source).not.toContain('summary-input')
    expect(source).not.toContain('body-input')
    expect(source).not.toContain('window.confirm')
  })

  it('keeps the operational workbench visually stable and non-decorative', () => {
    expect(source).not.toMatch(/border-left|border-inline-start/)
    expect(appSource).not.toContain('border-bottom-color')
    expect(appSource).not.toContain('graph-section-count')
    expect(source).not.toContain('board-card-accent')
    expect(source).not.toContain('.board-card:hover .board-card-actions')
    expect(source).not.toMatch(/max-height:\s*0/)
    expect(source).not.toMatch(/opacity:\s*0;/)
    expect(source).not.toMatch(/translateY\(/)
    expect(source).not.toMatch(
      /:hover[^{]*\{[^}]*(?:box-shadow|transform|filter):/s,
    )
    expect(source).not.toContain('portfolio-grid')
    expect(source).not.toContain('project-card:hover')
    expect(appSource).not.toContain('Visible knowledge')
    expect(appSource).not.toContain('graph-menu-help')
    expect(appSource).not.toContain('graph-scope-dots')
    expect(source).not.toMatch(/(?:linear|radial)-gradient|backdrop-filter/)
    expect(source).not.toMatch(/border-radius:\s*(?:[7-9]|[1-9]\d+)px/)
    expect(workBoardSource).toContain('class="board-row-title"')
    expect(workBoardSource).toContain('class="board-row-meta"')
    expect(workBoardSource).toContain(':options="priorities"')
    expect(workBoardSource).toContain('data-card-status')
    expect(workBoardSource).not.toMatch(/priorityGlyph|statusCode|meta-flag/)
    expect(portfolioSource).toContain('class="portfolio-table"')
    expect(portfolioSource).not.toContain('project-progress')
    const sectionActive = appSource.match(/\.graph-section-active\s*\{[^}]*\}/s)?.[0] || ''
    const viewActive = appSource.match(/\.graph-view-active\s*\{[^}]*\}/s)?.[0] || ''
    expect(sectionActive).not.toMatch(/border|box-shadow/)
    expect(viewActive).not.toMatch(/border|box-shadow/)
  })

  it('identifies every native interactive element for audit and automation', () => {
    const tags = source.match(/<(?:button|input|textarea|summary)\b.*?>/gms) || []
    const markers = [
      'data-graph-control',
      'data-graph-select-option',
      'data-graph-select-search',
      'data-scope-option',
      'data-context-',
      'data-related-',
      'data-deliverable-',
      'data-peek-fact',
      'data-date-value',
      'data-board-',
      'data-card-',
      'data-dispatch-',
      'data-rail-',
      'data-standing-',
      'data-now-',
      'data-graph-event',
      'data-project-card',
      'data-company-card',
      'data-timeline-node',
      'v-bind="$attrs"',
      ':ref="element =>',
    ]
    const unidentified = tags.filter(tag => !markers.some(marker => tag.includes(marker)))
    expect(unidentified).toEqual([])
  })

  it('keeps all redesigned surfaces in the audit set', () => {
    expect(BUSINESS_GRAPH_SURFACES).toHaveLength(19)
    expect(BUSINESS_GRAPH_SURFACES).toContain('../../../shared/ui/DatePicker.vue')
    expect(BUSINESS_GRAPH_SURFACES).toContain('GraphConfirmDialog.vue')
    expect(BUSINESS_GRAPH_SURFACES).toContain('GraphMarkdownEditor.vue')
    expect(BUSINESS_GRAPH_SURFACES).toContain('GraphRelationshipLine.vue')
    expect(BUSINESS_GRAPH_SURFACES).toContain('GraphSummaryDialog.vue')
    expect(BUSINESS_GRAPH_SURFACES).toContain('NowView.vue')
    expect(BUSINESS_GRAPH_SURFACES).toContain('DispatchBar.vue')
    expect(BUSINESS_GRAPH_SURFACES).not.toContain('GraphFilterBanner.vue')
  })
})
