import { invoke } from '@tauri-apps/api/core'

export async function exportPdf({ markdown, outputPath, template, fontFamily, fontSize, pageSize, bibContent, bibStyle }) {
  if (!window.__TAURI_INTERNALS__) {
    console.log('[export] PDF export requires Tauri')
    return null
  }
  return invoke('export_pdf', {
    request: {
      markdown,
      output_path: outputPath,
      template,
      font_family: fontFamily,
      font_size: fontSize,
      page_size: pageSize,
      bib_content: bibContent,
      bib_style: bibStyle,
    },
  })
}
