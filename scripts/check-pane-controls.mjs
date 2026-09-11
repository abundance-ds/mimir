#!/usr/bin/env node
// Checks actual shell components with the Vite harness and existing Puppeteer.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core')
const base = process.argv[2] || 'http://127.0.0.1:1420'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let cases = 0
  for (const vertical of [false, true]) for (const width of [760, 1360]) for (const sidebar of ['expanded', 'rail']) for (const rail of ['none', 'activity', 'editor']) {
    if (width === 760 && sidebar === 'expanded') continue
    await page.setViewport({ width, height: 800 })
    await page.goto(`${base}/harness/pane-chrome.html?sidebar=${sidebar}&${rail}=rail&tabs=12&html${vertical ? '&vertical' : ''}`, { waitUntil: 'networkidle0' })
    if (rail === 'none' && !vertical) {
      const tabStyles = await page.evaluate(() => {
        const properties = ['fontFamily', 'fontSize', 'fontWeight', 'borderRadius', 'borderWidth', 'backgroundColor', 'height', 'paddingLeft', 'paddingRight']
        const style = el => Object.fromEntries(properties.map(key => [key, getComputedStyle(el)[key]]))
        return ['activity', 'editor'].map(pane => {
          const root = document.querySelector(`[data-pane="${pane}"]`)
          return {
            active: style(root.querySelector('.pane-tab.selected')),
            button: style(root.querySelector('.pane-tab.selected [role=tab]')),
            inactive: style(root.querySelector('.pane-tab:not(.selected)')),
            close: style(root.querySelector('.pane-tab.selected .tab-close')),
          }
        })
      })
      assert.deepEqual(tabStyles[0], tabStyles[1], 'Main and Editor tab appearance must match')
    }
    assert.equal(await page.$$eval('[data-main-tab]', els => els.length), vertical ? 0 : 12)
    assert.equal(await page.$$eval('[data-close-main-view]', els => els.length), vertical ? 1 : 0)
    if (vertical && rail !== 'activity') {
      await page.click('[aria-label="Open views"]')
      await page.type('[aria-label="Find tab"]', 'Business')
      assert.equal(await page.$eval('[aria-label="Find tab"]', el => el === document.activeElement), true)
      await page.keyboard.press('Enter')
      assert.equal(await page.$eval('[data-pane-title]', el => el.textContent.includes('Business graph')), true)
      await page.click('[data-close-main-view]')
      assert.equal(await page.$eval('[data-pane-title]', el => el.textContent.includes('Today')), true)
      await page.click('[data-new-main-tab]')
      assert.equal(await page.$eval('[data-pane-title]', el => el.textContent.includes('New terminal')), true)
      await page.$eval('[data-main-content]', el => { window.__mainContent = el })
      await page.click('[data-harness-toggle-tabs]')
      assert.equal(await page.$$eval('[data-main-tab]', els => els.length), 12)
      await page.click('[data-harness-toggle-tabs]')
      assert.equal(await page.$eval('[data-main-content]', el => el === window.__mainContent), true)
    }
    const tabTargets = await page.evaluate(() => [...document.querySelectorAll('.pane-tab')].filter(tab => getComputedStyle(tab).visibility !== 'hidden').map(tab => {
      const select = tab.querySelector('[role=tab]').getBoundingClientRect()
      const close = tab.querySelector('.tab-close')
      return { width: tab.getBoundingClientRect().width, selection: select.width, separate: select.right <= close.getBoundingClientRect().left, opacity: getComputedStyle(close).opacity }
    }))
    for (const target of tabTargets) {
      assert(target.width >= 92)
      assert(target.selection >= 64)
      assert(target.separate)
      assert.equal(target.opacity, '1')
    }
    const metrics = await page.evaluate(() => {
      const visible = element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden'
      return {
        group: [...document.querySelectorAll('[data-editor-restore-cluster] button')].map(element => ({
          action: element.dataset.editorAction, x: element.getBoundingClientRect().x,
        })),
        mainArrows: document.querySelectorAll('[data-pane-restore="activity"] [data-rail-header] svg').length,
        editorArrows: document.querySelectorAll('[data-pane-restore="editor"] [data-rail-header] svg').length,
        headers: [...document.querySelectorAll('.pane-header')].filter(visible).map(element => element.getBoundingClientRect().height),
        footers: [...document.querySelectorAll('.pane-footer')].filter(visible).map(element => element.getBoundingClientRect().height),
        buttons: [...document.querySelectorAll('.pane-header .pane-icon-button')].filter(visible).map(element => {
          const r = element.getBoundingClientRect()
          return { left: r.left, right: r.right, centreY: r.y + r.height / 2 }
        }),
      }
    })
    assert.deepEqual(metrics.group.map(button => button.action), rail === 'activity'
      ? ['restore-activity'] : [])
    if (metrics.group.length === 2) assert(metrics.group[0].x < metrics.group[1].x)
    assert.equal(await page.$$eval('[data-pane-action="restore-sidebar"], [data-editor-action="restore-sidebar"]', buttons => buttons.length), 0)
    assert.equal(await page.$$eval('[data-sidebar-restore]', buttons => buttons.length), sidebar === 'rail' ? 1 : 0)
    assert.equal(metrics.mainArrows, 0)
    assert.equal(metrics.editorArrows, rail === 'editor' ? 1 : 0)
    assert(metrics.headers.every(height => height === 40))
    assert(metrics.footers.every(height => height === 26))
    for (const button of metrics.buttons) {
      assert.equal(button.centreY, 19.5)
      assert(button.left >= 0 && button.right <= width)
    }
    if (rail === 'activity') {
      await page.click('[data-editor-action="restore-activity"]')
      assert.equal(await page.$eval('[data-pane="activity"]', e => e.dataset.paneState), 'expanded')
      assert.equal(await page.evaluate(() => document.activeElement.closest('[data-pane]')?.dataset.pane), 'activity')
    } else if (rail === 'editor') {
      await page.click('[data-pane-restore="editor"]')
    }
    for (const pane of ['activity', 'editor']) {
      const selector = pane === 'activity' ? '[data-pane-action="expand"]' : '[data-editor-action="expand"]'
      const before = await page.$eval(selector, element => {
        window.__checkedToggle = element
        const r = element.getBoundingClientRect(), p = element.closest('[data-pane]').getBoundingClientRect()
        return { inset: p.right - r.right, y: r.y, width: r.width, height: r.height }
      })
      await page.click(selector)
      assert.equal(await page.$eval(selector, element => element.title), 'Restore split')
      const after = await page.$eval(selector, element => {
        const r = element.getBoundingClientRect(), p = element.closest('[data-pane]').getBoundingClientRect()
        return { inset: p.right - r.right, y: r.y, width: r.width, height: r.height }
      })
      assert.deepEqual(after, before)
      assert(await page.$eval(selector, element => element === window.__checkedToggle && element === document.activeElement))
      await page.click(selector)
      assert.equal(await page.$eval('[data-pane="activity"]', e => e.dataset.paneState), 'expanded')
      assert.equal(await page.$eval('[data-pane="editor"]', e => e.dataset.paneState), 'expanded')
      assert.equal(await page.$eval(selector, element => element.title), pane === 'activity' ? 'Expand Activity' : 'Expand Editor')
    }
    if (sidebar === 'rail') {
      await page.click('[data-pane-action="collapse"]')
      await page.click('[data-sidebar-restore]')
      assert.equal(await page.$eval('[data-pane="sidebar"]', e => e.dataset.paneState), 'expanded')
      assert.equal(await page.$eval('[data-pane="activity"]', e => e.dataset.paneState), 'rail')
      assert.deepEqual(await page.$$eval('[data-editor-restore-cluster] button', buttons => buttons.map(e => e.dataset.editorAction)), ['restore-activity'])
    }
    cases++
  }
  for (const width of [520, 680, 850, 1280]) for (const sidebar of ['rail', 'expanded']) {
    await page.setViewport({ width, height: 520 })
    await page.goto(`${base}/harness/pane-chrome.html?sidebar=${sidebar}&sidebarWidth=400`, { waitUntil: 'networkidle0' })
    await page.$eval('[data-editor-tabs-region] button', el => el.focus())
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector('[data-pane-shell]')
      const sidebar = document.querySelector('[data-pane="sidebar"]')
      return { x: sidebar.getBoundingClientRect().left, page: document.documentElement.scrollWidth, viewport: innerWidth, shell: shell.scrollWidth, client: shell.clientWidth }
    })
    assert.equal(geometry.x, 0, `Narrow Sidebar shifted: ${width} ${sidebar}`)
    assert.equal(geometry.page, geometry.viewport)
    assert.equal(geometry.shell, geometry.client, `Workbench overflowed: ${width} ${sidebar}`)
    cases++
  }
  assert.deepEqual(errors, [])
  console.log(`Passed ${cases} layouts: optional Main tabs, header navigation, Sidebar restore placement, shared tab appearance, stable expansion toggles, and focus.`)
} finally {
  await browser.close()
}
