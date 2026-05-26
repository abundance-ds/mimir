import { ref } from 'vue'
import { Marked } from 'marked'

function createMarkedWithLineNumbers() {
  let lineCounter = 0

  const m = new Marked({
    walkTokens(token) {
      if (token.type === 'space') {
        lineCounter += (token.raw.match(/\n/g) || []).length
        return
      }
      token._sourceLine = lineCounter
      lineCounter += (token.raw?.match(/\n/g) || []).length
    },
    renderer: {
      heading(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        return `<h${token.depth}${attr}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`
      },
      paragraph(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        return `<p${attr}>${this.parser.parseInline(token.tokens)}</p>\n`
      },
      list(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        const tag = token.ordered ? 'ol' : 'ul'
        let body = ''
        for (const item of token.items) {
          let itemBody = this.parser.parse(item.tokens)
          if (item.task) {
            const checkbox = `<input type="checkbox"${item.checked ? ' checked=""' : ''} disabled="" /> `
            itemBody = itemBody.replace(/^<p/, '<p').replace(/>/, '>' + checkbox)
          }
          body += `<li>${itemBody}</li>\n`
        }
        return `<${tag}${attr}>\n${body}</${tag}>\n`
      },
      blockquote(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        return `<blockquote${attr}>${this.parser.parse(token.tokens)}</blockquote>\n`
      },
      code(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        const lang = token.lang ? ` class="language-${token.lang}"` : ''
        const escaped = (token.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<pre${attr}><code${lang}>${escaped}</code></pre>\n`
      },
      hr(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        return `<hr${attr} />\n`
      },
      table(token) {
        const attr = token._sourceLine != null ? ` data-source-line="${token._sourceLine}"` : ''
        let header = '<tr>'
        for (let i = 0; i < token.header.length; i++) {
          const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : ''
          header += `<th${align}>${this.parser.parseInline(token.header[i].tokens)}</th>`
        }
        header += '</tr>\n'
        let body = ''
        for (const row of token.rows) {
          body += '<tr>'
          for (let i = 0; i < row.length; i++) {
            const align = token.align[i] ? ` style="text-align:${token.align[i]}"` : ''
            body += `<td${align}>${this.parser.parseInline(row[i].tokens)}</td>`
          }
          body += '</tr>\n'
        }
        return `<table${attr}>\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table>\n`
      },
    },
  })

  function parse(content) {
    lineCounter = 0
    return m.parse(content)
  }

  return { parse }
}

function scheduleIdle(fn, timeout = 500) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(fn, 0)
  return () => clearTimeout(id)
}

export function useDeferredMarkdownPreview({ delay = 180 } = {}) {
  const markedInstance = createMarkedWithLineNumbers()
  const html = ref('')
  let timer = null
  let cancelIdle = null

  function clearScheduled() {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    if (cancelIdle) {
      cancelIdle()
      cancelIdle = null
    }
  }

  function render(content, enabled = true) {
    clearScheduled()
    html.value = enabled && content ? markedInstance.parse(content) : ''
  }

  function schedule(content, enabled = true) {
    clearScheduled()
    if (!enabled) {
      html.value = ''
      return
    }
    timer = setTimeout(() => {
      timer = null
      cancelIdle = scheduleIdle(() => {
        cancelIdle = null
        html.value = content ? markedInstance.parse(content) : ''
      })
    }, delay)
  }

  function dispose() {
    clearScheduled()
  }

  return {
    html,
    render,
    schedule,
    dispose,
  }
}
