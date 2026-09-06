#!/usr/bin/env node
// Runs against the Vite harness. Uses an existing Puppeteer Core installation.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core')
const base = process.argv[2] || 'http://127.0.0.1:1420'
const output = process.env.PREVIEW_SCREENSHOTS
if (output) await mkdir(output, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  async function open(query) {
    await page.goto(`${base}/harness/image-preview.html?${query}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('img.preview-image', { visible: true })
  }
  for (const theme of ['studio', 'dracula']) {
    for (const width of [320, 520, 900]) {
      await page.setViewport({ width, height: 700, deviceScaleFactor: 2 })
      await open(`theme=${theme}`)
      const metrics = await page.evaluate(() => {
        const bar = document.querySelector('[data-image-toolbar]')
        const image = document.querySelector('img.preview-image').getBoundingClientRect()
        const viewport = document.querySelector('[role="region"]').getBoundingClientRect()
        return { barHeight: bar.getBoundingClientRect().height, overflow: bar.scrollWidth - bar.clientWidth,
          contained: image.left >= viewport.left && image.right <= viewport.right && image.top >= viewport.top && image.bottom <= viewport.bottom }
      })
      assert.equal(metrics.barHeight, 36)
      assert.equal(metrics.overflow, 0, `Toolbar overflow at ${width}px`)
      assert.equal(metrics.contained, true, 'Fit must contain the image')
      if (output) await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) })
      await page.click('[title="Actual size (0)"]')
      await page.click('[aria-label="SVG view"] button:nth-child(2)')
      assert.equal(await page.$eval('[role="region"]', el => getComputedStyle(el).display), 'none')
      assert.ok(await page.$eval('textarea', el => el.clientHeight) > 500)
      await page.click('[aria-label="SVG view"] button:first-child')
      assert.equal(await page.$eval('output', el => el.textContent), '100%')
    }
  }
  await page.setViewport({ width: 520, height: 700, deviceScaleFactor: 2 })
  for (const type of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    await open(`type=${type}`)
    assert.equal(await page.$eval('img.preview-image', el => el.naturalWidth), type === 'gif' ? 1 : 1200)
    const reads = await page.evaluate(() => {
      window.previewReads = 0
      const invoke = window.__TAURI_INTERNALS__.invoke
      window.__TAURI_INTERNALS__.invoke = (...args) => {
        if (args[0] === 'read_binary_file') window.previewReads++
        return invoke(...args)
      }
      return window.previewReads
    })
    assert.equal(reads, 0)
    await page.click('[title="Actual size (0)"]')
    await page.mouse.move(260, 350)
    await page.mouse.down()
    await page.mouse.move(200, 310, { steps: 5 })
    await page.mouse.up()
    const before = await page.$eval('img.preview-image', el => ({ style: el.style.cssText, url: el.src }))
    await page.evaluate(() => { window.previewFile.previewRevision++ })
    await page.waitForFunction(url => document.querySelector('img.preview-image')?.src !== url, {}, before.url)
    assert.equal(await page.$eval('img.preview-image', el => el.style.cssText), before.style)
    assert.equal(await page.evaluate(() => window.previewReads), 1)
  }
  await open('theme=studio')
  const requests = []
  page.on('request', request => { if (request.url().includes('/preview-external-probe')) requests.push(request.url()) })
  const oldUrl = await page.$eval('img.preview-image', el => el.src)
  await page.evaluate(() => {
    window.previewFile.content = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
      <script>window.previewScriptExecuted = true</script>
      <image href="${location.origin}/preview-external-probe" width="100" height="100"/>
      <rect width="100" height="100" fill="red"/></svg>`
  })
  await page.waitForFunction(url => document.querySelector('img.preview-image')?.src !== url, {}, oldUrl)
  assert.equal(await page.evaluate(() => window.previewScriptExecuted), undefined)
  assert.deepEqual(requests, [])
  assert.deepEqual(errors, [])
  console.log('Image browser checks passed: 6 layouts, 5 raster formats, SVG source, refresh, pan, and SVG resource isolation.')
} finally {
  await browser.close()
}
