const MIN_IDEAL_WIDTH = 112
const MAX_IDEAL_WIDTH = 188
const TAB_CHROME_WIDTH = 38
const MONO_CHARACTER_WIDTH = 6.7
const DEFAULT_TRAILING_CHARACTERS = 7
const COMPACT_NAME_CHARACTERS = 14
const FITTING_NAME_CHARACTERS = 8

function characterCount(value) {
  return Array.from(String(value || '')).length
}

export function tabIdealWidth(name) {
  const contentWidth = TAB_CHROME_WIDTH + characterCount(name) * MONO_CHARACTER_WIDTH
  return Math.round(Math.min(MAX_IDEAL_WIDTH, Math.max(MIN_IDEAL_WIDTH, contentWidth)))
}

export function splitTabName(name) {
  const value = String(name || '')
  const characters = Array.from(value)
  if (characters.length <= FITTING_NAME_CHARACTERS) {
    return { leading: value, trailing: '' }
  }

  const extensionMatch = value.match(/(\.[^./\\]+)$/)
  const extension = extensionMatch?.[1] !== value ? extensionMatch?.[1] || '' : ''
  if (characters.length <= COMPACT_NAME_CHARACTERS) {
    const trailingLength = extension
      ? characterCount(extension)
      : Math.min(3, Math.floor(characters.length / 3))
    return {
      leading: characters.slice(0, -trailingLength).join(''),
      trailing: characters.slice(-trailingLength).join(''),
    }
  }

  const extensionLength = characterCount(extension)
  const trailingLimit = Math.max(DEFAULT_TRAILING_CHARACTERS, extensionLength + 2)
  const stem = extension ? value.slice(0, -extension.length) : value
  const lastSeparator = Math.max(
    stem.lastIndexOf(' '),
    stem.lastIndexOf('-'),
    stem.lastIndexOf('_'),
    stem.lastIndexOf('.'),
  )
  const semanticTrailing = lastSeparator >= 0
    ? value.slice(lastSeparator + 1)
    : ''
  const semanticLength = characterCount(semanticTrailing)
  const trailingLength = semanticLength > 0 && semanticLength <= trailingLimit
    ? semanticLength
    : Math.min(trailingLimit, characters.length)
  const leadingLength = characters.length - trailingLength

  return {
    leading: characters.slice(0, leadingLength).join(''),
    trailing: characters.slice(leadingLength).join(''),
  }
}
