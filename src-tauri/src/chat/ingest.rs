use super::*;

pub(super) fn ingest_message(
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

pub(super) fn ingest_tag_message(
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

pub(super) fn ingest_redaction(
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

pub(super) fn conversation_target(
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

pub(super) fn actor_is_own(
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

pub(super) fn attachment_from_tags(config: &ChatConfig, raw: &IrcMessage) -> Vec<ChatAttachment> {
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

pub(super) fn attachment_url(endpoint: &str, file_id: &str) -> Option<String> {
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
