import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { expect, it } from 'vitest'

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)])
}

it('every authored text control disables native automatic text features before first focus', () => {
  const root = join(process.cwd(), 'src')
  const problems = []
  let checked = 0
  for (const file of files(root).filter(file => file.endsWith('.vue'))) {
    const ast = parse(readFileSync(file, 'utf8')).descriptor.template?.ast
    function visit(node) {
      if (['input', 'textarea'].includes(node.tag)) {
        const attrs = Object.fromEntries(node.props.filter(prop => prop.type === 6).map(prop => [prop.name, prop.value?.content]))
        if (node.tag === 'textarea' || ['text', 'search', 'email', 'url', 'password', 'tel', 'number'].includes(attrs.type || 'text')) {
          checked++
          for (const name of ['autocorrect', 'autocapitalize', 'autocomplete']) {
            if (attrs[name] !== 'off') problems.push(`${file}:${node.loc.start.line} ${name}`)
          }
          for (const name of ['spellcheck', 'writingsuggestions']) {
            if (attrs[name] !== 'false') problems.push(`${file}:${node.loc.start.line} ${name}`)
          }
        }
      }
      for (const child of node.children || []) visit(child)
    }
    if (ast) visit(ast)
  }
  expect(checked).toBeGreaterThan(80)
  expect(problems).toEqual([])
})
