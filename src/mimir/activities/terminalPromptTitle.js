const MAX_PROMPT_CHARS = 16 * 1024
const MAX_ESCAPE_CHARS = 256
const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'

export function createTerminalPromptTitleTracker() {
  let buffer = []
  let cursor = 0
  let bracketedPaste = false
  let invalidated = false
  let escapeCarry = ''
  let controlString = false
  let controlEscape = false

  function append(value) {
    const inserted = Array.from(value)
    buffer.splice(cursor, 0, ...inserted)
    cursor += inserted.length
    if (buffer.length <= MAX_PROMPT_CHARS) return
    const overflow = buffer.length - MAX_PROMPT_CHARS
    buffer.splice(0, overflow)
    cursor = Math.max(0, cursor - overflow)
  }

  function submit() {
    const title = invalidated ? '' : deriveProvisionalActivityTitle(buffer.join(''))
    clearPrompt()
    return title
  }

  function stripTerminalProtocol(value) {
    const input = `${escapeCarry}${String(value || '')}`
    escapeCarry = ''
    let output = ''
    let index = 0

    while (index < input.length) {
      const character = input[index]
      if (controlString) {
        if (controlEscape) {
          controlEscape = character === '\u001b'
          if (character === '\\') {
            controlString = false
            controlEscape = false
          }
        } else if (character === '\u0007' || character === '\u009c') {
          controlString = false
        } else if (character === '\u001b') {
          controlEscape = true
        }
        index += 1
        continue
      }

      if (isControlStringIntroducer(character)) {
        controlString = true
        controlEscape = false
        index += 1
        continue
      }
      if (character === '\u009b') {
        const sequence = scanCsiSequence(input, index + 1)
        if (!sequence.complete) {
          retainEscape(input.slice(index))
          break
        }
        output += `\u001b[${input.slice(index + 1, sequence.end)}`
        index = sequence.end
        continue
      }
      if (character === '\u008f') {
        const sequence = scanCsiSequence(input, index + 1)
        if (!sequence.complete) {
          retainEscape(input.slice(index))
          break
        }
        output += `\u001bO${input.slice(index + 1, sequence.end)}`
        index = sequence.end
        continue
      }
      if (character === '\u001b') {
        if (index + 1 >= input.length) {
          escapeCarry = character
          break
        }
        const introducer = input[index + 1]
        if (']P_^X'.includes(introducer)) {
          controlString = true
          controlEscape = false
          index += 2
          continue
        }
        if (introducer === '[' || introducer === 'O') {
          const sequence = scanCsiSequence(input, index + 2)
          if (!sequence.complete) {
            retainEscape(input.slice(index))
            break
          }
          output += input.slice(index, sequence.end)
          index = sequence.end
          continue
        }
        output += input.slice(index, index + 2)
        index += 2
        continue
      }
      if (character >= '\u0080' && character <= '\u009f') {
        index += 1
        continue
      }
      output += character
      index += 1
    }
    return output
  }

  function retainEscape(value) {
    if (value.length <= MAX_ESCAPE_CHARS) {
      escapeCarry = value
      return
    }
    // An unterminated control sequence must fail closed, not become a title.
    invalidated = true
  }

  function lineStart() {
    if (cursor <= 0) return 0
    return buffer.lastIndexOf('\n', cursor - 1) + 1
  }

  function lineEnd() {
    const end = buffer.indexOf('\n', cursor)
    return end < 0 ? buffer.length : end
  }

  function moveWord(direction) {
    if (direction < 0) {
      while (cursor > 0 && /\s/u.test(buffer[cursor - 1])) cursor -= 1
      while (cursor > 0 && !/\s/u.test(buffer[cursor - 1])) cursor -= 1
      return
    }
    while (cursor < buffer.length && !/\s/u.test(buffer[cursor])) cursor += 1
    while (cursor < buffer.length && /\s/u.test(buffer[cursor])) cursor += 1
  }

  function applyEscape(sequence) {
    if (/^\u001b\[(?:1;\d+)?D$/.test(sequence)) cursor = Math.max(0, cursor - 1)
    else if (/^\u001b\[(?:1;\d+)?C$/.test(sequence)) cursor = Math.min(buffer.length, cursor + 1)
    else if (/^\u001b\[(?:H|1~|7~)$/.test(sequence)) cursor = lineStart()
    else if (/^\u001b\[(?:F|4~|8~)$/.test(sequence)) cursor = lineEnd()
    else if (sequence === '\u001b[3~' && cursor < buffer.length) buffer.splice(cursor, 1)
    else if (sequence === '\u001bb') moveWord(-1)
    else if (sequence === '\u001bf') moveWord(1)
    else if (/^\u001b\[(?:A|B|5~|6~)$/.test(sequence)) invalidated = true
  }

  function feed(value) {
    const input = stripTerminalProtocol(value)
    let title = null
    let index = 0
    while (index < input.length) {
      if (input.startsWith(BRACKETED_PASTE_START, index)) {
        bracketedPaste = true
        index += BRACKETED_PASTE_START.length
        continue
      }
      if (input.startsWith(BRACKETED_PASTE_END, index)) {
        bracketedPaste = false
        index += BRACKETED_PASTE_END.length
        continue
      }

      const character = input[index]
      if (bracketedPaste) {
        append(character === '\r' ? '\n' : character)
        index += 1
        continue
      }
      if (character === '\r') {
        title ||= submit()
        index += 1
        continue
      }
      if (character === '\n' || character === '\t') {
        append(character)
        index += 1
        continue
      }
      if (character === '\u007f' || character === '\b') {
        if (cursor > 0) {
          buffer.splice(cursor - 1, 1)
          cursor -= 1
        }
        index += 1
        continue
      }
      if (character === '\u0001') {
        cursor = lineStart()
        index += 1
        continue
      }
      if (character === '\u0005') {
        cursor = lineEnd()
        index += 1
        continue
      }
      if (character === '\u0004') {
        if (cursor < buffer.length) buffer.splice(cursor, 1)
        index += 1
        continue
      }
      if (character === '\u000b') {
        buffer.splice(cursor, lineEnd() - cursor)
        index += 1
        continue
      }
      if (character === '\u0015') {
        const start = lineStart()
        buffer.splice(start, cursor - start)
        cursor = start
        index += 1
        continue
      }
      if (character === '\u0017') {
        const end = cursor
        moveWord(-1)
        buffer.splice(cursor, end - cursor)
        index += 1
        continue
      }
      if (character === '\u0003') {
        clearPrompt()
        index += 1
        continue
      }
      if (character === '\u001b') {
        const end = skipEscapeSequence(input, index)
        applyEscape(input.slice(index, end))
        index = end
        continue
      }
      if (character >= ' ') append(character)
      index += 1
    }
    return title
  }

  function paste(value) {
    append(String(value || '').replace(/\r\n?/g, '\n'))
  }

  function clearPrompt() {
    buffer = []
    cursor = 0
    bracketedPaste = false
    invalidated = false
  }

  function reset() {
    clearPrompt()
    escapeCarry = ''
    controlString = false
    controlEscape = false
  }

  return { feed, paste, reset }
}

function isControlStringIntroducer(character) {
  return ['\u0090', '\u0098', '\u009d', '\u009e', '\u009f'].includes(character)
}

function isCsiFinal(character = '') {
  const code = character.charCodeAt(0)
  return code >= 0x40 && code <= 0x7e
}

function scanCsiSequence(value, start) {
  let index = start
  while (index < value.length) {
    if (isCsiFinal(value[index])) {
      return { end: index + 1, complete: true }
    }
    index += 1
  }
  return { end: index, complete: false }
}

export function deriveProvisionalActivityTitle(value) {
  const text = redactSensitiveText(String(value || ''))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
  const candidates = text
    .split(/\r?\n/)
    .map(cleanCandidateLine)
    .filter(Boolean)
    .flatMap(splitCandidateSentences)
    .filter(isSubstantiveCandidate)
  if (!candidates.length) return ''

  const selected = candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
    ?.candidate
  return boundTitle(selected || '')
}

function cleanCandidateLine(value) {
  const line = value
    .replace(/^\s*(?:>|#{1,6}|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line || line.startsWith('/')) return ''
  if (isPathOnlyLine(line) || isLogOrCodeLine(line)) return ''
  return line
}

function splitCandidateSentences(value) {
  const sentences = value
    .split(/(?<=[.!?])\s+(?=[\p{L}\p{N}])/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  return sentences.length ? sentences : [value]
}

function candidateScore(value) {
  const words = value.split(/\s+/).filter(Boolean)
  let score = words.length >= 3 && words.length <= 18 ? 3 : 1
  if (/[?]$/.test(value)) score += 2
  if (/\b(?:add|build|change|check|create|debug|diagnose|explain|find|fix|implement|investigate|remove|rename|restore|review|update|why|how|what|analysiere|baue|ändere|erkläre|finde|fixe|implementiere|prüfe|stelle|untersuche|warum|wie|was)\b/iu.test(value)) score += 2
  if (/\b(?:bug|broken|error|fail(?:ed|ing|ure)?|issue|lost|missing|problem|regression|fehler|kaputt|problem|verloren|wieder)\b/iu.test(value)) score += 2
  return score
}

function isSubstantiveCandidate(value) {
  const words = value.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []
  if (words.length < 2) return false
  return !/^(?:accept|cancel|continue|ja|nein|no|ok(?:ay)?|quit|retry|skip|yes)(?:\s+(?:please|bitte))?$/iu.test(value)
}

function isPathOnlyLine(value) {
  const tokens = value.split(/\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.every(token => (
    /^(?:[.~]?\/?[\w@+-]+\/)+[\w@+.,()\[\]-]+$/.test(token)
    || /^[\w@+-]+\.[a-z0-9]{1,8}(?::\d+)?$/i.test(token)
  ))
}

function isLogOrCodeLine(value) {
  return /^(?:\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|at\s+\S+|stack backtrace:|traceback|(?:debug|error|info|warn(?:ing)?)[\s:[-])/i.test(value)
    || /^[{}[\]();,]+$/.test(value)
    || /^(?:npm|bun|cargo|git|node|python|rustc)\s+\S+/.test(value)
}

function redactSensitiveText(value) {
  return value
    .replace(/\b(?:https?|file):\/\/\S+/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, ' ')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])-[_a-z0-9-]{12,}\b/gi, ' ')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, ' ')
    .replace(/\b(?:[a-f0-9]{24,}|[A-Za-z0-9+/=_-]{40,})\b/g, ' ')
}

function boundTitle(value) {
  let title = value
    .replace(/^(?:please\s+|please help(?: me)?(?: to)?\s+|can you\s+|could you\s+|would you\s+|help me(?: to)?\s+|i (?:need|want|have)\s+|we (?:need|want|have)\s+|bitte\s+|kannst du\s+|könntest du\s+|hilf mir(?: bitte)?\s+|ich (?:brauche|möchte|habe)\s+|wir (?:brauchen|möchten|haben)(?: schon wieder)?\s+)/iu, '')
    .replace(/\s+/g, ' ')
    .trim()
  title = title.split(/\s+/).slice(0, 8).join(' ')
  if (Array.from(title).length > 60) {
    title = Array.from(title).slice(0, 60).join('')
    title = title.slice(0, title.lastIndexOf(' ')).trim()
  }
  title = title.replace(/(?:\s+(?:and|at|for|from|in|on|using|with|bei|für|mit|und|von|zu))+$/iu, '')
  title = title.replace(/[.,;:!?\-–—]+$/g, '').trim()
  if (!title) return ''
  return `${title[0].toLocaleUpperCase()}${title.slice(1)}`
}

function skipEscapeSequence(value, start) {
  if (value[start + 1] !== '[' && value[start + 1] !== 'O') {
    return Math.min(value.length, start + 2)
  }
  return scanCsiSequence(value, start + 2).end
}
