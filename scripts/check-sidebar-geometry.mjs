#!/usr/bin/env node
// Checks real browser geometry against the Files harness; uses existing Puppeteer.
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
  const measure = () => page.evaluate(() => {
    const side = document.querySelector('[data-sidebar-state]')
    const rect = element => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      if (!box.width || !box.height) return null
      return [box.x + box.width / 2, box.y + box.height / 2]
    }
    const get = selector => rect(side.querySelector(selector))
    return {
      workspace: get('[data-sidebar-workspace] > span'),
      tools: [...side.querySelectorAll('[data-tool-key] svg')].map(rect),
      toolsScroll: side.querySelector('nav[aria-label="Tools"]').scrollTop,
      record: get('[title="Open recording"] svg'),
      microphone: get('[data-sidebar-meeting-microphone] svg'),
      stop: get('[aria-label="Stop recording"] svg'),
      files: get('[data-sidebar-files-restore] svg') || get('[data-files-mode="project"] svg'),
      settings: get('[data-sidebar-settings] svg'),
    }
  })
  let count = 0
  for (const width of [240, 280, 400]) for (const height of [420, 800]) {
    for (const tools of [5, 30]) for (const recording of [false, true]) for (const toolsClosed of [false, true]) {
      const label = JSON.stringify({ width, height, tools, recording, toolsClosed })
      await page.setViewport({ width: 1400, height })
      await page.goto(`${base}/harness/files.html?width=${width}&tools=${tools}${recording ? '&recording' : ''}${toolsClosed ? '&toolsClosed' : ''}`, { waitUntil: 'networkidle0' })
      if (!toolsClosed && tools === 30) {
        await page.$eval('[data-sidebar-state] nav[aria-label="Tools"]', element => { element.scrollTop = 55 })
      }
      const before = await measure()
      await page.click('[data-sidebar-collapse]')
      assert.deepEqual(await measure(), before, `Collapse moved icons: ${label}`)
      const hiddenHeading = await page.$eval('[data-tools-disclosure]', element => ({
        height: element.getBoundingClientRect().height,
        visibility: getComputedStyle(element).visibility,
        tabIndex: element.tabIndex,
      }))
      assert(hiddenHeading.height > 0)
      assert.equal(hiddenHeading.visibility, 'hidden')
      assert.equal(hiddenHeading.tabIndex, -1)
      await page.click('[data-sidebar-files-restore]')
      assert.deepEqual(await measure(), before, `Restore moved icons: ${label}`)
      count++
    }
  }
  assert.deepEqual(errors, [])
  console.log(`Passed ${count} Sidebar layouts: icon coordinates and Tools scroll stay fixed through collapse and restore.`)
} finally {
  await browser.close()
}
