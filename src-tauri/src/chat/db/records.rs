use super::*;

pub(super) fn chat_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
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

pub(super) fn message_by_id(
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

pub(super) fn hydrate_attachments(
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

pub(super) fn chat_attachment_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ChatAttachment> {
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

pub(super) fn hydrate_reactions(
    connection: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), String> {
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

pub(super) fn recompute_message_state(
    connection: &Connection,
    identifier: &str,
) -> Result<(), String> {
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

pub(super) fn same_actor(
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

pub(super) fn ensure_column(
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

pub(super) fn update_member_count(connection: &Connection, target: &str) -> Result<(), String> {
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
