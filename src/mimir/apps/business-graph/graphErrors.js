export function graphErrorMessage(cause) {
  return cause instanceof Error
    ? cause.message
    : String(cause || 'Business graph operation failed.')
}
