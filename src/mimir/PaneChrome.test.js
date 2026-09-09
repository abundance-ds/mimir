import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PANE_CHROME_INVENTORY,
  PANE_CHROME_KINDS,
  PANE_CHROME_NO_OWN_HEADER,
} from './paneChromeInventory.js'

const srcDirectory = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(join(srcDirectory, file), 'utf8')
const chromeCss = read('shared/styles/pane-chrome.css')

const SIZE_OR_COLOUR_UTILITY = /(?:^|\s)(?:h|min-h|max-h|bg|py|pt|pb)-\S+|(?:^|\s)border-(?:t|b|y)(?:-\S+)?(?=\s|$)/
const SIZE_OR_COLOUR_DECLARATION = /(?:^|[\s;{])(?:height|min-height|max-height|background(?:-color)?|padding(?:-top|-bottom)?)\s*:/

function openingTag(source, marker) {
  const match = source.match(new RegExp(`<[a-zA-Z][^>]*[\\s:]${marker}(?:=|\\s|>)[^>]*>`, 's'))
  return match?.[0] || ''
}

function staticClass(tag) {
  return tag.match(/(?:^|\s)class="([^"]*)"/)?.[1] || ''
}

function ownRuleBlocks(source, cssClass) {
  const pattern = new RegExp(`(?:^|[\\s,}])\\.${cssClass}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`, 'gs')
  return [...source.matchAll(pattern)].map(match => match[1])
}

function vueFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return entry.endsWith('.vue') ? [path] : []
  })
}

const activeEntries = PANE_CHROME_INVENTORY.filter(entry => !entry.pending)

