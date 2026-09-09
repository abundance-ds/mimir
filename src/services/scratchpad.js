import { invoke } from '@tauri-apps/api/core'

export const scratchpadSnapshot = () => invoke('scratchpad_snapshot')
export const saveScratchpad = (content, expected) => invoke('scratchpad_save', { content, expected })
export const resolveScratchpad = path => invoke('scratchpad_resolve', { path })
export const prepareScratchpad = workspace => invoke('scratchpad_prepare', { workspace })
