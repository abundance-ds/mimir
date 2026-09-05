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
  // first-party connections
  'connections_status', 'connections_connect_google', 'connections_connect_slack',
  'connections_connect_slack_token', 'connections_connect_granola', 'connections_disconnect',
  'connections_set_google_default',
  // filesystem (top-level)
  'read_text_file', 'read_binary_file', 'write_text_file', 'write_binary_file',
  'path_exists', 'workspace_paths_status', 'create_dir', 'list_dir',
  // unified business graph
  'graph_open', 'graph_status', 'graph_get', 'graph_query', 'graph_search',
  'graph_neighbors', 'graph_diagnostics', 'graph_refresh', 'graph_update',
  'graph_create', 'graph_move_scope', 'graph_delete', 'graph_restore', 'graph_migration_report',
  'graph_context', 'graph_events',
  'workspace_config_load', 'workspace_config_save', 'workspace_project_paths',
  'workspace_project_file_resolve',
  // git
  'git_status', 'git_changes', 'git_file_diff', 'git_stage_file', 'git_unstage_file',
  'git_file_history_available', 'git_file_history', 'git_file_version', 'git_restore_file_version',
  // managed Git and GitHub
  'team_repository_status', 'team_repository_setup', 'team_repository_move', 'team_repository_sync',
  'team_resource_import', 'team_resource_list', 'managed_project_status', 'managed_project_set_enabled',
  'managed_project_set_remote', 'managed_project_sync', 'managed_repositories_sync', 'github_connection_status',
  'github_connect', 'github_disconnect',
  // IPC / window coordination (top-level)
  'proposal_create', 'proposal_list', 'proposal_register_editor', 'proposal_apply', 'proposal_reject',
  'proposal_respond', 'notify_file_updated', 'get_proposals_for_path',
  'settings_changed',
  'app_quit_confirmed', 'app_prepare_relaunch',
  // spell
  'spell_suggest',
  // shell_exec
  'shell_exec',
  // Activities and launcher presets
  'activity_list', 'activity_search_history', 'activity_spawn', 'activity_respawn', 'activity_snapshot', 'activity_write',
  'activity_terminal_attach', 'activity_terminal_checkpoint', 'activity_terminal_release',
  'activity_resize', 'activity_stop', 'activity_close', 'activity_interrupt_all', 'activity_flush',
  'activity_rename', 'activity_provisional_title',
  'activity_set_archived', 'activity_clear',
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
  // scoped agent packages and scope inventory
  'agent_run', 'agent_list', 'scope_inventory',
  // Scribe meetings
  'meetings_snapshot', 'meetings_get', 'meetings_prepare', 'meetings_library_page', 'meetings_search_library', 'meetings_transcript_page',
  'meetings_request_microphone_permission', 'meetings_request_system_audio_permission',
  'meetings_open_system_audio_settings',
  'meetings_check_audio',
  'meetings_microphone_devices', 'meetings_audio_test_start', 'meetings_audio_test_stop',
  'meetings_dismiss_candidate', 'meetings_take_record_requests',
  'meetings_issue_start_consent',
  'meetings_start', 'meetings_signal_stop', 'meetings_stop', 'meetings_set_mic_muted',
  'meetings_update', 'meetings_decide_kg', 'meetings_retry_job', 'meetings_run_summary', 'meetings_follow_up_context', 'meetings_retranscribe', 'meetings_delete',
  'meetings_export', 'meetings_file_to_graph', 'meetings_update_config', 'meetings_set_api_key',
  'meetings_clear_api_key', 'meetings_install_model', 'meetings_delete_model',
  // first-party Tracker
  'tracker_status', 'tracker_config_update', 'tracker_set_enabled', 'tracker_set_armed',
  'tracker_start_break', 'tracker_end_break', 'tracker_query', 'tracker_report',
  'tracker_classifications', 'tracker_classification_update',
  'tracker_import_preview', 'tracker_import_argus', 'tracker_accessibility_request',
  'tracker_context_update',
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
  'open_html_in_browser',
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
