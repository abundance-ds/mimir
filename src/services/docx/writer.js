import { invoke } from '@tauri-apps/api/core'

export function generateRevisionPath(inputPath) {
  const lastDot = inputPath.lastIndexOf('.')
  const ext = lastDot > 0 ? inputPath.slice(lastDot) : '.docx'
  const base = lastDot > 0 ? inputPath.slice(0, lastDot) : inputPath
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  return `${base}_revision_${ts}${ext}`
}

function parseSidecarResponse(responseJson, operation) {
  try {
    return JSON.parse(responseJson)
  } catch {
    return { success: false, error: `docx-worker returned invalid response during ${operation}` }
  }
}

export async function annotateDocx(inputPath, operations) {
  const outputPath = generateRevisionPath(inputPath)
  const request = JSON.stringify({
    command: 'annotate',
    inputPath,
    outputPath,
    operations,
  })
  const responseJson = await invoke('docx_annotate', { requestJson: request })
  return parseSidecarResponse(responseJson, 'annotate')
}

export async function getDocxComments(filePath) {
  const responseJson = await invoke('docx_read_comments', { path: filePath })
  return parseSidecarResponse(responseJson, 'read_comments')
}

export async function validateDocx(filePath) {
  const responseJson = await invoke('docx_validate', { path: filePath })
  return parseSidecarResponse(responseJson, 'validate')
}
