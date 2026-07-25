const MAX_OUTPUT_CHARS = 48_000

export function withGate(name, executeFn) {
  return async (args) => {
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      return { error: `Tool '${name}' received invalid arguments: expected an object, got ${typeof args}.`, blocked: true }
    }

    return enforceOutputSize(await executeFn(args))
  }
}

function enforceOutputSize(result) {
  if (typeof result === 'string' && result.length > MAX_OUTPUT_CHARS) {
    return result.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Truncated]'
  }
  if (result && typeof result === 'object' && typeof result.content === 'string' && result.content.length > MAX_OUTPUT_CHARS) {
    return { ...result, content: result.content.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Truncated]' }
  }
  return result
}
