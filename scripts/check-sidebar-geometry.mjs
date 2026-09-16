#!/usr/bin/env node
// Real production components, measured in a browser. Fixture data has no user state.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core')
const base = process.argv[2] || 'http://127.0.0.1:1420'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const measure = () => page.evaluate(() => {
    const side = document.querySelector('[data-sidebar-state]')
    const rect = element => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return [box.x + box.width / 2, box.y + box.height / 2]
    }
    const get = selector => rect(side.querySelector(selector))
    return {
      workspace: get('[data-sidebar-workspace] > span'),
      tools: [...side.querySelectorAll('[data-sidebar-tool-icon]')].map(rect),
      activities: [...side.querySelectorAll('[data-activity-key] > button svg')].map(rect),
      navigationScroll: side.querySelector('[data-sidebar-navigation-scroll]').scrollTop,
      navigationHeight: side.querySelector('[data-sidebar-navigation-scroll]').clientHeight,
      recordingHeight: side.querySelector('[data-sidebar-meeting-capture]')?.getBoundingClientRect().height || 0,
      record: get('[data-sidebar-meeting-open] svg'), microphone: get('[data-sidebar-meeting-microphone] svg'),
      stop: get('[aria-label="Stop recording"] svg'), files: get('[data-sidebar-files-toggle] svg') || get('[data-files-mode="project"] svg'),
      settings: get('[data-sidebar-settings] svg'),
    }
  })
  let count = 0
  for (const width of [240, 280, 400]) for (const height of [360, 520, 900]) {
    for (const long of [false, true]) for (const recording of [false, true]) for (const filesClosed of [false, true]) {
      const label = JSON.stringify({ width, height, long, recording, filesClosed })
      await page.setViewport({ width: 1400, height })
      await page.goto(`${base}/harness/files.html?width=${width}&tools=${long ? 30 : 5}&activities=${long ? 20 : 2}${recording ? '&recording' : ''}${filesClosed ? '&filesClosed' : ''}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-sidebar-files]')
      await paint()
      await page.$eval('[data-sidebar-navigation-scroll]', el => { el.scrollTop = 55 })
      const before = await measure()
      let firstRail
      for (const collapsed of [true, false, true, false]) {
        await page.click(collapsed ? '[data-sidebar-collapse]' : '[data-sidebar-restore]')
        await paint()
        const after = await measure()
        if (!collapsed) assert.deepEqual(after, before, `Restore lost expanded positions or scroll: ${label}`)
        else {
          assert.deepEqual(after.workspace, before.workspace)
          assert.deepEqual(after.settings, before.settings)
          // Files can release enough space to clamp scrollTop. Account for
          // that scroll change only; row positions must otherwise stay fixed.
          const unscroll = state => [...state.tools, ...state.activities].map(([x, y]) => [x, y + state.navigationScroll])
          assert.deepEqual(unscroll(after), unscroll(before), `Rail moved navigation icons: ${label}`)
          if (firstRail) assert.deepEqual(after, firstRail, `Rail round trip moved icons or scroll: ${label}`)
          else firstRail = after
          assert(after.navigationHeight >= before.navigationHeight, `Rail must release Files space: ${label}`)
          assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 28)
          assert(await page.$eval('[data-sidebar-state]', side => side.querySelector('[data-sidebar-files-toggle]').getBoundingClientRect().bottom === side.querySelector('[data-sidebar-footer]').getBoundingClientRect().top))
        }
        const geometry = await page.$eval('[data-sidebar-state]', side => ({
          rowHeights: [...side.querySelectorAll('[data-tool-key], [data-activity-key]')].map(row => row.getBoundingClientRect().height),
          nested: [...side.querySelectorAll('nav')].some(nav => ['auto', 'scroll'].includes(getComputedStyle(nav).overflowY)),
          outerOverflow: side.scrollHeight > side.clientHeight,
          horizontalOverflow: side.querySelector('[data-sidebar-navigation-scroll]').scrollWidth > side.querySelector('[data-sidebar-navigation-scroll]').clientWidth,
          footer: side.querySelector('[data-sidebar-footer]').getBoundingClientRect().bottom === side.getBoundingClientRect().bottom,
        }))
        assert(geometry.rowHeights.every(value => value === 24), `Row height: ${label}`)
        assert(!geometry.nested && !geometry.outerOverflow && !geometry.horizontalOverflow && geometry.footer, `Overflow: ${label} ${JSON.stringify(geometry)}`)
        if (recording) {
          const capture = await page.$eval('[data-sidebar-meeting-capture]', el => {
            const box = el.getBoundingClientRect()
            const timer = el.querySelector('[data-sidebar-meeting-elapsed]')
            const time = timer.getBoundingClientRect()
            const scribe = el.previousElementSibling
            return {
              height: box.height,
              belowScribe: scribe?.dataset.toolKey === 'app:scribe' && scribe.getBoundingClientRect().bottom === box.top,
              withinTools: Boolean(el.closest('nav[aria-label="Tools"]')),
              badgeOnScribe: Boolean(scribe?.querySelector('[data-sidebar-recording-badge]')),
              separateIndicator: Boolean(el.querySelector('.sidebar-recording-icon')),
              borders: [getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderBottomWidth],
              timeVisible: time.width > 0 && time.height > 0 && getComputedStyle(timer).visibility === 'visible',
              timeFits: timer.scrollWidth <= timer.clientWidth && time.left >= box.left && time.right <= box.right,
              controlsFit: [...el.querySelectorAll('button')].every(button => {
                const bounds = button.getBoundingClientRect()
                return bounds.width >= 24 && bounds.height >= 24 && bounds.left >= box.left && bounds.right <= box.right
                  && bounds.top >= box.top && bounds.bottom <= box.bottom
              }),
            }
          })
          assert.equal(capture.height, 48, `Recording height: ${label}`)
          assert.equal(capture.badgeOnScribe, collapsed, `Recording badge: ${label}`)
          assert.equal(capture.separateIndicator, !collapsed, `Duplicate recording indicator: ${label}`)
          if (collapsed) assert.deepEqual(capture.borders, ['0px', '0px'], `Rail recording rules: ${label}`)
          assert(capture.belowScribe && capture.withinTools, `Recording must stay with Scribe: ${label}`)
          assert(capture.timeVisible && capture.timeFits && capture.controlsFit, `Recording controls: ${label} ${JSON.stringify(capture)}`)
        }
      }
      count++
    }
  }
  await page.setViewport({ width: 1400, height: 900 })
  await page.goto(`${base}/harness/files.html?width=280&activities=4`, { waitUntil: 'networkidle0' })
  await page.click('[data-activity-key="session-1"] > button')
  assert.equal(await page.$eval('[data-main-tab="session-1"] [role=tab]', el => el.getAttribute('aria-selected')), 'true')
  await page.click('[data-main-tab="session-0"] [role=tab]')
  assert.equal(await page.$eval('[data-activity-key="session-0"] > button', el => el.getAttribute('aria-current')), 'page')
  const before = await measure()
  assert.equal(await page.$$eval('[data-sidebar-files-toggle]', rows => rows.length), 0)
  assert(await page.$eval('[data-sidebar-state]', side => side.querySelector('[data-sidebar-files-content]').getBoundingClientRect().bottom === side.querySelector('[data-sidebar-footer]').getBoundingClientRect().top))
  await page.click('[data-files-collapse]')
  await paint()
  const closed = await measure()
  assert.deepEqual(closed.tools, before.tools)
  assert.deepEqual(closed.activities, before.activities)
  assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 28)
  await page.click('[data-sidebar-files-toggle]')
  await paint()
  assert.deepEqual(await measure(), before)
  const handle = await page.$('[data-sidebar-files-resize]')
  const box = await handle.boundingBox()
  await page.mouse.move(box.x + 80, box.y + 4)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y - 76, { steps: 6 })
  await page.mouse.up()
  await paint()
  const resized = await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow')))
  assert.equal(resized, 320)
  await page.click('[data-files-collapse]')
  await page.click('[data-sidebar-files-toggle]')
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), resized)
  await page.setViewport({ width: 1400, height: 360 })
  await paint()
  assert(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))) < resized)
  await page.setViewport({ width: 1400, height: 900 })
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), resized)
  // Collapse and reopen without releasing the original resize gesture.
  const snapBox = await (await page.$('[data-sidebar-files-resize]')).boundingBox()
  const snapGrab = { x: snapBox.x + 80, y: snapBox.y + 4 }
  await page.mouse.move(snapGrab.x, snapGrab.y)
  await page.mouse.down()
  await page.mouse.move(snapGrab.x, snapGrab.y + resized - 40, { steps: 8 })
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 28)
  assert.equal(await page.$$eval('[data-sidebar-files-resize]', els => els.length), 0)
  await page.mouse.move(snapGrab.x, snapGrab.y + resized - 180, { steps: 6 })
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 208)
  await page.mouse.up()
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), 180)
  // Dropping a snapped gesture keeps Files closed and retains its open size.
  const dropBox = await (await page.$('[data-sidebar-files-resize]')).boundingBox()
  await page.mouse.move(dropBox.x + 80, dropBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(dropBox.x + 80, dropBox.y + 164, { steps: 6 })
  await paint()
  await page.mouse.up()
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 28)
  assert(await page.$eval('[data-sidebar-files-toggle]', el => el === document.activeElement))
  await page.click('[data-sidebar-files-toggle]')
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), 180)
  // Open directly from the collapsed row, with a live pointer-sized preview.
  await page.click('[data-files-collapse]')
  const collapsedRow = await (await page.$('[data-sidebar-files-toggle]')).boundingBox()
  const grab = { x: collapsedRow.x + 70, y: collapsedRow.y + 14 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x, grab.y - 200, { steps: 8 })
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 228)
  assert.equal(await page.$$eval('[data-sidebar-files-resize]', els => els.length), 0, 'Drag preview must not commit state')
  await page.mouse.up()
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), 200)
  assert(await page.$eval('[data-sidebar-files-resize]', el => el === document.activeElement))
  // A small movement remains a click and restores the newly saved size.
  await page.click('[data-files-collapse]')
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 1, grab.y - 3)
  await page.mouse.up()
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), 200)
  // Escape must retain the collapsed state through pointer release and its click.
  await page.click('[data-files-collapse]')
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x, grab.y - 180, { steps: 6 })
  await page.keyboard.press('Escape')
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.up()
  await paint()
  assert.equal(await page.$eval('[data-sidebar-files]', el => el.clientHeight), 28)
  await page.click('[data-sidebar-files-toggle]')
  assert.equal(await page.$eval('[data-sidebar-files-resize]', el => Number(el.getAttribute('aria-valuenow'))), 200)
  const search = '[data-sidebar-state] [data-files-search]'
  const fieldBox = await (await page.$(search)).boundingBox()
  await page.click(search)
  assert.deepEqual(await (await page.$(search)).boundingBox(), fieldBox, 'Focus must not add rows')
  assert.equal(await page.$$eval('[data-files-search-scope]', els => els.length), 0)
  await page.type(search, 'alpha')
  assert.equal(await page.$eval(search, el => el.value), 'alpha', 'Search must retain every typed character after drag restore')
  await page.waitForSelector('[data-sidebar-state] [data-search-kind="content"]').catch(async error => {
    console.error('Search state after drag restore:', await page.$eval('[data-sidebar-state]', sidebar => ({
      query: sidebar.querySelector('[data-files-search]')?.value,
      focused: document.activeElement?.outerHTML,
      text: sidebar.innerText,
    })), errors)
    throw error
  })
  const results = await page.$$eval('[data-sidebar-state] [data-files-search-match]', rows => rows.map(row => ({ kind: row.dataset.searchKind, path: row.dataset.searchPath, height: row.getBoundingClientRect().height })))
  assert.deepEqual(results.map(row => row.kind), ['name', 'content'])
  assert.equal(new Set(results.map(row => row.path)).size, results.length)
  assert(results.every(row => row.height === 44))
  if (process.env.SIDEBAR_SCREENSHOT) await page.screenshot({ path: process.env.SIDEBAR_SCREENSHOT })
  assert.deepEqual(errors, [])
  console.log(`Passed ${count} Sidebar layouts, fixed icon positions, shared scroll, drawer resize/restore, drag collapse and reopen, drag from collapsed, and unified search.`)
} finally { await browser.close() }
