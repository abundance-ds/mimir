use std::{collections::HashMap, path::PathBuf};

mod read;
mod records;
mod targets;
mod write;

use records::*;

#[cfg(test)]
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::model::{
    ChatAttachment, ChatMember, ChatMessage, ChatReaction, ChatTarget, ChatTargetKind,
};

#[derive(Clone)]
pub struct ChatDatabase {
    path: PathBuf,
}

impl ChatDatabase {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, String> {
        let database = Self { path: path.into() };
        if let Some(parent) = database.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        database.initialize()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn initialize(&self) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS chat_targets (
                    target TEXT PRIMARY KEY COLLATE NOCASE,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    topic TEXT NOT NULL DEFAULT '',
                    joined INTEGER NOT NULL DEFAULT 0,
                    member_count INTEGER NOT NULL DEFAULT 0,
                    last_read_at TEXT,
                    last_message_at TEXT,
                    muted INTEGER NOT NULL DEFAULT 0,
                    hidden INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS chat_messages (
                    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                    msgid TEXT NOT NULL UNIQUE,
                    target TEXT NOT NULL COLLATE NOCASE,
                    server_time TEXT NOT NULL,
                    sender_nick TEXT NOT NULL,
                    sender_account TEXT,
                    body TEXT NOT NULL,
                    reply_to TEXT,
                    own INTEGER NOT NULL DEFAULT 0,
                    agent_label TEXT,
                    activity_id TEXT,
                    original_body TEXT NOT NULL DEFAULT '',
                    edited_at TEXT,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    mentioned INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS chat_messages_target_time
                    ON chat_messages(target, server_time, msgid);

                CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts
                    USING fts5(body, content='chat_messages', content_rowid='rowid');

                CREATE TRIGGER IF NOT EXISTS chat_messages_ai
                AFTER INSERT ON chat_messages BEGIN
                    INSERT INTO chat_messages_fts(rowid, body) VALUES (new.rowid, new.body);
                END;
                CREATE TRIGGER IF NOT EXISTS chat_messages_ad
                AFTER DELETE ON chat_messages BEGIN
                    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, body)
                    VALUES ('delete', old.rowid, old.body);
                END;
                CREATE TRIGGER IF NOT EXISTS chat_messages_au
                AFTER UPDATE ON chat_messages BEGIN
                    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, body)
                    VALUES ('delete', old.rowid, old.body);
                    INSERT INTO chat_messages_fts(rowid, body) VALUES (new.rowid, new.body);
                END;

                CREATE TABLE IF NOT EXISTS activity_chat_links (
                    activity_id TEXT PRIMARY KEY,
                    target TEXT NOT NULL COLLATE NOCASE,
                    agent_label TEXT
                );

                CREATE TABLE IF NOT EXISTS chat_members (
                    target TEXT NOT NULL COLLATE NOCASE,
                    nick TEXT NOT NULL COLLATE NOCASE,
                    account TEXT,
                    display_name TEXT NOT NULL DEFAULT '',
                    active INTEGER NOT NULL DEFAULT 1,
                    away INTEGER NOT NULL DEFAULT 0,
                    away_message TEXT,
                    PRIMARY KEY(target, nick)
                );

                CREATE TABLE IF NOT EXISTS chat_message_events (
                    event_id TEXT PRIMARY KEY,
                    target TEXT NOT NULL COLLATE NOCASE,
                    reference_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    actor_nick TEXT NOT NULL,
                    actor_account TEXT,
                    value TEXT NOT NULL DEFAULT '',
                    server_time TEXT NOT NULL,
                    own INTEGER NOT NULL DEFAULT 0,
                    mentioned INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS chat_message_events_reference
                    ON chat_message_events(reference_id, server_time, event_id);

                CREATE TABLE IF NOT EXISTS chat_reactions (
                    message_id TEXT NOT NULL,
                    reaction TEXT NOT NULL,
                    actor_key TEXT NOT NULL,
                    actor_label TEXT NOT NULL,
                    own INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(message_id, reaction, actor_key)
                );

                CREATE TABLE IF NOT EXISTS chat_attachments (
                    file_id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    public_url TEXT NOT NULL,
                    local_path TEXT
                );

                CREATE INDEX IF NOT EXISTS chat_attachments_message
                    ON chat_attachments(message_id);
                ",
            )
            .map_err(|error| error.to_string())?;
        ensure_column(&connection, "chat_messages", "activity_id", "TEXT")?;
        ensure_column(
            &connection,
            "chat_messages",
            "original_body",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(&connection, "chat_messages", "edited_at", "TEXT")?;
        ensure_column(
            &connection,
            "chat_messages",
            "deleted",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "chat_messages",
            "mentioned",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "chat_targets",
            "hidden",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "chat_members",
            "away",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "chat_members", "away_message", "TEXT")?;
        // Ergo can retain synthetic HistServ JOIN/PART/mode records alongside
        // actual conversation history. Mimir intentionally presents the human
        // transcript, not IRC server chatter.
        connection
            .execute(
                "DELETE FROM chat_messages WHERE lower(sender_nick) = 'histserv'",
                [],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "
                UPDATE chat_messages
                SET body = substr(body, length(agent_label) + 4)
                WHERE agent_label IS NOT NULL
                  AND body LIKE '[' || agent_label || '] %'
                ",
                [],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "
                UPDATE chat_messages
                SET original_body = body
                WHERE original_body = ''
                  AND body != ''
                  AND deleted = 0
                ",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
