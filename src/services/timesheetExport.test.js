import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { exportTimesheetCsv } from './timesheetExport.js'

afterEach(() => { delete window.__TAURI_INTERNALS__; vi.clearAllMocks() })

describe('time sheet CSV file export', () => {
  it('writes the frozen CSV only after a destination is selected', async () => {
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(save).mockResolvedValue('/exports/september.csv')
    vi.mocked(invoke).mockResolvedValue(undefined)
    expect(await exportTimesheetCsv('Atlas / September', 'frozen rows\r\n')).toBe(true)
    expect(save).toHaveBeenCalledWith({ defaultPath: 'Atlas-September.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })
    expect(invoke).toHaveBeenCalledWith('write_text_file', { path: '/exports/september.csv', content: 'frozen rows\r\n' })
  })
  it('does not overwrite a Markdown source or write after cancellation', async () => {
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(save).mockResolvedValue('/graph/sheet.md')
    await exportTimesheetCsv('Sheet', 'rows')
    expect(invoke).toHaveBeenCalledWith('write_text_file', { path: '/graph/sheet.md.csv', content: 'rows' })
    vi.mocked(invoke).mockClear()
    vi.mocked(save).mockResolvedValue(null)
    expect(await exportTimesheetCsv('Sheet', 'rows')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
})
