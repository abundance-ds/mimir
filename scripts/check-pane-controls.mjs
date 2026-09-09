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
  for (const width of [760, 1360]) for (const sidebar of ['expanded', 'rail']) for (const rail of ['none', 'activity', 'editor']) {
    if (width === 760 && sidebar === 'expanded') continue
    await page.setViewport({ width, height: 800 })
    await page.goto(`${base}/harness/pane-chrome.html?sidebar=${sidebar}&${rail}=rail&tabs=12&html`, { waitUntil: 'networkidle0' })
    if (rail === 'none') {
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
      ? [...(sidebar === 'rail' ? ['restore-sidebar'] : []), 'restore-activity'] : [])
    if (metrics.group.length === 2) assert(metrics.group[0].x < metrics.group[1].x)
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
      await page.click('[data-editor-action="restore-sidebar"]')
      assert.equal(await page.$eval('[data-pane="sidebar"]', e => e.dataset.paneState), 'expanded')
      assert.equal(await page.$eval('[data-pane="activity"]', e => e.dataset.paneState), 'rail')
      assert.deepEqual(await page.$$eval('[data-editor-restore-cluster] button', buttons => buttons.map(e => e.dataset.editorAction)), ['restore-activity'])
    }
    cases++
  }
  assert.deepEqual(errors, [])
  console.log(`Passed ${cases} layouts: original restore order, quiet Main rail, shared tab appearance, stable expansion toggles, restore actions, and focus.`)
} finally {
  await browser.close()
}
