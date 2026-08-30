use super::*;

#[tauri::command]
pub fn chat_status(runtime: tauri::State<'_, ChatRuntime>) -> ChatStatus {
    runtime.status()
}

#[tauri::command]
pub fn chat_config(runtime: tauri::State<'_, ChatRuntime>) -> Result<ChatConfig, String> {
    runtime.config()
}

#[tauri::command]
pub fn chat_configure(
    runtime: tauri::State<'_, ChatRuntime>,
    endpoint: String,
    account: String,
    display_name: String,
    password: String,
) -> Result<ChatStatus, String> {
    runtime.configure(
        ChatConfig {
            enabled: true,
            endpoint,
            account,
            display_name,
        },
        &password,
    )
}

#[tauri::command]
pub fn chat_update_config(
    runtime: tauri::State<'_, ChatRuntime>,
    endpoint: String,
    account: String,
    display_name: String,
    password: Option<String>,
) -> Result<ChatStatus, String> {
    let enabled = runtime.config()?.enabled;
    runtime.update_config(
        ChatConfig {
            enabled,
            endpoint,
            account,
            display_name,
        },
        password.as_deref(),
    )
}

#[tauri::command]
pub fn chat_reconnect(runtime: tauri::State<'_, ChatRuntime>) -> Result<ChatStatus, String> {
    runtime.start_configured()?;
    Ok(runtime.status())
}

#[tauri::command]
pub fn chat_disconnect(runtime: tauri::State<'_, ChatRuntime>) {
    runtime.disconnect();
}

#[tauri::command]
pub fn chat_set_enabled(
    runtime: tauri::State<'_, ChatRuntime>,
    registry: tauri::State<'_, ToolRegistry>,
    enabled: bool,
) -> Result<ChatStatus, String> {
    runtime.set_enabled(enabled, registry.inner())
}

#[tauri::command]
pub fn chat_targets(runtime: tauri::State<'_, ChatRuntime>) -> Result<Vec<ChatTarget>, String> {
    runtime.targets()
}

#[tauri::command]
pub fn chat_messages(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    before: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    runtime.messages(
        &target,
        before.as_deref(),
        limit.unwrap_or(100).clamp(1, 500),
    )
}

#[tauri::command]
pub fn chat_messages_around(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    message_id: String,
    radius: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    runtime.messages_around(&target, &message_id, radius.unwrap_or(30).clamp(1, 100))
}

#[tauri::command]
pub fn chat_members(
    runtime: tauri::State<'_, ChatRuntime>,
    target: Option<String>,
) -> Result<Vec<ChatMember>, String> {
    runtime.members(target.as_deref())
}

#[tauri::command]
pub fn chat_search(
    runtime: tauri::State<'_, ChatRuntime>,
    query: String,
    target: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ChatMessage>, String> {
    runtime.search(&query, target.as_deref(), limit.unwrap_or(50).clamp(1, 200))
}

#[tauri::command]
pub fn chat_send(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    text: String,
    reply_to: Option<String>,
) -> Result<(), String> {
    runtime.send(&target, &text, reply_to.as_deref(), None, None)
}

#[tauri::command]
pub fn chat_react(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    message_id: String,
    reaction: String,
    add: bool,
) -> Result<(), String> {
    runtime.react(&target, &message_id, &reaction, add)
}

#[tauri::command]
pub fn chat_typing(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    state: String,
) -> Result<(), String> {
    runtime.typing(&target, &state)
}

#[tauri::command]
pub fn chat_edit(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    message_id: String,
    text: String,
) -> Result<(), String> {
    runtime.edit(&target, &message_id, &text)
}

#[tauri::command]
pub async fn chat_delete(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    message_id: String,
) -> Result<(), String> {
    runtime.delete(&target, &message_id).await
}

#[tauri::command]
pub async fn chat_upload_path(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    path: String,
) -> Result<ChatAttachment, String> {
    runtime.upload_path(&target, &path).await
}

#[tauri::command]
pub async fn chat_upload_base64(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    name: String,
    mime: String,
    data_base64: String,
) -> Result<ChatAttachment, String> {
    runtime
        .upload_base64(&target, &name, &mime, &data_base64)
        .await
}

#[tauri::command]
pub async fn chat_download_attachment(
    runtime: tauri::State<'_, ChatRuntime>,
    file_id: String,
) -> Result<ChatAttachment, String> {
    runtime.download_attachment(&file_id).await
}

#[tauri::command]
pub fn chat_open_attachment(
    runtime: tauri::State<'_, ChatRuntime>,
    file_id: String,
) -> Result<(), String> {
    runtime.open_attachment(&file_id)
}

#[tauri::command]
pub fn chat_attachment_preview(
    runtime: tauri::State<'_, ChatRuntime>,
    file_id: String,
) -> Result<String, String> {
    runtime.attachment_preview(&file_id)
}

#[tauri::command]
pub fn chat_create_channel(
    runtime: tauri::State<'_, ChatRuntime>,
    name: String,
    topic: Option<String>,
) -> Result<String, String> {
    runtime.create_channel(&name, topic.as_deref())
}

#[tauri::command]
pub fn chat_set_topic(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    topic: String,
) -> Result<(), String> {
    runtime.set_topic(&target, &topic)
}

#[tauri::command]
pub fn chat_join(runtime: tauri::State<'_, ChatRuntime>, target: String) -> Result<String, String> {
    runtime.join(&target)
}

#[tauri::command]
pub fn chat_leave(runtime: tauri::State<'_, ChatRuntime>, target: String) -> Result<(), String> {
    runtime.leave(&target)
}

#[tauri::command]
pub fn chat_open_direct(
    runtime: tauri::State<'_, ChatRuntime>,
    account: String,
) -> Result<String, String> {
    runtime.open_direct(&account)
}

#[tauri::command]
pub fn chat_close_direct(
    runtime: tauri::State<'_, ChatRuntime>,
    account: String,
) -> Result<(), String> {
    runtime.close_direct(&account)
}

#[tauri::command]
pub fn chat_mark_read(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    message_id: Option<String>,
) -> Result<(), String> {
    runtime.mark_read(&target, message_id.as_deref())
}

#[tauri::command]
pub fn chat_set_muted(
    runtime: tauri::State<'_, ChatRuntime>,
    target: String,
    muted: bool,
) -> Result<(), String> {
    runtime.set_muted(&target, muted)
}

#[tauri::command]
pub fn chat_set_active(
    runtime: tauri::State<'_, ChatRuntime>,
    target: Option<String>,
) -> Result<(), String> {
    runtime.set_active(target.as_deref())
}

#[tauri::command]
pub fn chat_link_activity(
    runtime: tauri::State<'_, ChatRuntime>,
    activity_id: String,
    target: String,
    agent_label: Option<String>,
) -> Result<(), String> {
    runtime.link_activity(&activity_id, &target, agent_label.as_deref())
}
