#!/usr/bin/env node
// Exercise xterm's real viewport: buffer-only tests miss DOM scroll timing.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core')
const routes = new Map([
  ['/xterm.js', ['../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript']],
  ['/xterm.css', ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css']],
  ['/anchor.js', ['../src/mimir/activities/terminalResizeAnchor.js', 'text/javascript']],
])
const server = createServer(async (request, response) => {
  const route = routes.get(request.url)
  if (route) {
    response.setHeader('Content-Type', route[1])
    response.end(await readFile(new URL(route[0], import.meta.url)))
  } else {
    response.setHeader('Content-Type', 'text/html')
    response.end('<link rel="stylesheet" href="/xterm.css"><div id="terminal" style="width:1100px;height:650px"></div><script src="/xterm.js"></script>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const result = await page.evaluate(async () => {
    const { createTerminalResizeAnchor } = await import('/anchor.js')
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true })
    terminal.open(document.querySelector('#terminal'))
    const anchor = createTerminalResizeAnchor(terminal)
    const write = text => new Promise(resolve => terminal.write(text, resolve))
    const settle = async () => {
      for (let index = 0; index < 3; index += 1) await new Promise(requestAnimationFrame)
    }
    const text = Array.from({ length: 200 }, (_, index) => (
      `line ${String(index).padStart(3, '0')} ${'sample '.repeat(index % 10 + 3)}\r\n`
    )).join('')
    const state = () => {
      const buffer = terminal.buffer.active
      return {
        top: buffer.viewportY,
        base: buffer.baseY,
        text: buffer.getLine(buffer.viewportY)?.translateToString(true),
        rendered: document.querySelector('.xterm-rows > div')?.textContent.replace(/\u00a0/g, ' '),
      }
    }
    await write(text)
    await settle()
    terminal.scrollToLine(109)
    await settle()
    const before = state()
    const resized = []
    for (const [cols, rows] of [[50, 24], [110, 40], [65, 18], [80, 24], [40, 35], [100, 15]]) {
      anchor.begin()
      terminal.resize(cols, rows)
      anchor.applied(true)
      await settle()
      resized.push(state())
    }
    await write('\x1b[3J\x1b[H\x1b[2J')
    anchor.applied()
    await settle()
    const redrawn = []
    for (let index = 0; index < text.length; index += 2000) {
      await write(text.slice(index, index + 2000))
      anchor.applied()
      await settle()
      redrawn.push(state())
    }
    anchor.cancel()
    terminal.scrollToBottom()
    await settle()
    const bottom = []
    for (const [cols, rows] of [[65, 20], [110, 40], [80, 24]]) {
      anchor.begin()
      terminal.resize(cols, rows)
      anchor.applied(true)
      await settle()
      await write('\x1b[3J\x1b[H\x1b[2J' + text)
      anchor.applied()
      await settle()
      bottom.push(state())
    }
    anchor.dispose()
    terminal.dispose()
    return { before, resized, redrawn, bottom }
  })
  for (const state of result.resized) assert.equal(state.text, result.before.text)
  for (const state of result.redrawn) {
    assert.equal(state.top, Math.round(result.before.top / result.before.base * state.base))
  }
  for (const state of result.bottom) assert.equal(state.top, state.base)
  for (const state of [result.before, ...result.resized, ...result.redrawn, ...result.bottom]) {
    assert.equal(state.rendered?.trimEnd(), state.text.trimEnd())
  }
  assert.deepEqual(errors, [])
  console.log('Passed browser checks for reading position, width/height changes, split redraws, and bottom following.')
} finally {
  await browser?.close()
  server.close()
}
