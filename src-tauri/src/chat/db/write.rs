use super::*;

impl ChatDatabase {
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

    #[cfg(test)]
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
}
