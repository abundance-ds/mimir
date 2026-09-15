import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

export async function exportTimesheetCsv(name, content) {
  const filename = `${name.replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 100) || 'time-sheet'}.csv`
  if (window.__TAURI_INTERNALS__) {
    const path = await save({ defaultPath: filename, filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (!path) return false
    await invoke('write_text_file', { path: /\.csv$/i.test(path) ? path : `${path}.csv`, content })
  } else {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return true
}
