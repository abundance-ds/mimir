import { isTauriRuntime, platformKind } from '../shared/platform.js'
import { basename } from '../shared/utils/path.js'

const RECENT_MENU_LIMIT = 12

function parentName(path) {
  const parts = String(path).split(/[/\\]/).filter(Boolean)
  if (parts.length < 2) return ''
  return parts[parts.length - 2]
}

function run(action) {
  return () => {
    Promise.resolve()
      .then(action)
      .catch((error) => {
        console.error('[nativeMenu]', error)
      })
  }
}

function separator() {
  return { item: 'Separator' }
}

function item(id, text, accelerator, action, options = {}) {
  const config = {
    id,
    text,
    ...options,
  }
  if (accelerator) config.accelerator = accelerator
  if (action) config.action = run(action)
  return config
}

function recentLabels(files) {
  const counts = files.reduce((map, path) => {
    const name = basename(path)
    map.set(name, (map.get(name) || 0) + 1)
    return map
  }, new Map())

  return files.map((path) => {
    const name = basename(path)
    if (counts.get(name) === 1) return name
    const parent = parentName(path)
    return parent ? `${name} (${parent})` : name
  })
}

function recentMenuItems(recentFiles, actions) {
  const files = recentFiles.slice(0, RECENT_MENU_LIMIT)
  if (files.length === 0) {
    return [
      item('editor:no-recent-files', 'No Recent Files', null, null, { enabled: false }),
    ]
  }

  const labels = recentLabels(files)
  return [
    ...files.map((path, index) =>
      item(
        `editor:open-recent-${index}`,
        labels[index],
        null,
        () => actions.openRecent?.(path)
      )
    ),
    separator(),
    item('editor:clear-recent', 'Clear Menu', null, actions.clearRecent),
  ]
}

export function buildNativeEditorMenuItems(recentFiles, actions) {
  return [
    {
      text: 'Mimir',
      items: [
        { item: { About: { name: 'Mimir' } } },
        item('editor:check-updates', 'Check for Updates...', null, actions.openUpdates),
        separator(),
        item('editor:settings', 'Settings...', 'CmdOrCtrl+,', actions.openSettings),
        separator(),
        { item: 'Hide' },
        { item: 'HideOthers' },
        { item: 'ShowAll' },
        separator(),
        item('editor:quit', 'Quit Mimir', 'CmdOrCtrl+Q', actions.quit),
      ],
    },
    {
      text: 'File',
      items: [
        ...(actions.openQuickOpen
          ? [
              item('workbench:go-to', 'Go to...', 'CmdOrCtrl+P', actions.openQuickOpen),
              separator(),
            ]
          : []),
        item('editor:new-file', 'New File', 'CmdOrCtrl+N', actions.newFile),
        item('editor:open-file', 'Open File...', 'CmdOrCtrl+O', actions.openFile),
        {
          text: 'Open Recent',
          items: recentMenuItems(recentFiles, actions),
        },
        separator(),
        item('editor:save', 'Save', 'CmdOrCtrl+S', actions.save),
        item('editor:save-as', 'Save As...', 'CmdOrCtrl+Shift+S', actions.saveAs),
        separator(),
        item('editor:close-tab', 'Close Tab', 'CmdOrCtrl+W', actions.closeTab),
      ],
    },
    {
      text: 'Edit',
      items: [
        item('editor:undo', 'Undo', 'CmdOrCtrl+Z', () => actions.editCommand?.('undo')),
        item('editor:redo', 'Redo', 'CmdOrCtrl+Shift+Z', () => actions.editCommand?.('redo')),
        separator(),
        { item: 'Cut' },
        { item: 'Copy' },
        { item: 'Paste' },
        item('editor:select-all', 'Select All', 'CmdOrCtrl+A', () => actions.editCommand?.('select-all')),
        separator(),
        item('editor:find', 'Find', 'CmdOrCtrl+F', () => actions.editCommand?.('find')),
        item('editor:rewrite-selection', 'Rewrite Selection', 'CmdOrCtrl+K', actions.rewriteSelection),
      ],
    },
    {
      text: 'Window',
      items: [
        { item: 'Minimize' },
        { item: 'Maximize' },
        { item: 'Fullscreen' },
        separator(),
        { item: 'BringAllToFront' },
      ],
    },
    {
      text: 'Help',
      items: [
        item('editor:help-about', 'About Mimir', null, null, { enabled: false }),
      ],
    },
  ]
}

export function shouldInstallNativeEditorMenu() {
  return isTauriRuntime() && platformKind() === 'macos'
}

export async function installNativeEditorMenu({ recentFiles = [], actions = {} } = {}) {
  if (!shouldInstallNativeEditorMenu()) return false

  const { Menu } = await import('@tauri-apps/api/menu')
  const menu = await Menu.new({ items: buildNativeEditorMenuItems(recentFiles, actions) })
  await menu.setAsAppMenu()
  return true
}
