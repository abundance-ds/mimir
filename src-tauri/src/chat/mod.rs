mod db;
mod model;

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use irc_proto::{BatchSubCommand, CapSubCommand, Command, Message as IrcMessage, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest, http::HeaderValue, protocol::Message as WebSocketMessage,
    },
};
use url::Url;

use crate::{
    ai_models::app_config_dir,
    persistence::write_json_atomic,
    tool_registry::{
        ToolAnnotations, ToolCallContext, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner,
        ToolRegistration, ToolRegistry, ToolResult, ToolSource,
    },
};

pub use model::{
    ChatAttachment, ChatConfig, ChatConnectionState, ChatEvent, ChatMember, ChatMessage,
    ChatReaction, ChatStatus, ChatTarget, ChatTargetKind, DEFAULT_CHAT_ACCOUNT,
    DEFAULT_CHAT_ENDPOINT,
};

use db::ChatDatabase;

const CHAT_EVENT: &str = "mimir://chat-event";
#[cfg(all(target_os = "macos", not(debug_assertions)))]
const KEYCHAIN_SERVICE: &str = "rs.shoulde.mimir";
const MAX_MESSAGE_BYTES: usize = 4_000;
const IRC_CHUNK_BYTES: usize = 350;
const REQUESTED_CAPABILITIES: &str =
    "sasl message-tags server-time batch echo-message account-tag account-notify away-notify \
     extended-join draft/chathistory draft/event-playback draft/message-redaction draft/multiline";

#[derive(Clone)]
pub struct ChatRuntime {
    inner: Arc<ChatInner>,
}

struct ChatInner {
    config_path: PathBuf,
    credential_path: PathBuf,
    database: ChatDatabase,
    status: RwLock<ChatStatus>,
    app: Mutex<Option<tauri::AppHandle>>,
    outbound: Mutex<Option<mpsc::UnboundedSender<ChatOutbound>>>,
    generation: AtomicU64,
    active_target: RwLock<Option<String>>,
}

enum ChatOutbound {
    Lines(Vec<String>),
    Shutdown,
}

#[derive(Default)]
struct SessionState {
    caps: String,
    requested_caps: bool,
    history_requested: HashSet<String>,
    history_batches: HashSet<String>,
    multiline_batches: HashMap<String, PendingMultiline>,
    names: HashMap<String, HashSet<String>>,
}

/// One open draft/multiline batch. Its msgid, time, account, and reply tags
/// live on the opening BATCH message; the inner PRIVMSG lines carry only the
/// batch reference and an optional concat marker.
struct PendingMultiline {
    opening: IrcMessage,
    target: String,
    historical: bool,
    chunks: Vec<(String, bool)>,
    bytes: usize,
}

const MAX_MULTILINE_BATCHES: usize = 16;
const MAX_MULTILINE_BYTES: usize = 65_536;

impl ChatRuntime {
    pub fn new() -> Result<Self, String> {
        let config_directory = app_config_dir()?;
        fs::create_dir_all(&config_directory).map_err(|error| error.to_string())?;
        let config_path = config_directory.join("chat.json");
        let config = read_config_at(&config_path)?.unwrap_or_default();
        let database = ChatDatabase::open(config_directory.join("chat.sqlite3"))?;
        Ok(Self {
            inner: Arc::new(ChatInner {
                config_path,
                credential_path: config_directory.join("chat.credential"),
                database,
                status: RwLock::new(ChatStatus::new(
                    &config,
                    ChatConnectionState::NeedsCredentials,
                )),
                app: Mutex::new(None),
                outbound: Mutex::new(None),
                generation: AtomicU64::new(0),
                active_target: RwLock::new(None),
            }),
        })
    }

    pub fn install(&self, app: &tauri::AppHandle, registry: &ToolRegistry) -> Result<(), String> {
        log::info!("Installing native team chat runtime");
        *lock(&self.inner.app) = Some(app.clone());
        reserve_native_tool_names(registry)?;
        if self.config()?.enabled {
            register_native_tools(registry, self)?;
        }
        self.start_configured()
    }

    pub fn status(&self) -> ChatStatus {
        read_lock(&self.inner.status).clone()
    }

    pub fn config(&self) -> Result<ChatConfig, String> {
        Ok(read_config_at(&self.inner.config_path)?.unwrap_or_default())
    }

    pub fn configure(&self, config: ChatConfig, password: &str) -> Result<ChatStatus, String> {
        validate_config(&config)?;
        if password.trim().is_empty() {
            return Err("Chat passphrase is required.".into());
        }
        write_json_atomic(&self.inner.config_path, &config).map_err(|error| error.to_string())?;
        store_credential(&self.inner.credential_path, &config, password)?;
        self.connect(config, password.to_string());
        Ok(self.status())
    }

