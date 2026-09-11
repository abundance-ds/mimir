#!/usr/bin/env node
// The restored Sidebar treatment uses the real components and their original animation.
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
  await page.setViewport({ width: 1400, height: 900 })
  let cases = 0
  for (const width of [240, 280, 400]) for (const theme of ['parchment', 'dracula']) {
    await page.goto(`${base}/harness/files.html?states&filesClosed&width=${width}`, { waitUntil: 'networkidle0' })
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
    for (const rail of [false, true]) {
      if (rail) await page.click('[data-sidebar-collapse]')
      for (const reduce of [false, true]) {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }])
        const state = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-activity-key]')]
          const dots = [...document.querySelectorAll('[data-activity-working="working"] > span')]
          const row = id => rows.find(row => row.dataset.activityKey === id)
          const animations = dots.map(dot => ({ name: getComputedStyle(dot).animationName, duration: getComputedStyle(dot).animationDuration }))
          return {
            heights: rows.map(row => row.getBoundingClientRect().height),
            animations,
            markers: ['error', 'needs-input', 'unread'].map(id => row(id).querySelector('[role=img]')?.getAttribute('aria-label')),
            quiet: ['idle', 'done', 'interrupted', 'prompt-ready', 'resuming'].every(id => !row(id).querySelector('[data-activity-working], [data-activity-error], [data-activity-attention], [data-activity-unread]')),
            providerIcons: rows.map(row => row.querySelectorAll('button > span:first-child svg').length),
          }
        })
        assert(state.heights.every(height => height === 24))
        assert.equal(state.animations.length, 9)
        assert(state.animations.every(animation => reduce ? animation.name === 'none' : animation.name.startsWith('m') && animation.duration === '5s'))
        assert.deepEqual(state.markers, ['Error', 'Needs input', 'Unread'])
        assert(state.quiet)
        assert(state.providerIcons.every(count => count === 1))
        cases++
      }
    }
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
  await page.goto(`${base}/harness/files.html?states&filesClosed&width=280`, { waitUntil: 'networkidle0' })
  const frames = await page.$eval('[data-activity-working="working"]', async grid => {
    const read = () => [...grid.children].map(dot => getComputedStyle(dot).opacity)
    const before = read()
    await new Promise(resolve => setTimeout(resolve, 350))
    return [before, read()]
  })
  assert.notDeepEqual(frames[0], frames[1], 'Working dots must visibly animate')
  await page.click('[data-activity-key="needs-input"] > button')
  assert.equal(await page.$$eval('[data-activity-attention="needs-input"]', els => els.length), 0)
  await page.click('[data-sidebar-files-toggle]')
  assert(await page.$$eval('[data-activity-working] > span', dots => dots.every(dot => getComputedStyle(dot).animationPlayState === 'running')))
  await page.click('[data-files-collapse]')
  if (process.env.SIDEBAR_SCREENSHOT) await page.screenshot({ path: process.env.SIDEBAR_SCREENSHOT })
  assert.deepEqual(errors, [])
  console.log(`Passed ${cases} Activity status layouts, live animation, attention acknowledgement, and Files drawer checks.`)
} finally {
  await browser.close()
}
