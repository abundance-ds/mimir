import { beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Fresh Pinia for every test
beforeEach(() => {
  setActivePinia(createPinia())
})

// --- Tauri mocks (prevent import errors in component tests) ---

// Every command registered in src-tauri/src/lib.rs → generate_handler![...].
// Keep this list in sync when adding/removing Rust commands.
const VALID_TAURI_COMMANDS = new Set([
  // ai
  'ai_config_dir', 'ai_model_registry', 'ai_key_status', 'ai_set_api_key', 'ai_generate',
  // ai_proxy
  'ai_proxy_stream', 'ai_abort', 'ai_cleanup',
  // editor session persistence
  'session_load', 'session_save',
  // local workbench/editor settings persistence
  'settings_load', 'settings_save', 'settings_save_editor',
  // filesystem (top-level)
  'read_text_file', 'read_binary_file', 'write_text_file', 'write_binary_file',
  'path_exists', 'create_dir', 'list_dir',
  // git
  'git_status',
  // IPC / window coordination (top-level)
  'proposal_create', 'proposal_list', 'proposal_register_editor', 'proposal_apply', 'proposal_reject',
  'proposal_respond', 'notify_file_updated', 'get_proposals_for_path',
  'document_context_send', 'comments_submit', 'settings_changed', 'focus_main_window',
  'app_quit_confirmed',
  // spell
  'spell_suggest',
  // shell_exec
  'shell_exec',
  // Activities and launcher presets
  'activity_list', 'activity_spawn', 'activity_snapshot', 'activity_write',
  'activity_resize', 'activity_stop', 'activity_interrupt_all', 'activity_flush',
  'activity_rename', 'activity_set_archived', 'activity_clear',
  'launcher_detect_agents', 'launcher_load_config', 'launcher_save_config', 'launcher_resolve',
  // file_open
  'take_pending_files', 'open_files_in_editor',
  // apps
  'app_open_window', 'app_data_load', 'app_data_save', 'app_data_delete',
  'app_catalog', 'app_reload', 'app_create', 'app_duplicate', 'app_update_title', 'app_trash',
  'app_resolve', 'app_http_request',
  // routines
  'routine_catalog', 'routine_reload', 'routine_run_now', 'routine_create', 'routine_update',
  'routine_duplicate', 'routine_trash', 'routine_reveal',
  // canonical dynamic tool providers
  'tool_server_start', 'tool_server_stop', 'tool_server_status', 'tool_call_response',
  'tool_registry_snapshot', 'tool_registry_list', 'tool_registry_call',
  'tool_ui_provider_reconcile', 'tool_ui_provider_unregister',
  'tool_provider_window_disconnected',
  'tool_app_provider_reconcile', 'tool_app_provider_unregister', 'tool_relay_response',
  'tool_relay_cancel',
  // file indexing and content search
  'file_index_open', 'file_index_files', 'file_index_filter', 'file_index_refresh',
  'file_index_begin_search', 'file_index_cancel_search', 'file_index_search',
  'workspace_file_list_directory', 'workspace_file_create', 'workspace_file_rename',
  'workspace_file_duplicate', 'workspace_file_trash', 'workspace_file_open_native',
  'workspace_file_reveal',
  'search_file_content',
  // reveal
  'reveal_in_finder',
])

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd) => {
    if (!VALID_TAURI_COMMANDS.has(cmd)) {
      throw new Error(
        `Unknown Tauri command: ${cmd}. Check that this command is registered in src-tauri/src/lib.rs`
      )
    }
    return undefined
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
  emit: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    label: 'main',
    listen: vi.fn(() => Promise.resolve(vi.fn())),
    emit: vi.fn(),
    onCloseRequested: vi.fn(() => Promise.resolve(vi.fn())),
  })),
  WebviewWindow: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}))