describe('Pane chrome contract', () => {
  it('keeps the row grammar fixed in the shared stylesheet', () => {
    const expected = {
      'pane-header': ['height: 40px', 'background: var(--color-chrome)', 'border-bottom: 1px solid var(--color-rule)'],
      'pane-bar': ['height: 36px', 'background: var(--color-chrome-high)', 'padding: 0 12px'],
      'pane-subbar': ['height: 28px', 'background: var(--color-chrome-high)', 'padding: 0 12px'],
      'pane-footer': ['height: 26px', 'background: var(--color-chrome)', 'border-top: 1px solid var(--color-rule)'],
      'pane-footer-input': ['min-height: 36px', 'background: var(--color-chrome-high)', 'border-top: 1px solid var(--color-rule)'],
    }
    for (const [cssClass, declarations] of Object.entries(expected)) {
      const block = ownRuleBlocks(chromeCss, cssClass).join('\n')
      for (const declaration of declarations) expect(block).toContain(declaration)
    }
  })

  it('sizes every migrated bar through its pane chrome class only', () => {
    for (const entry of activeEntries) {
      const source = read(entry.file)
      const tag = openingTag(source, entry.marker)
      expect(tag, `${entry.file}: no element carries ${entry.marker}`).not.toBe('')
      const classes = [staticClass(tag), tag.startsWith('<PaneBand') ? `pane-${tag.match(/kind="(header|footer)"/)?.[1]}` : ''].join(' ')
      expect(classes.split(/\s+/), `${entry.file} ${entry.marker}: missing ${entry.kind}`).toContain(entry.kind)
      const otherKinds = PANE_CHROME_KINDS.filter(kind => kind !== entry.kind)
      for (const kind of otherKinds) {
        expect(classes.split(/\s+/), `${entry.file} ${entry.marker}: two kinds`).not.toContain(kind)
      }
      expect(classes, `${entry.file} ${entry.marker}: sizes or colours itself with "${classes}"`)
        .not.toMatch(SIZE_OR_COLOUR_UTILITY)
      if (entry.cssClass) {
        const blocks = ownRuleBlocks(source, entry.cssClass)
        expect(blocks.length, `${entry.file}: no .${entry.cssClass} rule`).toBeGreaterThan(0)
        for (const block of blocks) {
          expect(block, `${entry.file}: .${entry.cssClass} sets height or background`)
            .not.toMatch(SIZE_OR_COLOUR_DECLARATION)
        }
      }
    }
  })

  it('puts the complete top band on one shared header contract', () => {
    const topBand = activeEntries
      .filter(entry => entry.kind === 'pane-header')
      .map(entry => [entry.file, entry.marker])

    expect(topBand).toEqual([
      ['mimir/components/WorkbenchSidebar.vue', 'data-sidebar-header'],
      ['mimir/components/PaneFrame.vue', 'data-pane-header'],
      ['editor/components/shell/AppHeader.vue', 'data-editor-header'],
      ['mimir/components/RailRestore.vue', 'data-rail-header'],
    ])
  })

  it('owns tab appearance in shared components, with no panel-specific tab skin', () => {
    const shared = read('shared/ui/chrome/PaneTab.vue')
    expect(shared).toContain('background: var(--color-chrome-high)')
    expect(shared).toContain('font-family: var(--font-sans)')
    for (const file of ['editor/components/workspace/TabStrip.vue', 'mimir/components/ActivityTabs.vue']) {
      const source = read(file)
      for (const component of ['PaneTab', 'PaneTabButton', 'PaneTabClose', 'PaneTabStrip']) {
        expect(source).toContain(`<${component}`)
      }
      expect(source).not.toMatch(/\.(?:file-tab|main-tab|tab-active|tab-inactive|tab-close)\s*\{/)
      expect(source).not.toContain('rounded-t-')
    }
  })

  it('keeps identity out of app surfaces that use the pane header', () => {
    // Pane-level bars are direct children of the surface root, indented by
    // four spaces in this codebase. Deeper headers belong to dialogs.
    for (const file of PANE_CHROME_NO_OWN_HEADER) {
      const source = read(file)
      const template = source.slice(0, source.indexOf('<script'))
      const paneLevel = template.match(/^ {4}<header\b[^>]*>/gms) || []
      expect(paneLevel.map(tag => tag.slice(0, 80)), `${file} still draws its own header`).toEqual([])
    }
  })

  it('keeps the remaining shell rows on their specified heights', () => {
    const sidebarFooter = openingTag(read('mimir/components/WorkbenchSidebar.vue'), 'data-sidebar-footer')
    expect(sidebarFooter).toContain('<PaneBand')
    expect(sidebarFooter).toContain('kind="footer"')
    const settingsButton = openingTag(read('mimir/components/WorkbenchSidebar.vue'), 'data-sidebar-settings')
    expect(staticClass(settingsButton).split(/\s+/)).toContain('h-full')

    expect(read('mimir/activities/RoutinesActivity.vue')).toContain('<span>New</span>')
    for (const file of [
      'mimir/apps/tracker/TrackerClassifications.vue',
      'mimir/apps/tracker/TrackerLog.vue',
      'mimir/apps/tracker/TrackerOverview.vue',
      'mimir/apps/tracker/TrackerTimeline.vue',
    ]) {
      const source = read(file)
      const headerClasses = [...source.matchAll(/<header\s+class="([^"]+)"/g)].map(match => match[1])
      expect(headerClasses.length, `${file}: no section headers`).toBeGreaterThan(0)
      expect(
        headerClasses.every(value => value.split(/\s+/).includes('h-7')),
        `${file}: section header is not 28 px`,
      ).toBe(true)
    }
  })

  it('uses no undefined shell tokens', () => {
    const offenders = []
    for (const path of vueFiles(join(srcDirectory, 'mimir')).concat(vueFiles(join(srcDirectory, 'editor')))) {
      const source = readFileSync(path, 'utf8')
      if (/chrome-low|chrome-lower|chrome-higher/.test(source)) offenders.push(path.slice(srcDirectory.length + 1))
    }
    expect(offenders).toEqual([])
  })
})
