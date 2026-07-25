import { describe, expect, it, vi } from 'vitest'
import { buildNativeEditorMenuItems } from './nativeMenu.js'

describe('native Editor menu', () => {
  it('delegates the macOS close accelerator through the supplied focus-aware action', async () => {
    const closeTab = vi.fn()
    const menu = buildNativeEditorMenuItems([], { closeTab })
    const fileMenu = menu.find((entry) => entry.text === 'File')
    const closeItem = fileMenu.items.find((entry) => entry.id === 'editor:close-tab')

    expect(closeItem.accelerator).toBe('CmdOrCtrl+W')
    closeItem.action()
    await Promise.resolve()
    await Promise.resolve()
    expect(closeTab).toHaveBeenCalledTimes(1)
  })

  it('routes Quit through the asynchronous Editor close guard', async () => {
    const quit = vi.fn()
    const menu = buildNativeEditorMenuItems([], { quit })
    const appMenu = menu.find((entry) => entry.text === 'Mim')
    const quitItem = appMenu.items.find((entry) => entry.id === 'editor:quit')

    expect(quitItem.accelerator).toBe('CmdOrCtrl+Q')
    quitItem.action()
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
