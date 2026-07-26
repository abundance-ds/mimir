export function parseLauncherFlags(value) {
  const source = String(value || '')
  const args = []
  let token = ''
  let tokenStarted = false
  let quote = ''
  let escaping = false

  for (const character of source) {
    if (escaping) {
      token += character
      tokenStarted = true
      escaping = false
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = ''
      else token += character
      tokenStarted = true
      continue
    }
    if (quote === '"') {
      if (character === '"') quote = ''
      else if (character === '\\') escaping = true
      else token += character
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }
    if (character === '\\') {
      escaping = true
      tokenStarted = true
      continue
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        args.push(token)
        token = ''
        tokenStarted = false
      }
      continue
    }
    token += character
    tokenStarted = true
  }

  if (escaping) throw new Error('CLI flags cannot end with an unfinished escape (\\).')
  if (quote) throw new Error(`CLI flags contain an unclosed ${quote === "'" ? 'single' : 'double'} quote.`)
  if (tokenStarted) args.push(token)
  return args
}

export function formatLauncherFlags(args = []) {
  return args.map((value) => {
    const argument = String(value)
    if (!argument) return "''"
    if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(argument)) return argument
    return `'${argument.replaceAll("'", `'\"'\"'`)}'`
  }).join(' ')
}
