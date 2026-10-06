import starter from './agents-starter.md?raw'

export const AGENTS_STARTER = starter

export function normalizeAgentsTemplate(value) {
  return typeof value === 'string' && value.trim() ? value : AGENTS_STARTER
}
