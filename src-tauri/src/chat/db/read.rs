use super::*;

impl ChatDatabase {
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