    pub fn update_config(
        &self,
        config: ChatConfig,
        replacement_password: Option<&str>,
    ) -> Result<ChatStatus, String> {
        validate_config(&config)?;
        let current = self.config()?;
        let password = match replacement_password
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(password) => password.to_string(),
            None if credential_key(&current) == credential_key(&config) => {
                load_credential(&self.inner.credential_path, &current)?
                    .ok_or_else(|| "No saved chat passphrase was found.".to_string())?
            }
            None => {
                return Err("Enter the passphrase when changing the chat server or account.".into())
            }
        };
        write_json_atomic(&self.inner.config_path, &config).map_err(|error| error.to_string())?;
        if replacement_password.is_some_and(|value| !value.trim().is_empty()) {
            store_credential(&self.inner.credential_path, &config, &password)?;
        }
        self.connect(config, password);
        Ok(self.status())
    }

    pub fn start_configured(&self) -> Result<(), String> {
        let config = read_config_at(&self.inner.config_path)?.unwrap_or_default();
        if !config.enabled {
            self.update_status(ChatStatus::new(&config, ChatConnectionState::Disconnected));
            return Ok(());
        }
        #[cfg(debug_assertions)]
        if let Ok(password) = std::env::var("MIMIR_CHAT_PASSWORD") {
            if !password.is_empty() {
                if std::env::var_os("MIMIR_CHAT_PERSIST_PASSWORD").is_some() {
                    store_credential(&self.inner.credential_path, &config, &password)?;
                }
                log::info!("Starting chat with the development credential override");
                self.connect(config, password);
                return Ok(());
            }
        }
        match load_credential(&self.inner.credential_path, &config) {
            Ok(Some(password)) if !password.is_empty() => {
                self.connect(config, password);
                Ok(())
            }
            Ok(_) => {
                self.update_status(ChatStatus::new(
                    &config,
                    ChatConnectionState::NeedsCredentials,
                ));
                Ok(())
            }
            Err(error) => {
                let mut status = ChatStatus::new(&config, ChatConnectionState::NeedsCredentials);
                status.diagnostic = Some(format!("Could not read the chat credential: {error}"));
                self.update_status(status);
                Ok(())
            }
        }
    }

    pub fn disconnect(&self) {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(sender) = lock(&self.inner.outbound).take() {
            let _ = sender.send(ChatOutbound::Shutdown);
        }
        let config = self.config().unwrap_or_default();
        self.update_status(ChatStatus::new(&config, ChatConnectionState::Disconnected));
    }

    pub fn set_enabled(
        &self,
        enabled: bool,
        registry: &ToolRegistry,
    ) -> Result<ChatStatus, String> {
        let mut config = self.config()?;
        if config.enabled == enabled {
            return Ok(self.status());
        }
        config.enabled = enabled;
        write_json_atomic(&self.inner.config_path, &config).map_err(|error| error.to_string())?;
        if enabled {
            register_native_tools(registry, self)?;
            self.start_configured()?;
        } else {
            self.disconnect();
            *write_lock(&self.inner.active_target) = None;
            for name in [
                "chat.rooms",
                "chat.read",
                "chat.search",
                "chat.send",
                "chat.download",
            ] {
                let _ = registry.unregister(name, &ToolOwner::Core);
            }
        }
        Ok(self.status())
    }

    pub fn targets(&self) -> Result<Vec<ChatTarget>, String> {
        self.inner.database.targets()
    }

    pub fn messages(
        &self,
        target: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        self.inner
            .database
            .messages(&normalize_target(target)?, before, limit)
    }

    pub fn messages_around(
        &self,
        target: &str,
        message_id: &str,
        radius: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        self.inner.database.messages_around(
            &normalize_target(target)?,
            &validate_message_id(message_id)?,
            radius,
        )
    }

    pub fn members(&self, target: Option<&str>) -> Result<Vec<ChatMember>, String> {
        let normalized = target.map(normalize_target).transpose()?;
        self.inner.database.members(normalized.as_deref())
    }

    pub fn search(
        &self,
        query: &str,
        target: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let normalized = target.map(normalize_target).transpose()?;
        self.inner
            .database
            .search(query, normalized.as_deref(), limit)
    }

    pub fn send(
        &self,
        target: &str,
        text: &str,
        reply_to: Option<&str>,
        agent_label: Option<&str>,
        activity_id: Option<&str>,
    ) -> Result<(), String> {
        let target = normalize_target(target)?;
        let text = normalize_body(text)?;
        let reply_to = reply_to.map(validate_message_id).transpose()?;
        let config = self.config()?;
        let status = self.status();
        let lines = if let Some(agent_label) = agent_label {
            agent_lines(
                &config.account,
                &target,
                &text,
                reply_to.as_deref(),
                agent_label,
                activity_id,
                status.relay_ready,
            )
        } else {
            human_lines(&target, &text, reply_to.as_deref())
        };
        self.queue_lines(lines)
    }

    pub fn react(
        &self,
        target: &str,
        message_id: &str,
        reaction: &str,
        add: bool,
    ) -> Result<(), String> {
        let target = normalize_target(target)?;
        let message_id = validate_message_id(message_id)?;
        let reaction = normalize_reaction(reaction)?;
        let action = if add {
            "+draft/react"
        } else {
            "+draft/unreact"
        };
        self.queue_lines(vec![format!(
            "@+reply={};{action}={} TAGMSG {target}",
            irc_tag_value(&message_id),
            irc_tag_value(&reaction),
        )])
    }

    pub fn typing(&self, target: &str, state: &str) -> Result<(), String> {
        let target = normalize_target(target)?;
        let state = match state.trim().to_ascii_lowercase().as_str() {
            "active" => "active",
            "pause" => "pause",
            "done" => "done",
            _ => return Err("Typing state must be active, pause, or done.".into()),
        };
        self.queue_lines(vec![format!("@+typing={state} TAGMSG {target}")])
    }

    pub fn edit(&self, target: &str, message_id: &str, text: &str) -> Result<(), String> {
        let target = normalize_target(target)?;
        let message_id = validate_message_id(message_id)?;
        if !self.inner.database.own_message(&target, &message_id)? {
            return Err("Only your own, non-deleted messages can be edited.".into());
        }
        let text = normalize_body(text)?;
        if text.contains('\n') || text.len() > IRC_CHUNK_BYTES {
            return Err(
                "Edited messages must fit on one line. Send a new message for longer changes."
                    .into(),
            );
        }
        self.queue_lines(vec![format!(
            "@+shoulde.rs/edit={} PRIVMSG {target} :{text}",
            irc_tag_value(&message_id),
        )])
    }

    pub async fn delete(&self, target: &str, message_id: &str) -> Result<(), String> {
        let target = normalize_target(target)?;
        let message_id = validate_message_id(message_id)?;
        if !self.inner.database.own_message(&target, &message_id)? {
            return Err("Only your own, non-deleted messages can be deleted.".into());
        }
        let attachments = self
            .inner
            .database
            .message_attachments(&target, &message_id)?;
        // Redact first: if the connection is gone this fails before any blob
        // is destroyed, so the message never ends up visible with dead
        // attachment cards.
        self.queue_lines(vec![format!(
            "REDACT {target} {message_id} :deleted by author",
        )])?;
        if !attachments.is_empty() {
            let config = self.config()?;
            let password = load_credential(&self.inner.credential_path, &config)?
                .ok_or_else(|| "No saved chat passphrase was found.".to_string())?;
            for attachment in attachments {
                if let Err(error) =
                    delete_remote_attachment(&config, &password, &attachment.url).await
                {
                    log::warn!(
                        "Could not delete attachment {} after redaction: {error}",
                        attachment.name
                    );
                }
                if let Some(path) = attachment.local_path {
                    match fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            log::warn!("Could not remove cached chat attachment: {error}");
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn upload_path(&self, target: &str, path: &str) -> Result<ChatAttachment, String> {
        let path = PathBuf::from(path);
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Attachment filename is not valid UTF-8.".to_string())?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("Could not read attachment: {error}"))?;
        self.upload_bytes(target, name, mime_for_filename(name), bytes)
            .await
    }

    pub async fn upload_base64(
        &self,
        target: &str,
        name: &str,
        mime: &str,
        data_base64: &str,
    ) -> Result<ChatAttachment, String> {
        let bytes = STANDARD
            .decode(data_base64)
            .map_err(|_| "Pasted attachment data is invalid.".to_string())?;
        self.upload_bytes(target, name, mime, bytes).await
    }

    async fn upload_bytes(
        &self,
        target: &str,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<ChatAttachment, String> {
        let target = normalize_target(target)?;
        let name = normalize_attachment_name(name)?;
        if bytes.is_empty() || bytes.len() > 25 * 1024 * 1024 {
            return Err("Attachments must be between 1 byte and 25 MB.".into());
        }
        let mime = normalize_mime(mime).unwrap_or_else(|| mime_for_filename(&name).into());
        let config = self.config()?;
        let password = load_credential(&self.inner.credential_path, &config)?
            .ok_or_else(|| "No saved chat passphrase was found.".to_string())?;
        let endpoint = attachment_collection_url(&config.endpoint)?;
        let expected_hash = format!("{:x}", Sha256::digest(&bytes));
        let response = reqwest::Client::new()
            .post(endpoint)
            .basic_auth(&config.account, Some(&password))
            .header("Content-Type", &mime)
            .header("X-Mimir-Filename", URL_SAFE_NO_PAD.encode(name.as_bytes()))
            .body(bytes)
            .send()
            .await
            .map_err(|error| format!("Attachment upload failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Attachment upload failed with HTTP {}.",
                response.status().as_u16(),
            ));
        }
        let attachment = response
            .json::<ChatAttachment>()
            .await
            .map_err(|error| format!("Attachment service returned invalid metadata: {error}"))?;
        if attachment.name != name
            || attachment.mime != mime
            || attachment.sha256 != expected_hash
            || attachment.size == 0
        {
            return Err("Attachment service returned mismatched metadata.".into());
        }
        let line = attachment_message_line(&target, &attachment);
        if let Err(error) = self.queue_lines(vec![line]) {
            let _ = delete_remote_attachment(&config, &password, &attachment.url).await;
            return Err(error);
        }
        Ok(attachment)
    }

    pub async fn download_attachment(&self, file_id: &str) -> Result<ChatAttachment, String> {
        let file_id = validate_message_id(file_id)?;
        let attachment = self
            .inner
            .database
            .attachment(&file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".to_string())?;
        if attachment
            .local_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).is_file())
        {
            return Ok(attachment);
        }
        let config = self.config()?;
        let password = load_credential(&self.inner.credential_path, &config)?
            .ok_or_else(|| "No saved chat passphrase was found.".to_string())?;
        let response = reqwest::Client::new()
            .get(&attachment.url)
            .basic_auth(&config.account, Some(&password))
            .send()
            .await
            .map_err(|error| format!("Attachment download failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Attachment download failed with HTTP {}.",
                response.status().as_u16(),
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Could not read attachment download: {error}"))?;
        if bytes.len() as u64 != attachment.size
            || format!("{:x}", Sha256::digest(&bytes)) != attachment.sha256
        {
            return Err("Downloaded attachment failed its size or checksum check.".into());
        }
        let cache = self
            .inner
            .config_path
            .parent()
            .ok_or_else(|| "Chat cache directory is unavailable.".to_string())?
            .join("chat-files")
            .join(&attachment.id);
        fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
        let path = cache.join(normalize_attachment_name(&attachment.name)?);
        crate::persistence::write_secret_bytes_atomic(&path, &bytes)
            .map_err(|error| error.to_string())?;
        self.inner
            .database
            .set_attachment_local_path(&attachment.id, &path.to_string_lossy())
    }

    pub fn open_attachment(&self, file_id: &str) -> Result<(), String> {
        let file_id = validate_message_id(file_id)?;
        let attachment = self
            .inner
            .database
            .attachment(&file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".to_string())?;
        let path = attachment
            .local_path
            .filter(|path| std::path::Path::new(path).is_file())
            .ok_or_else(|| "Download the attachment before opening it.".to_string())?;
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer");
        command
            .arg(path)
            .spawn()
            .map_err(|error| format!("Could not open attachment: {error}"))?;
        Ok(())
    }

    pub fn attachment_preview(&self, file_id: &str) -> Result<String, String> {
        let file_id = validate_message_id(file_id)?;
        let attachment = self
            .inner
            .database
            .attachment(&file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".to_string())?;
        if !matches!(
            attachment.mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err("That attachment does not have an inline image preview.".into());
        }
        if attachment.size > 10 * 1024 * 1024 {
            return Err("Image is too large for an inline preview.".into());
        }
        let path = attachment
            .local_path
            .filter(|path| std::path::Path::new(path).is_file())
            .ok_or_else(|| "Download the attachment before previewing it.".to_string())?;
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        if format!("{:x}", Sha256::digest(&bytes)) != attachment.sha256 {
            return Err("Cached attachment failed its checksum check.".into());
        }
        Ok(format!(
            "data:{};base64,{}",
            attachment.mime,
            STANDARD.encode(bytes),
        ))
    }

    pub fn create_channel(&self, name: &str, topic: Option<&str>) -> Result<String, String> {
        let channel = normalize_channel(name)?;
        let mut lines = vec![
            format!("JOIN {channel}"),
            format!("PRIVMSG ChanServ :REGISTER {channel}"),
        ];
        if let Some(topic) = topic.map(str::trim).filter(|topic| !topic.is_empty()) {
            lines.push(format!("TOPIC {channel} :{}", clean_irc_parameter(topic)));
        }
        self.queue_lines(lines)?;
        let now = timestamp();
        self.inner
            .database
            .ensure_target(&channel, ChatTargetKind::Channel, true, Some(&now))?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(channel)
    }

    pub fn set_topic(&self, target: &str, topic: &str) -> Result<(), String> {
        let channel = normalize_channel(target)?;
        let topic = clean_irc_parameter(topic);
        self.queue_lines(vec![format!("TOPIC {channel} :{topic}")])
    }

    pub fn join(&self, target: &str) -> Result<String, String> {
        let channel = normalize_channel(target)?;
        self.queue_lines(vec![format!("JOIN {channel}")])?;
        let now = timestamp();
        self.inner
            .database
            .ensure_target(&channel, ChatTargetKind::Channel, true, Some(&now))?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(channel)
    }

    pub fn leave(&self, target: &str) -> Result<(), String> {
        let channel = normalize_channel(target)?;
        self.queue_lines(vec![format!("PART {channel} :Left from Mimir")])?;
        self.inner.database.set_joined(&channel, false)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn open_direct(&self, account: &str) -> Result<String, String> {
        let target = normalize_nick(account)?;
        self.inner
            .database
            .ensure_target(&target, ChatTargetKind::Direct, false, None)?;
        self.inner.database.set_hidden(&target, false)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(target)
    }

    pub fn close_direct(&self, account: &str) -> Result<(), String> {
        let target = normalize_nick(account)?;
        self.inner.database.set_hidden(&target, true)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn mark_read(&self, target: &str, message_id: Option<&str>) -> Result<(), String> {
        let target = normalize_target(target)?;
        self.inner.database.mark_read(&target, message_id)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn set_muted(&self, target: &str, muted: bool) -> Result<(), String> {
        let target = normalize_target(target)?;
        self.inner.database.set_muted(&target, muted)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn set_active(&self, target: Option<&str>) -> Result<(), String> {
        let target = target.map(normalize_target).transpose()?;
        *write_lock(&self.inner.active_target) = target;
        Ok(())
    }

    pub fn link_activity(
        &self,
        activity_id: &str,
        target: &str,
        agent_label: Option<&str>,
    ) -> Result<(), String> {
        let activity_id = activity_id.trim();
        if activity_id.is_empty() {
            return Err("Activity ID is required.".into());
        }
        let target = normalize_target(target)?;
        self.inner
            .database
            .link_activity(activity_id, &target, agent_label)?;
        Ok(())
    }

    fn connect(&self, config: ChatConfig, password: String) {
        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(sender) = lock(&self.inner.outbound).take() {
            let _ = sender.send(ChatOutbound::Shutdown);
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        *lock(&self.inner.outbound) = Some(sender);
        self.update_status(ChatStatus::new(&config, ChatConnectionState::Connecting));
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            supervise_connection(inner, generation, config, password, receiver).await;
        });
    }

    fn queue_lines(&self, lines: Vec<String>) -> Result<(), String> {
        if self.status().state != ChatConnectionState::Connected {
            return Err("Chat is reconnecting. Try again when the connection is back.".into());
        }
        let sender = lock(&self.inner.outbound)
            .as_ref()
            .cloned()
            .ok_or_else(|| "Chat is not connected.".to_string())?;
        sender
            .send(ChatOutbound::Lines(lines))
            .map_err(|_| "Chat connection is unavailable.".to_string())
    }

    fn resolve_tool_target(
        &self,
        context: &ToolCallContext,
        requested: Option<&str>,
    ) -> Result<String, String> {
        // The Activity link is a default aim, not a fence: an explicit target
        // always wins, then the linked room, then the room open in the UI.
        if let Some(requested) = requested {
            return normalize_target(requested);
        }
        let activity_id = context.metadata.get("activityId").and_then(Value::as_str);
        let linked = activity_id
            .map(|activity_id| self.inner.database.activity_link(activity_id))
            .transpose()?
            .flatten();
        if let Some((linked_target, _)) = linked {
            return Ok(linked_target);
        }
        read_lock(&self.inner.active_target)
            .clone()
            .ok_or_else(|| "Pass target or launch the agent from a chat room.".to_string())
    }

    fn resolve_agent_label(&self, context: &ToolCallContext) -> String {
        let activity_id = context.metadata.get("activityId").and_then(Value::as_str);
        if let Some(activity_id) = activity_id {
            if let Ok(Some((_, Some(label)))) = self.inner.database.activity_link(activity_id) {
                return label;
            }
        }
        context
            .metadata
            .get("agentId")
            .and_then(Value::as_str)
            .unwrap_or("agent")
            .to_string()
    }

    fn update_status(&self, status: ChatStatus) {
        if let Some(diagnostic) = status.diagnostic.as_deref() {
            log::warn!("Chat {:?}: {diagnostic}", status.state);
        } else {
            log::debug!("Chat state: {:?}", status.state);
        }
        *write_lock(&self.inner.status) = status.clone();
        self.emit(ChatEvent::Status { status });
    }

    fn emit(&self, event: ChatEvent) {
        if let Some(app) = lock(&self.inner.app).clone() {
            let _ = app.emit(CHAT_EVENT, event);
        }
    }
}

async fn supervise_connection(
    inner: Arc<ChatInner>,
    generation: u64,
    config: ChatConfig,
    password: String,
    mut receiver: mpsc::UnboundedReceiver<ChatOutbound>,
) {
    let runtime = ChatRuntime {
        inner: inner.clone(),
    };
    let mut attempt = 0_u32;
    loop {
        if inner.generation.load(Ordering::Acquire) != generation {
            return;
        }
        let state = if attempt == 0 {
            ChatConnectionState::Connecting
        } else {
            ChatConnectionState::Reconnecting
        };
        runtime.update_status(ChatStatus::new(&config, state));
        match run_session(&runtime, generation, &config, &password, &mut receiver).await {
            Ok(SessionEnd::Shutdown) => return,
            Ok(SessionEnd::Disconnected) => {}
            Err(error) => {
                let mut status = ChatStatus::new(&config, ChatConnectionState::Reconnecting);
                status.diagnostic = Some(error);
                runtime.update_status(status);
            }
        }
        if inner.generation.load(Ordering::Acquire) != generation {
            return;
        }
        attempt = attempt.saturating_add(1);
        let delay = match attempt {
            1 => 1,
            2 => 2,
            3 => 5,
            4 => 10,
            _ => 30,
        };
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

enum SessionEnd {
    Shutdown,
    Disconnected,
}

async fn run_session(
    runtime: &ChatRuntime,
    generation: u64,
    config: &ChatConfig,
    password: &str,
    receiver: &mut mpsc::UnboundedReceiver<ChatOutbound>,
) -> Result<SessionEnd, String> {
    let mut request = config
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| format!("Invalid chat endpoint: {error}"))?;
    let origin = websocket_origin(&config.endpoint)?;
    request.headers_mut().insert(
        "Origin",
        HeaderValue::from_str(&origin).map_err(|error| error.to_string())?,
    );
    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|error| format!("Could not connect to chat: {error}"))?;
    send_line(&mut socket, "CAP LS 302").await?;
    send_line(&mut socket, &format!("NICK {}", config.account)).await?;
    send_line(
        &mut socket,
        &format!("USER {} 0 * :{}", config.account, config.display_name),
    )
    .await?;
    let mut session = SessionState::default();

    loop {
        if runtime.inner.generation.load(Ordering::Acquire) != generation {
            let _ = socket.close(None).await;
            return Ok(SessionEnd::Shutdown);
        }
        tokio::select! {
            outbound = receiver.recv() => {
                match outbound {
                    Some(ChatOutbound::Lines(lines)) => {
                        for line in lines {
                            send_line(&mut socket, &line).await?;
                        }
                    }
                    Some(ChatOutbound::Shutdown) | None => {
                        let _ = send_line(&mut socket, "QUIT :Mimir disconnected").await;
                        let _ = socket.close(None).await;
                        return Ok(SessionEnd::Shutdown);
                    }
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(WebSocketMessage::Text(text))) => {
                        for line in text.lines() {
                            let outgoing = handle_irc_line(
                                runtime,
                                config,
                                password,
                                &mut session,
                                line.trim_end_matches('\r'),
                            )?;
                            for line in outgoing {
                                send_line(&mut socket, &line).await?;
                            }
                        }
                    }
                    Some(Ok(WebSocketMessage::Ping(payload))) => {
                        socket.send(WebSocketMessage::Pong(payload))
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    Some(Ok(WebSocketMessage::Close(_))) | None => {
                        return Ok(SessionEnd::Disconnected);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(format!("Chat connection closed: {error}")),
                }
            }
        }
    }
}

async fn send_line<S>(socket: &mut S, line: &str) -> Result<(), String>
where
    S: futures_util::Sink<WebSocketMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    socket
        .send(WebSocketMessage::Text(format!("{line}\r\n").into()))
        .await
        .map_err(|error| error.to_string())
}

fn handle_irc_line(
    runtime: &ChatRuntime,
    config: &ChatConfig,
    password: &str,
    session: &mut SessionState,
    line: &str,
) -> Result<Vec<String>, String> {
    let message = match IrcMessage::from_str(line) {
        Ok(message) => message,
        // Extensions occasionally add numeric replies unknown to irc-proto
        // (for example WHOIS account metadata). They are informational and
        // must not tear down an otherwise healthy chat session.
        Err(_) if has_unknown_numeric_command(line) => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut outgoing = Vec::new();
    match &message.command {
        Command::PING(server, second) => {
            outgoing.push(match second {
                Some(second) => format!("PONG {server} :{second}"),
                None => format!("PONG :{server}"),
            });
        }
        Command::CAP(_, CapSubCommand::LS, continuation, capabilities) => {
            if let Some(capabilities) = cap_payload(continuation, capabilities) {
                if !session.caps.is_empty() {
                    session.caps.push(' ');
                }
                session.caps.push_str(capabilities);
            }
            if continuation.as_deref() != Some("*") && !session.requested_caps {
                for required in [
                    "sasl",
                    "message-tags",
                    "server-time",
                    "batch",
                    "draft/chathistory",
                    "draft/event-playback",
                    "draft/message-redaction",
                    "account-notify",
                    "away-notify",
                    "extended-join",
                ] {
                    if !session
                        .caps
                        .split_whitespace()
                        .any(|capability| capability.split('=').next() == Some(required))
                    {
                        return Err(format!(
                            "Chat server does not advertise required capability {required}."
                        ));
                    }
                }
                session.requested_caps = true;
                outgoing.push(format!("CAP REQ :{REQUESTED_CAPABILITIES}"));
            }
        }
        Command::CAP(_, CapSubCommand::ACK, continuation, capabilities)
            if cap_payload(continuation, capabilities)
                .unwrap_or_default()
                .split_whitespace()
                .any(|capability| capability == "sasl") =>
        {
            outgoing.push("AUTHENTICATE PLAIN".into());
        }
        Command::CAP(_, CapSubCommand::NAK, continuation, capabilities) => {
            return Err(format!(
                "Chat server rejected required capabilities: {}",
                cap_payload(continuation, capabilities).unwrap_or("unknown")
            ));
        }
        Command::AUTHENTICATE(challenge) if challenge == "+" => {
            let payload = format!("\0{}\0{password}", config.account);
            outgoing.push(format!("AUTHENTICATE {}", STANDARD.encode(payload)));
        }
        Command::Response(Response::RPL_SASLSUCCESS, _) => {
            outgoing.push("CAP END".into());
        }
        Command::Response(
            Response::ERR_SASLFAIL | Response::ERR_SASLTOOLONG | Response::ERR_SASLABORT,
            _,
        ) => {
            let mut status = ChatStatus::new(config, ChatConnectionState::Error);
            status.diagnostic = Some("Chat authentication failed.".into());
            runtime.update_status(status);
        }
        Command::Response(Response::RPL_WELCOME, _) => {
            let mut status = ChatStatus::new(config, ChatConnectionState::Connected);
            // This owned Ergo deployment grants only the RELAYMSG capability
            // and uses the already verified SASL passphrase for OPER. Resumed
            // always-on sessions may not repeat numeric 381.
            status.relay_ready = true;
            runtime.update_status(status);
            outgoing.push(format!("OPER {} {password}", config.account));
            if !config.display_name.trim().is_empty() {
                outgoing.push(format!(
                    "SETNAME :{}",
                    clean_irc_parameter(&config.display_name)
                ));
            }
            let mut channels = runtime.inner.database.known_channels()?;
            if !channels.iter().any(|channel| channel == "#general") {
                channels.insert(0, "#general".into());
            }
            for channel in channels {
                outgoing.push(format!("JOIN {channel}"));
            }
            outgoing.push(format!(
                "CHATHISTORY TARGETS timestamp=1970-01-01T00:00:00.000Z timestamp={} 100",
                timestamp()
            ));
        }
        Command::Response(Response::RPL_YOUREOPER, _) => {
            let mut status = runtime.status();
            status.relay_ready = true;
            runtime.update_status(status);
        }
        Command::Response(
            Response::ERR_PASSWDMISMATCH | Response::ERR_NOPRIVILEGES | Response::ERR_NOOPERHOST,
            _,
        ) => {
            let mut status = runtime.status();
            status.relay_ready = false;
            status.diagnostic =
                Some("Agent messages will use visible labels instead of relay identity.".into());
            runtime.update_status(status);
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("FAIL")
                && arguments
                    .first()
                    .is_some_and(|value| value.eq_ignore_ascii_case("RELAYMSG")) =>
        {
            let mut status = runtime.status();
            status.relay_ready = false;
            status.diagnostic =
                Some("Agent messages will use visible labels instead of relay identity.".into());
            runtime.update_status(status);
        }
        Command::JOIN(target, extended_account, _) => {
            if let Some(nick) = message.source_nickname() {
                let account = tag(&message, "account")
                    .or_else(|| extended_account.clone())
                    .filter(|account| account != "*");
                runtime
                    .inner
                    .database
                    .upsert_member(target, nick, account.as_deref(), None)?;
            }
            if message
                .source_nickname()
                .is_some_and(|nick| nick.eq_ignore_ascii_case(&config.account))
            {
                let now = timestamp();
                runtime.inner.database.ensure_target(
                    target,
                    ChatTargetKind::Channel,
                    true,
                    Some(&now),
                )?;
                if session.history_requested.insert(target.to_lowercase()) {
                    outgoing.push(format!("CHATHISTORY LATEST {target} * 100"));
                }
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::PART(target, _) => {
            if let Some(nick) = message.source_nickname() {
                runtime.inner.database.remove_member(target, nick)?;
            }
            if message
                .source_nickname()
                .is_some_and(|nick| nick.eq_ignore_ascii_case(&config.account))
            {
                runtime.inner.database.set_joined(target, false)?;
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::QUIT(_) => {
            if let Some(nick) = message.source_nickname() {
                runtime.inner.database.remove_member_everywhere(nick)?;
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::TOPIC(target, Some(topic)) => {
            runtime.inner.database.set_topic(target, topic)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::Response(Response::RPL_TOPIC, arguments) if arguments.len() >= 3 => {
            let target = &arguments[arguments.len() - 2];
            let topic = &arguments[arguments.len() - 1];
            runtime.inner.database.set_topic(target, topic)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::Response(Response::RPL_NAMREPLY, arguments) if arguments.len() >= 4 => {
            let target = arguments[arguments.len() - 2].to_lowercase();
            let members = session.names.entry(target).or_default();
            for member in arguments
                .last()
                .into_iter()
                .flat_map(|names| names.split_whitespace())
            {
                members.insert(
                    member
                        .trim_start_matches(['~', '&', '@', '%', '+'])
                        .to_lowercase(),
                );
            }
        }
        Command::Response(Response::RPL_ENDOFNAMES, arguments) if arguments.len() >= 2 => {
            let target = arguments[arguments.len() - 2].to_lowercase();
            if let Some(members) = session.names.remove(&target) {
                let members = members.into_iter().collect::<Vec<_>>();
                runtime.inner.database.replace_members(&target, &members)?;
                for member in &members {
                    outgoing.push(format!("WHOIS {member}"));
                }
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::Response(Response::RPL_WHOISUSER, arguments) if arguments.len() >= 6 => {
            let nick = &arguments[1];
            let display_name = arguments.last().map(String::as_str).unwrap_or(nick);
            runtime
                .inner
                .database
                .update_member_profile(nick, display_name)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::AWAY(reason) => {
            if let Some(nick) = message.source_nickname() {
                runtime.inner.database.update_member_presence(
                    nick,
                    reason.is_some(),
                    reason.as_deref(),
                )?;
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::Response(Response::RPL_AWAY, arguments) if arguments.len() >= 3 => {
            let nick = &arguments[arguments.len() - 2];
            let reason = arguments.last().map(String::as_str);
            runtime
                .inner
                .database
                .update_member_presence(nick, true, reason)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::BATCH(reference, Some(BatchSubCommand::CUSTOM(kind)), _)
            if reference.starts_with('+') && kind.eq_ignore_ascii_case("chathistory") =>
        {
            session
                .history_batches
                .insert(reference.trim_start_matches('+').to_string());
        }
        Command::BATCH(reference, Some(BatchSubCommand::CUSTOM(kind)), arguments)
            if reference.starts_with('+') && kind.eq_ignore_ascii_case("draft/multiline") =>
        {
            let Some(target) = arguments.as_ref().and_then(|arguments| arguments.first()) else {
                return Ok(outgoing);
            };
            let historical = tag(&message, "batch")
                .as_deref()
                .is_some_and(|batch| session.history_batches.contains(batch));
            if session.multiline_batches.len() < MAX_MULTILINE_BATCHES {
                session.multiline_batches.insert(
                    reference.trim_start_matches('+').to_string(),
                    PendingMultiline {
                        target: target.clone(),
                        historical,
                        opening: message.clone(),
                        chunks: Vec::new(),
                        bytes: 0,
                    },
                );
            }
        }
        Command::BATCH(reference, None, _) if reference.starts_with('-') => {
            let reference = reference.trim_start_matches('-');
            session.history_batches.remove(reference);
            if let Some(pending) = session.multiline_batches.remove(reference) {
                let mut body = String::new();
                for (chunk, concatenate) in &pending.chunks {
                    if !body.is_empty() && !concatenate {
                        body.push('\n');
                    }
                    body.push_str(chunk);
                }
                if !body.trim().is_empty() {
                    ingest_message(
                        runtime,
                        config,
                        &pending.opening,
                        &pending.target,
                        &body,
                        pending.historical,
                    )?;
                }
            }
        }
        Command::PRIVMSG(target, body) => {
            let batch = tag(&message, "batch");
            if let Some(pending) = batch
                .as_deref()
                .and_then(|batch| session.multiline_batches.get_mut(batch))
            {
                if pending.bytes + body.len() <= MAX_MULTILINE_BYTES {
                    let concatenate = has_tag(&message, "draft/multiline-concat")
                        || has_tag(&message, "+draft/multiline-concat");
                    pending.bytes += body.len();
                    pending.chunks.push((body.clone(), concatenate));
                }
                return Ok(outgoing);
            }
            let historical = batch
                .as_deref()
                .is_some_and(|batch| session.history_batches.contains(batch));
            ingest_message(runtime, config, &message, target, body, historical)?;
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("TAGMSG") && !arguments.is_empty() =>
        {
            ingest_tag_message(runtime, config, &message, &arguments[0])?;
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("REDACT") && arguments.len() >= 2 =>
        {
            ingest_redaction(runtime, config, &message, &arguments[0], &arguments[1])?;
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("CHATHISTORY")
                && arguments
                    .first()
                    .is_some_and(|value| value.eq_ignore_ascii_case("TARGETS"))
                && arguments.len() >= 2 =>
        {
            let target = normalize_target(&arguments[1])?;
            let kind = if target.starts_with(['#', '&']) {
                ChatTargetKind::Channel
            } else {
                ChatTargetKind::Direct
            };
            let now = timestamp();
            runtime.inner.database.ensure_target(
                &target,
                kind,
                target.starts_with(['#', '&']),
                Some(&now),
            )?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        _ => {}
    }
    Ok(outgoing)
}

fn cap_payload<'a>(
    continuation_or_payload: &'a Option<String>,
    payload: &'a Option<String>,
) -> Option<&'a str> {
    payload.as_deref().or_else(|| {
        continuation_or_payload
            .as_deref()
            .filter(|value| *value != "*")
    })
}

fn ingest_message(
    runtime: &ChatRuntime,
    config: &ChatConfig,
    raw: &IrcMessage,
    raw_target: &str,
    body: &str,
    historical: bool,
) -> Result<(), String> {
    let sender_nick = raw.source_nickname().unwrap_or("unknown").to_string();
    if sender_nick.eq_ignore_ascii_case("HistServ") {
        return Ok(());
    }
    let target = conversation_target(config, raw_target, &sender_nick)?;
    let direct = !target.starts_with(['#', '&']);
    let kind = if !direct {
        ChatTargetKind::Channel
    } else {
        ChatTargetKind::Direct
    };
    runtime.inner.database.ensure_target(
        &target,
        kind,
        raw_target.starts_with(['#', '&']),
        None,
    )?;
    if direct && !historical {
        runtime.inner.database.set_hidden(&target, false)?;
    }
    let sender_account = tag(raw, "account").filter(|account| account != "*");
    let relayed_by = tag(raw, "draft/relaymsg");
    let own = sender_nick.eq_ignore_ascii_case(&config.account)
        || sender_account
            .as_deref()
            .is_some_and(|account| account.eq_ignore_ascii_case(&config.account))
        || relayed_by
            .as_deref()
            .is_some_and(|account| account.eq_ignore_ascii_case(&config.account));
    let server_time = tag(raw, "time").unwrap_or_else(timestamp);
    let reply_to = tag(raw, "+reply");
    let agent_label = sender_nick
        .split_once('/')
        .map(|(_, label)| label.to_string())
        .or_else(|| tag(raw, "+shoulde.rs/agent"));
    let activity_id = tag(raw, "+shoulde.rs/activity");
    let id = tag(raw, "msgid")
        .unwrap_or_else(|| synthetic_message_id(&target, &server_time, &sender_nick, body));
    let body = agent_label
        .as_deref()
        .and_then(|label| body.strip_prefix(&format!("[{label}] ")))
        .unwrap_or(body)
        .to_string();
    if let Some(reference_id) = tag(raw, "+shoulde.rs/edit") {
        let reference_id = validate_message_id(&reference_id)?;
        if let Some(message) = runtime.inner.database.record_message_event(
            &id,
            &target,
            &reference_id,
            "edit",
            &sender_nick,
            sender_account.as_deref(),
            &body,
            &server_time,
            own,
            mentions_account(&body, &config.account),
        )? {
            runtime.emit(ChatEvent::Message {
                message: Box::new(message),
                notify: false,
            });
        }
        return Ok(());
    }
    let mentioned = mentions_account(&body, &config.account);
    let message = ChatMessage {
        id,
        target,
        server_time,
        sender_nick,
        sender_account,
        body,
        reply_to,
        own,
        agent_label,
        activity_id,
        edited_at: None,
        deleted: false,
        mentioned,
        reactions: Vec::new(),
        attachments: attachment_from_tags(config, raw),
    };
    if runtime.inner.database.insert_message(&message)? {
        runtime.emit(ChatEvent::Message {
            message: Box::new(message.clone()),
            notify: !historical && !message.own,
        });
    }
    Ok(())
}

fn ingest_tag_message(
    runtime: &ChatRuntime,
    config: &ChatConfig,
    raw: &IrcMessage,
    raw_target: &str,
) -> Result<(), String> {
    if let Some(state) = tag(raw, "+typing") {
        let sender_nick = raw.source_nickname().unwrap_or("unknown").to_string();
        let sender_account = tag(raw, "account").filter(|account| account != "*");
        if !actor_is_own(config, &sender_nick, sender_account.as_deref(), raw) {
            let target = conversation_target(config, raw_target, &sender_nick)?;
            runtime.emit(ChatEvent::Typing {
                target,
                sender_nick,
                active: matches!(state.as_str(), "active" | "pause"),
            });
        }
        return Ok(());
    }
    let reaction = tag(raw, "+draft/react")
        .or_else(|| tag(raw, "+react"))
        .map(|value| ("react", value))
        .or_else(|| {
            tag(raw, "+draft/unreact")
                .or_else(|| tag(raw, "+unreact"))
                .map(|value| ("unreact", value))
        });
    let Some((kind, reaction)) = reaction else {
        return Ok(());
    };
    let Some(reference_id) = tag(raw, "+reply") else {
        return Ok(());
    };
    let reference_id = validate_message_id(&reference_id)?;
    let reaction = normalize_reaction(&reaction)?;
    let sender_nick = raw.source_nickname().unwrap_or("unknown").to_string();
    let target = conversation_target(config, raw_target, &sender_nick)?;
    let sender_account = tag(raw, "account").filter(|account| account != "*");
    let own = actor_is_own(config, &sender_nick, sender_account.as_deref(), raw);
    let server_time = tag(raw, "time").unwrap_or_else(timestamp);
    let id = tag(raw, "msgid")
        .unwrap_or_else(|| synthetic_message_id(&target, &server_time, &sender_nick, &reaction));
    if let Some(message) = runtime.inner.database.record_message_event(
        &id,
        &target,
        &reference_id,
        kind,
        &sender_nick,
        sender_account.as_deref(),
        &reaction,
        &server_time,
        own,
        false,
    )? {
        runtime.emit(ChatEvent::Message {
            message: Box::new(message),
            notify: false,
        });
    }
    Ok(())
}

fn ingest_redaction(
    runtime: &ChatRuntime,
    config: &ChatConfig,
    raw: &IrcMessage,
    raw_target: &str,
    identifier: &str,
) -> Result<(), String> {
    let sender_nick = raw.source_nickname().unwrap_or("unknown");
    let target = conversation_target(config, raw_target, sender_nick)?;
    let identifier = validate_message_id(identifier)?;
    let server_time = tag(raw, "time").unwrap_or_else(timestamp);
    if let Some(message) = runtime
        .inner
        .database
        .redact(&target, &identifier, &server_time)?
    {
        runtime.emit(ChatEvent::Message {
            message: Box::new(message),
            notify: false,
        });
    }
    Ok(())
}

fn conversation_target(
    config: &ChatConfig,
    raw_target: &str,
    sender_nick: &str,
) -> Result<String, String> {
    let target = if raw_target.eq_ignore_ascii_case(&config.account) {
        sender_nick
    } else {
        raw_target
    };
    normalize_target(target)
}

fn actor_is_own(
    config: &ChatConfig,
    sender_nick: &str,
    sender_account: Option<&str>,
    raw: &IrcMessage,
) -> bool {
    sender_nick.eq_ignore_ascii_case(&config.account)
        || sender_account.is_some_and(|account| account.eq_ignore_ascii_case(&config.account))
        || tag(raw, "draft/relaymsg")
            .as_deref()
            .is_some_and(|account| account.eq_ignore_ascii_case(&config.account))
}

fn attachment_from_tags(config: &ChatConfig, raw: &IrcMessage) -> Vec<ChatAttachment> {
    let Some(id) = tag(raw, "+shoulde.rs/file") else {
        return Vec::new();
    };
    let Some(name) = tag(raw, "+shoulde.rs/file-name") else {
        return Vec::new();
    };
    let Some(mime) = tag(raw, "+shoulde.rs/file-type") else {
        return Vec::new();
    };
    let Some(size) = tag(raw, "+shoulde.rs/file-size")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|size| *size > 0 && *size <= 25 * 1024 * 1024)
    else {
        return Vec::new();
    };
    let Some(sha256) = tag(raw, "+shoulde.rs/file-sha256").filter(|value| {
        value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
    }) else {
        return Vec::new();
    };
    if validate_message_id(&id).is_err()
        || name.is_empty()
        || name.len() > 240
        || mime.is_empty()
        || mime.len() > 120
    {
        return Vec::new();
    }
    let Some(url) = attachment_url(&config.endpoint, &id) else {
        return Vec::new();
    };
    vec![ChatAttachment {
        id,
        name,
        mime,
        size,
        sha256,
        url,
        local_path: None,
    }]
}

fn attachment_url(endpoint: &str, file_id: &str) -> Option<String> {
    let mut url = Url::parse(endpoint).ok()?;
    url.set_scheme(if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    })
    .ok()?;
    url.set_path(&format!("/files/{file_id}"));
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn human_lines(target: &str, text: &str, reply_to: Option<&str>) -> Vec<String> {
    if !text.contains('\n') && text.len() <= IRC_CHUNK_BYTES {
        return vec![format!(
            "{}PRIVMSG {target} :{text}",
            tags_prefix(reply_to, None, None)
        )];
    }
    let batch = format!("mimir{}", uuid::Uuid::new_v4().simple());
    let opening_tags = tags_prefix(reply_to, None, None);
    let mut lines = vec![format!(
        "{opening_tags}BATCH +{batch} draft/multiline {target}"
    )];
    for (body, concatenate) in multiline_chunks(text) {
        let concat = if concatenate {
            "draft/multiline-concat;"
        } else {
            ""
        };
        lines.push(format!("@{concat}batch={batch} PRIVMSG {target} :{body}"));
    }
    lines.push(format!("BATCH -{batch}"));
    lines
}

fn attachment_message_line(target: &str, attachment: &ChatAttachment) -> String {
    let tags = [
        format!("+shoulde.rs/file={}", irc_tag_value(&attachment.id)),
        format!("+shoulde.rs/file-name={}", irc_tag_value(&attachment.name),),
        format!("+shoulde.rs/file-size={}", attachment.size),
        format!("+shoulde.rs/file-type={}", irc_tag_value(&attachment.mime),),
        format!(
            "+shoulde.rs/file-sha256={}",
            irc_tag_value(&attachment.sha256),
        ),
    ]
    .join(";");
    format!("@{tags} PRIVMSG {target} :📎 {}", attachment.name)
}

async fn delete_remote_attachment(
    config: &ChatConfig,
    password: &str,
    url: &str,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .delete(url)
        .basic_auth(&config.account, Some(password))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status().as_u16()))
    }
}

fn attachment_collection_url(endpoint: &str) -> Result<String, String> {
    let mut url = Url::parse(endpoint).map_err(|error| error.to_string())?;
    url.set_scheme(if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    })
    .map_err(|_| "Invalid chat endpoint scheme.".to_string())?;
    url.set_path("/files");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn normalize_attachment_name(value: &str) -> Result<String, String> {
    let name = std::path::Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim();
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 240
        || name.chars().any(|character| character == '\0')
    {
        return Err("Invalid attachment filename.".into());
    }
    Ok(name.to_string())
}

fn normalize_mime(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase();
    if value.is_empty()
        || value.len() > 120
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/+.-".contains(character))
    {
        None
    } else {
        Some(value)
    }
}

fn mime_for_filename(name: &str) -> &'static str {
    match std::path::Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "log" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn agent_lines(
    account: &str,
    target: &str,
    text: &str,
    reply_to: Option<&str>,
    agent_label: &str,
    activity_id: Option<&str>,
    relay_ready: bool,
) -> Vec<String> {
    let agent = normalize_agent_label(agent_label);
    let chunks = plain_chunks(text);
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            let reply = (index == 0).then_some(reply_to).flatten();
            let prefix = tags_prefix(reply, Some(&agent), activity_id);
            if relay_ready && target.starts_with(['#', '&']) {
                format!("{prefix}RELAYMSG {target} {account}/{agent} :{chunk}")
            } else {
                format!("{prefix}PRIVMSG {target} :[{agent}] {chunk}")
            }
        })
        .collect()
}

fn tags_prefix(
    reply_to: Option<&str>,
    agent_label: Option<&str>,
    activity_id: Option<&str>,
) -> String {
    let mut tags = Vec::new();
    if let Some(reply_to) = reply_to {
        tags.push(format!("+reply={}", irc_tag_value(reply_to)));
    }
    if let Some(agent_label) = agent_label {
        tags.push(format!("+shoulde.rs/agent={}", irc_tag_value(agent_label)));
    }
    if let Some(activity_id) = activity_id {
        tags.push(format!(
            "+shoulde.rs/activity={}",
            irc_tag_value(activity_id)
        ));
    }
    if tags.is_empty() {
        String::new()
    } else {
        format!("@{} ", tags.join(";"))
    }
}

fn irc_tag_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            ';' => escaped.push_str(r"\:"),
            ' ' => escaped.push_str(r"\s"),
            '\\' => escaped.push_str(r"\\"),
            '\r' => escaped.push_str(r"\r"),
            '\n' => escaped.push_str(r"\n"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn multiline_chunks(text: &str) -> Vec<(String, bool)> {
    let mut chunks = Vec::new();
    for line in text.split('\n') {
        let line_chunks = split_utf8(line, IRC_CHUNK_BYTES);
        if line_chunks.is_empty() {
            chunks.push((String::new(), false));
        } else {
            for (index, chunk) in line_chunks.into_iter().enumerate() {
                chunks.push((chunk, index > 0));
            }
        }
    }
    chunks
}

fn plain_chunks(text: &str) -> Vec<String> {
    text.split('\n')
        .flat_map(|line| {
            let chunks = split_utf8(line, IRC_CHUNK_BYTES);
            if chunks.is_empty() {
                vec![" ".into()]
            } else {
                chunks
            }
        })
        .collect()
}

fn split_utf8(value: &str, max_bytes: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = (start + max_bytes).min(value.len());
        while end > start && !value.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            break;
        }
        if end < value.len() {
            let whitespace = value[start..end]
                .char_indices()
                .filter(|(_, character)| character.is_whitespace())
                .next_back();
            if let Some((index, character)) = whitespace {
                let candidate = start + index + character.len_utf8();
                if candidate > start + max_bytes / 2 {
                    end = candidate;
                }
            }
        }
        chunks.push(value[start..end].to_string());
        start = end;
    }
    chunks
}

fn normalize_body(value: &str) -> Result<String, String> {
    let value = value.replace("\r\n", "\n").replace('\r', "\n");
    let value = value.trim_end_matches('\n').to_string();
    if value.trim().is_empty() {
        return Err("Message cannot be empty.".into());
    }
    if value.len() > MAX_MESSAGE_BYTES {
        return Err(format!(
            "Message is too long; keep it below {MAX_MESSAGE_BYTES} UTF-8 bytes."
        ));
    }
    Ok(value)
}

fn normalize_reaction(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 32
        || value.chars().any(char::is_control)
        || value.contains(char::is_whitespace)
    {
        return Err("A reaction must be one emoji or short token.".into());
    }
    Ok(value.to_string())
}

fn mentions_account(body: &str, account: &str) -> bool {
    let expected = account.to_lowercase();
    body.split(|character: char| {
        !(character.is_ascii_alphanumeric() || "-_[]{}^`@".contains(character))
    })
    .any(|word| {
        word.strip_prefix('@')
            .is_some_and(|value| value.eq_ignore_ascii_case(&expected))
    })
}

fn normalize_target(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with(['#', '&']) {
        normalize_channel(value)
    } else {
        normalize_nick(value)
    }
}

fn normalize_channel(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = if value.starts_with(['#', '&']) {
        value.to_string()
    } else {
        format!("#{value}")
    };
    if value.len() < 2
        || value.len() > 64
        || !value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(
            "Channel names may contain letters, numbers, dashes, underscores, and dots.".into(),
        );
    }
    Ok(value.to_lowercase())
}

fn normalize_nick(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 32
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_[]{}^`".contains(character))
    {
        return Err("Invalid chat account or direct-message target.".into());
    }
    Ok(value.to_lowercase())
}

fn validate_message_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == ';')
    {
        return Err("Invalid reply message ID.".into());
    }
    Ok(value.to_string())
}

fn clean_irc_parameter(value: &str) -> String {
    value.replace(['\r', '\n', '\0'], " ").trim().to_string()
}

fn normalize_agent_label(value: &str) -> String {
    let label: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "-_".contains(*character))
        .take(16)
        .collect();
    if label.is_empty() {
        "agent".into()
    } else {
        label.to_lowercase()
    }
}

fn has_tag(message: &IrcMessage, name: &str) -> bool {
    message
        .tags
        .as_ref()
        .is_some_and(|tags| tags.iter().any(|tag| tag.0 == name))
}

fn tag(message: &IrcMessage, name: &str) -> Option<String> {
    message
        .tags
        .as_ref()?
        .iter()
        .find_map(|tag| if tag.0 == name { tag.1.clone() } else { None })
}

fn has_unknown_numeric_command(line: &str) -> bool {
    let command = if line.starts_with(':') {
        line.split_whitespace().nth(1)
    } else {
        line.split_whitespace().next()
    };
    command.is_some_and(|value| value.len() == 3 && value.chars().all(|c| c.is_ascii_digit()))
}

fn synthetic_message_id(target: &str, time: &str, sender: &str, body: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(target);
    hash.update([0]);
    hash.update(time);
    hash.update([0]);
    hash.update(sender);
    hash.update([0]);
    hash.update(body);
    format!("local-{:x}", hash.finalize())[..30].to_string()
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn validate_config(config: &ChatConfig) -> Result<(), String> {
    let endpoint =
        Url::parse(&config.endpoint).map_err(|_| "Invalid chat endpoint.".to_string())?;
    match endpoint.scheme() {
        "wss" => {}
        "ws" if endpoint
            .host_str()
            .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "::1") => {}
        _ => return Err("Chat endpoint must use wss://, except for localhost development.".into()),
    }
    normalize_nick(&config.account)?;
    if config.display_name.chars().count() > 80 {
        return Err("Display name is too long.".into());
    }
    Ok(())
}

fn websocket_origin(endpoint: &str) -> Result<String, String> {
    let url = Url::parse(endpoint).map_err(|error| error.to_string())?;
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    let host = url
        .host_str()
        .ok_or_else(|| "Chat endpoint has no host.".to_string())?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("{scheme}://{host}{port}"))
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn store_credential(
    _path: &std::path::Path,
    config: &ChatConfig,
    password: &str,
) -> Result<(), String> {
    use security_framework::os::macos::keychain::SecKeychain;

    SecKeychain::default()
        .map_err(|error| error.to_string())?
        .set_generic_password(
            KEYCHAIN_SERVICE,
            &credential_key(config),
            password.as_bytes(),
        )
        .map_err(|error| error.to_string())
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn load_credential(_path: &std::path::Path, config: &ChatConfig) -> Result<Option<String>, String> {
    use security_framework::os::macos::keychain::SecKeychain;

    let keychain = SecKeychain::default().map_err(|error| error.to_string())?;
    match keychain.find_generic_password(KEYCHAIN_SERVICE, &credential_key(config)) {
        Ok((password, _)) => String::from_utf8(password.to_vec())
            .map(Some)
            .map_err(|_| "The saved chat passphrase is not valid UTF-8.".to_string()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(any(not(target_os = "macos"), debug_assertions))]
fn store_credential(
    path: &std::path::Path,
    config: &ChatConfig,
    password: &str,
) -> Result<(), String> {
    let value = serde_json::to_vec(&json!({
        "credentialKey": credential_key(config),
        "password": password,
    }))
    .map_err(|error| error.to_string())?;
    crate::persistence::write_secret_bytes_atomic(path, &value).map_err(|error| error.to_string())
}

#[cfg(any(not(target_os = "macos"), debug_assertions))]
fn load_credential(path: &std::path::Path, config: &ChatConfig) -> Result<Option<String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if value.get("credentialKey").and_then(Value::as_str) != Some(credential_key(config).as_str()) {
        return Ok(None);
    }
    Ok(value
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn credential_key(config: &ChatConfig) -> String {
    let host = Url::parse(&config.endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "chat".into());
    format!("chat:{}@{host}", config.account.to_lowercase())
}

fn read_config_at(path: &std::path::Path) -> Result<Option<ChatConfig>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("Invalid chat configuration: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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

fn reserve_native_tool_names(registry: &ToolRegistry) -> Result<(), String> {
    for (canonical, alias) in [
        ("chat.rooms", "chat_rooms"),
        ("chat.read", "chat_read"),
        ("chat.search", "chat_search"),
        ("chat.send", "chat_send"),
        ("chat.download", "chat_download"),
    ] {
        registry
            .reserve_core_tool(canonical, alias)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn register_native_tools(registry: &ToolRegistry, runtime: &ChatRuntime) -> Result<(), String> {
    register_tool(
        registry,
        runtime,
        "chat.rooms",
        "chat_rooms",
        "List chat rooms.",
        object_schema(json!({}), &[]),
        true,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.read",
        "chat_read",
        "Read chat messages.",
        object_schema(
            json!({
                "target": { "type": "string", "description": "Channel or account; default linked/open room." },
                "before": { "type": "string", "description": "Page before this message ID." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
            }),
            &[],
        ),
        true,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.search",
        "chat_search",
        "Search chat messages.",
        object_schema(
            json!({
                "query": { "type": "string" },
                "target": { "type": "string", "description": "Room filter; default linked/open room, else all." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
            }),
            &["query"],
        ),
        true,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.send",
        "chat_send",
        "Send a chat message.",
        object_schema(
            json!({
                "target": { "type": "string", "description": "Channel or account; default linked/open room." },
                "text": { "type": "string" },
                "reply_to": { "type": "string", "description": "Message ID to reply to." }
            }),
            &["text"],
        ),
        false,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.download",
        "chat_download",
        "Download a chat attachment; returns its verified local path.",
        object_schema(
            json!({
                "file_id": { "type": "string", "description": "Attachment ID from chat_read." }
            }),
            &["file_id"],
        ),
        false,
    )?;
    Ok(())
}

fn register_tool(
    registry: &ToolRegistry,
    runtime: &ChatRuntime,
    canonical: &'static str,
    alias: &'static str,
    description: &'static str,
    schema: Value,
    read_only: bool,
) -> Result<(), String> {
    let runtime = runtime.clone();
    let registration = ToolRegistration::new(
        ToolDescriptor::new(
            canonical,
            alias,
            description,
            schema,
            ToolOwner::Core,
            ToolSource::Native,
        )
        .with_annotations(ToolAnnotations {
            read_only_hint: Some(read_only),
            destructive_hint: Some(false),
            idempotent_hint: read_only.then_some(true),
        }),
        move |context: ToolCallContext, input: Value| {
            let runtime = runtime.clone();
            async move {
                if canonical == "chat.download" {
                    let file_id =
                        input
                            .get("file_id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                ToolError::new(ToolErrorCode::Handler, "file_id is required")
                            })?;
                    return runtime
                        .download_attachment(file_id)
                        .await
                        .map(|attachment| ToolResult::new(json!({ "attachment": attachment })))
                        .map_err(|message| ToolError::new(ToolErrorCode::Handler, message));
                }
                let execute = || -> Result<Value, String> {
                    let result = match canonical {
                        "chat.read" => {
                            let target = runtime.resolve_tool_target(
                                &context,
                                input.get("target").and_then(Value::as_str),
                            )?;
                            let messages = runtime.messages(
                                &target,
                                input.get("before").and_then(Value::as_str),
                                input.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize,
                            )?;
                            json!({
                                "target": target,
                                "status": runtime.status(),
                                "messages": messages,
                            })
                        }
                        "chat.rooms" => {
                            let rooms = runtime
                                .targets()?
                                .into_iter()
                                .map(|room| {
                                    json!({
                                        "id": room.id,
                                        "kind": room.kind.as_str(),
                                        "topic": room.topic,
                                        "unread": room.unread_count,
                                    })
                                })
                                .collect::<Vec<_>>();
                            json!({ "rooms": rooms })
                        }
                        "chat.search" => {
                            // Explicit or linked/active room scopes the search;
                            // with neither, search every room.
                            let target = match input.get("target").and_then(Value::as_str) {
                                Some(requested) => Some(normalize_target(requested)?),
                                None => runtime.resolve_tool_target(&context, None).ok(),
                            };
                            let query = input
                                .get("query")
                                .and_then(Value::as_str)
                                .ok_or_else(|| "query is required".to_string())?;
                            let messages = runtime.search(
                                query,
                                target.as_deref(),
                                input.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize,
                            )?;
                            json!({ "target": target, "messages": messages })
                        }
                        "chat.send" => {
                            let target = runtime.resolve_tool_target(
                                &context,
                                input.get("target").and_then(Value::as_str),
                            )?;
                            let text = input
                                .get("text")
                                .and_then(Value::as_str)
                                .ok_or_else(|| "text is required".to_string())?;
                            let label = runtime.resolve_agent_label(&context);
                            let activity_id =
                                context.metadata.get("activityId").and_then(Value::as_str);
                            runtime.send(
                                &target,
                                text,
                                input.get("reply_to").and_then(Value::as_str),
                                Some(&label),
                                activity_id,
                            )?;
                            json!({ "target": target, "queued": true, "agent": label })
                        }
                        _ => return Err("Unknown chat tool.".to_string()),
                    };
                    Ok(result)
                };
                execute()
                    .map(ToolResult::new)
                    .map_err(|message| ToolError::new(ToolErrorCode::Handler, message))
            }
        },
    );
    registry
        .register(registration)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_runtime() -> (tempfile::TempDir, ChatRuntime) {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("chat.json");
        let database = ChatDatabase::open(directory.path().join("chat.sqlite3")).unwrap();
        let config = ChatConfig::default();
        let runtime = ChatRuntime {
            inner: Arc::new(ChatInner {
                config_path,
                credential_path: directory.path().join("chat.credential"),
                database,
                status: RwLock::new(ChatStatus::new(&config, ChatConnectionState::Connected)),
                app: Mutex::new(None),
                outbound: Mutex::new(None),
                generation: AtomicU64::new(0),
                active_target: RwLock::new(None),
            }),
        };
        (directory, runtime)
    }

    #[test]
    fn chunking_survives_multibyte_whitespace_at_the_wrap_point() {
        // U+00A0 after the midpoint of a >350-byte line used to make the
        // word-wrap adjustment split inside the character and panic.
        let text = format!("{}\u{a0}{}", "a".repeat(300), "b".repeat(100));
        let chunks = split_utf8(&text, IRC_CHUNK_BYTES);
        assert_eq!(chunks.concat(), text);
        let ideographic = format!("{}\u{3000}{}", "語".repeat(100), "b".repeat(100));
        let chunks = split_utf8(&ideographic, IRC_CHUNK_BYTES);
        assert_eq!(chunks.concat(), ideographic);
    }

    #[test]
    fn incoming_multiline_batches_assemble_into_one_message() {
        let (_directory, runtime) = test_runtime();
        let config = ChatConfig::default();
        let mut session = SessionState::default();
        for line in [
            "@msgid=ml1;time=2026-01-01T00:00:00.000Z;account=anna \
             :anna!~u@example BATCH +b1 draft/multiline #general",
            "@batch=b1 :anna!~u@example PRIVMSG #general :first line",
            "@batch=b1;draft/multiline-concat :anna!~u@example PRIVMSG #general : continued",
            "@batch=b1 :anna!~u@example PRIVMSG #general :second line",
            ":anna!~u@example BATCH -b1",
        ] {
            handle_irc_line(&runtime, &config, "", &mut session, line).unwrap();
        }
        let messages = runtime.messages("#general", None, 10).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "ml1");
        assert_eq!(messages[0].body, "first line continued\nsecond line");
        assert_eq!(messages[0].server_time, "2026-01-01T00:00:00.000Z");
        assert!(session.multiline_batches.is_empty());

        // Replaying the same batch inside a chathistory batch dedupes on the
        // stable msgid instead of accumulating synthetic duplicates.
        for line in [
            ":server BATCH +hist chathistory #general",
            "@batch=hist;msgid=ml1;time=2026-01-01T00:00:00.000Z;account=anna \
             :anna!~u@example BATCH +b2 draft/multiline #general",
            "@batch=b2 :anna!~u@example PRIVMSG #general :first line",
            "@batch=b2;draft/multiline-concat :anna!~u@example PRIVMSG #general : continued",
            "@batch=b2 :anna!~u@example PRIVMSG #general :second line",
            ":server BATCH -b2",
            ":server BATCH -hist",
        ] {
            handle_irc_line(&runtime, &config, "", &mut session, line).unwrap();
        }
        assert_eq!(runtime.messages("#general", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn failed_oper_and_relaymsg_disable_relay_identity() {
        let (_directory, runtime) = test_runtime();
        let config = ChatConfig::default();
        let mut session = SessionState::default();
        {
            let mut status = runtime.status();
            status.relay_ready = true;
            *write_lock(&runtime.inner.status) = status;
        }
        handle_irc_line(
            &runtime,
            &config,
            "",
            &mut session,
            ":server 491 waqr :No O-lines for your host",
        )
        .unwrap();
        assert!(!runtime.status().relay_ready);

        {
            let mut status = runtime.status();
            status.relay_ready = true;
            *write_lock(&runtime.inner.status) = status;
        }
        handle_irc_line(
            &runtime,
            &config,
            "",
            &mut session,
            ":server FAIL RELAYMSG NOT_OPER :You are not an operator",
        )
        .unwrap();
        assert!(!runtime.status().relay_ready);
    }

    #[test]
    fn message_chunking_preserves_utf8_and_reply_tags() {
        let text = format!("hello\n{} world", "å".repeat(400));
        let lines = human_lines("#general", &text, Some("msg-1"));
        assert!(lines[0].starts_with("@+reply=msg-1 BATCH +mimir"));
        assert!(lines
            .iter()
            .any(|line| line.contains("draft/multiline-concat")));
        assert!(lines.last().unwrap().starts_with("BATCH -mimir"));
        assert!(lines.iter().all(|line| line.len() < 512));
    }

    #[test]
    fn client_only_tag_values_are_escaped_before_transport() {
        let prefix = tags_prefix(
            Some("reply\\id"),
            Some("codex"),
            Some("agent:one; workspace\nnext"),
        );
        assert_eq!(
            prefix,
            r"@+reply=reply\\id;+shoulde.rs/agent=codex;+shoulde.rs/activity=agent:one\:\sworkspace\nnext "
        );
    }

    #[test]
    fn agent_messages_use_relay_when_ready_and_visible_fallback_otherwise() {
        let relay = agent_lines(
            "waqr",
            "#general",
            "done",
            None,
            "Codex",
            Some("agent:one"),
            true,
        );
        assert_eq!(
            relay,
            vec![
                "@+shoulde.rs/agent=codex;+shoulde.rs/activity=agent:one \
                 RELAYMSG #general waqr/codex :done"
            ]
        );
        let fallback = agent_lines("waqr", "#general", "done", None, "Codex", None, false);
        assert!(fallback[0].contains("PRIVMSG #general :[codex] done"));
    }

    #[test]
    fn target_and_endpoint_validation_is_deliberately_small() {
        assert_eq!(normalize_channel("Product").unwrap(), "#product");
        assert!(normalize_channel("#bad room").is_err());
        assert!(validate_config(&ChatConfig::default()).is_ok());
        assert!(validate_config(&ChatConfig {
            endpoint: "ws://example.com/webirc".into(),
            ..ChatConfig::default()
        })
        .is_err());
    }

    #[cfg(any(not(target_os = "macos"), debug_assertions))]
    #[test]
    fn file_credential_round_trip_is_owner_only_and_target_bound() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("chat.credential");
        let config = ChatConfig::default();

        store_credential(&path, &config, "correct horse battery staple").unwrap();
        assert_eq!(
            load_credential(&path, &config).unwrap().as_deref(),
            Some("correct horse battery staple")
        );

        let other_account = ChatConfig {
            account: "someone-else".into(),
            ..config
        };
        assert_eq!(load_credential(&path, &other_account).unwrap(), None);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn irc_message_ingestion_reads_reply_and_relay_identity() {
        let parsed = IrcMessage::from_str(
            "@msgid=m1;time=2026-01-01T00:00:00.000Z;+reply=m0;draft/relaymsg=waqr \
             :waqr/codex!~u@example PRIVMSG #general :done",
        )
        .unwrap();
        assert_eq!(tag(&parsed, "msgid").as_deref(), Some("m1"));
        assert_eq!(tag(&parsed, "+reply").as_deref(), Some("m0"));
        assert_eq!(parsed.source_nickname(), Some("waqr/codex"));
    }

    #[test]
    fn synced_message_events_materialize_for_people_and_agents() {
        let (_directory, runtime) = test_runtime();
        let config = ChatConfig::default();
        let original = IrcMessage::from_str(
            "@msgid=m1;time=2026-01-01T00:00:00.000Z;account=anna \
             :anna!~u@example PRIVMSG #general :hello @waqr",
        )
        .unwrap();
        ingest_message(
            &runtime,
            &config,
            &original,
            "#general",
            "hello @waqr",
            false,
        )
        .unwrap();
        assert!(runtime.messages("#general", None, 10).unwrap()[0].mentioned);

        let edit = IrcMessage::from_str(
            "@msgid=e1;time=2026-01-01T00:00:01.000Z;account=anna;\
             +shoulde.rs/edit=m1 :anna!~u@example PRIVMSG #general :edited",
        )
        .unwrap();
        ingest_message(&runtime, &config, &edit, "#general", "edited", false).unwrap();

        let reaction = IrcMessage::from_str(
            "@msgid=r1;time=2026-01-01T00:00:02.000Z;account=waqr;\
             +reply=m1;+draft/react=👍 :waqr!~u@example TAGMSG #general",
        )
        .unwrap();
        ingest_tag_message(&runtime, &config, &reaction, "#general").unwrap();
        let materialized = runtime.messages("#general", None, 10).unwrap()[0].clone();
        assert_eq!(materialized.body, "edited");
        assert!(materialized.edited_at.is_some());
        assert!(!materialized.mentioned);
        assert_eq!(materialized.reactions[0].value, "👍");
        assert!(materialized.reactions[0].own);

        let redaction = IrcMessage::from_str(
            "@time=2026-01-01T00:00:03.000Z :anna!~u@example REDACT #general m1",
        )
        .unwrap();
        ingest_redaction(&runtime, &config, &redaction, "#general", "m1").unwrap();
        let deleted = runtime.messages("#general", None, 10).unwrap()[0].clone();
        assert!(deleted.deleted);
        assert!(deleted.body.is_empty());
        assert!(deleted.reactions.is_empty());
    }

    #[test]
    fn mentions_require_an_account_word_and_reactions_stay_small() {
        assert!(mentions_account("please ask @Waqr about it", "waqr"));
        assert!(!mentions_account("mail waqr@example.com", "waqr"));
        assert!(normalize_reaction("👍").is_ok());
        assert!(normalize_reaction("two words").is_err());
    }

    #[test]
    fn attachment_tags_become_canonical_authenticated_file_metadata() {
        let parsed = IrcMessage::from_str(
            "@msgid=m1;+shoulde.rs/file=file-one;\
             +shoulde.rs/file-name=launch.pdf;+shoulde.rs/file-size=42;\
             +shoulde.rs/file-type=application/pdf;\
             +shoulde.rs/file-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
             :anna!~u@example PRIVMSG #general :📎 launch.pdf",
        )
        .unwrap();
        let attachments = attachment_from_tags(&ChatConfig::default(), &parsed);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "launch.pdf");
        assert_eq!(attachments[0].url, "https://chat.shoulde.rs/files/file-one",);
        assert_eq!(
            attachment_message_line("#general", &attachments[0]),
            "@+shoulde.rs/file=file-one;+shoulde.rs/file-name=launch.pdf;\
             +shoulde.rs/file-size=42;+shoulde.rs/file-type=application/pdf;\
             +shoulde.rs/file-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
             PRIVMSG #general :📎 launch.pdf",
        );
    }

    #[test]
    fn cap_payload_handles_single_and_multiline_server_forms() {
        let single = IrcMessage::from_str(":server CAP * LS :sasl batch server-time").unwrap();
        match single.command {
            Command::CAP(_, CapSubCommand::LS, continuation, payload) => {
                assert_eq!(
                    cap_payload(&continuation, &payload),
                    Some("sasl batch server-time")
                );
            }
            other => panic!("unexpected command: {other:?}"),
        }
        let multiline = IrcMessage::from_str(":server CAP * LS * :sasl batch server-time").unwrap();
        match multiline.command {
            Command::CAP(_, CapSubCommand::LS, continuation, payload) => {
                assert_eq!(continuation.as_deref(), Some("*"));
                assert_eq!(
                    cap_payload(&continuation, &payload),
                    Some("sasl batch server-time")
                );
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn away_notifications_materialize_as_coarse_member_presence() {
        let (_directory, runtime) = test_runtime();
        let config = ChatConfig::default();
        runtime
            .inner
            .database
            .upsert_member("#general", "anna", Some("anna"), Some("Anna"))
            .unwrap();
        let mut session = SessionState::default();

        handle_irc_line(
            &runtime,
            &config,
            "",
            &mut session,
            ":anna!~u@example AWAY :User is currently disconnected",
        )
        .unwrap();
        let away = runtime.members(Some("#general")).unwrap().remove(0);
        assert!(away.away);
        assert_eq!(
            away.away_message.as_deref(),
            Some("User is currently disconnected")
        );

        handle_irc_line(&runtime, &config, "", &mut session, ":anna!~u@example AWAY").unwrap();
        assert!(!runtime.members(Some("#general")).unwrap()[0].away);
    }

    #[test]
    fn typing_events_are_ephemeral_and_have_a_small_frontend_contract() {
        let event = ChatEvent::Typing {
            target: "#general".into(),
            sender_nick: "anna".into(),
            active: true,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "typing",
                "target": "#general",
                "senderNick": "anna",
                "active": true,
            })
        );
    }

    #[test]
    fn activity_link_is_a_default_target_not_a_fence() {
        let (_directory, runtime) = test_runtime();
        runtime
            .inner
            .database
            .link_activity("agent:one", "#general", Some("codex"))
            .unwrap();
        let mut context = ToolCallContext::new(crate::tool_registry::ToolCaller::MimirCli);
        context
            .metadata
            .insert("activityId".into(), Value::String("agent:one".into()));

        assert_eq!(
            runtime.resolve_tool_target(&context, None).unwrap(),
            "#general"
        );
        assert_eq!(
            runtime.resolve_tool_target(&context, Some("#product")).unwrap(),
            "#product"
        );
        assert_eq!(
            runtime.resolve_tool_target(&context, Some("anna")).unwrap(),
            "anna"
        );
    }

    #[test]
    fn disabling_chat_disconnects_and_removes_its_public_tools() {
        let (_directory, runtime) = test_runtime();
        let registry = ToolRegistry::default();
        register_native_tools(&registry, &runtime).unwrap();
        assert_eq!(
            registry
                .snapshot()
                .tools
                .iter()
                .filter(|tool| tool.canonical_name.starts_with("chat."))
                .count(),
            5
        );

        let status = runtime.set_enabled(false, &registry).unwrap();
        assert_eq!(status.state, ChatConnectionState::Disconnected);
        assert!(!runtime.config().unwrap().enabled);
        assert!(!registry
            .snapshot()
            .tools
            .iter()
            .any(|tool| tool.canonical_name.starts_with("chat.")));

        runtime.set_enabled(true, &registry).unwrap();
        assert!(runtime.config().unwrap().enabled);
        assert_eq!(
            registry
                .snapshot()
                .tools
                .iter()
                .filter(|tool| tool.canonical_name.starts_with("chat."))
                .count(),
            5
        );
    }
}
