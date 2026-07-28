const encoder = new TextEncoder()

const ENDED = new Set(['done', 'error', 'stopped', 'interrupted'])

const STATUS_LABELS = {
  ready: 'Ready',
  starting: 'Starting',
  working: 'Working',
  'needs-input': 'Input',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
}

export function terminalBytes(value) {
  if (typeof value === 'string') return encoder.encode(value)
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return Uint8Array.from(value || [])
}

export function isEndedStatus(status) {
  return ENDED.has(status)
}

export function terminalStatusLabel(status) {
  return STATUS_LABELS[status] || 'Unknown'
}

export function eventActivityId(event) {
  return event?.activityId || event?.activity_id || ''
}

export function orderedReplayChunks(snapshot) {
  return [...(snapshot?.scrollback?.chunks || [])]
    .filter((chunk) => Number.isFinite(Number(chunk?.sequence)))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
}

export async function prepareTerminalFonts(
  fontSize,
  fonts = typeof document === 'undefined' ? null : document.fonts,
) {
  if (!fonts?.load) return
  const size = Math.max(9, Math.min(24, Number(fontSize) || 12))
  await Promise.allSettled([
    fonts.load(`400 ${size}px "IBM Plex Mono"`, 'MW'),
    fonts.load(`italic 400 ${size}px "IBM Plex Mono"`, 'MW'),
    fonts.load(`600 ${size}px "IBM Plex Mono"`, 'MW'),
    fonts.load(`italic 600 ${size}px "IBM Plex Mono"`, 'MW'),
  ])
}

export function readTerminalTheme(root = document.documentElement) {
  const styles = getComputedStyle(root)
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback
  const accent = token('--color-accent', '#c05d3c')
  const surface = token('--color-surface', '#ffffff')
  const ink = token('--color-ink', '#1a1a18')
  const ink2 = token('--color-ink-2', '#4a4a44')
  const ink3 = token('--color-ink-3', '#8a8a80')
  const dark = isDarkHex(surface)

  return {
    background: surface,
    foreground: ink,
    cursor: accent,
    cursorAccent: surface,
    selectionBackground: withAlpha(accent, '33'),
    selectionInactiveBackground: withAlpha(accent, '1f'),
    scrollbarSliderBackground: withAlpha(ink3, '66'),
    scrollbarSliderHoverBackground: withAlpha(ink2, '99'),
    scrollbarSliderActiveBackground: withAlpha(accent, 'aa'),
    black: dark ? token('--color-chrome', '#1e1e1e') : ink,
    red: token('--color-rem', '#c05d3c'),
    green: token('--color-add', '#5e8b3e'),
    yellow: '#d4a520',
    blue: '#4a7c9b',
    magenta: '#7c4dff',
    cyan: '#5a9e8f',
    white: dark ? ink2 : ink3,
    brightBlack: ink3,
    brightRed: '#e07070',
    brightGreen: '#7cc68a',
    brightYellow: '#f0c040',
    brightBlue: '#6ea8c8',
    brightMagenta: '#b39dff',
    brightCyan: '#7cc6b8',
    brightWhite: ink,
  }
}

function withAlpha(color, alpha) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${alpha}`
  return color
}

function isDarkHex(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return false
  const value = Number.parseInt(match[1], 16)
  const red = value >> 16
  const green = (value >> 8) & 0xff
  const blue = value & 0xff
  return (red * 299 + green * 587 + blue * 114) / 255_000 < 0.5
}
