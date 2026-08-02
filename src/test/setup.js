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
  // unified business graph
  'graph_open', 'graph_status', 'graph_get', 'graph_query', 'graph_search',
  'graph_neighbors', 'graph_diagnostics', 'graph_refresh', 'graph_update',
  'graph_create', 'graph_delete', 'graph_restore', 'graph_migration_report',
  'graph_context', 'graph_events',
  // git
  'git_status',
  // IPC / window coordination (top-level)
  'proposal_create', 'proposal_list', 'proposal_register_editor', 'proposal_apply', 'proposal_reject',
  'proposal_respond', 'push_proposals', 'notify_file_updated', 'get_proposals_for_path',
  // document_context_send has no Rust command but is still invoked by
  // useDocumentBridge.js behind a silent catch; keeping it mocked stops
  // editor tests from tripping the unknown-command guard. Tracked debt —
  // see scripts/check-tauri-commands.mjs and docs/issues.md.
  'document_context_send', 'settings_changed',
  'app_quit_confirmed',
  // spell
  'spell_suggest',
  // shell_exec
  'shell_exec',
  // Activities and launcher presets
  'activity_list', 'activity_search_history', 'activity_spawn', 'activity_respawn', 'activity_snapshot', 'activity_write',
  'activity_resize', 'activity_stop', 'activity_close', 'activity_interrupt_all', 'activity_flush',
  'activity_rename', 'activity_auto_title', 'activity_set_archived', 'activity_clear',
  'launcher_detect_agents', 'launcher_load_config', 'launcher_save_config', 'launcher_resolve',
  // team chat
  'chat_status', 'chat_config', 'chat_configure', 'chat_update_config', 'chat_reconnect',
  'chat_disconnect', 'chat_set_enabled', 'chat_targets', 'chat_members', 'chat_messages', 'chat_messages_around',
  'chat_search', 'chat_send', 'chat_typing', 'chat_react', 'chat_edit', 'chat_delete',
  'chat_upload_path', 'chat_upload_base64', 'chat_download_attachment', 'chat_open_attachment',
  'chat_attachment_preview',
  'chat_create_channel', 'chat_set_topic', 'chat_join', 'chat_leave',
  'chat_open_direct', 'chat_close_direct', 'chat_mark_read', 'chat_set_muted',
  'chat_set_active', 'chat_link_activity',
  // file_open
  'take_pending_files', 'open_files_in_editor',
  // apps
  'app_open_window', 'app_data_load', 'app_data_save', 'app_data_delete',
  'app_catalog', 'app_reload', 'app_create', 'app_duplicate', 'app_update_title', 'app_trash',
  'app_resolve', 'app_http_request',
  // routines
  'routine_catalog', 'routine_reload', 'routine_run_now', 'routine_create', 'routine_update',
  'routine_duplicate', 'routine_trash', 'routine_reveal',
  // Scribe meetings
  'meetings_snapshot', 'meetings_library_page', 'meetings_search_library', 'meetings_transcript_page',
  'meetings_request_microphone_permission', 'meetings_open_system_audio_settings',
  'meetings_check_audio',
  'meetings_microphone_devices', 'meetings_audio_test_start', 'meetings_audio_test_stop',
  'meetings_dismiss_candidate',
  'meetings_issue_start_consent',
  'meetings_start', 'meetings_stop', 'meetings_set_mic_muted',
  'meetings_update', 'meetings_decide_kg', 'meetings_retry_job', 'meetings_run_summary', 'meetings_follow_up_context', 'meetings_retranscribe', 'meetings_delete',
  'meetings_export', 'meetings_update_config', 'meetings_set_api_key',
  'meetings_clear_api_key', 'meetings_install_model', 'meetings_delete_model',
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
  'workspace_file_list_directory', 'workspace_file_inspect', 'workspace_file_create', 'workspace_file_rename',
  'workspace_file_move', 'workspace_file_duplicate', 'workspace_file_import', 'workspace_file_trash',
  'workspace_file_open_native', 'workspace_file_reveal',
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

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(() => ({
    setZoom: vi.fn(() => Promise.resolve()),
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  })),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    label: 'main',
    listen: vi.fn(() => Promise.resolve(vi.fn())),
    emit: vi.fn(),
    onCloseRequested: vi.fn(() => Promise.resolve(vi.fn())),
    setBadgeCount: vi.fn(() => Promise.resolve()),
  })),
  WebviewWindow: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  open: vi.fn(),
  save: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve('denied')),
  sendNotification: vi.fn(),
}))
