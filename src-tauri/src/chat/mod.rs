mod attachments;
mod channels;
mod commands;
mod connection;
mod db;
mod handler;
mod ingest;
mod model;
mod protocol;
mod runtime_core;
mod tools;
mod validation;

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

pub use commands::*;
pub use tools::register_native_tools;

use connection::*;
use handler::*;
use ingest::*;
use protocol::*;
use tools::reserve_native_tool_names;
use validation::*;

pub use model::{
    ChatAttachment, ChatConfig, ChatConnectionState, ChatEvent, ChatMember, ChatMessage,
    ChatReaction, ChatStatus, ChatTarget, ChatTargetKind, DEFAULT_CHAT_ACCOUNT,
    DEFAULT_CHAT_ENDPOINT,
};

use db::ChatDatabase;

const CHAT_EVENT: &str = "mimir://chat-event";
#[cfg(all(target_os = "macos", not(debug_assertions)))]
const KEYCHAIN_SERVICE: &str = "com.abundanceds.mimir";
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

#[cfg(test)]
mod tests;
