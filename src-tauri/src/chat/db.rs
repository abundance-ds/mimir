use std::{collections::HashMap, path::PathBuf};

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

    fn connection(&self) -> Result<Connection, String> {
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

    pub fn ensure_target(
        &self,
        target: &str,
        kind: ChatTargetKind,
        joined: bool,
        initial_read_at: Option<&str>,
    ) -> Result<(), String> {
        let title = target.trim_start_matches(['#', '&']).to_string();
        self.connection()?
            .execute(
                "
                INSERT INTO chat_targets
                    (target, kind, title, joined, last_read_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(target) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    joined = CASE WHEN excluded.joined = 1 THEN 1 ELSE chat_targets.joined END
                ",
                params![target, kind.as_str(), title, joined, initial_read_at],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_joined(&self, target: &str, joined: bool) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET joined = ?2 WHERE target = ?1",
                params![target, joined],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_topic(&self, target: &str, topic: &str) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET topic = ?2 WHERE target = ?1",
                params![target, topic],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn replace_members(&self, target: &str, nicks: &[String]) -> Result<(), String> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE chat_members SET active = 0 WHERE target = ?1",
                params![target],
            )
            .map_err(|error| error.to_string())?;
        for nick in nicks {
            transaction
                .execute(
                    "
                    INSERT INTO chat_members(target, nick, display_name, active)
                    VALUES (?1, ?2, ?2, 1)
                    ON CONFLICT(target, nick) DO UPDATE SET active = 1
                    ",
                    params![target, nick],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "UPDATE chat_targets SET member_count = ?2 WHERE target = ?1",
                params![target, nicks.len() as u32],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn upsert_member(
        &self,
        target: &str,
        nick: &str,
        account: Option<&str>,
        display_name: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "
                INSERT INTO chat_members(target, nick, account, display_name, active)
                VALUES (?1, ?2, ?3, COALESCE(?4, ?2), 1)
                ON CONFLICT(target, nick) DO UPDATE SET
                    account = COALESCE(excluded.account, chat_members.account),
                    display_name = CASE
                        WHEN ?4 IS NULL OR ?4 = '' THEN chat_members.display_name
                        ELSE ?4
                    END,
                    active = 1
                ",
                params![target, nick, account, display_name],
            )
            .map_err(|error| error.to_string())?;
        update_member_count(&connection, target)?;
        Ok(())
    }

    pub fn remove_member(&self, target: &str, nick: &str) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE chat_members SET active = 0 WHERE target = ?1 AND nick = ?2",
                params![target, nick],
            )
            .map_err(|error| error.to_string())?;
        update_member_count(&connection, target)?;
        Ok(())
    }

    pub fn remove_member_everywhere(&self, nick: &str) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE chat_members SET active = 0 WHERE nick = ?1",
                params![nick],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "
                UPDATE chat_targets
                SET member_count = (
                    SELECT COUNT(*)
                    FROM chat_members
                    WHERE chat_members.target = chat_targets.target
                      AND active = 1
                )
                WHERE kind = 'channel'
                ",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_member_profile(&self, nick: &str, display_name: &str) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_members SET display_name = ?2 WHERE nick = ?1",
                params![nick, display_name],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_member_presence(
        &self,
        nick: &str,
        away: bool,
        away_message: Option<&str>,
    ) -> Result<(), String> {
        self.connection()?
            .execute(
                "
                UPDATE chat_members
                SET away = ?2, away_message = ?3
                WHERE nick = ?1
                ",
                params![nick, away, away_message],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn members(&self, target: Option<&str>) -> Result<Vec<ChatMember>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "
                SELECT nick, MAX(account), MAX(NULLIF(display_name, '')),
                       MAX(away), MAX(NULLIF(away_message, ''))
                FROM chat_members
                WHERE active = 1
                  AND (?1 IS NULL OR target = ?1)
                GROUP BY lower(nick)
                ORDER BY lower(COALESCE(MAX(NULLIF(display_name, '')), nick))
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![target], |row| {
                let nick: String = row.get(0)?;
                let display_name = row
                    .get::<_, Option<String>>(2)?
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| nick.clone());
                Ok(ChatMember {
                    nick,
                    account: row.get(1)?,
                    display_name,
                    away: row.get::<_, i64>(3)? != 0,
                    away_message: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn set_muted(&self, target: &str, muted: bool) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET muted = ?2 WHERE target = ?1",
                params![target, muted],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_hidden(&self, target: &str, hidden: bool) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET hidden = ?2 WHERE target = ?1",
                params![target, hidden],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn insert_message(&self, message: &ChatMessage) -> Result<bool, String> {
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "
                INSERT OR IGNORE INTO chat_messages
                    (msgid, target, server_time, sender_nick, sender_account,
                     body, reply_to, own, agent_label, activity_id,
                     original_body, edited_at, deleted, mentioned)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?6, ?11, ?12, ?13)
                ",
                params![
                    message.id,
                    message.target,
                    message.server_time,
                    message.sender_nick,
                    message.sender_account,
                    message.body,
                    message.reply_to,
                    message.own,
                    message.agent_label,
                    message.activity_id,
                    message.edited_at,
                    message.deleted,
                    message.mentioned,
                ],
            )
            .map_err(|error| error.to_string())?
            > 0;
        if changed {
            connection
                .execute(
                    "
                    UPDATE chat_targets
                    SET last_message_at = CASE
                        WHEN last_message_at IS NULL OR last_message_at < ?2 THEN ?2
                        ELSE last_message_at
                    END
                    WHERE target = ?1
                    ",
                    params![message.target, message.server_time],
                )
                .map_err(|error| error.to_string())?;
            recompute_message_state(&connection, &message.id)?;
            for attachment in &message.attachments {
                connection
                    .execute(
                        "
                        INSERT OR IGNORE INTO chat_attachments
                            (file_id, message_id, filename, mime_type, size_bytes,
                             sha256, public_url, local_path)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                        ",
                        params![
                            attachment.id,
                            message.id,
                            attachment.name,
                            attachment.mime,
                            attachment.size,
                            attachment.sha256,
                            attachment.url,
                            attachment.local_path,
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(changed)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_message_event(
        &self,
        event_id: &str,
        target: &str,
        reference_id: &str,
        kind: &str,
        actor_nick: &str,
        actor_account: Option<&str>,
        value: &str,
        server_time: &str,
        own: bool,
        mentioned: bool,
    ) -> Result<Option<ChatMessage>, String> {
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "
                INSERT OR IGNORE INTO chat_message_events
                    (event_id, target, reference_id, kind, actor_nick,
                     actor_account, value, server_time, own, mentioned)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ",
                params![
                    event_id,
                    target,
                    reference_id,
                    kind,
                    actor_nick,
                    actor_account,
                    value,
                    server_time,
                    own,
                    mentioned,
                ],
            )
            .map_err(|error| error.to_string())?
            > 0;
        if !changed {
            return Ok(None);
        }
        recompute_message_state(&connection, reference_id)?;
        message_by_id(&connection, target, reference_id).map_err(|error| error.to_string())
    }

    pub fn redact(
        &self,
        target: &str,
        identifier: &str,
        server_time: &str,
    ) -> Result<Option<ChatMessage>, String> {
        let connection = self.connection()?;
        let reference = connection
            .query_row(
                "
                SELECT reference_id
                FROM chat_message_events
                WHERE event_id = ?1 AND target = ?2
                ",
                params![identifier, target],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(reference) = reference {
            connection
                .execute(
                    "DELETE FROM chat_message_events WHERE event_id = ?1",
                    params![identifier],
                )
                .map_err(|error| error.to_string())?;
            recompute_message_state(&connection, &reference)?;
            return message_by_id(&connection, target, &reference)
                .map_err(|error| error.to_string());
        }
        let changed = connection
            .execute(
                "
                UPDATE chat_messages
                SET body = '',
                    original_body = '',
                    edited_at = NULL,
                    deleted = 1
                WHERE msgid = ?1 AND target = ?2
                ",
                params![identifier, target],
            )
            .map_err(|error| error.to_string())?
            > 0;
        if !changed {
            return Ok(None);
        }
        connection
            .execute(
                "DELETE FROM chat_reactions WHERE message_id = ?1",
                params![identifier],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM chat_attachments WHERE message_id = ?1",
                params![identifier],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "
                UPDATE chat_targets
                SET last_message_at = MAX(COALESCE(last_message_at, ''), ?2)
                WHERE target = ?1
                ",
                params![target, server_time],
            )
            .map_err(|error| error.to_string())?;
        message_by_id(&connection, target, identifier).map_err(|error| error.to_string())
    }

    pub fn own_message(&self, target: &str, identifier: &str) -> Result<bool, String> {
        self.connection()?
            .query_row(
                "
                SELECT own = 1 AND deleted = 0
                FROM chat_messages
                WHERE target = ?1 AND msgid = ?2
                ",
                params![target, identifier],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.unwrap_or(false))
            .map_err(|error| error.to_string())
    }

    pub fn attachment(&self, file_id: &str) -> Result<Option<ChatAttachment>, String> {
        let connection = self.connection()?;
        connection
            .query_row(
                "
                SELECT file_id, filename, mime_type, size_bytes, sha256,
                       public_url, local_path
                FROM chat_attachments
                WHERE file_id = ?1
                ",
                params![file_id],
                chat_attachment_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn attachment_target(&self, file_id: &str) -> Result<Option<String>, String> {
        self.connection()?
            .query_row(
                "
                SELECT m.target
                FROM chat_attachments a
                JOIN chat_messages m ON m.msgid = a.message_id
                WHERE a.file_id = ?1
                ",
                params![file_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn message_attachments(
        &self,
        target: &str,
        identifier: &str,
    ) -> Result<Vec<ChatAttachment>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "
                SELECT a.file_id, a.filename, a.mime_type, a.size_bytes,
                       a.sha256, a.public_url, a.local_path
                FROM chat_attachments a
                JOIN chat_messages m ON m.msgid = a.message_id
                WHERE m.target = ?1 AND m.msgid = ?2
                ORDER BY a.rowid
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![target, identifier], chat_attachment_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn set_attachment_local_path(
        &self,
        file_id: &str,
        path: &str,
    ) -> Result<ChatAttachment, String> {
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE chat_attachments SET local_path = ?2 WHERE file_id = ?1",
                params![file_id, path],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("That attachment is not in the local chat cache.".into());
        }
        self.attachment(file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".into())
    }

    pub fn targets(&self) -> Result<Vec<ChatTarget>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "
                SELECT
                    t.target, t.kind, t.title, t.topic, t.joined, t.member_count,
                    (
                        SELECT COUNT(*)
                        FROM chat_messages m
                        WHERE m.target = t.target
                          AND m.own = 0
                          AND m.deleted = 0
                          AND (
                            t.last_read_at IS NULL
                            OR m.server_time > t.last_read_at
                          )
                    ) AS unread_count,
                    (
                        SELECT m.msgid
                        FROM chat_messages m
                        WHERE m.target = t.target
                          AND m.own = 0
                          AND m.deleted = 0
                          AND (
                            t.last_read_at IS NULL
                            OR m.server_time > t.last_read_at
                          )
                        ORDER BY m.server_time, m.msgid
                        LIMIT 1
                    ) AS first_unread_id,
                    t.last_message_at, t.muted
                FROM chat_targets t
                WHERE (t.joined = 1 OR t.kind = 'direct')
                  AND t.hidden = 0
                ORDER BY
                    CASE WHEN lower(t.target) = '#general' THEN 0 ELSE 1 END,
                    CASE WHEN t.kind = 'channel' THEN 0 ELSE 1 END,
                    lower(t.title)
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(ChatTarget {
                    id: row.get(0)?,
                    kind: ChatTargetKind::from(row.get::<_, String>(1)?.as_str()),
                    title: row.get(2)?,
                    topic: row.get(3)?,
                    joined: row.get(4)?,
                    member_count: row.get(5)?,
                    unread_count: row.get(6)?,
                    first_unread_id: row.get(7)?,
                    last_message_at: row.get(8)?,
                    muted: row.get(9)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn known_channels(&self) -> Result<Vec<String>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT target FROM chat_targets WHERE kind = 'channel' AND joined = 1 ORDER BY target",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn messages(
        &self,
        target: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        let connection = self.connection()?;
        let before_key: Option<(String, String)> = before
            .map(|msgid| {
                connection
                    .query_row(
                        "SELECT server_time, msgid FROM chat_messages WHERE msgid = ?1",
                        params![msgid],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|error| error.to_string())
            })
            .transpose()?
            .flatten();
        let (before_time, before_id) = before_key
            .map(|(time, id)| (Some(time), Some(id)))
            .unwrap_or((None, None));
        let mut statement = connection
            .prepare(
                "
                SELECT msgid, target, server_time, sender_nick, sender_account,
                       body, reply_to, own, agent_label, activity_id,
                       edited_at, deleted, mentioned
                FROM chat_messages
                WHERE target = ?1
                  AND (
                    ?2 IS NULL
                    OR server_time < ?2
                    OR (server_time = ?2 AND msgid < ?3)
                  )
                ORDER BY server_time DESC, msgid DESC
                LIMIT ?4
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![target, before_time, before_id, limit.clamp(1, 500)],
                chat_message_from_row,
            )
            .map_err(|error| error.to_string())?;
        let mut messages = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        messages.reverse();
        hydrate_reactions(&connection, &mut messages)?;
        hydrate_attachments(&connection, &mut messages)?;
        Ok(messages)
    }

    pub fn messages_around(
        &self,
        target: &str,
        message_id: &str,
        radius: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        let connection = self.connection()?;
        let key = connection
            .query_row(
                "
                SELECT server_time, msgid
                FROM chat_messages
                WHERE target = ?1 AND msgid = ?2
                ",
                params![target, message_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "That chat message is not in the local cache.".to_string())?;
        let radius = radius.clamp(1, 100);
        let mut before = connection
            .prepare(
                "
                SELECT msgid, target, server_time, sender_nick, sender_account,
                       body, reply_to, own, agent_label, activity_id,
                       edited_at, deleted, mentioned
                FROM chat_messages
                WHERE target = ?1
                  AND (server_time < ?2 OR (server_time = ?2 AND msgid < ?3))
                ORDER BY server_time DESC, msgid DESC
                LIMIT ?4
                ",
            )
            .map_err(|error| error.to_string())?;
        let before_rows = before
            .query_map(params![target, key.0, key.1, radius], chat_message_from_row)
            .map_err(|error| error.to_string())?;
        let mut messages = before_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        messages.reverse();
        let mut after = connection
            .prepare(
                "
                SELECT msgid, target, server_time, sender_nick, sender_account,
                       body, reply_to, own, agent_label, activity_id,
                       edited_at, deleted, mentioned
                FROM chat_messages
                WHERE target = ?1
                  AND (
                    server_time > ?2
                    OR (server_time = ?2 AND msgid >= ?3)
                  )
                ORDER BY server_time, msgid
                LIMIT ?4
                ",
            )
            .map_err(|error| error.to_string())?;
        let after_rows = after
            .query_map(
                params![target, key.0, key.1, radius + 1],
                chat_message_from_row,
            )
            .map_err(|error| error.to_string())?;
        messages.extend(
            after_rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?,
        );
        hydrate_reactions(&connection, &mut messages)?;
        hydrate_attachments(&connection, &mut messages)?;
        Ok(messages)
    }

    pub fn search(
        &self,
        query: &str,
        target: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        let phrase = format!("\"{}\"", query.trim().replace('"', "\"\""));
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "
                SELECT m.msgid, m.target, m.server_time, m.sender_nick,
                       m.sender_account, m.body, m.reply_to, m.own, m.agent_label,
                       m.activity_id, m.edited_at, m.deleted, m.mentioned
                FROM chat_messages_fts f
                JOIN chat_messages m ON m.rowid = f.rowid
                WHERE chat_messages_fts MATCH ?1
                  AND (?2 IS NULL OR m.target = ?2)
                ORDER BY bm25(chat_messages_fts), m.server_time DESC
                LIMIT ?3
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![phrase, target, limit.clamp(1, 200)],
                chat_message_from_row,
            )
            .map_err(|error| error.to_string())?;
        let mut messages = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        hydrate_reactions(&connection, &mut messages)?;
        hydrate_attachments(&connection, &mut messages)?;
        Ok(messages)
    }

    pub fn mark_read(&self, target: &str, message_id: Option<&str>) -> Result<(), String> {
        let connection = self.connection()?;
        let read_at = match message_id {
            Some(message_id) => connection
                .query_row(
                    "SELECT server_time FROM chat_messages WHERE msgid = ?1 AND target = ?2",
                    params![message_id, target],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?,
            None => connection
                .query_row(
                    "SELECT MAX(server_time) FROM chat_messages WHERE target = ?1",
                    params![target],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(|error| error.to_string())?,
        };
        if let Some(read_at) = read_at {
            // Reading an older message (for example inside a search-result
            // window) must never move the read anchor backwards.
            connection
                .execute(
                    "
                    UPDATE chat_targets
                    SET last_read_at = ?2
                    WHERE target = ?1
                      AND (last_read_at IS NULL OR last_read_at < ?2)
                    ",
                    params![target, read_at],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn link_activity(
        &self,
        activity_id: &str,
        target: &str,
        agent_label: Option<&str>,
    ) -> Result<(), String> {
        self.connection()?
            .execute(
                "
                INSERT INTO activity_chat_links(activity_id, target, agent_label)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(activity_id) DO UPDATE SET
                    target = excluded.target,
                    agent_label = excluded.agent_label
                ",
                params![activity_id, target, agent_label],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn activity_link(
        &self,
        activity_id: &str,
    ) -> Result<Option<(String, Option<String>)>, String> {
        self.connection()?
            .query_row(
                "SELECT target, agent_label FROM activity_chat_links WHERE activity_id = ?1",
                params![activity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())
    }
}

fn chat_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: row.get(0)?,
        target: row.get(1)?,
        server_time: row.get(2)?,
        sender_nick: row.get(3)?,
        sender_account: row.get(4)?,
        body: row.get(5)?,
        reply_to: row.get(6)?,
        own: row.get(7)?,
        agent_label: row.get(8)?,
        activity_id: row.get(9)?,
        edited_at: row.get(10)?,
        deleted: row.get(11)?,
        mentioned: row.get(12)?,
        reactions: Vec::new(),
        attachments: Vec::new(),
    })
}

fn message_by_id(
    connection: &Connection,
    target: &str,
    identifier: &str,
) -> rusqlite::Result<Option<ChatMessage>> {
    let mut message = connection
        .query_row(
            "
            SELECT msgid, target, server_time, sender_nick, sender_account,
                   body, reply_to, own, agent_label, activity_id,
                   edited_at, deleted, mentioned
            FROM chat_messages
            WHERE target = ?1 AND msgid = ?2
            ",
            params![target, identifier],
            chat_message_from_row,
        )
        .optional()?;
    if let Some(message) = message.as_mut() {
        hydrate_reactions(connection, std::slice::from_mut(message))
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        hydrate_attachments(connection, std::slice::from_mut(message))
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
    }
    Ok(message)
}

fn hydrate_attachments(
    connection: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "
            SELECT file_id, filename, mime_type, size_bytes, sha256,
                   public_url, local_path
            FROM chat_attachments
            WHERE message_id = ?1
            ORDER BY rowid
            ",
        )
        .map_err(|error| error.to_string())?;
    for message in messages {
        let rows = statement
            .query_map(params![message.id], chat_attachment_from_row)
            .map_err(|error| error.to_string())?;
        message.attachments = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn chat_attachment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatAttachment> {
    Ok(ChatAttachment {
        id: row.get(0)?,
        name: row.get(1)?,
        mime: row.get(2)?,
        size: row.get(3)?,
        sha256: row.get(4)?,
        url: row.get(5)?,
        local_path: row.get(6)?,
    })
}

fn hydrate_reactions(connection: &Connection, messages: &mut [ChatMessage]) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "
            SELECT reaction, actor_label, own
            FROM chat_reactions
            WHERE message_id = ?1
            ORDER BY reaction, lower(actor_label)
            ",
        )
        .map_err(|error| error.to_string())?;
    for message in messages {
        let rows = statement
            .query_map(params![message.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut grouped: Vec<ChatReaction> = Vec::new();
        for row in rows {
            let (value, actor, own) = row.map_err(|error| error.to_string())?;
            if let Some(reaction) = grouped.iter_mut().find(|item| item.value == value) {
                reaction.count += 1;
                reaction.own |= own;
                reaction.reactors.push(actor);
            } else {
                grouped.push(ChatReaction {
                    value,
                    count: 1,
                    own,
                    reactors: vec![actor],
                });
            }
        }
        message.reactions = grouped;
    }
    Ok(())
}

fn recompute_message_state(connection: &Connection, identifier: &str) -> Result<(), String> {
    let base = connection
        .query_row(
            "
            SELECT sender_nick, sender_account, original_body, mentioned, deleted
            FROM chat_messages
            WHERE msgid = ?1
            ",
            params![identifier],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((sender_nick, sender_account, original_body, original_mentioned, deleted)) = base
    else {
        return Ok(());
    };
    if deleted {
        connection
            .execute(
                "DELETE FROM chat_reactions WHERE message_id = ?1",
                params![identifier],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut body = original_body;
    let mut edited_at: Option<String> = None;
    let mut mentioned = original_mentioned;
    let mut reactions: HashMap<(String, String), (bool, String, bool)> = HashMap::new();
    let mut statement = connection
        .prepare(
            "
            SELECT kind, actor_nick, actor_account, value, server_time, own, mentioned
            FROM chat_message_events
            WHERE reference_id = ?1
            ORDER BY server_time, event_id
            ",
        )
        .map_err(|error| error.to_string())?;
    let events = statement
        .query_map(params![identifier], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for event in events {
        let (kind, actor_nick, actor_account, value, time, own, event_mentioned) =
            event.map_err(|error| error.to_string())?;
        match kind.as_str() {
            "edit"
                if same_actor(
                    &sender_nick,
                    sender_account.as_deref(),
                    &actor_nick,
                    actor_account.as_deref(),
                ) =>
            {
                body = value;
                edited_at = Some(time);
                mentioned = event_mentioned;
            }
            "react" | "unreact" => {
                let actor_key = actor_account
                    .as_deref()
                    .unwrap_or(&actor_nick)
                    .to_lowercase();
                let actor_label = actor_account.unwrap_or(actor_nick);
                reactions.insert((value, actor_key), (kind == "react", actor_label, own));
            }
            _ => {}
        }
    }
    drop(statement);

    connection
        .execute(
            "
            UPDATE chat_messages
            SET body = ?2, edited_at = ?3, mentioned = ?4
            WHERE msgid = ?1
            ",
            params![identifier, body, edited_at, mentioned],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM chat_reactions WHERE message_id = ?1",
            params![identifier],
        )
        .map_err(|error| error.to_string())?;
    for ((reaction, actor_key), (active, actor_label, own)) in reactions {
        if active {
            connection
                .execute(
                    "
                    INSERT INTO chat_reactions
                        (message_id, reaction, actor_key, actor_label, own)
                    VALUES (?1, ?2, ?3, ?4, ?5)
                    ",
                    params![identifier, reaction, actor_key, actor_label, own],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn same_actor(
    message_nick: &str,
    message_account: Option<&str>,
    event_nick: &str,
    event_account: Option<&str>,
) -> bool {
    match (message_account, event_account) {
        (Some(message), Some(event)) => message.eq_ignore_ascii_case(event),
        _ => message_nick.eq_ignore_ascii_case(event_nick),
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !names.iter().any(|name| name == column) {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn update_member_count(connection: &Connection, target: &str) -> Result<(), String> {
    connection
        .execute(
            "
            UPDATE chat_targets
            SET member_count = (
                SELECT COUNT(*)
                FROM chat_members
                WHERE chat_members.target = chat_targets.target
                  AND active = 1
            )
            WHERE target = ?1
            ",
            params![target],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn message(id: &str, target: &str, time: &str, body: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            target: target.into(),
            server_time: time.into(),
            sender_nick: "anna".into(),
            sender_account: Some("anna".into()),
            body: body.into(),
            reply_to: None,
            own: false,
            agent_label: None,
            activity_id: None,
            edited_at: None,
            deleted: false,
            mentioned: false,
            reactions: Vec::new(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn targets_messages_unread_search_and_links_round_trip() {
        let directory = tempdir().unwrap();
        let db = ChatDatabase::open(directory.path().join("chat.sqlite3")).unwrap();
        assert!(db.path().exists());
        db.ensure_target(
            "#general",
            ChatTargetKind::Channel,
            true,
            Some("2026-01-01T00:00:00.000Z"),
        )
        .unwrap();
        assert!(db
            .insert_message(&message(
                "m1",
                "#general",
                "2026-01-01T00:00:01.000Z",
                "hello product"
            ))
            .unwrap());
        assert!(!db
            .insert_message(&message(
                "m1",
                "#general",
                "2026-01-01T00:00:01.000Z",
                "hello product"
            ))
            .unwrap());
        assert_eq!(db.targets().unwrap()[0].unread_count, 1);
        assert_eq!(
            db.targets().unwrap()[0].first_unread_id.as_deref(),
            Some("m1")
        );
        assert_eq!(db.messages("#general", None, 50).unwrap().len(), 1);
        assert_eq!(
            db.messages_around("#general", "m1", 10).unwrap()[0].id,
            "m1"
        );
        assert_eq!(db.search("product", None, 10).unwrap()[0].id, "m1");
        let edited = db
            .record_message_event(
                "e1",
                "#general",
                "m1",
                "edit",
                "anna",
                Some("anna"),
                "hello edited product",
                "2026-01-01T00:00:02.000Z",
                false,
                false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(edited.body, "hello edited product");
        assert_eq!(
            edited.edited_at.as_deref(),
            Some("2026-01-01T00:00:02.000Z"),
        );
        let reacted = db
            .record_message_event(
                "r1",
                "#general",
                "m1",
                "react",
                "waqr",
                Some("waqr"),
                "👍",
                "2026-01-01T00:00:03.000Z",
                true,
                false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(reacted.reactions[0].count, 1);
        assert!(reacted.reactions[0].own);
        let unreacted = db
            .record_message_event(
                "r2",
                "#general",
                "m1",
                "unreact",
                "waqr",
                Some("waqr"),
                "👍",
                "2026-01-01T00:00:04.000Z",
                true,
                false,
            )
            .unwrap()
            .unwrap();
        assert!(unreacted.reactions.is_empty());
        let restored = db
            .redact("#general", "e1", "2026-01-01T00:00:05.000Z")
            .unwrap()
            .unwrap();
        assert_eq!(restored.body, "hello product");
        let mut attachment_message = message(
            "m2",
            "#general",
            "2026-01-01T00:00:06.000Z",
            "📎 launch.pdf",
        );
        attachment_message.own = true;
        attachment_message.attachments.push(ChatAttachment {
            id: "file-one".into(),
            name: "launch.pdf".into(),
            mime: "application/pdf".into(),
            size: 42,
            sha256: "a".repeat(64),
            url: "https://chat.example/files/file-one".into(),
            local_path: None,
        });
        db.insert_message(&attachment_message).unwrap();
        assert_eq!(
            db.attachment_target("file-one").unwrap().as_deref(),
            Some("#general"),
        );
        assert_eq!(
            db.messages("#general", None, 50).unwrap()[1].attachments[0].name,
            "launch.pdf",
        );
        let cached = db
            .set_attachment_local_path("file-one", "/tmp/launch.pdf")
            .unwrap();
        assert_eq!(cached.local_path.as_deref(), Some("/tmp/launch.pdf"));
        db.replace_members("#general", &["anna".into(), "waqr".into()])
            .unwrap();
        assert_eq!(db.targets().unwrap()[0].member_count, 2);
        db.remove_member("#general", "anna").unwrap();
        assert_eq!(db.targets().unwrap()[0].member_count, 1);
        db.upsert_member("#general", "anna", Some("anna"), None)
            .unwrap();
        assert_eq!(db.targets().unwrap()[0].member_count, 2);
        db.remove_member_everywhere("anna").unwrap();
        assert_eq!(db.targets().unwrap()[0].member_count, 1);
        db.upsert_member("#general", "anna", Some("anna"), None)
            .unwrap();
        db.update_member_profile("anna", "Anna Example").unwrap();
        assert_eq!(
            db.members(Some("#general")).unwrap()[0].display_name,
            "Anna Example"
        );
        db.mark_read("#general", Some("m1")).unwrap();
        assert_eq!(db.targets().unwrap()[0].unread_count, 0);
        db.insert_message(&message(
            "m3",
            "#general",
            "2026-01-01T00:00:07.000Z",
            "unread after anchor",
        ))
        .unwrap();
        assert_eq!(db.targets().unwrap()[0].unread_count, 1);
        // Marking an older message read must not resurrect newer unreads.
        db.mark_read("#general", Some("m1")).unwrap();
        assert_eq!(db.targets().unwrap()[0].unread_count, 1);
        db.mark_read("#general", Some("m3")).unwrap();
        assert_eq!(db.targets().unwrap()[0].unread_count, 0);
        db.link_activity("activity-1", "#general", Some("codex"))
            .unwrap();
        assert_eq!(
            db.activity_link("activity-1").unwrap(),
            Some(("#general".into(), Some("codex".into())))
        );

        db.ensure_target("anna", ChatTargetKind::Direct, false, None)
            .unwrap();
        db.set_hidden("anna", true).unwrap();
        assert!(db
            .targets()
            .unwrap()
            .iter()
            .all(|target| target.id != "anna"));
        db.set_hidden("anna", false).unwrap();
        assert!(db
            .targets()
            .unwrap()
            .iter()
            .any(|target| target.id == "anna"));
    }
}
