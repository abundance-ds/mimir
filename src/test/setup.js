import { beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Fresh Pinia for every test
beforeEach(() => {
  setActivePinia(createPinia())
})

// --- Tauri mocks (prevent import errors in component tests) ---

// Every command registered in src-tauri/src/lib.rs → generate_handler![...]
// Tauri strips module prefixes, so `usage::usage_record` becomes `usage_record`.
// Keep this list in sync when adding/removing Rust commands.
const VALID_TAURI_COMMANDS = new Set([
  // ai
  'ai_config_dir', 'ai_model_registry', 'ai_key_status', 'ai_set_api_key', 'ai_generate',
  // ai_proxy
  'ai_proxy_stream', 'ai_abort', 'ai_cleanup',
  // filesystem (top-level)
  'read_text_file', 'read_binary_file', 'write_text_file', 'write_binary_file',
  'path_exists', 'create_dir', 'list_dir', 'copy_dir', 'symlink_dir', 'delete_path',
  // references
  'ref_dir', 'ref_list', 'ref_add', 'ref_remove', 'ref_update',
  // typst_export
  'export_pdf',
  // usage
  'usage_record', 'usage_query_month', 'usage_query_daily',
  'usage_get_setting', 'usage_set_setting',
  'tool_execution_record', 'tool_execution_query', 'usage_query_month_csv',
  // audit
  'audit_log', 'audit_query', 'audit_query_summary', 'audit_export_csv',
  // git
  'git_clone', 'git_clone_authenticated', 'git_init', 'git_status', 'git_file_log', 'git_file_at_revision',
  // IPC / window coordination (top-level)
  'proposal_create', 'proposal_list', 'proposal_register_editor', 'proposal_apply', 'proposal_reject',
  'proposal_send', 'proposal_respond', 'diff_open', 'notify_file_updated',
  'document_context_send', 'comments_submit', 'settings_changed', 'focus_main_window',
  // spell
  'spell_suggest',
  // docx_worker
  'docx_annotate', 'docx_read_comments', 'docx_validate',
  // shell_exec
  'shell_exec',
  // cursor / tabs (top-level)
  'get_cursor_position', 'tab_drag_resolve',
  // pty
  'pty_spawn', 'pty_write', 'pty_resize', 'pty_kill',
  // file_open
  'take_pending_files', 'open_files_in_editor',
  // apps
  'app_discover', 'app_create', 'app_write_file', 'app_delete', 'app_open_window',
  'app_data_load', 'app_data_save', 'app_data_delete', 'app_data_keys',
  // search
  'search_sessions',
  // file_search
  'search_file_content',
  // reveal
  'reveal_in_finder',
  // profile / bundled resources
  'read_bundled_profile', 'list_bundled_skills', 'list_bundled_apps',
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

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: vi.fn(),
}))
