use serde::{Deserialize, Serialize};

pub const DEFAULT_CHAT_ENDPOINT: &str = "wss://chat.abundanceds.com/webirc";
pub const DEFAULT_CHAT_ACCOUNT: &str = "waqr";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub endpoint: String,
    pub account: String,
    pub display_name: String,
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            endpoint: DEFAULT_CHAT_ENDPOINT.into(),
            account: DEFAULT_CHAT_ACCOUNT.into(),
            display_name: "Waqr".into(),
        }
    }
}

const fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatConnectionState {
    NeedsCredentials,
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    pub state: ChatConnectionState,
    pub endpoint: String,
    pub account: String,
    pub relay_ready: bool,
    pub diagnostic: Option<String>,
}

impl ChatStatus {
    pub fn new(config: &ChatConfig, state: ChatConnectionState) -> Self {
        Self {
            state,
            endpoint: config.endpoint.clone(),
            account: config.account.clone(),
            relay_ready: false,
            diagnostic: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatTargetKind {
    Channel,
    Direct,
}

impl ChatTargetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Direct => "direct",
        }
    }
}

impl From<&str> for ChatTargetKind {
    fn from(value: &str) -> Self {
        if value == "direct" {
            Self::Direct
        } else {
            Self::Channel
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTarget {
    pub id: String,
    pub kind: ChatTargetKind,
    pub title: String,
    pub topic: String,
    pub joined: bool,
    pub member_count: u32,
    pub unread_count: u32,
    pub first_unread_id: Option<String>,
    pub last_message_at: Option<String>,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMember {
    pub nick: String,
    pub account: Option<String>,
    pub display_name: String,
    pub away: bool,
    pub away_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReaction {
    pub value: String,
    pub count: u32,
    pub own: bool,
    pub reactors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub url: String,
    #[serde(default)]
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub target: String,
    pub server_time: String,
    pub sender_nick: String,
    pub sender_account: Option<String>,
    pub body: String,
    pub reply_to: Option<String>,
    pub own: bool,
    pub agent_label: Option<String>,
    pub activity_id: Option<String>,
    pub edited_at: Option<String>,
    pub deleted: bool,
    pub mentioned: bool,
    pub reactions: Vec<ChatReaction>,
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Status {
        status: ChatStatus,
    },
    Message {
        message: Box<ChatMessage>,
        notify: bool,
    },
    Typing {
        target: String,
        #[serde(rename = "senderNick")]
        sender_nick: String,
        active: bool,
    },
    TargetsChanged,
}
